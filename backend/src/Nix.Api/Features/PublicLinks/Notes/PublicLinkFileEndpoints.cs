using Nix.Errors;
using Nix.Http;

namespace Nix.Features.PublicLinks.Notes;

/// <summary>
/// Lane 7 stub: a file embedded in a note's public link. When implemented it answers 302 to a
/// 60-second signed URL with <c>Cache-Control: no-store</c>, so an <c>img</c> or <c>a</c> in the
/// rendered note can point at it. Replace the handler; keep the route.
/// </summary>
internal static class PublicLinkFileEndpoints
{
    internal static IEndpointRouteBuilder MapPublicLinkFileEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        endpoints.MapGet(
                "/public/v1/links/{token}/files/{fileItemId:guid}",
                (string token, Guid fileItemId, HttpContext context) => TypedResults.Problem(ApiProblem.Create(
                    context,
                    StatusCodes.Status501NotImplemented,
                    "public_links.not_implemented",
                    "Not implemented",
                    "This route is not implemented yet.")))
            .WithTags("PublicLinks")
            .WithName("GetPublicLinkFile")
            .Produces(StatusCodes.Status302Found)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .RequireRateLimiting(RateLimitRefusal.PublicLinksPolicyName);
        return endpoints;
    }
}
