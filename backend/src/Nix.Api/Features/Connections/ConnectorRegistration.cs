using System.Diagnostics.CodeAnalysis;
using System.Text.Json;
using Nix.Abstractions;
using Nix.Abstractions.Connections;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;

namespace Nix.Features.Connections;

[SuppressMessage("Performance", "CA1812", Justification = "Created by ASP.NET Core dependency injection.")]
internal sealed class ConnectorRegistration(
    IConnectorStore store, IPermissionResolver permissions, ConnectorWorkerClient worker, ConnectorSecrets secrets,
    IIsolatedUnitOfWork isolated, INixSessionContextAccessor session)
{
    internal async Task<Result<bool>> RegisterRemoteMcpAsync(
        WorkspaceId workspace, RegisterPetMcpConnectionRequest request, CancellationToken token)
    {
        if (!await permissions.CanManageWorkspaceAsync(workspace, token).ConfigureAwait(false))
        {
            return Result.Failure<bool>(ConnectorErrors.Missing());
        }
        if (!IsIdentifier(request.Tool, 96) || request.Url is not { Length: > 0 and <= 400 }
            || !Uri.TryCreate(request.Url, UriKind.Absolute, out var url) || url.Scheme != Uri.UriSchemeHttps
            || url.UserInfo.Length + url.Query.Length + url.Fragment.Length != 0 || request.Token is not { Length: > 0 and <= 8192 }
            || request.Token.Any(character => character is < '!' or > '~'))
        {
            return Result.Failure<bool>(ConnectorErrors.Invalid());
        }
        var reply = await worker.SendAsync(new("inspect", request.Tool, url.AbsoluteUri, AccessToken: request.Token), token).ConfigureAwait(false);
        var tool = ReadRegisteredTool(reply);
        if (tool is null || tool.Tool != request.Tool || !Uri.TryCreate(tool.Url, UriKind.Absolute, out var registeredUrl)
            || registeredUrl != url)
        {
            return Result.Failure<bool>(ConnectorErrors.Invalid());
        }
        if (!await CanStillManageAsync(workspace, token).ConfigureAwait(false))
        {
            return Result.Failure<bool>(ConnectorErrors.Missing());
        }
        return await store.SaveScopedAsync(workspace, "mcp", "tool", $"{tool.Url}#{tool.Tool}", ["remote.invoke"],
            secrets.Protect(new ConnectorCredential(request.Token, tool)), token).ConfigureAwait(false)
            ? Result.Success(true) : Result.Failure<bool>(ConnectorErrors.Stale());
    }

    private Task<bool> CanStillManageAsync(WorkspaceId workspace, CancellationToken token) =>
        isolated.RunAsync(session.Current ?? throw new InvalidOperationException("Connection management requires a tenant unit of work."),
            async (services, ct) =>
            {
                var allowed = await services.GetRequiredService<IPermissionResolver>().CanManageWorkspaceAsync(workspace, ct).ConfigureAwait(false);
                return new IsolatedOutcome<bool>(allowed, Commit: false);
            }, token);

    private static RegisteredMcpTool? ReadRegisteredTool(ConnectorWorkerResponse? reply)
    {
        try
        {
            var tool = reply is { Failure: null, Result: { ValueKind: JsonValueKind.Object } value }
                ? value.Deserialize(ConnectorJsonContext.Default.RegisteredMcpTool) : null;
            return tool is { Url.Length: > 0 and <= 400, SchemaHash.Length: 64, Schema.ValueKind: JsonValueKind.Object }
                ? tool : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static bool IsIdentifier(string? value, int max) =>
        value is { Length: > 0 } && value.Length <= max && value.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '-' or '_');

}
