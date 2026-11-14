using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Errors;
using Nix.Http;

namespace Nix.Features.Tokens;

/// <summary>
/// The two unauthenticated routes that make personal access tokens work everywhere: the exchange
/// that turns one into a short-lived JWT, and the key set other services validate that JWT with.
/// </summary>
/// <remarks>
/// <para>
/// Mounted under <c>/public/v1</c>, outside the unit-of-work branch, like the public form routes
/// and for the same reason: the caller has no session yet - a session is what they are here to
/// buy. The one lookup this needs runs through a security-definer function with the same
/// constraints as the two on <see cref="IIdentityDirectory"/>: exact match, at most one row, no
/// listing.
/// </para>
/// <para>
/// <b>The token itself stops here.</b> Everything past this endpoint - Core's API, the
/// collaboration service and delegated worker boundary sees only the minted JWT, validated the way every
/// other issuer's tokens are validated. That is what makes revocation a Core-side fact and keeps
/// the services that never see a database out of the credential's blast radius.
/// </para>
/// <para>
/// Guessing is met the way sign-in guessing is met: a presented token that fails counts against
/// the per-address failed-authentication throttle, and the endpoint carries its own fixed-window
/// limit besides, so even valid exchanges cannot become a signing treadmill.
/// </para>
/// </remarks>
internal static class TokenExchangeEndpoints
{
    /// <summary>Stable code for an exchange refused because no signing key is configured.</summary>
    internal const string ExchangeUnconfiguredCode = "auth.exchange_unconfigured";

    /// <summary>
    /// Registers the exchange and key-set routes on <paramref name="endpoints"/>.
    /// </summary>
    internal static IEndpointRouteBuilder MapTokenExchangeEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var auth = endpoints.MapGroup("/public/v1/auth").WithTags("AccessTokens");

        auth.MapPost("/token", ExchangeEndpoint.Handle)
            .WithName("ExchangeAccessToken")
            .WithSummary("Exchange a personal access token for a short-lived session")
            .WithDescription(
                "Turns a personal access token into a JWT that every Nix service accepts as a "
                + "bearer token, for a few minutes. Exchange again before it runs out - the "
                + "personal access token lives until its chosen expiry or its revocation, and "
                + "revocation does not wait for an exchanged session to expire: every request is "
                + "re-checked against the token row. Fails with 'auth.unauthenticated' for a "
                + "token that does not authenticate, 'auth.token_revoked' and "
                + "'auth.token_expired' for one that did and no longer does, and "
                + "'auth.principal_inactive' when the principal behind it may no longer act.")
            .Produces<TokenExchangeResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .RequireRateLimiting(RateLimitRefusal.TokenExchangePolicyName);

        auth.MapGet("/jwks", JwksEndpoint.Handle)
            .WithName("GetAccessTokenSigningKeys")
            .WithSummary("The public keys exchanged sessions are signed with")
            .WithDescription(
                "An RFC 7517 key set. Collaboration lists Core's issuer "
                + "beside the identity providers they already trust and fetch its keys here; an "
                + "empty set means no key is configured and nothing signed by this issuer should "
                + "validate.")
            .Produces<JwksResponse>(StatusCodes.Status200OK);

        return endpoints;
    }
}

/// <summary>Route handler for the exchange.</summary>
internal static class ExchangeEndpoint
{
    /// <summary>Handles an exchange.</summary>
    /// <param name="request">The presented token.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="tokens">The pre-authentication lookup.</param>
    /// <param name="minter">Signs the session.</param>
    /// <param name="throttle">Counts failed presentations per client, so guessing meets a 429.</param>
    /// <returns>The session, or why there is none.</returns>
    internal static async Task<Results<Ok<TokenExchangeResponse>, ProblemHttpResult>> Handle(
        TokenExchangeRequest request,
        HttpContext httpContext,
        [FromServices] IPersonalAccessTokens tokens,
        [FromServices] SelfIssuedTokenService minter,
        [FromServices] FailedAuthenticationThrottle throttle)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(httpContext);
        ArgumentNullException.ThrowIfNull(tokens);
        ArgumentNullException.ThrowIfNull(minter);
        ArgumentNullException.ThrowIfNull(throttle);

        if (!minter.IsConfigured)
        {
            // Says which key is missing rather than pretending the token was wrong: this is an
            // operator's problem, and a client retrying a correct token against it forever is
            // the dishonest alternative.
            return Problem(
                httpContext,
                StatusCodes.Status503ServiceUnavailable,
                TokenExchangeEndpoints.ExchangeUnconfiguredCode,
                "Token exchange not configured",
                $"This deployment has no {SelfIssuedTokenService.SigningKeyConfigurationKey} "
                + "configured, so personal access tokens cannot buy sessions.");
        }

