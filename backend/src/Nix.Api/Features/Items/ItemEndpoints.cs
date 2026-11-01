using Microsoft.AspNetCore.Mvc;
using Nix.Contracts;
using Nix.Domain.Primitives;
using Nix.Errors;
using Nix.Http;

namespace Nix.Features.Items;

/// <summary>
/// Route registration for the items feature: the tree, and the operations that reshape it.
/// </summary>
/// <remarks>
/// <para>
/// The failure codes below are the stable part of the contract and are what the frontend switches
/// on, so they are named here rather than invented at each call site.
/// </para>
/// </remarks>
internal static class ItemEndpoints
{
    /// <summary>Stable code for "no such item, or the caller cannot see it".</summary>
    internal const string NotFoundCode = "items.not_found";

    /// <summary>Stable code for "the requested parent does not exist or is not visible".</summary>
    internal const string ParentNotFoundCode = "items.parent_not_found";

    /// <summary>
    /// Stable code for a move whose destination is the item itself or one of its descendants.
    /// </summary>
    internal const string CycleCode = "items.move_would_create_cycle";

    /// <summary>Stable code for an operation that is not valid in the item's lifecycle state.</summary>
    internal const string LifecycleConflictCode = "items.lifecycle_conflict";

    /// <summary>
    /// Stable code for a move ordered after a sibling that is not a child of the destination.
    /// </summary>
    internal const string SiblingNotInDestinationCode = "items.sibling_not_in_destination";

    /// <summary>
    /// Stable code for a lock the caller has not opened: the item's children are withheld, and it
    /// cannot be moved into or out of the locked subtree.
    /// </summary>
    internal const string LockedCode = "items.locked";

    /// <summary>Stable code for deleting an item that is, or holds, a deletion-protected item.</summary>
    internal const string DeleteProtectedCode = "items.delete_protected";

    /// <summary>Stable code for creating under, or moving into, an item that refuses new children.</summary>
    internal const string ChildrenProtectedCode = "items.children_protected";

    /// <summary>Stable code for changing a protection the system manages.</summary>
    internal const string ProtectionManagedCode = "items.protection_managed";

    /// <summary>Stable code for editing an item that mirrors a source the caller may not edit.</summary>
    internal const string ReadOnlyCode = "items.read_only";

    /// <summary>Stable code for a body the caller can read and may not change.</summary>
    internal const string BodyReadOnlyCode = "items.body_read_only";

    /// <summary>Stable code for Markdown that is not a valid note.</summary>
    internal const string MarkdownInvalidCode = "items.markdown_invalid";

    /// <summary>Stable code for Markdown over the character ceiling.</summary>
    internal const string MarkdownTooLargeCode = "items.markdown_too_large";

    /// <summary>Stable code for a canvas or spreadsheet, which Markdown cannot carry.</summary>
    internal const string BodyNotProseCode = "items.body_not_prose";

    /// <summary>Stable code for a collaboration service that could not answer.</summary>
    internal const string BodyUnavailableCode = "items.body_unavailable";

    /// <summary>Stable code for a note that would exceed a document ceiling.</summary>
    internal const string BodyTooLargeCode = "items.body_too_large";

    /// <summary>Stable code for the collaboration update window.</summary>
    internal const string BodyRateLimitedCode = "items.body_rate_limited";

    /// <summary>Stable code for a body write the document's schema pin refused.</summary>
    internal const string BodyConflictCode = "items.body_conflict";

    /// <summary>
    /// Registers the items feature's routes on <paramref name="endpoints"/>.
    /// </summary>
    internal static IEndpointRouteBuilder MapItemEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        // Listing hangs off the workspace because a listing is always workspace-scoped; the single
        // item routes do not, because an item identifier is unique on its own and forcing clients
        // to carry the workspace around to fetch one would be ceremony.
        var workspaceItems = endpoints.MapGroup("/api/v1/workspaces/{workspaceId:guid}/items")
            .WithTags("Items");

