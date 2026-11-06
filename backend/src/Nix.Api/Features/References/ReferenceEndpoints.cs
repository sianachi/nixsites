using System.Text.Json.Serialization;
using Nix.Contracts;
using Microsoft.AspNetCore.Http.HttpResults;
using Nix.Errors;
using Nix.Http;

namespace Nix.Features.References;

/// <summary>Adds a reference from the item in the route (the holder) to a target item, optionally pinned to one file version.</summary>
/// <param name="TargetItemId">The item referenced; same workspace as the holder.</param>
/// <param name="TargetFileVersionId">An approved version of the target file to pin, or null for a plain reference.</param>
/// <param name="Role">Free-text relationship label, at most 80 characters.</param>
public sealed record AddItemReferenceRequest(Guid TargetItemId, Guid? TargetFileVersionId = null, string? Role = null);

/// <summary>A reference held by an item.</summary>
/// <param name="TargetAvailable">False while the target is in Trash; the reference is kept.</param>
/// <param name="TargetVersionState">The pinned version's current state (a revoked pin is kept and shown as revoked), or null for a plain reference.</param>
public sealed record ItemReferenceResponse(
    Guid Id,
    Guid HolderItemId,
    Guid TargetItemId,
    string? TargetTitle,
    bool TargetAvailable,
    Guid? TargetFileVersionId,
    string? TargetVersionState,
    string? Role,
    Guid CreatedBy,
    DateTimeOffset CreatedAt);

/// <summary>A reference pointing at an item, seen from the target's side.</summary>
/// <param name="HolderAvailable">False while the holder is in Trash.</param>
public sealed record ItemReferencedByResponse(
    Guid Id,
    Guid HolderItemId,
    string? HolderTitle,
    bool HolderAvailable,
    Guid TargetItemId,
    Guid? TargetFileVersionId,
    string? Role,
    Guid CreatedBy,
    DateTimeOffset CreatedAt);

/// <summary>Lane 2 stubs: references and pins. Replace the handlers; keep the routes and types.</summary>
internal static class ReferenceEndpoints
{
    internal static IEndpointRouteBuilder MapReferenceEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var group = endpoints.MapGroup("/api/v1/items/{itemId:guid}").WithTags("References");
        group.MapGet("/references", (Guid itemId, HttpContext context, string? cursor, int limit = CursorPaging.DefaultLimit) => NotImplemented(context))
            .WithName("ListItemReferences")
            .Produces<CursorPage<ItemReferenceResponse>>()
            .ProducesProblem(StatusCodes.Status404NotFound);
        group.MapPost("/references", (Guid itemId, AddItemReferenceRequest request, HttpContext context) => NotImplemented(context))
            .WithName("AddItemReference")
            .Produces<ItemReferenceResponse>(StatusCodes.Status201Created)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapDelete("/references/{referenceId:guid}", (Guid itemId, Guid referenceId, HttpContext context) => NotImplemented(context))
            .WithName("RemoveItemReference")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapGet("/referenced-by", (Guid itemId, HttpContext context, string? cursor, int limit = CursorPaging.DefaultLimit) => NotImplemented(context))
            .WithName("ListReferencedBy")
            .Produces<CursorPage<ItemReferencedByResponse>>()
            .ProducesProblem(StatusCodes.Status404NotFound);
        return endpoints;
    }

    private static ProblemHttpResult NotImplemented(HttpContext context) => TypedResults.Problem(ApiProblem.Create(
        context,
        StatusCodes.Status501NotImplemented,
        "references.not_implemented",
        "Not implemented",
        "This route is not implemented yet."));
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(AddItemReferenceRequest))]
[JsonSerializable(typeof(ItemReferenceResponse))]
[JsonSerializable(typeof(ItemReferencedByResponse))]
[JsonSerializable(typeof(CursorPage<ItemReferenceResponse>))]
[JsonSerializable(typeof(CursorPage<ItemReferencedByResponse>))]
internal sealed partial class ReferencesJsonContext : JsonSerializerContext;
