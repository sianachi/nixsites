using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Tests.Support;

/// <summary>
/// An item tree whose every required member throws, so a test double overrides only the calls
/// its handler is expected to make and any other call fails the test.
/// </summary>
internal abstract class ThrowingItemTree : IItemTree
{
    public virtual ValueTask<Item?> FindAsync(ItemId id, CancellationToken cancellationToken) => throw new NotSupportedException();

    public virtual ValueTask<Item?> FindStoredAsync(ItemId id, CancellationToken cancellationToken) => throw new NotSupportedException();

    public virtual ValueTask<IReadOnlySet<ItemId>> WithChildrenAsync(WorkspaceId workspaceId, IReadOnlyList<ItemId> parents, CancellationToken cancellationToken) => throw new NotSupportedException();

    public virtual ValueTask<IReadOnlyList<Item>> ListChildrenAsync(WorkspaceId workspaceId, ItemId? parentId, bool includeDeleted, long? afterSeq, int limit, CancellationToken cancellationToken) => throw new NotSupportedException();

    public virtual ValueTask<bool> WorkspaceExistsAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => throw new NotSupportedException();

    public virtual ValueTask<long> NextSiblingSequenceAsync(WorkspaceId workspaceId, ItemId? parentId, CancellationToken cancellationToken) => throw new NotSupportedException();

    public virtual ValueTask<long> AllocateSiblingSequenceAsync(WorkspaceId workspaceId, ItemId? parentId, ItemId movingId, ItemId? afterId, CancellationToken cancellationToken) => throw new NotSupportedException();

    public virtual ValueTask InsertAsync(Item item, CancellationToken cancellationToken) => throw new NotSupportedException();

    public virtual ValueTask UpdatePropertiesAsync(ItemId id, string properties, PrincipalId actor, DateTimeOffset at, CancellationToken cancellationToken) => throw new NotSupportedException();

    public virtual ValueTask UpdateSchemaAsync(ItemId id, string? schema, PrincipalId actor, DateTimeOffset at, CancellationToken cancellationToken) => throw new NotSupportedException();

    public virtual ValueTask UpdateViewsAsync(ItemId id, string? views, PrincipalId actor, DateTimeOffset at, CancellationToken cancellationToken) => throw new NotSupportedException();

    public virtual ValueTask TouchAsync(ItemId id, PrincipalId actor, DateTimeOffset at, CancellationToken cancellationToken) => throw new NotSupportedException();

    public virtual ValueTask<bool> WouldCreateCycleAsync(ItemId id, ItemId parentId, CancellationToken cancellationToken) => throw new NotSupportedException();

    public virtual ValueTask ReparentAsync(ItemId id, ItemId? newParentId, long seq, PrincipalId actor, DateTimeOffset at, CancellationToken cancellationToken) => throw new NotSupportedException();

    public virtual ValueTask SetLifecycleAsync(ItemId id, ItemLifecycleState state, PrincipalId actor, DateTimeOffset at, CancellationToken cancellationToken) => throw new NotSupportedException();
}
