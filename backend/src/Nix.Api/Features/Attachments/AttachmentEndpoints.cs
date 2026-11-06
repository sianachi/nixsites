using System.Text.Json.Serialization;
using Nix.Contracts;
using Nix.Errors;

namespace Nix.Features.Attachments;

/// <summary>One file item in the attachments list. Carries no link URL, only whether a public link exists.</summary>
/// <param name="ShownVersionId">The version the file shows: latest approved, else latest upload.</param>
/// <param name="ShownVersionState">That version's state: draft, in_review, approved or revoked.</param>
/// <param name="ExpiresAt">The item's expiry, or null.</param>
/// <param name="SourceItemId">The note the shown version was exported from, or null.</param>
/// <param name="PinCount">How many references pin a version of this file.</param>
public sealed record AttachmentRow(
    Guid ItemId,
    string Title,
    string MediaType,
    Guid ShownVersionId,
    string ShownVersionState,
    DateTimeOffset? ExpiresAt,
    Guid? SourceItemId,
    int PinCount,
    bool HasPublicLink);

/// <summary>Lane 9 stub: the workspace attachments list. Replace the handler; keep the route and types.</summary>
internal static class AttachmentEndpoints
{
    internal static IEndpointRouteBuilder MapAttachmentEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        endpoints.MapGet(
                "/api/v1/workspaces/{workspaceId:guid}/attachments",
                (Guid workspaceId, HttpContext context, string? cursor, string? state, bool includeImages = false, bool expiring = false, int limit = CursorPaging.DefaultLimit) =>
                    TypedResults.Problem(ApiProblem.Create(
                        context,
                        StatusCodes.Status501NotImplemented,
                        "attachments.not_implemented",
                        "Not implemented",
                        "This route is not implemented yet.")))
            .WithTags("Attachments")
            .WithName("ListAttachments")
            .Produces<CursorPage<AttachmentRow>>()
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity);
        return endpoints;
    }
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(AttachmentRow))]
[JsonSerializable(typeof(CursorPage<AttachmentRow>))]
internal sealed partial class AttachmentsJsonContext : JsonSerializerContext;