        var clientKey = ClientKey.For(httpContext);
        if (throttle.IsThrottled(clientKey, out var retryAfter))
        {
            // The same refusal the unit-of-work middleware gives a throttled address, as a typed
            // result rather than a hand-written response, because this is an endpoint and the
            // pipeline owns the write.
            httpContext.Response.Headers.RetryAfter =
                Math.Max(1L, (long)Math.Ceiling(retryAfter.TotalSeconds))
                    .ToString(System.Globalization.CultureInfo.InvariantCulture);
            return Problem(
                httpContext,
                StatusCodes.Status429TooManyRequests,
                RateLimitRefusal.Code,
                "Too many requests",
                "Too many failed authentications from this address. Wait before retrying.");
        }

        // Shape check, candidate lookup, then the constant-time hash comparison. All three
        // refusals are the same answer - a guessed token learns nothing about which part of it
        // was wrong - and all three count against the throttle, because each was a guess.
        if (!PersonalAccessTokenSecret.TryReadLookup(request.Token, out var lookup))
        {
            return Refused(httpContext, throttle, clientKey);
        }

        var candidate = await tokens
            .FindForExchangeAsync(lookup, httpContext.RequestAborted)
            .ConfigureAwait(false);

        if (candidate is null || !PersonalAccessTokenSecret.Matches(candidate.SecretHash, request.Token!))
        {
            return Refused(httpContext, throttle, clientKey);
        }

        // Past here the caller has proven possession, so the refusals are specific: telling the
        // holder of a revoked token that it is revoked discloses nothing and is the honest
        // answer - MVP-9.4's rule applies to this surface like any other.
        if (candidate.RevokedAt is { } revokedAt)
        {
            return Problem(
                httpContext,
                StatusCodes.Status401Unauthorized,
                AuthenticationRefusalCodes.TokenRevoked,
                "Access token revoked",
                $"Personal access token '{candidate.Id}' was revoked at {revokedAt:O}.");
        }

        var now = minter.Clock.GetUtcNow();
        if (candidate.ExpiresAt <= now)
        {
            return Problem(
                httpContext,
                StatusCodes.Status401Unauthorized,
                AuthenticationRefusalCodes.TokenExpired,
                "Access token expired",
                $"Personal access token '{candidate.Id}' expired at {candidate.ExpiresAt:O}.");
        }

        if (candidate.PrincipalStatus != PrincipalStatus.Active)
        {
            return Problem(
                httpContext,
                StatusCodes.Status403Forbidden,
                AuthenticationRefusalCodes.PrincipalInactive,
                "Account is not active",
                "The principal this token acts as has been suspended or deprovisioned.");
        }

        var session = minter.Mint(candidate.PrincipalId, candidate.TenantId, candidate.Id, lookup);
        return TypedResults.Ok(new TokenExchangeResponse(
            session,
            "Bearer",
            (long)minter.Lifetime.TotalSeconds));
    }

    private static Results<Ok<TokenExchangeResponse>, ProblemHttpResult> Refused(
        HttpContext httpContext,
        FailedAuthenticationThrottle throttle,
        System.Net.IPAddress clientKey)
    {
        throttle.RecordFailure(clientKey);
        return Problem(
            httpContext,
            StatusCodes.Status401Unauthorized,
            AuthenticationRefusalCodes.Unauthenticated,
            "Not authenticated",
            "The presented value is not a personal access token that authenticates.");
    }

    private static Results<Ok<TokenExchangeResponse>, ProblemHttpResult> Problem(
        HttpContext httpContext,
        int status,
        string code,
        string title,
        string detail) =>
        TypedResults.Problem(ApiProblem.Create(httpContext, status, code, title, detail));
}

/// <summary>Route handler for the key set.</summary>
internal static class JwksEndpoint
{
    /// <summary>Handles a key-set request.</summary>
    /// <param name="httpContext">The current request.</param>
    /// <param name="minter">Describes its public key.</param>
    /// <returns>The key set.</returns>
    internal static Ok<JwksResponse> Handle(
        HttpContext httpContext,
        [FromServices] SelfIssuedTokenService minter)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        ArgumentNullException.ThrowIfNull(minter);

        // Cacheable for a few minutes: validators poll key sets, the key rotates rarely, and the
        // validator side already tolerates staleness by design (its own cache and refetch floor).
        httpContext.Response.Headers.CacheControl = "public, max-age=300";
        return TypedResults.Ok(minter.DescribePublicKeys());
    }
}
