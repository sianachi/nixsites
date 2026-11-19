using System.Diagnostics.CodeAnalysis;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.WebUtilities;
using Nix.Abstractions;
using Nix.Abstractions.Connections;
using Nix.Authentication;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;

namespace Nix.Features.Connections;

[SuppressMessage("Performance", "CA1812", Justification = "Created by ASP.NET Core dependency injection.")]
internal sealed class ConnectorOAuth(
    IConnectorStore store, IPermissionResolver permissions, ConnectorWorkerClient worker, ConnectorTokenClient tokens,
    IDataProtectionProvider protection, IConfiguration config, TimeProvider clock, ConnectorCalendars calendars,
    IIsolatedUnitOfWork isolated, INixSessionContextAccessor session)
{
    internal const string CallbackPath = "/auth/pet-connections/callback";
    private readonly IDataProtector _pending = protection.CreateProtector("Nix.PetConnectors.Pending.v1");

    internal static string Redirect(string? path, string status) =>
        QueryHelpers.AddQueryString(ReturnToPath.Sanitize(path, "/settings?tab=connections"), "pet_connection_status", status);

    internal async Task<Result<AuthorizePetConnectionResponse>> BeginAsync(
        WorkspaceId workspace, Guid browserSession, Uri callback, AuthorizePetConnectionRequest request, CancellationToken token)
    {
        if (!await permissions.CanManageWorkspaceAsync(workspace, token).ConfigureAwait(false))
        {
            return Result.Failure<AuthorizePetConnectionResponse>(ConnectorErrors.Missing());
        }
        if (!IsIdentifier(request.Provider, 40) || !IsIdentifier(request.ResourceKind, 48)
            || request.ResourceId is not { Length: > 0 and <= 512 }
            || request.ResourceId.Any(c => !(char.IsAsciiLetterOrDigit(c) || "_.@+!~:/=,%$-".Contains(c, StringComparison.Ordinal)))
            || request.Actions is not { Length: > 0 and <= 32 } || request.Actions.Any(id => !IsIdentifier(id, 96)))
        {
            return Result.Failure<AuthorizePetConnectionResponse>(ConnectorErrors.Invalid());
        }

        var reply = await worker.SendAsync(new("catalog"), token).ConfigureAwait(false);
        var selected = request.Actions.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        var actions = reply?.Actions?.Where(action => action.Provider == request.Provider
            && action.ResourceKind == request.ResourceKind && selected.Contains(action.Id, StringComparer.Ordinal)).ToArray();
        if (actions is null || actions.Length != selected.Length)
        {
            return Result.Failure<AuthorizePetConnectionResponse>(ConnectorErrors.Invalid());
        }

        if (request.CalendarLinkId is { } calendarLink)
        {
            if (request.ResourceKind != "calendar"
                || await calendars.CheckAsync(workspace, calendarLink, request.Provider, request.ResourceId,
                    actions.Any(action => action.Kind == "write"), token).ConfigureAwait(false) is null
                || !await store.SaveScopedAsync(workspace, request.Provider, request.ResourceKind, request.ResourceId,
                    selected, tokens.Protect(new ConnectorCredential("", null, null, calendarLink)), token).ConfigureAwait(false))
            {
                return Result.Failure<AuthorizePetConnectionResponse>(ConnectorErrors.Invalid());
            }
            return Result.Success(new AuthorizePetConnectionResponse(
                new Uri(callback, Redirect(request.ReturnTo, "connected")).AbsoluteUri));
        }
        if (ConnectorProvider.Find(config, request.Provider) is not { } provider)
        {
            return Result.Failure<AuthorizePetConnectionResponse>(ConnectorErrors.Unavailable());
        }

        var state = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        var verifier = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        var payload = new PendingConnectorConsent(selected, verifier, ReturnToPath.Sanitize(request.ReturnTo, "/settings?tab=connections"), provider.ClientId);
        var secured = _pending.Protect(JsonSerializer.Serialize(payload, ConnectorJsonContext.Default.PendingConnectorConsent));
        if (!await store.BeginOAuthAsync(workspace, request.Provider, request.ResourceKind, request.ResourceId,
            HashState(browserSession, state), secured, clock.GetUtcNow().AddMinutes(10), token).ConfigureAwait(false))
        {
            return Result.Failure<AuthorizePetConnectionResponse>(ConnectorErrors.Stale());
        }

        var parameters = new Dictionary<string, string?>(StringComparer.Ordinal)
        {
            ["client_id"] = provider.ClientId,
            ["redirect_uri"] = callback.AbsoluteUri,
            ["response_type"] = "code",
            ["state"] = state,
        };
        var scopes = provider.Scopes(actions);
        if (scopes.Length != 0)
        {
            parameters["scope"] = string.Join(provider.Id is "slack" or "linear" ? ',' : ' ', scopes);
        }
        if (provider.UsePkce)
        {
            parameters["code_challenge"] = WebEncoders.Base64UrlEncode(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
            parameters["code_challenge_method"] = "S256";
        }
        if (provider.Id == "google")
        {
            parameters["access_type"] = "offline";
            parameters["prompt"] = "consent";
        }
        if (provider.Id == "linear" && actions.Any(action => action.Kind == "write"))
        {
            parameters["actor"] = "app";
        }
        return Result.Success(new AuthorizePetConnectionResponse(QueryHelpers.AddQueryString(provider.Authorize, parameters)));
    }

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
        var reply = await worker.SendMcpAsync(new("inspect", request.Tool, url.AbsoluteUri, AccessToken: request.Token), token).ConfigureAwait(false);
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
            tokens.Protect(new ConnectorCredential(request.Token, null, null, RemoteMcp: tool)), token).ConfigureAwait(false)
            ? Result.Success(true) : Result.Failure<bool>(ConnectorErrors.Stale());
    }

    internal Task<ConnectorPending?> ConsumeAsync(Guid browserSession, string? state, CancellationToken token) =>
        state is { Length: 43 } && state.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_')
            ? store.ConsumeOAuthAsync(HashState(browserSession, state), clock.GetUtcNow(), token)
            : Task.FromResult<ConnectorPending?>(null);

    internal async Task<string> CompleteAsync(ConnectorPending receipt, Uri callback, string? code, string? error, CancellationToken token)
    {
        PendingConnectorConsent? pending;
        try
        {
            pending = JsonSerializer.Deserialize(_pending.Unprotect(receipt.ProtectedState), ConnectorJsonContext.Default.PendingConnectorConsent);
        }
        catch (Exception failure) when (failure is CryptographicException or JsonException)
        {
            return Redirect(null, "failed");
        }

        if (pending is null || !await permissions.CanManageWorkspaceAsync(receipt.WorkspaceId, token).ConfigureAwait(false))
        {
            return Redirect(null, "failed");
        }
        if (!string.IsNullOrEmpty(error))
        {
            return Redirect(pending.ReturnTo, "cancelled");
        }
        if (code is not { Length: > 0 and <= 4096 } || code.Any(char.IsControl)
            || ConnectorProvider.Find(config, receipt.Provider) is not { } provider || provider.ClientId != pending.ClientId)
        {
            return Redirect(pending.ReturnTo, "failed");
        }

        var credential = await tokens.ExchangeAsync(provider, code, callback, pending.Verifier, token).ConfigureAwait(false);
        return credential is not null && await CanStillManageAsync(receipt.WorkspaceId, token).ConfigureAwait(false)
            && await store.CompleteOAuthAsync(receipt, pending.Actions, tokens.Protect(credential), token).ConfigureAwait(false)
            ? Redirect(pending.ReturnTo, "connected")
            : Redirect(pending.ReturnTo, "failed");
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

    private static string HashState(Guid browserSession, string state) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.ASCII.GetBytes($"{browserSession:D}:{state}")));
}
