using System.Globalization;
using System.Text.Json;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Errors;
using Nix.Http;

namespace Nix.Features.BrowserAuth;

/// <summary>Same-origin browser authentication backed by an opaque Core session cookie.</summary>
internal static class BrowserAuthEndpoints
{
    /// <summary>Per-address limiter on starting and completing an interactive sign-in.</summary>
    internal const string LoginPolicy = "browser-login";

    private const string LoginCookiePath = "/";

    /// <summary>Registers the interactive login, session, token and logout routes.</summary>
    internal static IEndpointRouteBuilder MapBrowserAuthEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var auth = endpoints.MapGroup("/auth").WithTags("BrowserAuth");
        auth.MapGet("/login", BeginLogin).RequireRateLimiting(LoginPolicy);
        auth.MapGet("/callback", CompleteLogin).RequireRateLimiting(LoginPolicy);
        auth.MapGet("/session", GetSession);
        auth.MapPost("/token", RefreshToken);
        auth.MapPost("/native/redeem", RedeemNative).WithRequestBodyLimit(2048).RequireRateLimiting(RateLimitRefusal.TokenExchangePolicyName);
        auth.MapPost("/logout", Logout);
        return endpoints;
    }

    private static async Task<Results<RedirectHttpResult, ProblemHttpResult>> BeginLogin(
        string? returnTo,
        string? native,
        HttpContext httpContext,
        [FromServices] BrowserAuthCoordinator coordinator)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        ArgumentNullException.ThrowIfNull(coordinator);
        SetNoStore(httpContext);

        if (native is not null && !NativeHandoffCoordinator.IsChallenge(native))
        {
            return Problem(httpContext, BrowserAuthFailure.InvalidState);
        }

        try
        {
            var start = await coordinator.BeginAsync(returnTo, httpContext.RequestAborted, native).ConfigureAwait(false);
            httpContext.Response.Cookies.Append(
                coordinator.LoginCookieName,
                start.ProtectedState,
                Cookie(coordinator, LoginCookiePath, start.ExpiresAt));
            return TypedResults.Redirect(start.RedirectUri.AbsoluteUri);
        }
        catch (BrowserAuthException exception)
        {
            return Problem(httpContext, exception.Failure);
        }
        catch (InvalidOperationException)
        {
            return Problem(httpContext, BrowserAuthFailure.InvalidProviderResponse);
        }
        catch (HttpRequestException)
        {
            return Problem(httpContext, BrowserAuthFailure.InvalidProviderResponse);
        }
    }

    private static async Task<Results<RedirectHttpResult, ProblemHttpResult>> CompleteLogin(
        string? code,
        string? state,
        string? error,
        HttpContext httpContext,
        [FromServices] BrowserAuthCoordinator coordinator,
        [FromServices] NativeHandoffCoordinator handoffs)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        ArgumentNullException.ThrowIfNull(coordinator);
        ArgumentNullException.ThrowIfNull(handoffs);
        SetNoStore(httpContext);

        var protectedState = httpContext.Request.Cookies[coordinator.LoginCookieName];
        httpContext.Response.Cookies.Delete(
            coordinator.LoginCookieName,
            Cookie(coordinator, LoginCookiePath, expiresAt: null));
        if (!string.IsNullOrEmpty(error)
            || string.IsNullOrWhiteSpace(code)
            || string.IsNullOrWhiteSpace(state)
            || string.IsNullOrWhiteSpace(protectedState))
        {
            return Problem(httpContext, BrowserAuthFailure.InvalidState);
        }

        try
        {
            var completed = await coordinator.CompleteAsync(
                code,
                state,
                protectedState,
                httpContext.RequestAborted).ConfigureAwait(false);
            if (completed.NativeChallenge is not null)
            {
                // The system sheet never receives the session: only a one-time code the app redeems with its verifier.
                var handoff = await handoffs.CreateAsync(completed, completed.NativeChallenge, httpContext.RequestAborted)
                    .ConfigureAwait(false);
                return handoff is null
                    ? Problem(httpContext, BrowserAuthFailure.HandoffBusy)
                    : TypedResults.Redirect(NativeHandoffCoordinator.CallbackUrl(handoff, coordinator.PublicOrigin));
            }

            httpContext.Response.Cookies.Append(
                coordinator.SessionCookieName,
                completed.CookieToken,
                Cookie(coordinator, "/", completed.ExpiresAt));
            return TypedResults.Redirect(completed.ReturnTo);
        }
        catch (BrowserAuthException exception)
        {
            return Problem(httpContext, exception.Failure);
        }
        catch (UserInfoUnavailableException)
        {
            return Problem(httpContext, BrowserAuthFailure.InvalidProviderResponse);
        }
        catch (HttpRequestException)
        {
            return Problem(httpContext, BrowserAuthFailure.TokenExchangeFailed);
        }
        catch (InvalidOperationException)
        {
            return Problem(httpContext, BrowserAuthFailure.ProvisioningFailed);
        }
    }

    private static async Task<Ok<BrowserSessionResponse>> GetSession(
        HttpContext httpContext,
        [FromServices] BrowserAuthCoordinator coordinator,
        [FromServices] SelfIssuedTokenService tokens)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        ArgumentNullException.ThrowIfNull(coordinator);
        ArgumentNullException.ThrowIfNull(tokens);
        SetNoStore(httpContext);

        var session = await ResolveAsync(httpContext, coordinator).ConfigureAwait(false);
        if (session is null)
        {
            return TypedResults.Ok(BrowserSessionResponse.Anonymous(coordinator.IsConfigured));
        }

        return TypedResults.Ok(BrowserSessionResponse.SignedIn(
            new BrowserProfileResponse(
                session.PrincipalId.Value.ToString("D", CultureInfo.InvariantCulture),
                session.DisplayName),
            coordinator.MintAccessToken(session),
            tokens.Clock.GetUtcNow() + tokens.Lifetime,
            coordinator.AccountPage?.AbsoluteUri));
    }

    private static async Task<Results<Ok<BrowserTokenResponse>, ProblemHttpResult>> RefreshToken(
        HttpContext httpContext,
        [FromServices] BrowserAuthCoordinator coordinator,
        [FromServices] SelfIssuedTokenService tokens)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        ArgumentNullException.ThrowIfNull(coordinator);
        ArgumentNullException.ThrowIfNull(tokens);
        SetNoStore(httpContext);

        if (!HasSameOrigin(httpContext, coordinator))
        {
            return CsrfProblem(httpContext);
        }

        var session = await ResolveAsync(httpContext, coordinator).ConfigureAwait(false);
        if (session is null)
        {
            return AuthenticationProblem(httpContext);
        }

        var expiresAt = tokens.Clock.GetUtcNow() + tokens.Lifetime;
        return TypedResults.Ok(new BrowserTokenResponse(coordinator.MintAccessToken(session), expiresAt));
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> RedeemNative(
        HttpContext httpContext,
        [FromServices] BrowserAuthCoordinator coordinator,
        [FromServices] NativeHandoffCoordinator handoffs)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        ArgumentNullException.ThrowIfNull(coordinator);
        ArgumentNullException.ThrowIfNull(handoffs);
        SetNoStore(httpContext);

        if (!HasSameOrigin(httpContext, coordinator))
        {
            return CsrfProblem(httpContext);
        }

        NativeRedeemRequest? request;
        try
        {
            request = await httpContext.Request.ReadFromJsonAsync<NativeRedeemRequest>(httpContext.RequestAborted).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is JsonException or InvalidOperationException or BadHttpRequestException)
        {
            request = null;
        }

        // Every refusal is the same answer, so a caller cannot tell an unknown, used or expired code from a bad verifier.
        var session = await handoffs.RedeemAsync(request?.Code, request?.Verifier, httpContext.RequestAborted).ConfigureAwait(false);
        if (session is not { } redeemed)
        {
            return TypedResults.Problem(ApiProblem.Create(
                httpContext,
                StatusCodes.Status400BadRequest,
                "invalid_handoff",
                "Sign-in handoff refused",
                "The sign-in handoff is invalid or has expired."));
        }

        httpContext.Response.Cookies.Append(
            coordinator.SessionCookieName,
            redeemed.CookieToken,
            Cookie(coordinator, "/", redeemed.ExpiresAt));
        return TypedResults.NoContent();
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> Logout(
        HttpContext httpContext,
        [FromServices] BrowserAuthCoordinator coordinator)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        ArgumentNullException.ThrowIfNull(coordinator);
        SetNoStore(httpContext);

        if (!HasSameOrigin(httpContext, coordinator))
        {
            return CsrfProblem(httpContext);
        }

        var session = await ResolveAsync(httpContext, coordinator).ConfigureAwait(false);
        if (session is not null)
        {
            await coordinator.RevokeAsync(session, httpContext.RequestAborted).ConfigureAwait(false);
        }

        httpContext.Response.Cookies.Delete(
            coordinator.SessionCookieName,
            Cookie(coordinator, "/", expiresAt: null));
        return TypedResults.NoContent();
    }

    private static ValueTask<AuthenticatedBrowserSession?> ResolveAsync(
        HttpContext context,
        BrowserAuthCoordinator coordinator) => coordinator.ResolveAsync(
            context.Request.Cookies[coordinator.SessionCookieName],
            context.RequestAborted);

    private static CookieOptions Cookie(
        BrowserAuthCoordinator coordinator,
        string path,
        DateTimeOffset? expiresAt) => new()
        {
            HttpOnly = true,
            Secure = coordinator.SecureCookies,
            SameSite = SameSiteMode.Lax,
            Path = path,
            Expires = expiresAt,
            IsEssential = true,
        };

    private static bool HasSameOrigin(HttpContext context, BrowserAuthCoordinator coordinator)
    {
        var expected = coordinator.PublicOrigin;
        var supplied = context.Request.Headers.Origin.ToString();
        return expected is not null
            && Uri.TryCreate(supplied, UriKind.Absolute, out var origin)
            && string.IsNullOrEmpty(origin.UserInfo)
            && string.IsNullOrEmpty(origin.Query)
            && string.IsNullOrEmpty(origin.Fragment)
            && origin.AbsolutePath == "/"
            && string.Equals(origin.Scheme, expected.Scheme, StringComparison.OrdinalIgnoreCase)
            && string.Equals(origin.IdnHost, expected.IdnHost, StringComparison.OrdinalIgnoreCase)
            && origin.Port == expected.Port;
    }

    private static void SetNoStore(HttpContext context)
    {
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.Pragma = "no-cache";
    }

    private static ProblemHttpResult CsrfProblem(HttpContext context) => TypedResults.Problem(ApiProblem.Create(
        context,
        StatusCodes.Status403Forbidden,
        "auth.cross_origin_refused",
        "Cross-origin request refused",
        "This browser-session operation must originate from the configured Nix origin."));

    private static ProblemHttpResult AuthenticationProblem(HttpContext context) => TypedResults.Problem(
        ApiProblem.Create(
            context,
            StatusCodes.Status401Unauthorized,
            AuthenticationRefusalCodes.Unauthenticated,
            "Not authenticated",
            "No active browser session was presented."));

    private static ProblemHttpResult Problem(HttpContext context, BrowserAuthFailure failure)
    {
        var (status, code, title, detail) = failure switch
        {
            BrowserAuthFailure.NotConfigured => (
                StatusCodes.Status503ServiceUnavailable,
                "auth.browser_not_configured",
                "Browser sign-in is not configured",
                "This deployment cannot start an interactive sign-in."),
            BrowserAuthFailure.JitDisabled => (
                StatusCodes.Status403Forbidden,
                "auth.jit_disabled",
                "First sign-in is disabled",
                "This identity provider does not allow first-sign-in provisioning."),
            BrowserAuthFailure.PrincipalInactive => (
                StatusCodes.Status403Forbidden,
                AuthenticationRefusalCodes.PrincipalInactive,
                "Account is not active",
                "This account has been suspended or deprovisioned."),
            BrowserAuthFailure.ProviderNotRegistered => (
                StatusCodes.Status403Forbidden,
                "auth.provider_not_registered",
                "Identity provider not registered",
                "This interactive client is not registered for Nix."),
            BrowserAuthFailure.UserInfoNotConfigured => (
                StatusCodes.Status503ServiceUnavailable,
                "auth.userinfo_not_configured",
                "User profile lookup is not configured",
                "The registered identity provider has no UserInfo endpoint."),
            BrowserAuthFailure.ProvisioningFailed => (
                StatusCodes.Status503ServiceUnavailable,
                "auth.provisioning_unavailable",
                "Sign-in could not be completed",
                "The local account and workspace could not be prepared. Try again."),
            BrowserAuthFailure.HandoffBusy => (
                StatusCodes.Status429TooManyRequests,
                "auth.handoff_busy",
                "Too many app sign-ins are waiting",
                "Finish or close an earlier sign-in in the app, or wait a minute, then try again."),
            BrowserAuthFailure.TokenExchangeFailed or BrowserAuthFailure.InvalidProviderResponse => (
                StatusCodes.Status502BadGateway,
                "auth.provider_unavailable",
                "Identity provider response was refused",
                "The identity provider did not complete a valid sign-in. Try again."),
            _ => (
                StatusCodes.Status400BadRequest,
                "auth.invalid_callback",
                "Sign-in could not be completed",
                "The sign-in transaction is missing, expired or invalid."),
        };

        return TypedResults.Problem(ApiProblem.Create(context, status, code, title, detail));
    }
}

/// <summary>The browser's non-secret authenticated profile.</summary>
public sealed record BrowserProfileResponse(string Subject, string Name);

/// <summary>The result of restoring the HttpOnly browser session.</summary>
internal sealed record BrowserSessionResponse(
    bool Authenticated,
    bool Configured,
    BrowserProfileResponse? Profile,
    string? AccessToken,
    DateTimeOffset? ExpiresAt,
    string? AccountUrl)
{
    internal static BrowserSessionResponse Anonymous(bool configured) =>
        new(false, configured, null, null, null, null);

    internal static BrowserSessionResponse SignedIn(
        BrowserProfileResponse profile,
        string accessToken,
        DateTimeOffset expiresAt,
        string? accountUrl) => new(true, true, profile, accessToken, expiresAt, accountUrl);
}

/// <summary>A renewed short-lived Core bearer token.</summary>
internal sealed record BrowserTokenResponse(string AccessToken, DateTimeOffset ExpiresAt);
