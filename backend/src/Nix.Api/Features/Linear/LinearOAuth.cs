using System.Diagnostics.CodeAnalysis;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.WebUtilities;
using Nix.Abstractions;
using Nix.Abstractions.Linear;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Linear;

[SuppressMessage("Performance", "CA1812", Justification = "Created by ASP.NET Core dependency injection.")]
internal sealed class LinearOAuth(
    ILinearStore store,
    IPermissionResolver permissions,
    LinearWorkerClient worker,
    IIsolatedUnitOfWork isolated,
    INixSessionContextAccessor session,
    IDataProtectionProvider protection,
    TimeProvider clock) :
    IQueryHandler<ReadLinearConnection, Result<LinearConnectionResponse>>,
    ICommandHandler<AuthorizeLinearConnection, LinearAuthorizationResponse>,
    ICommandHandler<DisconnectLinearConnection, bool>
{
    private const string ReturnPath = "/settings?tab=connections";
    internal const string CallbackPath = "/auth/linear/callback";
    private readonly IDataProtector _credential = protection.CreateProtector("Nix.Linear.Credential.v1");
    private readonly IDataProtector _pending = protection.CreateProtector("Nix.Linear.PendingOAuth.v1");
    private readonly IDataProtector _state = protection.CreateProtector("Nix.Linear.BrowserState.v1");

    internal static string Redirect(string? path, string status) =>
        QueryHelpers.AddQueryString(Nix.Authentication.ReturnToPath.Sanitize(path, ReturnPath), "linear_status", status);

    public async ValueTask<Result<LinearConnectionResponse>> HandleAsync(ReadLinearConnection query, CancellationToken token)
    {
        if (!await permissions.CanManageWorkspaceAsync(query.WorkspaceId, token).ConfigureAwait(false))
        {
            return Result.Failure<LinearConnectionResponse>(LinearErrors.Missing());
        }

        var connection = await store.FindConnectionAsync(query.WorkspaceId, token).ConfigureAwait(false);
        return Result.Success(new LinearConnectionResponse(connection?.ProtectedOAuthState is not null));
    }

    public async ValueTask<Result<LinearAuthorizationResponse>> HandleAsync(
        AuthorizeLinearConnection command, CancellationToken token)
    {
        if (!await permissions.CanManageWorkspaceAsync(command.WorkspaceId, token).ConfigureAwait(false))
        {
            return Result.Failure<LinearAuthorizationResponse>(LinearErrors.WorkspaceOwner());
        }

        var state = _state.Protect(WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32)));
        using var empty = JsonDocument.Parse("{}");
        var begun = await worker.ExecuteAsync(
            new("authorize", empty.RootElement, command.Callback.AbsoluteUri, State: state), token).ConfigureAwait(false);
        if (begun is not { Failure: null, OAuthState.ValueKind: JsonValueKind.Object }
            || !Uri.TryCreate(begun.AuthorizationUrl, UriKind.Absolute, out var destination)
            || destination.Scheme != Uri.UriSchemeHttps || destination.IdnHost != "mcp.linear.app"
            || !destination.IsDefaultPort || destination.UserInfo.Length != 0 || destination.Fragment.Length != 0)
        {
            return Result.Failure<LinearAuthorizationResponse>(LinearErrors.Unavailable());
        }

        var payload = new LinearPendingOAuth(
            begun.OAuthState, Nix.Authentication.ReturnToPath.Sanitize(command.ReturnTo, ReturnPath));
        var secured = _pending.Protect(JsonSerializer.Serialize(payload, LinearJsonContext.Default.LinearPendingOAuth));
        return await store.BeginOAuthAsync(command.WorkspaceId, BoundState(command.BrowserSessionId, state),
            secured, clock.GetUtcNow().AddMinutes(10), token).ConfigureAwait(false)
            ? Result.Success(new LinearAuthorizationResponse(destination.AbsoluteUri))
            : Result.Failure<LinearAuthorizationResponse>(LinearErrors.Ended());
    }

    public async ValueTask<Result<bool>> HandleAsync(DisconnectLinearConnection command, CancellationToken token)
    {
        if (!await permissions.CanManageWorkspaceAsync(command.WorkspaceId, token).ConfigureAwait(false))
        {
            return Result.Failure<bool>(LinearErrors.WorkspaceOwner());
        }

        await store.DisconnectAsync(command.WorkspaceId, token).ConfigureAwait(false);
        return Result.Success(true);
    }

    internal async Task<LinearOAuthAttempt?> ConsumeAsync(Guid browserId, string? state, CancellationToken token)
    {
        if (state is not { Length: > 0 and <= 768 })
        {
            return null;
        }

        try
        {
            _ = _state.Unprotect(state);
        }
        catch (CryptographicException)
        {
            return null;
        }

        return await store.ConsumeOAuthAsync(BoundState(browserId, state), clock.GetUtcNow(), token).ConfigureAwait(false);
    }

    internal async Task<string> CompleteAsync(
        LinearOAuthAttempt attempt, Uri callback, string? code, string? error, CancellationToken token)
    {
        LinearPendingOAuth? payload;
        try
        {
            payload = JsonSerializer.Deserialize(_pending.Unprotect(attempt.ProtectedOAuthState),
                LinearJsonContext.Default.LinearPendingOAuth);
        }
        catch (Exception failure) when (failure is CryptographicException or JsonException)
        {
            return Redirect(null, "failed");
        }

        if (payload is null || !await permissions.CanManageWorkspaceAsync(attempt.WorkspaceId, token).ConfigureAwait(false))
        {
            return Redirect(payload?.ReturnTo, "failed");
        }

        if (!string.IsNullOrEmpty(error))
        {
            return Redirect(payload.ReturnTo, "cancelled");
        }

        if (code is not { Length: > 0 and <= 4096 } || code.Any(char.IsControl))
        {
            return Redirect(payload.ReturnTo, "failed");
        }

        var result = await worker.ExecuteAsync(
            new("complete", payload.OAuthState, callback.AbsoluteUri, Code: code), token).ConfigureAwait(false);
        var completed = result is { Failure: null, OAuthState.ValueKind: JsonValueKind.Object }
            && await CanStillManageAsync(attempt, token).ConfigureAwait(false)
            && await store.CompleteOAuthAsync(attempt, ProtectCredential(result.OAuthState), token).ConfigureAwait(false);
        return Redirect(payload.ReturnTo, completed ? "connected" : "failed");
    }

    private Task<bool> CanStillManageAsync(LinearOAuthAttempt attempt, CancellationToken token) =>
        isolated.RunAsync(session.Current ?? throw new InvalidOperationException("An OAuth callback requires a unit of work."),
            async (services, ct) =>
            {
                var allowed = await services.GetRequiredService<IPermissionResolver>()
                    .CanManageWorkspaceAsync(attempt.WorkspaceId, ct).ConfigureAwait(false);
                return new IsolatedOutcome<bool>(allowed, Commit: false);
            }, token);

    internal string ProtectCredential(JsonElement state) => _credential.Protect(state.GetRawText());

    internal JsonElement ReadCredential(string protectedState)
    {
        using var json = JsonDocument.Parse(_credential.Unprotect(protectedState));
        return json.RootElement.Clone();
    }

    private static string BoundState(Guid browserId, string state) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes($"{browserId:D}:{state}")));
}
