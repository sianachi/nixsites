using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Features.Items;

/// <summary>Moves an item to a new parent, at a chosen position among its new siblings.</summary>
/// <param name="ItemId">The item to move.</param>
/// <param name="NewParentId">The new parent, or <see langword="null"/> for the workspace root.</param>
/// <param name="AfterId">
/// The sibling to sit immediately after, or <see langword="null"/> to sit first.
/// </param>
/// <remarks>
/// <para>
/// The one operation that can corrupt the tree, so it is the one with the most checks. A move into
/// the item's own subtree would produce a cycle: a set of rows reachable only from each other, no
/// longer under any workspace root, invisible to every listing and impossible to delete through the
/// interface. The closure table makes that question a single indexed lookup rather than a walk, and
/// it is asked before anything is written.
/// </para>
/// <para>
/// Placement is expressed as "after this sibling" rather than as an index, because an index is a
/// claim about a list the client last saw and a sibling identifier is a claim about a relationship
/// that is still meaningful when the list has changed underneath it.
/// </para>
/// </remarks>
public sealed record MoveItem(ItemId ItemId, ItemId? NewParentId, ItemId? AfterId, WorkspaceId? WorkspaceId = null) : ICommand<Item>;

/// <summary>Moves an item to a new parent, at a chosen position among its new siblings.</summary>
/// <remarks>
/// <para>
/// The one operation that can corrupt the tree, so it is the one with the most checks. A move into
/// the item's own subtree would produce a cycle: a set of rows reachable only from each other, no
/// longer under any workspace root, invisible to every listing and impossible to delete through the
/// interface. The closure table makes that question a single indexed lookup rather than a walk, and
/// it is asked before anything is written.
/// </para>
/// <para>
/// Placement is expressed as "after this sibling" rather than as an index, because an index is a
/// claim about a list the client last saw and a sibling identifier is a claim about a relationship
/// that is still meaningful when the list has changed underneath it.
/// </para>
/// </remarks>
public sealed class MoveItemHandler(
    IItemTree tree,
    IPermissionResolver permissions,
    INixSessionContextAccessor session,
    TimeProvider clock,
    IItemLocks locks,
    IFinanceMutationGuard? financeGuard = null,
    IFinanceLock? topology = null)
    : ICommandHandler<MoveItem, Item>
{
    private readonly INixSessionContextAccessor _session = session;

    /// <summary>Moves the item.</summary>
    /// <param name="command">
    /// The item to move; the new parent, or <see langword="null"/> for the workspace root; and the
    /// sibling to sit immediately after, or <see langword="null"/> to sit first.
    /// </param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The moved item, or why it could not be moved.</returns>
    public async ValueTask<Result<Item>> HandleAsync(MoveItem command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var itemId = command.ItemId;
        var newParentId = command.NewParentId;
        var afterId = command.AfterId;

        var context = _session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

        var item = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Item>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }
        var workspaceId = item.WorkspaceId;

        if (item.LifecycleState == ItemLifecycleState.Purged)
        {
            return Result.Failure<Item>(ItemErrors.LifecycleConflict("A purged item cannot be moved."));
        }

        if (command.WorkspaceId is { } destinationWorkspace && destinationWorkspace != workspaceId)
        {
            return await TransferAsync(command, item, destinationWorkspace, cancellationToken).ConfigureAwait(false);
        }

        if (financeGuard is not null)
        {
            var blocked = await financeGuard.CheckAsync(item.WorkspaceId, itemId, newParentId, true, cancellationToken).ConfigureAwait(false);
            if (blocked is not null)
            {
                return Result.Failure<Item>(blocked.Value);
            }
            item = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
            if (item is null || item.WorkspaceId != workspaceId)
            {
                return Result.Failure<Item>(ItemErrors.NotFound($"No item {itemId} is visible."));
            }
        }

        if (newParentId != item.ParentId && item.ManagedBy == ItemManagers.CalendarEvent)
        {
            // Leaving the linked container is how an event is deleted upstream, so it is a
            // deletion by another name and is refused for the same reason one is.
            return Result.Failure<Item>(ItemErrors.DeleteProtected(
                "This event belongs to a linked calendar and cannot be moved out of it."));
        }

        if (newParentId is { } destination)
        {
            var parent = await tree.FindAsync(destination, cancellationToken).ConfigureAwait(false);
            if (parent is null || parent.WorkspaceId != item.WorkspaceId)
            {
                return Result.Failure<Item>(
                    ItemErrors.ParentNotFound($"No parent {destination} is visible in this workspace."));
            }

            if (parent.LifecycleState != ItemLifecycleState.Active)
            {
                return Result.Failure<Item>(
                    ItemErrors.LifecycleConflict("An item cannot be moved into a deleted parent."));
            }

            // A reorder inside the same parent adds no child, so only a change of parent is asked.
            if (parent.NoChildren && newParentId != item.ParentId)
            {
                return Result.Failure<Item>(
                    ItemErrors.ChildrenProtected("The destination does not accept new children."));
            }

            if (destination == itemId
                || await tree.WouldCreateCycleAsync(itemId, destination, cancellationToken).ConfigureAwait(false))
            {
                return Result.Failure<Item>(
                    ItemErrors.WouldCreateCycle(
                        $"Item {itemId} cannot be moved into itself or into one of its descendants."));
            }

            // Into a closed lock is refused too: the item would vanish from the caller's own view
            // the moment it landed, which reads as the move having lost it.
            if (!await locks.MayReadBodyAsync(destination, cancellationToken).ConfigureAwait(false))
            {
                return Result.Failure<Item>(
                    ItemErrors.Locked($"Item {destination} is locked. Unlock it before moving anything into it."));
            }
        }

        // A lock covers everything under it, so moving an item out from under a closed lock would
        // open it to anybody who can edit the workspace. Asked of the current parent, not the item:
        // the item's own lock travels with it, so a locked note can still be reordered or filed
        // without being opened; only a lock above it is left behind by the move.
        if (item.ParentId is { } currentParent
            && !await locks.MayReadBodyAsync(currentParent, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Item>(
                ItemErrors.Locked($"Item {currentParent} is locked. Unlock it before moving anything out of it."));
        }

        if (afterId is { } anchor)
        {
            var sibling = await tree.FindAsync(anchor, cancellationToken).ConfigureAwait(false);
            if (sibling is null || sibling.WorkspaceId != item.WorkspaceId)
            {
                return Result.Failure<Item>(ItemErrors.NotFound($"No item {anchor} is visible."));
            }

            if (sibling.ParentId != newParentId || anchor == itemId)
            {
                // Placing something after a sibling that is not in the destination has no defined
                // meaning. Guessing one - appending, or ignoring the request - would put the item
                // somewhere the caller did not ask for, which is exactly what a drag-and-drop user
                // notices and nobody else does.
                return Result.Failure<Item>(
                    ItemErrors.SiblingNotInDestination(
                        $"Item {anchor} is not a child of the destination, so it cannot order the move."));
            }
        }

        var seq = await tree
            .AllocateSiblingSequenceAsync(item.WorkspaceId, newParentId, itemId, afterId, cancellationToken)
            .ConfigureAwait(false);

        await tree
            .ReparentAsync(itemId, newParentId, seq, context.PrincipalId, clock.GetUtcNow(), cancellationToken)
            .ConfigureAwait(false);

        // Re-read rather than patching the shape in memory: the closure rewrite and the row update
        // both went through the store, and inventing what the row now looks like is how a response
        // drifts from the row it claims to describe.
        var moved = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);

        return moved is null
            ? Result.Failure<Item>(ItemErrors.NotFound($"Item {itemId} disappeared during the move."))
            : Result.Success(moved);
    }
    private async ValueTask<Result<Item>> TransferAsync(
        MoveItem command, Item original, WorkspaceId destination, CancellationToken cancellationToken)
    {
        if (!await permissions.CanWriteWorkspaceAsync(destination, cancellationToken).ConfigureAwait(false)
            || !await tree.WorkspaceExistsAsync(destination, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Item>(ItemErrors.WorkspaceNotFound("No writable destination workspace is visible."));
        }

        // Structural writes already share this lock with finance operations. Acquire both before
        // discovery, in a stable order, so opposing transfers cannot deadlock or discover stale trees.
        if (topology is not null)
        {
            foreach (var workspace in new[] { original.WorkspaceId, destination }.OrderBy(id => id.Value))
            {
                await topology.AcquireWorkspaceTopologyAsync(workspace, cancellationToken).ConfigureAwait(false);
            }
        }
        var item = await tree.FindAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
        if (item is null || item.WorkspaceId != original.WorkspaceId)
        {
            return Result.Failure<Item>(ItemErrors.TransferConflict("The item moved while this request was being checked. Reload it before retrying."));
        }
        if (item.ParentId is { } oldParent
            && !await locks.MayReadBodyAsync(oldParent, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Item>(ItemErrors.Locked("Unlock the current parent before moving this item to another workspace."));
        }
        if (command.NewParentId is { } parentId)
        {
            var parent = await tree.FindAsync(parentId, cancellationToken).ConfigureAwait(false);
            if (parent is null || parent.WorkspaceId != destination)
            {
                return Result.Failure<Item>(ItemErrors.ParentNotFound("The destination parent is not visible in the selected workspace."));
            }
            if (parent.LifecycleState != ItemLifecycleState.Active)
            {
                return Result.Failure<Item>(ItemErrors.LifecycleConflict("An item cannot be moved into a deleted parent."));
            }
            if (parent.NoChildren)
            {
                return Result.Failure<Item>(ItemErrors.ChildrenProtected("The destination does not accept new children."));
            }
            if (!await locks.MayReadBodyAsync(parentId, cancellationToken).ConfigureAwait(false))
            {
                return Result.Failure<Item>(ItemErrors.Locked("Unlock the destination before moving an item into it."));
            }
        }
        if (command.AfterId is { } anchorId)
        {
            var anchor = await tree.FindAsync(anchorId, cancellationToken).ConfigureAwait(false);
            if (anchor is null || anchor.WorkspaceId != destination || anchor.ParentId != command.NewParentId)
            {
                return Result.Failure<Item>(ItemErrors.SiblingNotInDestination("The chosen sibling is not in the destination."));
            }
        }
        if (financeGuard is not null)
        {
            var error = await financeGuard.CheckAsync(item.WorkspaceId, item.Id, null, true, cancellationToken).ConfigureAwait(false);
            if (error is not null)
            {
                return Result.Failure<Item>(error.Value);
            }
            if (command.NewParentId is { } financeParentId)
            {
                error = await financeGuard.CheckAsync(destination, financeParentId, null, false, cancellationToken).ConfigureAwait(false);
                if (error is not null)
                {
                    return Result.Failure<Item>(error.Value);
                }
            }
        }
        var context = _session.Current
            ?? throw new InvalidOperationException("No session context was established.");
        var refusal = await tree.TransferWorkspaceAsync(
            item.Id, item.WorkspaceId, destination, command.NewParentId, command.AfterId,
            context.PrincipalId, clock.GetUtcNow(), cancellationToken).ConfigureAwait(false);
        if (refusal is not null)
        {
            return Result.Failure<Item>(ItemErrors.TransferConflict(refusal));
        }
        var moved = await tree.FindAsync(item.Id, cancellationToken).ConfigureAwait(false);
        return moved is null
            ? Result.Failure<Item>(ItemErrors.NotFound("The moved item could not be read."))
            : Result.Success(moved);
    }

}

/// <summary>
/// Route handler for moving an item to a new parent.
/// </summary>
/// <remarks>
/// Named apart from <see cref="MoveItem"/> itself: the command record already owns that identifier
/// in this namespace, and a route handler with the same name would be an ambiguous simple name at
/// the <c>MapPost</c> call site.
/// </remarks>
internal static class MoveItemEndpoint
{
    /// <summary>Handles a request to move an item.</summary>
    /// <param name="itemId">The item to move.</param>
    /// <param name="request">The requested new parent and sibling position.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the command to its handler.</param>
    /// <returns>The moved item, or a problem describing why it could not be moved.</returns>
    internal static async Task<Results<Ok<ItemResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        MoveItemRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher
            .SendAsync<MoveItem, Item>(
                new MoveItem(
                    ItemId.From(itemId),
                    request.ParentId is { } parent ? ItemId.From(parent) : null,
                    request.AfterId is { } after ? ItemId.From(after) : null,
                    request.WorkspaceId is { } workspace ? WorkspaceId.From(workspace) : null),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        if (result.IsFailure)
        {
            return TypedResults.Problem(ItemEndpoints.Problem(httpContext, result.Error));
        }

        return TypedResults.Ok(
            await ItemMapping.RespondAsync(result.Value, dispatcher, httpContext.RequestAborted)
                .ConfigureAwait(false));
    }
}
