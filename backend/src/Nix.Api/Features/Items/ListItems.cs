using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Contracts;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Properties;
using Nix.Messaging;

namespace Nix.Features.Items;

/// <summary>Reads one page of a folder's children, or the workspace roots.</summary>
/// <param name="WorkspaceId">The workspace to read in.</param>
/// <param name="ParentId">The folder, or <see langword="null"/> for the roots.</param>
/// <param name="IncludeDeleted">Whether soft-deleted items are included.</param>
/// <param name="AfterSeq">Resume after this sibling position.</param>
/// <param name="Limit">How many to return.</param>
/// <remarks>
/// Items the caller cannot read are omitted entirely rather than redacted. A query result is how
/// you enumerate what exists, so a placeholder row would disclose the existence of something the
/// caller was refused - the redaction rule applies to links an author placed, not to listings.
/// </remarks>
public sealed record ListItems(
    WorkspaceId WorkspaceId,
    ItemId? ParentId,
    bool IncludeDeleted,
    long? AfterSeq,
    int Limit) : IQuery<Result<IReadOnlyList<Item>>>;

/// <summary>Reads one page of a folder's children, or the workspace roots.</summary>
/// <remarks>
/// Items the caller cannot read are omitted entirely rather than redacted. A query result is how
/// you enumerate what exists, so a placeholder row would disclose the existence of something the
/// caller was refused - the redaction rule applies to links an author placed, not to listings.
/// </remarks>
public sealed class ListItemsHandler(
    IItemTree tree,
    IPermissionResolver permissions,
    IItemLocks locks)
    : IQueryHandler<ListItems, Result<IReadOnlyList<Item>>>
{
    /// <summary>Largest page this use case will return, whatever was asked for.</summary>
    public const int MaximumPageSize = 200;

    private readonly IItemTree _tree = tree;

    /// <summary>Reads the page.</summary>
    /// <param name="query">
    /// The workspace to read in; the folder, or <see langword="null"/> for the roots; whether
    /// soft-deleted items are included; the sibling position to resume after; and how many to
    /// return.
    /// </param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The children, in sibling order.</returns>
    public async ValueTask<Result<IReadOnlyList<Item>>> HandleAsync(
        ListItems query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        var workspaceId = query.WorkspaceId;
        var parentId = query.ParentId;
        var includeDeleted = query.IncludeDeleted;
        var afterSeq = query.AfterSeq;
        var limit = query.Limit;

        // Existence and permission answer with the same failure, deliberately: a workspace the
        // caller may not read must not be distinguishable from one that does not exist.
        if (!await _tree.WorkspaceExistsAsync(workspaceId, cancellationToken).ConfigureAwait(false)
            || !await permissions.CanReadWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<IReadOnlyList<Item>>(
                ItemErrors.WorkspaceNotFound($"No workspace {workspaceId} is visible."));
        }

        // A ceiling rather than a rejection: a client asking for ten thousand rows gets a working
        // answer and a cursor, not a 400 telling it to ask again more politely.
        var capped = Math.Clamp(limit, 1, MaximumPageSize);

        if (parentId is { } parent)
        {
            var visibleParent = await _tree.FindAsync(parent, cancellationToken).ConfigureAwait(false);
            if (visibleParent is null || visibleParent.WorkspaceId != workspaceId)
            {
                return Result.Failure<IReadOnlyList<Item>>(
                    ItemErrors.ParentNotFound($"No parent {parent} is visible in this workspace."));
            }

            // A lock covers the subtree, and a children list is every view's source - the table,
            // the board and the tree all draw from here. Refused outright rather than answered
            // empty: an empty page would read as "nothing is in here", which is not what a lock
            // means.
            if (!await locks.MayReadBodyAsync(parent, cancellationToken).ConfigureAwait(false))
            {
                return Result.Failure<IReadOnlyList<Item>>(
                    ItemErrors.Locked($"Item {parent} is locked. Unlock it to see what is inside."));
            }
        }

        var page = await _tree
            .ListChildrenAsync(workspaceId, parentId, includeDeleted, afterSeq, capped, cancellationToken)
            .ConfigureAwait(false);

        return Result.Success(page);
    }
}

/// <summary>
/// Route handler for reading a folder's children, or the workspace roots.
/// </summary>
/// <remarks>
/// Named apart from <see cref="ListItems"/> itself: the query record already owns that identifier
/// in this namespace, and a route handler with the same name would be an ambiguous simple name at
/// the <c>MapGet</c> call site.
/// </remarks>
internal static class ListItemsEndpoint
{
    /// <summary>Handles a request for a page of a folder's children, or the workspace roots.</summary>
    /// <param name="workspaceId">The workspace to read in.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the query to its handler.</param>
    /// <param name="parentId">The folder, or <see langword="null"/> for the roots.</param>
    /// <param name="includeDeleted">Whether soft-deleted items are included.</param>
    /// <param name="cursor">Resume after this position, or <see langword="null"/> to start.</param>
    /// <param name="limit">How many to return.</param>
    /// <returns>The page, or a problem describing why it could not be read.</returns>
    internal static async Task<Results<Ok<CursorPage<ItemResponse>>, ProblemHttpResult>> Handle(
        Guid workspaceId,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher,
        Guid? parentId = null,
        bool includeDeleted = false,
        string? cursor = null,
        int limit = CursorPaging.DefaultLimit)
    {
        var result = await dispatcher
            .QueryAsync<ListItems, Result<IReadOnlyList<Item>>>(
                new ListItems(
                    WorkspaceId.From(workspaceId),
                    parentId is { } parent ? ItemId.From(parent) : null,
                    includeDeleted,
                    ItemCursor.Decode(cursor),
                    limit),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        if (result.IsFailure)
        {
            return TypedResults.Problem(ItemEndpoints.Problem(httpContext, result.Error));
        }

        var page = result.Value;

        // One question for the whole page. Asked per row it would be a query per item in the tree,
        // which is the shape this exists to avoid - see TreeShapeSql for the measurement.
        var withChildren = await dispatcher
            .QueryAsync<ItemsWithChildren, IReadOnlySet<ItemId>>(
                new ItemsWithChildren(WorkspaceId.From(workspaceId), [.. page.Select(item => item.Id)]),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        // The same shape again, and the same reason: one fold for the whole page, not one per row.
        // The declarations come from the container being listed, whose own schema is exactly what
        // its children carry; the workspace roots have no container and so no rollups.
        var rollups = await dispatcher
            .QueryAsync<ItemRollups, IReadOnlyDictionary<ItemId, JsonObject>>(
                new ItemRollups(
                    WorkspaceId.From(workspaceId),
                    [.. page.Select(item => item.Id)],
                    parentId is { } container ? ItemId.From(container) : null),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return TypedResults.Ok(
            new CursorPage<ItemResponse>(
                [
                    .. page.Select(item => ItemMapping.ToResponse(
                        item,
                        withChildren.Contains(item.Id),
                        rollups.TryGetValue(item.Id, out var computed) ? computed : new JsonObject())),
                ],
                ItemCursor.NextFrom(page, limit)));
    }
}
