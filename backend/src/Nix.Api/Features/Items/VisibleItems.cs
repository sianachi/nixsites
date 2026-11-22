using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;

namespace Nix.Features.Items;

/// <summary>Implements <see cref="IVisibleItems"/> over the item tree, the permission resolver and the locks.</summary>
public sealed class VisibleItems(IItemTree tree, IPermissionResolver permissions, IItemLocks locks) : IVisibleItems
{
    /// <inheritdoc />
    public async ValueTask<Result<Item>> FindAsync(
        ItemId id,
        ItemAccess access,
        CancellationToken cancellationToken,
        string? notFoundDetail = null,
        string? lockedDetail = null)
    {
        var item = await tree.FindAsync(id, cancellationToken).ConfigureAwait(false);
        if (item is null || !await MayAsync(item.WorkspaceId, access, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Item>(ItemErrors.NotFound(notFoundDetail ?? $"No item {id} is visible."));
        }

        // The tree's visibility query only returns active, non-template items; a violation here is a
        // broken store, not a caller error.
        if (item.LifecycleState != ItemLifecycleState.Active || item.TemplateId is not null)
        {
            throw new InvalidOperationException($"The item tree returned item {id}, which is not an active ordinary item.");
        }

        if (lockedDetail is not null && !await locks.MayReadBodyAsync(item.Id, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Item>(ItemErrors.Locked(lockedDetail));
        }

        return Result.Success(item);
    }

    private ValueTask<bool> MayAsync(WorkspaceId workspace, ItemAccess access, CancellationToken cancellationToken) =>
        access switch
        {
            ItemAccess.Read => permissions.CanReadWorkspaceAsync(workspace, cancellationToken),
            ItemAccess.Comment => permissions.CanCommentWorkspaceAsync(workspace, cancellationToken),
            ItemAccess.Write => permissions.CanWriteWorkspaceAsync(workspace, cancellationToken),
            ItemAccess.Manage => permissions.CanManageWorkspaceAsync(workspace, cancellationToken),
            _ => throw new ArgumentOutOfRangeException(nameof(access)),
        };
}
