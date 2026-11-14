using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Identity;
using Nix.Domain.Primitives;
using Nix.Errors;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.Tokens;

/// <summary>
/// Route registration for personal access tokens: minted, listed and revoked by their own
/// principal, under <c>/me</c>.
/// </summary>
/// <remarks>
/// <para>
/// Under <c>/me</c> because a token is personal state, like the shelf and the canvas library: it
/// belongs to the caller and no request can ask for somebody else's. There is deliberately no
/// admin surface over other people's tokens in this phase - deprovisioning a principal already
/// ends every token they issued, because the request pipeline re-resolves the principal per
/// request, and that is the control an administrator actually reaches for.
/// </para>
/// <para>
/// These routes are the ones a token itself can never call: see
/// <c>AccessTokenScopePolicy</c>, which refuses token-authenticated sessions here outright. A
/// credential that could mint credentials would make every ceiling on it advisory.
/// </para>
/// </remarks>
internal static class TokenEndpoints
{
    /// <summary>
    /// Registers the token feature's routes on <paramref name="endpoints"/>.
    /// </summary>
    internal static IEndpointRouteBuilder MapTokenEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var tokens = endpoints.MapGroup("/api/v1/me/tokens").WithTags("AccessTokens");

        tokens.MapGet(string.Empty, ListTokensEndpoint.Handle)
            .WithName("ListAccessTokens")
            .WithSummary("The caller's personal access tokens")
            .WithDescription(
                "Returns every token the calling principal has issued, newest first, revoked and "
                + "expired ones included: the list is an audit of what has been able to act as "
                + "this principal, and an audit that forgets is not one. The secret is never "
                + "here - it was shown once, at creation, and only its hash is stored.")
            .Produces<AccessTokenListResponse>(StatusCodes.Status200OK);

        tokens.MapPost(string.Empty, CreateTokenEndpoint.Handle)
            .WithName("CreateAccessToken")
            .WithSummary("Mint a personal access token")
            .WithDescription(
                "Mints a token that authenticates a non-browser client as the calling principal, "
                + "within the ceiling the request chooses: scopes from 'read', 'write' and "
                + "'admin', and an expiry of 1 to 365 days - both required, neither defaulted. "
                + "The response is the only place the secret ever appears; store it or lose it. "
                + "A token only narrows: every request it authenticates still resolves the "
                + "principal's own permissions, so it can never do what its issuer cannot. Fails "
                + "with 'tokens.invalid' when the name, scopes or expiry cannot mint a token, and "
                + "'tokens.limit_reached' when the caller already holds the most live tokens one "
                + "principal may.")
            .Produces<CreatedAccessTokenResponse>(StatusCodes.Status201Created)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        tokens.MapDelete("/{tokenId:guid}", RevokeTokenEndpoint.Handle)
            .WithName("RevokeAccessToken")
            .WithSummary("Revoke a personal access token")
            .WithDescription(
                "Ends a token immediately: the next request it would have authenticated is "
                + "refused, without waiting out any session already exchanged. Idempotent, and "
                + "scoped to the caller's own tokens - revoking one twice, one that never "
                + "existed, and one belonging to somebody else all answer 204, because telling "
                + "them apart would answer, for any identifier, whether it names a row.")
            .Produces(StatusCodes.Status204NoContent)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        tokens.MapPost("/{tokenId:guid}/rotate", RotateTokenEndpoint.Handle)
            .WithName("RotateAccessToken")
            .WithSummary("Rotate a personal access token")
            .WithDescription(
                "Keeps the token's identity, name and scopes but issues a new secret, shown in "
                + "this response only. The old secret stops working immediately. The expiry "
                + "restarts from now with the token's original lifetime, capped at 365 days. "
                + "Fails with 'tokens.not_found' when the token is not the caller's, and "
                + "'tokens.not_rotatable' when it is revoked or expired.")
            .Produces<CreatedAccessTokenResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        return endpoints;
    }

    /// <summary>Projects a row onto the wire shape shared by the list and the create response.</summary>
    /// <param name="row">The stored row.</param>
    /// <returns>The response.</returns>
    internal static AccessTokenResponse ToResponse(PersonalAccessToken row)
    {
        ArgumentNullException.ThrowIfNull(row);

        return new AccessTokenResponse(
            row.Id.Value,
            row.Name,
            row.Scopes,
            row.CreatedAt,
            row.ExpiresAt,
            row.RevokedAt,
            row.LastUsedAt);
    }
}

