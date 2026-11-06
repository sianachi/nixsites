using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Contracts;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Errors;
using Nix.Http;
using Nix.Messaging;

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

internal static class ReferenceEndpoints
{
    internal static IEndpointRouteBuilder MapReferenceEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var group = endpoints.MapGroup("/api/v1/items/{itemId:guid}").WithTags("References");
        group.MapGet("/references", ListHeld)
            .WithName("ListItemReferences")
            .Produces<CursorPage<ItemReferenceResponse>>()
            .ProducesProblem(StatusCodes.Status404NotFound);
        group.MapPost("/references", Add)
            .WithName("AddItemReference")
            .Produces<ItemReferenceResponse>(StatusCodes.Status201Created)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapDelete("/references/{referenceId:guid}", Remove)
            .WithName("RemoveItemReference")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapGet("/referenced-by", ListBy)
            .WithName("ListReferencedBy")
            .Produces<CursorPage<ItemReferencedByResponse>>()
            .ProducesProblem(StatusCodes.Status404NotFound);
        return endpoints;
    }

    private static async Task<Results<Ok<CursorPage<ItemReferenceResponse>>, ProblemHttpResult>> ListHeld(
        Guid itemId, HttpContext context, [FromServices] NixDispatcher dispatcher, string? cursor = null, int limit = CursorPaging.DefaultLimit) =>
        (await dispatcher.QueryAsync<ListReferences, Result<ReferencePage<ItemReferenceResponse>>>(
            new(ItemId.From(itemId), cursor, limit), context.RequestAborted).ConfigureAwait(false))
        .Match<Results<Ok<CursorPage<ItemReferenceResponse>>, ProblemHttpResult>>(page => TypedResults.Ok(new CursorPage<ItemReferenceResponse>(page.Items, page.NextCursor)), error => Problem(context, error));

    private static async Task<Results<Ok<CursorPage<ItemReferencedByResponse>>, ProblemHttpResult>> ListBy(
        Guid itemId, HttpContext context, [FromServices] NixDispatcher dispatcher, string? cursor = null, int limit = CursorPaging.DefaultLimit) =>
        (await dispatcher.QueryAsync<ListReferencedBy, Result<ReferencePage<ItemReferencedByResponse>>>(
            new(ItemId.From(itemId), cursor, limit), context.RequestAborted).ConfigureAwait(false))
        .Match<Results<Ok<CursorPage<ItemReferencedByResponse>>, ProblemHttpResult>>(page => TypedResults.Ok(new CursorPage<ItemReferencedByResponse>(page.Items, page.NextCursor)), error => Problem(context, error));

    // Created whether the edge is new or already there: a retry is answered with the one that exists.
    private static async Task<Results<Created<ItemReferenceResponse>, ProblemHttpResult>> Add(
        Guid itemId, AddItemReferenceRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        (await dispatcher.SendAsync<AddReference, ItemReferenceResponse>(
            new(ItemId.From(itemId), request), context.RequestAborted).ConfigureAwait(false))
        .Match<Results<Created<ItemReferenceResponse>, ProblemHttpResult>>(
            value => TypedResults.Created($"/api/v1/items/{itemId}/references/{value.Id}", value), error => Problem(context, error));

    private static async Task<Results<NoContent, ProblemHttpResult>> Remove(
        Guid itemId, Guid referenceId, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        (await dispatcher.SendAsync<RemoveReference, Guid>(
            new(ItemId.From(itemId), referenceId), context.RequestAborted).ConfigureAwait(false))
        .Match<Results<NoContent, ProblemHttpResult>>(_ => TypedResults.NoContent(), error => Problem(context, error));

    private static ProblemHttpResult Problem(HttpContext context, NixError error)
    {
        var status = error.Code switch
        {
            "items.not_found" or "references.not_found" => StatusCodes.Status404NotFound,
            "items.locked" => StatusCodes.Status423Locked,
            _ => StatusCodes.Status422UnprocessableEntity,
        };
        return TypedResults.Problem(ApiProblem.Create(context, status, error.Code, "Reference request refused", error.Message));
    }
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(AddItemReferenceRequest))]
[JsonSerializable(typeof(ItemReferenceResponse))]
[JsonSerializable(typeof(ItemReferencedByResponse))]
[JsonSerializable(typeof(CursorPage<ItemReferenceResponse>))]
[JsonSerializable(typeof(CursorPage<ItemReferencedByResponse>))]
internal sealed partial class ReferencesJsonContext : JsonSerializerContext;
