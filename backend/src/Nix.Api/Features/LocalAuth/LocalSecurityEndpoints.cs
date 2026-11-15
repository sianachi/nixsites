using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Features.BrowserAuth;
using Nix.Http;

namespace Nix.Features.LocalAuth;

/// <summary>Settings > Security, the password and session part: summary, set or remove the password, sign out everywhere.</summary>
internal static class LocalSecurityEndpoints
{
    internal static IEndpointRouteBuilder MapLocalSecurityEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);
        var security = endpoints.MapGroup("/api/v1/me/security").WithTags("LocalSecurity").RequireAuthMode(AuthMode.Local);
        security.MapGet(string.Empty, Summary).WithName("GetLocalSecurity")
            .WithSummary("The caller's own sign-in methods");
        security.MapPost("/password", ChangePassword).WithName("SetLocalPassword")
            .WithSummary("Set or change the caller's password; other sessions are signed out")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        security.MapDelete("/password", RemovePassword).WithName("RemoveLocalPassword")
            .WithSummary("Remove the caller's password; only allowed while a passkey exists")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        security.MapPost("/sign-out-everywhere", SignOutEverywhere).WithName("SignOutEverywhere")
            .WithSummary("Ends every browser session of the caller, this one included")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        return endpoints;
    }

    private static async Task<IResult> Summary(
        HttpContext httpContext,
        [FromServices] LocalSecurityGuard guard,
        [FromServices] ILocalCredentials credentials,
        [FromServices] AuthSettings settings)
    {
        var (account, refusal) = await guard.ResolveAsync(httpContext).ConfigureAwait(false);
        if (account is null)
        {
            return refusal!;
        }

        var passkeys = await credentials.ListPasskeysAsync(account.PrincipalId, httpContext.RequestAborted).ConfigureAwait(false);
        return TypedResults.Ok(new LocalSecuritySummary(
            account.HasPassword,
            account.TotpEnabled,
            [.. passkeys.Select(static p => new LocalPasskeySummary(
                p.Id, p.Name, p.Kind == LocalPasskeyKind.Passkey ? "passkey" : "security_key", p.CreatedAt, p.LastUsedAt))],
            settings.PasskeyRpId));
    }

    private static async Task<IResult> ChangePassword(
        [FromBody] LocalChangePasswordRequest? request,
        HttpContext httpContext,
        [FromServices] LocalSecurityGuard guard,
        [FromServices] LocalReauth reauth,
        [FromServices] ILocalAccounts accounts,
        [FromServices] PasswordHasher hasher)
    {
        var (account, refusal) = await guard.ResolveAsync(httpContext).ConfigureAwait(false);
        if (account is null)
        {
            return refusal!;
        }

        var ct = httpContext.RequestAborted;
        var check = await reauth.CheckAsync(account, request?.CurrentPassword, ct).ConfigureAwait(false);
        if (!check.IsOk)
        {
            return LocalReauth.Refuse(httpContext, check);
        }

        if (!PasswordHasher.IsAcceptable(request?.NewPassword))
        {
            return LocalAuthEndpoints.PasswordRefusal(httpContext);
        }

        _ = await accounts.SetPasswordAsync(account.PrincipalId, hasher.Hash(request!.NewPassword!), changed: true, ct).ConfigureAwait(false);
        _ = await accounts.RevokeSessionsAsync(account.PrincipalId, guard.CurrentSession, ct).ConfigureAwait(false);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> RemovePassword(
        [FromBody(EmptyBodyBehavior = EmptyBodyBehavior.Allow)] LocalCurrentPasswordRequest? request,
        HttpContext httpContext,
        [FromServices] LocalSecurityGuard guard,
        [FromServices] LocalReauth reauth,
        [FromServices] ILocalAccounts accounts)
    {
        var (account, refusal) = await guard.ResolveAsync(httpContext).ConfigureAwait(false);
        if (account is null)
        {
            return refusal!;
        }

        var ct = httpContext.RequestAborted;
        var check = await reauth.CheckAsync(account, request?.CurrentPassword, ct).ConfigureAwait(false);
        if (!check.IsOk)
        {
            return LocalReauth.Refuse(httpContext, check);
        }

        // A password-less account with no passkey could never sign in again.
        if (account.PasskeyCount == 0)
        {
            return LocalAuthProblems.Refuse(
                httpContext,
                StatusCodes.Status409Conflict,
                "security.passkey_required",
                "Add a passkey first",
                "Removing the password would leave no way to sign in.");
        }

        _ = await accounts.SetPasswordAsync(account.PrincipalId, null, changed: true, ct).ConfigureAwait(false);
        _ = await accounts.RevokeSessionsAsync(account.PrincipalId, guard.CurrentSession, ct).ConfigureAwait(false);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> SignOutEverywhere(
        HttpContext httpContext,
        [FromServices] LocalSecurityGuard guard,
        [FromServices] ILocalAccounts accounts,
        [FromServices] BrowserAuthCoordinator coordinator)
    {
        var (account, refusal) = await guard.ResolveAsync(httpContext).ConfigureAwait(false);
        if (account is null)
        {
            return refusal!;
        }

        _ = await accounts.RevokeSessionsAsync(account.PrincipalId, null, httpContext.RequestAborted).ConfigureAwait(false);
        httpContext.Response.Cookies.Delete(coordinator.SessionCookieName, BrowserAuthEndpoints.Cookie(coordinator, "/", expiresAt: null));
        return TypedResults.NoContent();
    }
}
