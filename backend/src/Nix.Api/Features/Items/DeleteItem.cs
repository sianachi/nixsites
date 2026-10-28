using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Items;

/// <summary>Marks an item deleted, leaving its subtree intact.</summary>
/// <param name="ItemId">The item.</param>
/// <remarks>
/// <para>
/// <b>Soft deletion is one flag on one row, never a cascade.</b> Descendants disappear from
/// listings because a listing walks down from a visible parent, not because anything rewrote them,
/// which is what makes restoring a single flip back rather than a reconstruction from a log. It is
/// also what makes deleting a folder of ten thousand notes cost the same as deleting one note.
/// </para>
/// <para>
/// Purging is a separate, retention-driven operation and is not reachable from here. An item this
/// use case has deleted is still stored, still counted against quota, and still restorable until
/// the retention window closes over it.
/// </para>
/// </remarks>
public sealed record DeleteItem(ItemId ItemId) : ICommand<ItemId>
{
    /// <summary>
    /// Internal capability for calendar sync, which removes a mirrored event its source cancelled
    /// never request-bound. It passes the protection the system itself holds on what it manages,
    /// which exists to stop a deletion from the workspace, not the system keeping a mirror honest.
    /// It does not pass a protection a person set: an event cancelled at its source stays, with
    /// the refusal in the sync log, while somebody's protected note sits beneath it.
    /// </summary>
    internal bool CalendarWrite { get; init; }
}

/// <summary>Marks an item deleted, leaving its subtree intact.</summary>
/// <remarks>
/// <para>
/// <b>Soft deletion is one flag on one row, never a cascade.</b> Descendants disappear from
/// listings because a listing walks down from a visible parent, not because anything rewrote them,
/// which is what makes restoring a single flip back rather than a reconstruction from a log. It is
/// also what makes deleting a folder of ten thousand notes cost the same as deleting one note.
/// </para>
/// <para>
/// Purging is a separate, retention-driven operation and is not reachable from here. An item this
/// use case has deleted is still stored, still counted against quota, and still restorable until
/// the retention window closes over it.
/// </para>
/// </remarks>
public sealed class DeleteItemHandler(
    IItemTree tree,
    IPermissionResolver permissions,
    INixSessionContextAccessor session,
    TimeProvider clock,
    IFinanceMutationGuard? financeGuard = null,
    IItemProtections? protections = null)
    : ICommandHandler<DeleteItem, ItemId>
{
    private readonly INixSessionContextAccessor _session = session;

    /// <summary>Deletes the item.</summary>
    /// <param name="command">The item to delete.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The deleted item's identifier, or why it could not be deleted.</returns>
    /// <remarks>
    /// Deleting an already-deleted item succeeds. The caller asked for a state, the state holds, and
    /// a client retrying after a dropped response should not be told its second attempt was wrong.
    /// </remarks>
    public async ValueTask<Result<ItemId>> HandleAsync(DeleteItem command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var itemId = command.ItemId;

        var context = _session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

        var visible = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        var item = visible
            ?? await tree.FindStoredAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ItemId>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        // A directly deleted row remains addressable here for an idempotent retry. An active row
        // hidden below a deleted ancestor does not: being able to mutate it by guessing its id
        // would contradict the visibility boundary every ordinary read and collaboration session
        // observes.
        if (item.LifecycleState == ItemLifecycleState.Active && visible is null)
        {
            return Result.Failure<ItemId>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        if (item.LifecycleState == ItemLifecycleState.Purged)
        {
            return Result.Failure<ItemId>(
                ItemErrors.LifecycleConflict("A purged item cannot be deleted; it is already gone."));
        }

        if (item.LifecycleState == ItemLifecycleState.Deleted)
        {
            return Result.Success(itemId);
        }

        if (financeGuard is not null)
        {
            var workspaceId = item.WorkspaceId;
            var blocked = await financeGuard.CheckAsync(workspaceId, itemId, null, true, cancellationToken, allowOpenTransaction: true).ConfigureAwait(false);
            if (blocked is not null)
            {
                return Result.Failure<ItemId>(blocked.Value);
            }
            item = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
            if (item is null || item.WorkspaceId != workspaceId || item.LifecycleState != ItemLifecycleState.Active
                || !await permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
            {
                return Result.Failure<ItemId>(ItemErrors.NotFound($"No item {itemId} is visible."));
            }
        }

        if (item.NoDelete && !(command.CalendarWrite && item.ManagedBy is not null))
        {
            return Result.Failure<ItemId>(ItemErrors.DeleteProtected(item.ManagedBy is null
                ? "This item is protected from deletion. Remove the protection first."
                : "This item belongs to a linked calendar. Unlink the calendar in settings to remove it."));
        }

        // Trashing an item hides everything under it, so a protected item beneath it would be
        // deleted in every way that matters. Refused rather than skipped: the caller asked for
        // one outcome and half of it is not theirs to have.
        if (protections is not null
            && await protections
                .AnyDeleteProtectedBelowAsync(itemId, userOnly: command.CalendarWrite, cancellationToken)
                .ConfigureAwait(false))
        {
            return Result.Failure<ItemId>(ItemErrors.DeleteProtected(
                "An item inside this one is protected from deletion."));
        }

        await tree
            .SetLifecycleAsync(
                itemId,
                ItemLifecycleState.Deleted,
                context.PrincipalId,
                clock.GetUtcNow(),
                cancellationToken)
            .ConfigureAwait(false);

        return Result.Success(itemId);
    }
}

/// <summary>
/// Route handler for soft-deleting an item.
/// </summary>
/// <remarks>
/// Named apart from <see cref="DeleteItem"/> itself: the command record already owns that
/// identifier in this namespace, and a route handler with the same name would be an ambiguous
/// simple name at the <c>MapDelete</c> call site.
/// </remarks>
internal static class DeleteItemEndpoint
{
    /// <summary>Handles a request to soft-delete an item.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the command to its handler.</param>
    /// <returns>No content, or a problem describing why it could not be deleted.</returns>
    internal static async Task<Results<NoContent, ProblemHttpResult>> Handle(
        Guid itemId,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher
            .SendAsync<DeleteItem, ItemId>(new DeleteItem(ItemId.From(itemId)), httpContext.RequestAborted)
            .ConfigureAwait(false);

        // No body on success, including when the item was already deleted. The status is the whole
        // answer, and a client retrying after a dropped response gets the same one.
        return result.Match<Results<NoContent, ProblemHttpResult>>(
            _ => TypedResults.NoContent(),
            error => TypedResults.Problem(ItemEndpoints.Problem(httpContext, error)));
    }
}
