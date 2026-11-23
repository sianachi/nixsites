using System.Diagnostics.CodeAnalysis;
using System.Text.Json;
using Nix.Abstractions;
using Nix.Abstractions.Connections;
using Nix.Abstractions.PetRuns;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.PetRuns;

namespace Nix.Features.Connections;

[SuppressMessage("Performance", "CA1812", Justification = "Created by ASP.NET Core dependency injection.")]
internal sealed class ConnectorActions(
    IConnectorStore store, IPermissionResolver permissions, ConnectorWorkerClient worker,
    ConnectorSecrets secrets, IIsolatedUnitOfWork isolated, INixSessionContextAccessor session,
    IConfiguration configuration)
{
    internal async Task<Result<string>> CatalogAsync(WorkspaceId workspace, string filter, CancellationToken token)
    {
        if (!ConnectorEndpoints.Enabled(configuration, workspace)
            || !await permissions.CanManageWorkspaceAsync(workspace, token).ConfigureAwait(false))
        {
            return Result.Failure<string>(ConnectorErrors.Missing());
        }
        var grants = await store.ListAsync(workspace, token).ConfigureAwait(false);
        var registered = new List<ConnectorAvailableAction>();
        if ("remote.invoke".Contains(filter, StringComparison.OrdinalIgnoreCase) || filter == "mcp")
        {
            foreach (var grant in grants.Where(connection => connection.Provider == "mcp").Take(8))
            {
                var stored = await store.GetAsync(workspace, grant.Id, lockForUpdate: false, token).ConfigureAwait(false);
                if (stored?.ProtectedTokens is { } protectedTokens && secrets.Unprotect(protectedTokens)?.RemoteMcp is { } mcp)
                {
                    registered.Add(new ConnectorAvailableAction(grant.Id, grant.Revision, "mcp", grant.ResourceId, "remote.invoke", "write",
                        filter == "remote.invoke" ? mcp.Schema : null));
                }
            }
        }
        return Result.Success(JsonSerializer.Serialize(registered.ToArray(), ConnectorJsonContext.Default.ConnectorAvailableActionArray));
    }

    internal async Task<bool> CanObserveCatalogAsync(WorkspaceId workspace, string receipt, CancellationToken token)
    {
        if (!ConnectorEndpoints.Enabled(configuration, workspace)
            || !await permissions.CanManageWorkspaceAsync(workspace, token).ConfigureAwait(false))
        {
            return false;
        }
        ConnectorAvailableAction[]? entries;
        try
        {
            entries = JsonSerializer.Deserialize(receipt, ConnectorJsonContext.Default.ConnectorAvailableActionArray);
        }
        catch (JsonException)
        {
            return false;
        }
        if (entries is not { Length: <= 8 })
        {
            return false;
        }

        var grants = (await store.ListAsync(workspace, token).ConfigureAwait(false)).ToDictionary(grant => grant.Id);
        foreach (var entry in entries)
        {
            if (entry is null || !grants.TryGetValue(entry.ConnectionId, out var grant) || grant.Provider != entry.Provider
                || !MatchesScope(grant, entry.ConnectionRevision, entry.Resource, entry.Action))
            {
                return false;
            }
        }
        return true;
    }

    internal async Task<Result<PreparedConnectorAction>> PreviewAsync(
        WorkspaceId workspace, Guid connectionId, string action, JsonElement args, CancellationToken token)
    {
        if (action is not { Length: > 0 and <= 96 } || args.ValueKind != JsonValueKind.Object
            || args.GetRawText().Length > 48 * 1024)
        {
            return Result.Failure<PreparedConnectorAction>(ConnectorErrors.Invalid());
        }
        if (!ConnectorEndpoints.Enabled(configuration, workspace)
            || !await permissions.CanManageWorkspaceAsync(workspace, token).ConfigureAwait(false)
            || await store.GetAsync(workspace, connectionId, lockForUpdate: false, token).ConfigureAwait(false) is not { ProtectedTokens: not null } grant
            || !grant.Actions.Contains(action, StringComparer.Ordinal))
        {
            return Result.Failure<PreparedConnectorAction>(ConnectorErrors.Missing());
        }
        if (secrets.Unprotect(grant.ProtectedTokens) is not { } credential)
        {
            return Result.Failure<PreparedConnectorAction>(ConnectorErrors.Unavailable());
        }
        if (credential.RemoteMcp is not { } mcp || grant.Provider != "mcp" || action != "remote.invoke")
        {
            return Result.Failure<PreparedConnectorAction>(ConnectorErrors.Stale());
        }
        var remote = await worker.SendAsync(new("prepare", mcp.Tool, mcp.Url, args, mcp.SchemaHash, credential.AccessToken), token).ConfigureAwait(false);
        return remote is { Failure: null, Arguments: { ValueKind: JsonValueKind.Object } reviewed } && remote.SchemaHash == mcp.SchemaHash
            ? Result.Success(new PreparedConnectorAction(grant.Id, grant.Revision, action, "write", grant.ResourceId,
                grant.ResourceId, mcp.SchemaHash, reviewed))
            : Result.Failure<PreparedConnectorAction>(ConnectorErrors.Stale());
    }

    // The run coordinator must claim its approved persisted proposal before reaching this service.
    internal Task<Result<JsonElement>> ExecuteAsync(
        WorkspaceId workspace, Guid actionId, PreparedConnectorAction prepared, CancellationToken token)
    {
        var caller = session.Current ?? throw new InvalidOperationException("A tenant unit of work is required.");
        return isolated.RunAsync(caller with { WorkspaceId = workspace }, async (services, ct) =>
        {
            var actions = services.GetRequiredService<ConnectorActions>();
            var result = await actions.DispatchAsync(workspace, actionId, prepared, ct).ConfigureAwait(false);
            return new IsolatedOutcome<Result<JsonElement>>(result, Commit: false);
        }, token);
    }

    private async Task<Result<JsonElement>> DispatchAsync(
        WorkspaceId workspace, Guid actionId, PreparedConnectorAction prepared, CancellationToken token)
    {
        if (await FindPreparedGrantAsync(workspace, prepared, lockForUpdate: true, token).ConfigureAwait(false)
            is not { ProtectedTokens: { } protectedTokens } grant)
        {
            return Result.Failure<JsonElement>(ConnectorErrors.Stale());
        }
        if (secrets.Unprotect(protectedTokens) is not { RemoteMcp: { } mcp } credential)
        {
            return Result.Failure<JsonElement>(ConnectorErrors.Unavailable());
        }
        if (grant.Provider != "mcp" || prepared.Action != "remote.invoke" || prepared.Kind != "write"
            || prepared.SchemaHash != mcp.SchemaHash)
        {
            return Result.Failure<JsonElement>(ConnectorErrors.Stale());
        }
        var remote = await worker.SendAsync(new("execute", mcp.Tool, mcp.Url, prepared.Arguments, prepared.SchemaHash,
            credential.AccessToken, actionId), token).ConfigureAwait(false);
        if (remote is { Failure: null, Result: { } value })
        {
            return Result.Success(value);
        }
        return Result.Failure<JsonElement>(remote?.Failure switch
        {
            "schema_changed" or "unsupported_schema" or "unknown_tool" or "invalid_destination" => ConnectorErrors.Stale(),
            "invalid_args" => ConnectorErrors.Invalid(),
            _ => ConnectorErrors.Unknown(),
        });
    }

    private async Task<ConnectorGrant?> FindPreparedGrantAsync(
        WorkspaceId workspace, PreparedConnectorAction prepared, bool lockForUpdate, CancellationToken token)
    {
        if (!ConnectorEndpoints.Enabled(configuration, workspace)
            || !await permissions.CanManageWorkspaceAsync(workspace, token).ConfigureAwait(false)
            || await store.GetAsync(workspace, prepared.ConnectionId, lockForUpdate, token).ConfigureAwait(false)
                is not { ProtectedTokens: not null } grant
            || !MatchesScope(grant, prepared.ConnectionRevision, prepared.ResourceId, prepared.Action))
        {
            return null;
        }
        return grant;
    }

    private static bool MatchesScope(ConnectorGrant grant, Guid revision, string resource, string action) =>
        grant.Revision == revision && grant.ResourceId == resource && grant.Actions.Contains(action, StringComparer.Ordinal);

}

