using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Features.Items;
using Nix.Tests.Support;

namespace Nix.Tests.Features.Items;

public sealed class WorkspaceItemMoveTests
{
    private static readonly TenantId Tenant = TenantId.From(Guid.NewGuid());
    private static readonly WorkspaceId Source = WorkspaceId.From(Guid.NewGuid());
    private static readonly WorkspaceId Destination = WorkspaceId.From(Guid.NewGuid());
    private static readonly PrincipalId Principal = PrincipalId.From(Guid.NewGuid());
    private static readonly ItemId TheItem = ItemId.From(Guid.NewGuid());
    private static readonly ItemId Parent = ItemId.From(Guid.NewGuid());
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Transfer_requires_write_permission_on_both_workspaces(bool sourceWritable)
    {
        var tree = new RecordingTree(MakeItem(Source));
        var handler = new MoveItemHandler(tree, new Permissions(sourceWritable ? Destination : Source),
            new Session(), TimeProvider.System, new Locks(null));
        var result = await handler.HandleAsync(new MoveItem(TheItem, null, null, Destination), Cancellation);
        Assert.True(result.IsFailure);
        Assert.Equal(0, tree.TransferCalls);
    }

    [Fact]
    public async Task Transfer_to_workspace_root_preserves_identity_and_the_items_own_lock()
    {
        var tree = new RecordingTree(MakeItem(Source));
        var handler = new MoveItemHandler(tree, new Permissions(null), new Session(), TimeProvider.System, new Locks(TheItem));
        var result = await handler.HandleAsync(new MoveItem(TheItem, null, null, Destination), Cancellation);
        Assert.True(result.IsSuccess);
        Assert.Equal(TheItem, result.Value.Id);
        Assert.Equal(Destination, result.Value.WorkspaceId);
        Assert.Null(result.Value.ParentId);
        Assert.Equal(1, tree.TransferCalls);
    }

    [Fact]
    public async Task Transfer_cannot_leave_a_closed_ancestor_lock()
    {
        var tree = new RecordingTree(MakeItem(Source, Parent));
        var handler = new MoveItemHandler(tree, new Permissions(null), new Session(), TimeProvider.System, new Locks(Parent));
        var result = await handler.HandleAsync(new MoveItem(TheItem, null, null, Destination), Cancellation);
        Assert.Equal("items.locked", result.Error.Code);
        Assert.Equal(0, tree.TransferCalls);
    }

    [Fact]
    public async Task A_purged_item_cannot_be_transferred()
    {
        var tree = new RecordingTree(MakeItem(Source, state: ItemLifecycleState.Purged));
        var handler = new MoveItemHandler(tree, new Permissions(null), new Session(), TimeProvider.System, new Locks(null));
        var result = await handler.HandleAsync(new MoveItem(TheItem, null, null, Destination), Cancellation);
        Assert.Equal("items.lifecycle_conflict", result.Error.Code);
        Assert.Equal(0, tree.TransferCalls);
    }

    private static Item MakeItem(WorkspaceId workspace, ItemId? parent = null, ItemLifecycleState state = ItemLifecycleState.Active) => new()
    {
        Id = TheItem,
        TenantId = Tenant,
        WorkspaceId = workspace,
        ParentId = parent,
        Type = "note",
        Seq = 1000,
        Properties = "{}",
        LifecycleState = state,
        CreatedBy = Principal,
        LastModifiedBy = Principal,
        CreatedAt = DateTimeOffset.UnixEpoch,
        LastModifiedAt = DateTimeOffset.UnixEpoch,
    };
    private sealed class Session : INixSessionContextAccessor
    {
        public NixSessionContext? Current => NixSessionContext.ForTenant(Tenant, Principal);
    }
    private sealed class Permissions(WorkspaceId? refused) : IPermissionResolver
    {
        public ValueTask<bool> CanReadWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(true);
        public ValueTask<bool> CanWriteWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(workspaceId != refused);
        public ValueTask<bool> CanCommentWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(false);

        public ValueTask<bool> CanManageWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(false);
        public ValueTask<IReadOnlyList<WorkspaceId>> ReadableWorkspacesAsync(CancellationToken cancellationToken) => ValueTask.FromResult<IReadOnlyList<WorkspaceId>>([Source, Destination]);
        public ValueTask<bool> IsTenantAdministratorAsync(CancellationToken cancellationToken) => ValueTask.FromResult(false);
    }
    private sealed class RecordingTree(Item? item) : ThrowingItemTree, IItemTree
    {
        public Item? DestinationParent { get; set; }
        public int TransferCalls { get; private set; }
        public override ValueTask<Item?> FindAsync(ItemId id, CancellationToken cancellationToken) =>
            ValueTask.FromResult(item?.Id == id ? item : DestinationParent?.Id == id ? DestinationParent : null);

        public ValueTask<string?> TransferWorkspaceAsync(ItemId id, WorkspaceId sourceWorkspaceId,
            WorkspaceId destinationWorkspaceId, ItemId? newParentId, ItemId? afterId, PrincipalId actor,
            DateTimeOffset at, CancellationToken cancellationToken)
        {
            TransferCalls++;
            item = MakeItem(destinationWorkspaceId, newParentId);
            return ValueTask.FromResult<string?>(null);
        }

        public override ValueTask<Item?> FindStoredAsync(ItemId id, CancellationToken cancellationToken) =>
            FindAsync(id, cancellationToken);

        public override ValueTask<bool> WorkspaceExistsAsync(
            WorkspaceId workspaceId,
            CancellationToken cancellationToken) => ValueTask.FromResult(true);

        public override ValueTask<long> NextSiblingSequenceAsync(
            WorkspaceId workspaceId,
            ItemId? parentId,
            CancellationToken cancellationToken) => ValueTask.FromResult(1000L);

        public override ValueTask UpdatePropertiesAsync(
            ItemId id,
            string properties,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken)
        {
            item = item is null ? null : new Item
            {
                Id = item.Id,
                TenantId = item.TenantId,
                WorkspaceId = item.WorkspaceId,
                Type = item.Type,
                ParentId = item.ParentId,
                Seq = item.Seq,
                Properties = properties,
                Schema = item.Schema,
                Views = item.Views,
                LifecycleState = item.LifecycleState,
                CreatedBy = item.CreatedBy,
                LastModifiedBy = actor,
                CreatedAt = item.CreatedAt,
                LastModifiedAt = at,
            };
            return ValueTask.CompletedTask;
        }

    }

    private sealed class Locks(ItemId? closed) : IItemLocks
    {
        public ValueTask<bool> MayReadBodyAsync(ItemId itemId, CancellationToken cancellationToken) => ValueTask.FromResult(itemId != closed);
        public ValueTask<ItemLockState> GetStateAsync(ItemId itemId, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<bool> AnyInSubtreeAsync(ItemId itemId, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<IReadOnlySet<ItemId>> LockedAmongAsync(IReadOnlyList<ItemId> itemIds, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<string?> FindVerifierAsync(ItemId itemId, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<bool> LockAsync(ItemId itemId, string verifier, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<bool> ChangeVerifierAsync(ItemId itemId, string expected, string verifier, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<bool> RemoveAsync(ItemId itemId, string expected, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<bool> GrantAsync(ItemId itemId, string verifier, DateTimeOffset expiresAt, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<bool> IsLockedAsync(ItemId itemId, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask RevokeAsync(ItemId itemId, CancellationToken cancellationToken) => throw new NotSupportedException();
    }
}
