using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions.Files;
using Nix.Domain.Files;
using Nix.Domain.Items;
using Nix.Errors;
using Nix.Http;

namespace Nix.Features.Files;

/// <summary>Moves one file version to a lifecycle state: draft, in_review, approved or revoked.</summary>
public sealed record SetFileVersionStateRequest(string State);

/// <summary>
/// [SEC] Draft to in_review or approved, in_review to approved or back to draft, approved to revoked.
/// Approving and revoking are held to the workspace's agent policy; revoking never changes bytes.
/// </summary>
internal static class FileVersionStateEndpoints
{
    private static readonly string[] States = ["draft", "in_review", "approved", "revoked"];

    internal static IEndpointRouteBuilder MapFileVersionStateEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        endpoints.MapPut("/api/v1/items/{itemId:guid}/file/versions/{versionId:guid}/state", Handle)
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

    private static async Task<IResult> Handle(
        Guid itemId,
        Guid versionId,
        SetFileVersionStateRequest request,
        HttpContext context,
        [FromServices] IFileStore files)
    {
        if (request.State is null || !States.Contains(request.State))
        {
            return TypedResults.Problem(ApiProblem.Create(
                context, 422, "files.invalid_state", "Invalid state", "State must be draft, in_review, approved or revoked."));
        }

        var result = await files.SetVersionStateAsync(
            ItemId.From(itemId), FileVersionId.From(versionId), request.State, context.RequestAborted).ConfigureAwait(false);
        return result.Outcome switch
        {
            FileVersionStateOutcome.Changed => TypedResults.Ok(result.Version),
            FileVersionStateOutcome.NotPermitted => TypedResults.Problem(ApiProblem.Create(
                context, 403, "files.version_state_forbidden", "Not allowed",
                "This credential may not make that change to the file version in this workspace.")),
            FileVersionStateOutcome.InvalidTransition => TypedResults.Problem(ApiProblem.Create(
                context, 409, "files.invalid_transition", "Invalid transition",
                $"A {result.From} version cannot move to {request.State}.")),
            _ => TypedResults.Problem(ApiProblem.Create(
                context, 404, "files.not_found", "File not found", "No such file version is visible.")),
        };
    }
}