[SuppressMessage("Performance", "CA1812", Justification = "Created by ASP.NET Core dependency injection.")]
internal sealed class ConnectorRunCapability(ConnectorActions actions) : IPetRunCapability
{
    private static readonly JsonElement Schema = JsonSerializer.Deserialize("""
        {"type":"object","additionalProperties":false,"required":["connectionId","action","arguments"],"properties":{
            "connectionId":{"type":"string","format":"uuid"},"action":{"type":"string"},"arguments":{"type":"object"}}}
        """, ConnectorJsonContext.Default.JsonElement);

    public string Name => "connection.action";
    public string Description => "Propose an authorized action on a connected workspace resource. Use connectionId, action and arguments from the available connection catalog.";
    public JsonElement? InputSchema => Schema;

    public async Task<Result<PetRunEffect>> PreviewAsync(PetRunRecord run, JsonElement args, CancellationToken cancellationToken)
    {
        if (args.ValueKind != JsonValueKind.Object || args.EnumerateObject().Count() != 3 || !args.TryGetProperty("connectionId", out var id)
            || id.ValueKind != JsonValueKind.String || !id.TryGetGuid(out var connectionId)
            || !args.TryGetProperty("action", out var name) || name.ValueKind != JsonValueKind.String
            || !args.TryGetProperty("arguments", out var parameters) || name.GetString() is not { } action)
        {
            return Result.Failure<PetRunEffect>(ConnectorErrors.Invalid());
        }
        var preview = await actions.PreviewAsync(run.WorkspaceId, connectionId, action, parameters, cancellationToken).ConfigureAwait(false);
        return preview.Match(
            prepared => Result.Success(new PetRunEffect($"{prepared.Action} in {prepared.Destination}",
                JsonSerializer.SerializeToElement(prepared, ConnectorJsonContext.Default.PreparedConnectorAction))),
            Result.Failure<PetRunEffect>);
    }

