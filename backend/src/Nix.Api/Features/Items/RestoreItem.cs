using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Items;

/// <summary>Returns a soft-deleted item to the active state.</summary>
/// <param name="ItemId">The item.</param>
/// <remarks>
/// <para>
/// The inverse of <see cref="DeleteItem"/>, and deliberately just as small: one flag on one row.
/// The subtree was never rewritten, so there is nothing to reconstruct.
/// </para>
/// <para>
/// <b>Restoring an item whose parent is still deleted succeeds, and the item stays out of sight.</b>
/// Visibility is derived by walking down from a visible root, so the item is active and its
/// ancestor is not. Refusing instead would be defensible, but it makes restoring a subtree an
/// ordering puzzle for the caller, and the honest interface answer is a view that says why the item
/// is not where the user expected it - not a refusal that leaves them nowhere.
/// </para>
/// </remarks>
public sealed record RestoreItem(ItemId ItemId) : ICommand<Item>;

/// <summary>Returns a soft-deleted item to the active state.</summary>
/// <remarks>
/// <para>
/// The inverse of <see cref="DeleteItem"/>, and deliberately just as small: one flag on one row.
/// The subtree was never rewritten, so there is nothing to reconstruct.
/// </para>
/// <para>
/// <b>Restoring an item whose parent is still deleted succeeds, and the item stays out of sight.</b>
/// Visibility is derived by walking down from a visible root, so the item is active and its
/// ancestor is not. Refusing instead would be defensible, but it makes restoring a subtree an
/// ordering puzzle for the caller, and the honest interface answer is a view that says why the item
/// is not where the user expected it - not a refusal that leaves them nowhere.
/// </para>
/// </remarks>
public sealed class RestoreItemHandler(
    IItemTree tree,
    IPermissionResolver permissions,
    INixSessionContextAccessor session,
    TimeProvider clock,
    IFinanceMutationGuard? financeGuard = null)
    : ICommandHandler<RestoreItem, Item>
{
    private readonly INixSessionContextAccessor _session = session;

    /// <summary>Restores the item.</summary>
    /// <param name="command">The item to restore.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The restored item, or why it could not be restored.</returns>
    public async ValueTask<Result<Item>> HandleAsync(RestoreItem command, CancellationToken cancellationToken)
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
            return Result.Failure<Item>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        // An already-active row is idempotent only while it is visible. Otherwise a restore call
        // against a guessed descendant identifier would disclose the full item through a deleted
        // ancestor. A retry after restoring below a still-deleted parent therefore receives the
        // same non-answer as every other direct read; there is no request token that could prove it
        // is the caller whose earlier response was lost.
        if (item.LifecycleState == ItemLifecycleState.Active && visible is null)
        {
            return Result.Failure<Item>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        if (item.LifecycleState == ItemLifecycleState.Purged)
        {
            // The one lifecycle transition that is genuinely impossible: purging destroys the
            // content, so there is nothing to bring back and saying otherwise would be a lie.
            return Result.Failure<Item>(
                ItemErrors.LifecycleConflict("A purged item cannot be restored."));
        }

        if (item.LifecycleState == ItemLifecycleState.Active)
        {
            return Result.Success(visible!);
        }

        if (financeGuard is not null)
        {
            var blocked = await financeGuard.CheckAsync(item.WorkspaceId, itemId, null, true, cancellationToken, allowOpenTransaction: true).ConfigureAwait(false);
            if (blocked is not null)
            {
                return Result.Failure<Item>(blocked.Value);
            }
            item = await tree.FindStoredAsync(itemId, cancellationToken).ConfigureAwait(false);
            if (item is null || item.LifecycleState != ItemLifecycleState.Deleted)
            {
                return Result.Failure<Item>(ItemErrors.NotFound($"No deleted item {itemId} is visible."));
            }
        }

        var now = clock.GetUtcNow();
        await tree
            .SetLifecycleAsync(itemId, ItemLifecycleState.Active, context.PrincipalId, now, cancellationToken)
            .ConfigureAwait(false);

        // A restored child can deliberately remain hidden below a deleted parent. Read the stored
        // row here so that successful lifecycle transition is not misreported as disappearance.
        var restored = await tree.FindStoredAsync(itemId, cancellationToken).ConfigureAwait(false);

        return restored is null
            ? Result.Failure<Item>(ItemErrors.NotFound($"Item {itemId} disappeared during the restore."))
            : Result.Success(restored);
    }
}

/// <summary>
/// Route handler for restoring a soft-deleted item.
/// </summary>
/// <remarks>
/// Named apart from <see cref="RestoreItem"/> itself: the command record already owns that
/// identifier in this namespace, and a route handler with the same name would be an ambiguous
/// simple name at the <c>MapPost</c> call site.
/// </remarks>
internal static class RestoreItemEndpoint
{
    /// <summary>Handles a request to restore a soft-deleted item.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the command to its handler.</param>
    /// <returns>The restored item, or a problem describing why it could not be restored.</returns>
    internal static async Task<Results<Ok<ItemResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher
            .SendAsync<RestoreItem, Item>(new RestoreItem(ItemId.From(itemId)), httpContext.RequestAborted)
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