/// <summary>Route handler for listing the caller's tokens.</summary>
internal static class ListTokensEndpoint
{
    /// <summary>Handles a list request.</summary>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the query to its handler.</param>
    /// <returns>The caller's tokens.</returns>
    internal static async Task<Ok<AccessTokenListResponse>> Handle(
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        ArgumentNullException.ThrowIfNull(dispatcher);

        var result = await dispatcher
            .QueryAsync<ListAccessTokens, Result<IReadOnlyList<PersonalAccessToken>>>(
                new ListAccessTokens(),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        var rows = result.Value;
        var responses = new AccessTokenResponse[rows.Count];
        for (var index = 0; index < rows.Count; index++)
        {
            responses[index] = TokenEndpoints.ToResponse(rows[index]);
        }

        return TypedResults.Ok(new AccessTokenListResponse(responses));
    }
}

/// <summary>Route handler for minting a token.</summary>
internal static class CreateTokenEndpoint
{
    /// <summary>Handles a mint request.</summary>
    /// <param name="request">What was asked for.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the command to its handler.</param>
    /// <returns>The minted token, or why there is none.</returns>
    internal static async Task<Results<Created<CreatedAccessTokenResponse>, ProblemHttpResult>> Handle(
        CreateAccessTokenRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(httpContext);
        ArgumentNullException.ThrowIfNull(dispatcher);

        var result = await dispatcher
            .SendAsync<CreateAccessToken, IssuedAccessToken>(
                new CreateAccessToken(request.Name, request.Scopes, request.ExpiresInDays),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.Match<Results<Created<CreatedAccessTokenResponse>, ProblemHttpResult>>(
            issued => TypedResults.Created(
                "/api/v1/me/tokens",
                new CreatedAccessTokenResponse(issued.Secret, TokenEndpoints.ToResponse(issued.Row))),
            error => TypedResults.Problem(Problem(httpContext, error)));
    }

    private static Microsoft.AspNetCore.Mvc.ProblemDetails Problem(HttpContext httpContext, NixError error)
    {
        var status = error.Code switch
        {
            TokenErrors.LimitReachedCode => StatusCodes.Status409Conflict,
            _ => StatusCodes.Status422UnprocessableEntity,
        };

        return ApiProblem.Create(httpContext, status, error.Code, "Request refused", error.Message);
    }
}

/// <summary>Route handler for revoking a token.</summary>
internal static class RevokeTokenEndpoint
{
    /// <summary>Handles a revocation.</summary>
    /// <param name="tokenId">The token to revoke.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the command to its handler.</param>
    /// <returns>No content.</returns>
    internal static async Task<NoContent> Handle(
        Guid tokenId,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        ArgumentNullException.ThrowIfNull(dispatcher);

        await dispatcher
            .SendAsync<RevokeAccessToken, bool>(
                new RevokeAccessToken(PersonalAccessTokenId.From(tokenId)),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        // The same answer whether a row was revoked, was already revoked, or was never the
        // caller's. See the endpoint description: distinguishing them would turn this into a
        // probe for whether an identifier names anything.
        return TypedResults.NoContent();
    }
}

/// <summary>Route handler for rotating a token.</summary>
internal static class RotateTokenEndpoint
{
    /// <summary>Handles a rotation.</summary>
    /// <param name="tokenId">The token to rotate.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the command to its handler.</param>
    /// <returns>The token with its new secret, or why there is none.</returns>
    internal static async Task<Results<Ok<CreatedAccessTokenResponse>, ProblemHttpResult>> Handle(
        Guid tokenId,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        ArgumentNullException.ThrowIfNull(dispatcher);

        var result = await dispatcher
            .SendAsync<RotateAccessToken, IssuedAccessToken>(
                new RotateAccessToken(PersonalAccessTokenId.From(tokenId)),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.Match<Results<Ok<CreatedAccessTokenResponse>, ProblemHttpResult>>(
            issued => TypedResults.Ok(
                new CreatedAccessTokenResponse(issued.Secret, TokenEndpoints.ToResponse(issued.Row))),
            error => TypedResults.Problem(ApiProblem.Create(
                httpContext,
                error.Code == TokenErrors.NotFoundCode
                    ? StatusCodes.Status404NotFound
                    : StatusCodes.Status409Conflict,
                error.Code,
                "Request refused",
                error.Message)));
    }
}
