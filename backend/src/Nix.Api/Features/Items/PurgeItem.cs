using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Items;

public sealed record PurgeItem(ItemId ItemId) : ICommand<ItemId>;

public sealed class PurgeItemHandler : ICommandHandler<PurgeItem, ItemId>
{
    private readonly IItemTree _tree;
    private readonly IPermissionResolver _permissions;
    private readonly INixSessionContextAccessor _session;
    private readonly TimeProvider _clock;
    private readonly IItemLocks _locks;
    private readonly IFinanceMutationGuard? _financeGuard;
    private readonly ISiteStore? _sites;
    public PurgeItemHandler(IItemTree tree, IPermissionResolver permissions, INixSessionContextAccessor session, TimeProvider clock, IItemLocks locks, IFinanceMutationGuard? financeGuard = null, ISiteStore? sites = null) => (_tree, _permissions, _session, _clock, _locks, _financeGuard, _sites) = (tree, permissions, session, clock, locks, financeGuard, sites);

    public async ValueTask<Result<ItemId>> HandleAsync(PurgeItem command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var item = await _tree.FindStoredAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
        if (item is null || !await _permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ItemId>(ItemErrors.NotFound($"No item {command.ItemId} is visible."));
        }
        if (item.LifecycleState != ItemLifecycleState.Deleted)
        {
            return Result.Failure<ItemId>(ItemErrors.LifecycleConflict("Only an item in Trash can be permanently deleted."));
        }

        if (_financeGuard is not null)
        {
            var workspaceId = item.WorkspaceId;
            var blocked = await _financeGuard.CheckAsync(workspaceId, item.Id, null, true, cancellationToken, allowOpenTransaction: true).ConfigureAwait(false);
            if (blocked is not null)
            {
                return Result.Failure<ItemId>(blocked.Value);
            }
            item = await _tree.FindStoredAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
            if (item is null || item.WorkspaceId != workspaceId || item.LifecycleState != ItemLifecycleState.Deleted
                || !await _permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
            {
                return Result.Failure<ItemId>(ItemErrors.NotFound($"No deleted item {command.ItemId} is visible."));
            }
        }
        // The root of a live site, or of one whose files are still being deleted, stays until the
        // site is unpublished and drained, as a workspace purge does.
        if (_sites is not null && await _sites.HasLiveOrStoredSiteAsync(item.WorkspaceId, item.Id, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ItemId>(ItemErrors.LifecycleConflict("This item is the root of a published site. Unpublish the site before deleting it permanently."));
        }
        // Purging moves the item's children up to its parent, out from under its lock and any lock
        // above it. Whoever does that must have those locks open, the rule a move follows.
        if (!await _locks.MayReadBodyAsync(item.Id, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ItemId>(ItemErrors.Locked($"Item {item.Id} is locked. Unlock it before deleting it permanently."));
        }
        var context = _session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var now = _clock.GetUtcNow();
        await _tree.ReparentChildrenAsync(item.WorkspaceId, item.Id, item.ParentId, context.PrincipalId, now, cancellationToken).ConfigureAwait(false);
        await _tree.SetLifecycleAsync(item.Id, ItemLifecycleState.Purged, context.PrincipalId, now, cancellationToken).ConfigureAwait(false);
        return Result.Success(item.Id);
    }
}

internal static class PurgeItemEndpoint
{
    internal static async Task<Results<NoContent, ProblemHttpResult>> Handle(Guid itemId, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        (await dispatcher.SendAsync<PurgeItem, ItemId>(new PurgeItem(ItemId.From(itemId)), context.RequestAborted).ConfigureAwait(false)).Match<Results<NoContent, ProblemHttpResult>>(_ => TypedResults.NoContent(), error => TypedResults.Problem(ItemEndpoints.Problem(context, error)));
}
