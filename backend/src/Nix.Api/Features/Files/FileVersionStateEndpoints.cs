using Nix.Abstractions.Files;
using Nix.Errors;
using Nix.Http;

namespace Nix.Features.Files;

/// <summary>Moves one file version to a lifecycle state: draft, in_review, approved or revoked.</summary>
public sealed record SetFileVersionStateRequest(string State);

/// <summary>Lane 1 stub: file version state. Replace the handler; keep the route and types.</summary>
internal static class FileVersionStateEndpoints
{
    internal static IEndpointRouteBuilder MapFileVersionStateEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        endpoints.MapPut(
                "/api/v1/items/{itemId:guid}/file/versions/{versionId:guid}/state",
                (Guid itemId, Guid versionId, SetFileVersionStateRequest request, HttpContext context) =>
                    TypedResults.Problem(ApiProblem.Create(
                        context,
                        StatusCodes.Status501NotImplemented,
                        "files.not_implemented",
                        "Not implemented",
                        "This route is not implemented yet.")))
            .WithTags("Files")
            .WithName("SetFileVersionState")
            .Produces<FileVersionRecord>()
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        return endpoints;
    }
}
