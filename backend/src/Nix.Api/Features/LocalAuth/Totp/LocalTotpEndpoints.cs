using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Features.BrowserAuth;
using Nix.Http;

namespace Nix.Features.LocalAuth;

/// <summary>The code a person types for the second step.</summary>
internal sealed record LocalTotpStepRequest(Guid ChallengeId, string? Code);

/// <summary>The code that proves a new authenticator app works.</summary>
internal sealed record LocalTotpConfirmRequest(string? Code);

/// <summary>A new, still unconfirmed secret.</summary>
internal sealed record LocalTotpEnrolResponse(string Secret, string OtpauthUri);

/// <summary>Source-generated JSON metadata for authenticator codes.</summary>
[JsonSerializable(typeof(LocalTotpStepRequest))]
[JsonSerializable(typeof(LocalTotpConfirmRequest))]
[JsonSerializable(typeof(LocalTotpEnrolResponse))]
internal sealed partial class LocalTotpJsonContext : JsonSerializerContext;

/// <summary>Authenticator-app routes: the second step at sign-in and enrolment in Settings > Security.</summary>
internal static class LocalTotpEndpoints
{
    internal static IEndpointRouteBuilder MapLocalTotpSignInEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);
        endpoints.MapPost("/auth/local/second-step/totp", SecondStep)
            .WithTags("LocalAuth").WithName("LocalSecondStepTotp")
            .RequireAuthMode(AuthMode.Local)
            .RequireRateLimiting(BrowserAuthEndpoints.LoginPolicy)
            .WithRequestBodyLimit(1024);
        return endpoints;
    }

    internal static IEndpointRouteBuilder MapLocalTotpSecurityEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);
        var security = endpoints.MapGroup("/api/v1/me/security/totp").WithTags("LocalSecurity").RequireAuthMode(AuthMode.Local);
        security.MapPost(string.Empty, Enrol).WithName("EnrolLocalTotp")
            .WithSummary("Start an authenticator app; returns a secret that does nothing until confirmed")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        security.MapPost("/confirm", Confirm).WithName("ConfirmLocalTotp")
            .WithSummary("Turn the authenticator app on with its first code")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        security.MapDelete(string.Empty, Remove).WithName("RemoveLocalTotp")
            .WithSummary("Remove the authenticator app")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        return endpoints;
    }

    private static async Task<IResult> SecondStep(
        [FromBody] LocalTotpStepRequest? request,
        HttpContext httpContext,
        [FromServices] BrowserAuthCoordinator coordinator,
        [FromServices] LocalTotpSecondStep totp,
        [FromServices] LocalSignInCompleter completer)
    {
        BrowserAuthEndpoints.SetNoStore(httpContext);
        if (!BrowserAuthEndpoints.HasSameOrigin(httpContext, coordinator))
        {
            return BrowserAuthEndpoints.CsrfProblem(httpContext);
        }

        var outcome = request is null
            ? new TotpAttemptOutcome(TotpAttemptKind.Invalid)
            : await totp.CheckAsync(request.ChallengeId, request.Code, httpContext.RequestAborted).ConfigureAwait(false);
        return outcome.Kind switch
        {
            TotpAttemptKind.Accepted => await completer.CompleteAsync(httpContext, outcome.PrincipalId!.Value, outcome.ReturnTo, outcome.Native).ConfigureAwait(false),
            TotpAttemptKind.Paused => LocalAuthProblems.Paused(httpContext, outcome.RetryAfter),
            _ => LocalAuthProblems.InvalidCredentials(httpContext),
        };
    }

    private static async Task<IResult> Enrol(
        [FromBody(EmptyBodyBehavior = EmptyBodyBehavior.Allow)] LocalCurrentPasswordRequest? request,
        HttpContext httpContext,
        [FromServices] LocalSecurityGuard guard,
        [FromServices] LocalReauth reauth,
        [FromServices] ILocalCredentials credentials)
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

        // Replacing a working app in one step would silently drop the second factor if the new one is never confirmed.
        if (account.TotpEnabled)
        {
            return LocalAuthProblems.Refuse(
                httpContext,
                StatusCodes.Status409Conflict,
                "security.totp_exists",
                "An authenticator app is already set up",
                "Remove it first, then add the new one.");
        }

        var secret = LocalTotp.NewSecret();
        if (!await credentials.SetPendingTotpAsync(account.PrincipalId, secret, ct).ConfigureAwait(false))
        {
            return TypedResults.NotFound();
        }

        return TypedResults.Ok(new LocalTotpEnrolResponse(LocalTotp.ToBase32(secret), LocalTotp.OtpAuthLink(account.Email, secret)));
    }

    private static async Task<IResult> Confirm(
        [FromBody] LocalTotpConfirmRequest? request,
        HttpContext httpContext,
        [FromServices] LocalSecurityGuard guard,
        [FromServices] ILocalCredentials credentials,
        [FromServices] TimeProvider clock)
    {
        var (account, refusal) = await guard.ResolveAsync(httpContext).ConfigureAwait(false);
        if (account is null)
        {
            return refusal!;
        }

        var ct = httpContext.RequestAborted;
        var pending = await credentials.GetTotpAsync(account.PrincipalId, ct).ConfigureAwait(false);
        if (pending is not { ConfirmedAt: null }
            || LocalTotp.Match(pending.Secret.Span, request?.Code, clock.GetUtcNow()) is not { } step
            || !await credentials.ConfirmTotpAsync(account.PrincipalId, step, ct).ConfigureAwait(false))
        {
            return LocalAuthProblems.Invalid(httpContext, "invalid_code", "That code did not match. Check the app and try again.");
        }

        return TypedResults.NoContent();
    }

    private static async Task<IResult> Remove(
        [FromBody(EmptyBodyBehavior = EmptyBodyBehavior.Allow)] LocalCurrentPasswordRequest? request,
        HttpContext httpContext,
        [FromServices] LocalSecurityGuard guard,
        [FromServices] LocalReauth reauth,
        [FromServices] ILocalCredentials credentials)
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

        _ = await credentials.RemoveTotpAsync(account.PrincipalId, ct).ConfigureAwait(false);
        return TypedResults.NoContent();
    }
}