    public async Task<Result<string>> ApplyAsync(PetRunRecord run, Guid actionId, PetRunEffect effect, CancellationToken cancellationToken)
    {
        var prepared = effect.Parameters.Deserialize(ConnectorJsonContext.Default.PreparedConnectorAction);
        if (prepared is null)
        {
            return Result.Failure<string>(ConnectorErrors.Invalid());
        }
        var result = await actions.ExecuteAsync(run.WorkspaceId, actionId, prepared, cancellationToken).ConfigureAwait(false);
        return result.Match(value => Result.Success(value.GetRawText()), Result.Failure<string>);
    }
}

[SuppressMessage("Performance", "CA1812", Justification = "Created by ASP.NET Core dependency injection.")]
internal sealed class ConnectorCatalogCapability(ConnectorActions actions) : IPetRunCapability
{
    private static readonly JsonElement Schema = JsonSerializer.Deserialize("""
        {"type":"object","additionalProperties":false,"required":["filter"],"properties":{
            "filter":{"type":"string","maxLength":96}}}
        """, ConnectorJsonContext.Default.JsonElement);

    public string Name => "connection.catalog";
    public string Description => "Find the remote MCP tools registered in this workspace. Pass filter \"mcp\" to list them; \"remote.invoke\" includes each input schema.";
    public JsonElement? InputSchema => Schema;
    public bool RequiresApproval(PetRunEffect effect) => false;
    public string? ModelObservation(PetRunEffect effect, string receipt) => receipt;
    public Task<bool> CanObserveAsync(
        PetRunRecord run, PetRunEffect effect, string receipt, CancellationToken cancellationToken) =>
        actions.CanObserveCatalogAsync(run.WorkspaceId, receipt, cancellationToken);

    public Task<Result<PetRunEffect>> PreviewAsync(PetRunRecord run, JsonElement args, CancellationToken cancellationToken)
    {
        var success = args.ValueKind == JsonValueKind.Object && args.EnumerateObject().Count() == 1 && args.TryGetProperty("filter", out var filter)
            && filter.ValueKind == JsonValueKind.String && filter.GetString() is { Length: <= 96 };
        return Task.FromResult(success
            ? Result.Success(new PetRunEffect("Inspect scoped connection actions", args.Clone()))
            : Result.Failure<PetRunEffect>(ConnectorErrors.Invalid()));
    }

    public Task<Result<string>> ApplyAsync(PetRunRecord run, Guid actionId, PetRunEffect effect, CancellationToken cancellationToken) =>
        actions.CatalogAsync(run.WorkspaceId, effect.Parameters.GetProperty("filter").GetString() ?? "", cancellationToken);
}