        workspaceItems.MapGet("/trash", ListTrashEndpoint.Handle)
            .WithName("ListTrash")
            .WithSummary("Recoverable items in the workspace trash")
            .WithDescription("Returns directly deleted items the caller may read, newest first. Descendants hidden by a deleted ancestor are not independently trashed.")
            .Produces<CursorPage<ItemResponse>>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);

        workspaceItems.MapGet("/", ListItemsEndpoint.Handle)
            .WithName("ListItems")
            .WithSummary("Children of an item, or the workspace root")
            .WithDescription(
                "Returns the items directly under 'parentId', or the workspace's roots when it is "
                + "omitted, in sibling order. Items the caller cannot read are omitted entirely - "
                + "a query result is how you enumerate what exists, so redacted placeholders would "
                + "disclose their existence. Soft-deleted items are excluded unless "
                + "'includeDeleted' is set. Fails with 'items.locked' (423) when a lock the caller "
                + "has not opened covers 'parentId' - a locked item's children are withheld until "
                + "it is unlocked.")
            .Produces<CursorPage<ItemResponse>>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status423Locked);

        workspaceItems.MapPost("/", CreateItemEndpoint.Handle)
            .WithName("CreateItem")
            .WithSummary("Create an item")
            .WithDescription(
                "Creates an item under 'parentId', or at the workspace root when it is null. "
                + "Fails with 'items.parent_not_found' when the parent does not exist or is not "
                + "visible to the caller, and with 'items.children_protected' (409) when the "
                + "parent refuses new children. An optional UUID 'idempotencyKey' safely retries "
                + "the same creation; reusing it with different input returns 'items.idempotency_conflict' (409).")
            .Produces<ItemResponse>(StatusCodes.Status201Created)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        var items = endpoints.MapGroup("/api/v1/items")
            .WithTags("Items");

        items.MapGet("/{itemId:guid}", GetItemEndpoint.Handle)
            .WithName("GetItem")
            .WithSummary("One item")
            .WithDescription(
                "Returns the item, or a problem with code 'items.not_found'. An item the caller "
                + "may not read is reported as not found rather than as forbidden.")
            .Produces<ItemResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);

        items.MapPatch("/{itemId:guid}", RenameItemEndpoint.Handle)
            .WithName("UpdateItem")
            .WithSummary("Rename an item")
            .WithDescription("Changes the item's own fields. Moving and deleting are separate operations.")
            .Produces<ItemResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        items.MapGet("/{itemId:guid}/move-workspaces", ListItemMoveWorkspacesEndpoint.Handle)
            .WithName("ListItemMoveWorkspaces")
            .WithSummary("Writable destination workspaces for an item")
            .Produces<ItemMoveWorkspacePage>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity);

        items.MapPost("/{itemId:guid}/move", MoveItemEndpoint.Handle)
            .WithName("MoveItem")
            .WithSummary("Move an item to a new parent")
            .WithDescription(
                "Reparents the item and maintains the closure table. Fails with "
                + "'items.move_would_create_cycle' when the destination is the item itself or one "
                + "of its own descendants, and with 'items.parent_not_found' when the destination "
                + "is not visible. Fails with 'items.locked' (423) when a lock the caller has not "
                + "opened covers the item or the destination.")
            .Produces<ItemResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status423Locked)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        items.MapDelete("/{itemId:guid}", DeleteItemEndpoint.Handle)
            .WithName("DeleteItem")
            .WithSummary("Soft-delete an item")
            .WithDescription(
                "Marks the item deleted. The subtree stays intact and its descendants become "
                + "invisible by derivation rather than being rewritten, so restoring is a single "
                + "flag flip. Purging is a separate, retention-driven operation. Fails with "
                + "'items.delete_protected' (409) when the item, or an item beneath it, is "
                + "protected from deletion.")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        items.MapPut("/{itemId:guid}/protection", SetItemProtectionEndpoint.Handle)
            .WithName("SetItemProtection")
            .WithSummary("Protect an item from deletion or from new children")
            .WithDescription(
                "Sets whether the item can be deleted and whether it accepts new children. A field "
                + "left null is unchanged. Fails with 'items.protection_managed' (409) when the "
                + "deletion protection belongs to a system feature, such as a linked calendar.")
            .Produces<ItemResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        items.MapPost("/{itemId:guid}/restore", RestoreItemEndpoint.Handle)
            .WithName("RestoreItem")
            .WithSummary("Restore a soft-deleted item")
            .WithDescription(
                "Returns the item to the active state. Fails with 'items.lifecycle_conflict' when "
                + "the item has already been purged, which is not recoverable.")
            .Produces<ItemResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        items.MapDelete("/{itemId:guid}/purge", PurgeItemEndpoint.Handle)
            .WithName("PurgeItem").WithSummary("Permanently delete a trashed item")
            .Produces(StatusCodes.Status204NoContent).ProducesProblem(StatusCodes.Status404NotFound).ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status423Locked)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        items.MapGet("/{itemId:guid}/body", ReadItemBodyEndpoint.Handle)
            .WithName("GetItemBody")
            .WithSummary("Read a note body as Markdown")
            .WithDescription(
                "Returns the item's prose body as Markdown, plus the losses Markdown could not "
                + "carry. An item nobody has edited yet is an empty string, not an error. Exchange "
                + "a personal access token at POST /public/v1/auth/token and send that session as "
                + "a bearer token; reading needs the read scope. Fails with 'items.not_found' (404) "
                + "when the item is not visible, 'items.locked' (423) when its body is locked, "
                + "'items.body_not_prose' (422) for a canvas or spreadsheet, and "
                + "'items.body_unavailable' (503) when the body service cannot answer.")
            .Produces<ItemBodyResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .ProducesProblem(StatusCodes.Status423Locked)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable);

        items.MapPut("/{itemId:guid}/body", ReplaceItemBodyEndpoint.Handle)
            .WithName("ReplaceItemBody")
            .WithSummary("Replace a note body with Markdown")
            .WithDescription(
                "Replaces the prose body with the Markdown in { \"markdown\": \"...\" }, at most "
                + "200,000 characters. An empty string clears the note. The write is a minimal Yjs "
                + "update, the same diff nixctl note write applies, so a collaborator who has the "
                + "note open sees it. Exchange a personal access token at POST /public/v1/auth/token "
                + "and send that session as a bearer token; this route needs the write scope. "
                + "Fails with 'items.not_found' (404) when the item is not visible, 'items.locked' "
                + "(423) when its body is locked, 'items.body_read_only' (403) when the caller can "
                + "read but not write, 'items.body_not_prose' (422) for a canvas or spreadsheet, "
                + "'items.markdown_invalid' (422) when the Markdown is not a note, and "
                + "'items.markdown_too_large' (413) past the character ceiling.")
            .Produces<ItemBodyWriteResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status413PayloadTooLarge)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .ProducesProblem(StatusCodes.Status423Locked)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .WithRequestBodyLimit(ItemBodyLimits.RequestBytes)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        items.MapPost("/{itemId:guid}/body", AppendItemBodyEndpoint.Handle)
            .WithName("AppendItemBody")
            .WithSummary("Append Markdown to a note body")
            .WithDescription(
                "Appends the Markdown in { \"markdown\": \"...\" } as new blocks at the end of the "
                + "note, at most 200,000 characters. Existing blocks are not reserialised, so marks "
                + "Markdown cannot carry stay, and a collaborator who has the note open sees the "
                + "new blocks. Authentication and the failure codes match replacing the body. An "
                + "empty append is 'items.markdown_invalid' (422).")
            .Produces<ItemBodyWriteResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status413PayloadTooLarge)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .ProducesProblem(StatusCodes.Status423Locked)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .WithRequestBodyLimit(ItemBodyLimits.RequestBytes)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        return endpoints;
    }

    /// <summary>
    /// Maps a use case's failure onto the status its stable code implies.
    /// </summary>
    /// <param name="httpContext">The current request.</param>
    /// <param name="error">Why the use case failed.</param>
    /// <returns>Problem details describing the failure.</returns>
    /// <remarks>
    /// The code is the contract; the status is a consequence of it. Deciding the status here, in
    /// one place, is what stops two endpoints answering the same failure differently.
    /// </remarks>
    internal static Microsoft.AspNetCore.Mvc.ProblemDetails Problem(HttpContext httpContext, NixError error)
    {
        var status = error.Code switch
        {
            CycleCode or LifecycleConflictCode or SiblingNotInDestinationCode
                or DeleteProtectedCode or ChildrenProtectedCode or ProtectionManagedCode or ReadOnlyCode
                or BodyConflictCode
                or "items.transfer_conflict" or "items.idempotency_conflict" =>
                StatusCodes.Status409Conflict,
            "items.invalid_idempotency_key" => StatusCodes.Status400BadRequest,
            LockedCode => StatusCodes.Status423Locked,
            BodyReadOnlyCode => StatusCodes.Status403Forbidden,
            MarkdownInvalidCode or BodyNotProseCode => StatusCodes.Status422UnprocessableEntity,
            MarkdownTooLargeCode or BodyTooLargeCode => StatusCodes.Status413PayloadTooLarge,
            BodyUnavailableCode => StatusCodes.Status503ServiceUnavailable,
            BodyRateLimitedCode => StatusCodes.Status429TooManyRequests,
            _ => StatusCodes.Status404NotFound,
        };

        return ApiProblem.Create(httpContext, status, error.Code, "Request refused", error.Message);
    }
}
