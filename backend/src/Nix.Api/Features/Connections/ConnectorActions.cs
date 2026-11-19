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
    ConnectorTokenClient tokenClient, IIsolatedUnitOfWork isolated, INixSessionContextAccessor session,
    IConfiguration configuration, TimeProvider clock, ConnectorCalendars calendars)
{
    internal async Task<Result<string>> CatalogAsync(WorkspaceId workspace, string filter, CancellationToken token)
    {
        if (!ConnectorEndpoints.Enabled(configuration, workspace)
            || !await permissions.CanManageWorkspaceAsync(workspace, token).ConfigureAwait(false))
        {
            return Result.Failure<string>(ConnectorErrors.Missing());
        }
        var grants = await store.ListAsync(workspace, token).ConfigureAwait(false);
        var catalog = await worker.SendAsync(new("catalog"), token).ConfigureAwait(false);
        if (catalog?.Actions is not { } definitions)
        {
            return Result.Failure<string>(ConnectorErrors.Unavailable());
        }
        var native = from connection in grants
                     from action in definitions
                     where action.Provider == connection.Provider && action.ResourceKind == connection.ResourceKind
                         && connection.Actions.Contains(action.Id, StringComparer.Ordinal)
                         && (action.Id.Contains(filter, StringComparison.OrdinalIgnoreCase) || connection.Provider == filter)
                     select new ConnectorAvailableAction(connection.Id, connection.Revision, connection.Provider, connection.ResourceId, action.Id,
                         action.Kind, action.Id == filter ? action.Schema : null);
        var registered = new List<ConnectorAvailableAction>();
        if ("remote.invoke".Contains(filter, StringComparison.OrdinalIgnoreCase) || filter == "mcp")
        {
            foreach (var grant in grants.Where(connection => connection.Provider == "mcp").Take(8))
            {
                var stored = await store.GetAsync(workspace, grant.Id, lockForUpdate: false, token).ConfigureAwait(false);
                if (stored?.ProtectedTokens is { } protectedTokens && tokenClient.Unprotect(protectedTokens)?.RemoteMcp is { } mcp)
                {
                    registered.Add(new ConnectorAvailableAction(grant.Id, grant.Revision, "mcp", grant.ResourceId, "remote.invoke", "write",
                        filter == "remote.invoke" ? mcp.Schema : null));
                }
            }
        }
        return Result.Success(JsonSerializer.Serialize(native.Concat(registered).Take(8).ToArray(), ConnectorJsonContext.Default.ConnectorAvailableActionArray));
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
            if (grant.ResourceKind == "calendar"
                && (await store.GetAsync(workspace, grant.Id, lockForUpdate: false, token).ConfigureAwait(false)
                    is not { ProtectedTokens: { } protectedTokens } current
                    || current.Revision != grant.Revision
                    || tokenClient.Unprotect(protectedTokens) is not { } credential
                    || !await AliasIsActiveAsync(workspace, current, credential, entry.Kind == "write", token).ConfigureAwait(false)))
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
        if (tokenClient.Unprotect(grant.ProtectedTokens) is not { } credential)
        {
            return Result.Failure<PreparedConnectorAction>(ConnectorErrors.Unavailable());
        }
        if (credential.RemoteMcp is { } mcp)
        {
            if (grant.Provider != "mcp" || action != "remote.invoke")
            {
                return Result.Failure<PreparedConnectorAction>(ConnectorErrors.Stale());
            }
            var remote = await worker.SendMcpAsync(new("prepare", mcp.Tool, mcp.Url, args, mcp.SchemaHash, credential.AccessToken), token).ConfigureAwait(false);
            return remote is { Failure: null, Arguments: { ValueKind: JsonValueKind.Object } reviewed } && remote.SchemaHash == mcp.SchemaHash
                ? Result.Success(new PreparedConnectorAction(grant.Id, grant.Revision, action, "write", grant.ResourceId,
                    grant.ResourceId, mcp.SchemaHash, reviewed))
                : Result.Failure<PreparedConnectorAction>(ConnectorErrors.Stale());
        }
        var catalog = await worker.SendAsync(new("catalog"), token).ConfigureAwait(false);
        var definition = catalog?.Actions?.SingleOrDefault(entry => entry.Id == action && entry.Provider == grant.Provider && entry.ResourceKind == grant.ResourceKind);
        if (definition is null || definition.Kind is not ("read" or "write"))
        {
            return Result.Failure<PreparedConnectorAction>(ConnectorErrors.Stale());
        }
        if (!await AliasIsActiveAsync(workspace, grant, credential, definition.Kind == "write", token).ConfigureAwait(false))
        {
            return Result.Failure<PreparedConnectorAction>(ConnectorErrors.Unavailable());
        }
        var prepared = await worker.SendAsync(new("prepare", action, grant.ResourceId, args), token).ConfigureAwait(false);
        if (prepared is not { Failure: null, Arguments: { ValueKind: JsonValueKind.Object } normalized }
            || prepared.SchemaHash != definition.SchemaHash)
        {
            return Result.Failure<PreparedConnectorAction>(ConnectorErrors.Invalid());
        }
        return Result.Success(new PreparedConnectorAction(grant.Id, grant.Revision, action, definition.Kind, grant.ResourceId,
            $"{grant.Provider} {grant.ResourceKind} {grant.ResourceId}", definition.SchemaHash, normalized));
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
            // A committed refresh pair remains usable even when the following provider call fails.
            return new IsolatedOutcome<Result<JsonElement>>(result, Commit: true);
        }, token);
    }

    internal async Task<bool> CanObserveReadAsync(
        WorkspaceId workspace, PreparedConnectorAction prepared, CancellationToken token)
    {
        if (prepared.Kind != "read"
            || await FindPreparedGrantAsync(workspace, prepared, lockForUpdate: false, token).ConfigureAwait(false)
                is not { ProtectedTokens: { } protectedTokens } grant
            || tokenClient.Unprotect(protectedTokens) is not { RemoteMcp: null } credential)
        {
            return false;
        }
        return await AliasIsActiveAsync(workspace, grant, credential, write: false, token).ConfigureAwait(false);
    }

    private async Task<Result<JsonElement>> DispatchAsync(
        WorkspaceId workspace, Guid actionId, PreparedConnectorAction prepared, CancellationToken token)
    {
        if (await FindPreparedGrantAsync(workspace, prepared, lockForUpdate: true, token).ConfigureAwait(false)
            is not { ProtectedTokens: { } protectedTokens } grant)
        {
            return Result.Failure<JsonElement>(ConnectorErrors.Stale());
        }
        var credential = tokenClient.Unprotect(protectedTokens);
        if (credential is null)
        {
            return Result.Failure<JsonElement>(ConnectorErrors.Unavailable());
        }
        if (credential.RemoteMcp is { } mcp)
        {
            if (grant.Provider != "mcp" || prepared.Action != "remote.invoke" || prepared.Kind != "write"
                || prepared.SchemaHash != mcp.SchemaHash)
            {
                return Result.Failure<JsonElement>(ConnectorErrors.Stale());
            }
            var remote = await worker.SendMcpAsync(new("execute", mcp.Tool, mcp.Url, prepared.Arguments, prepared.SchemaHash,
                credential.AccessToken, actionId), token).ConfigureAwait(false);
            return MapDispatchResult(remote, writes: true);
        }
        if (credential.CalendarLinkId is { } calendarLink)
        {
            var access = await calendars.AcquireAsync(workspace, calendarLink, grant.Provider, grant.ResourceId,
                prepared.Kind == "write", token).ConfigureAwait(false);
            if (access is null)
            {
                return Result.Failure<JsonElement>(ConnectorErrors.Unavailable());
            }
            credential = credential with { AccessToken = access };
        }
        else if (credential.ExpiresAt is { } expiry && expiry <= clock.GetUtcNow().AddSeconds(45))
        {
            if (ConnectorProvider.Find(configuration, grant.Provider) is not { } provider
                || credential.RefreshToken is not { } refresh
                || await tokenClient.RefreshAsync(provider, refresh, token).ConfigureAwait(false) is not { } refreshed
                || !await store.SaveTokensAsync(grant.Id, grant.Revision, tokenClient.Protect(refreshed), CancellationToken.None)
                    .ConfigureAwait(false))
            {
                return Result.Failure<JsonElement>(ConnectorErrors.Unavailable());
            }
            credential = refreshed;
        }
        var reply = await worker.SendAsync(new("execute", prepared.Action, grant.ResourceId, prepared.Arguments,
            prepared.SchemaHash, credential.AccessToken, actionId), token).ConfigureAwait(false);
        return MapDispatchResult(reply, prepared.Kind == "write");
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

    private async Task<bool> AliasIsActiveAsync(
        WorkspaceId workspace, ConnectorGrant grant, ConnectorCredential credential, bool write, CancellationToken token) =>
        credential.CalendarLinkId is not { } calendarLink
        || await calendars.CheckAsync(workspace, calendarLink, grant.Provider, grant.ResourceId, write, token).ConfigureAwait(false) is not null;

    private static Result<JsonElement> MapDispatchResult(ConnectorWorkerResponse? reply, bool writes)
    {
        if (reply is { Failure: null, Result: { } value })
        {
            return Result.Success(value);
        }
        return Result.Failure<JsonElement>(reply?.Failure switch
        {
            "schema_changed" or "unsupported_schema" or "unknown_action" or "unknown_tool" or "invalid_destination" => ConnectorErrors.Stale(),
            "invalid_args" => ConnectorErrors.Invalid(),
            _ => writes ? ConnectorErrors.Unknown() : ConnectorErrors.Unavailable(),
        });
    }
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

    public string? ModelObservation(PetRunEffect effect, string receipt) =>
        effect.Parameters.ValueKind == JsonValueKind.Object && effect.Parameters.TryGetProperty("kind", out var kind)
            && kind.ValueKind == JsonValueKind.String && kind.GetString() == "read" ? receipt : null;

    public async Task<bool> CanObserveAsync(
        PetRunRecord run, PetRunEffect effect, string receipt, CancellationToken cancellationToken)
    {
        try
        {
            return effect.Parameters.ValueKind == JsonValueKind.Object
                && effect.Parameters.Deserialize(ConnectorJsonContext.Default.PreparedConnectorAction) is { } prepared
                && await actions.CanObserveReadAsync(run.WorkspaceId, prepared, cancellationToken).ConfigureAwait(false);
        }
        catch (JsonException)
        {
            return false;
        }
    }

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
    public string Description => "Find scoped workspace connectors. Pass filter (a provider or action id). An exact action id includes its input schema.";
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
