using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Features.Items;
using Nix.Tests.Support;

namespace Nix.Tests.Features.Items;

/// <summary>The access, lock and not-found decision table of the visible-item gate.</summary>
public sealed class VisibleItemsTests
{
    private static readonly TenantId Tenant = TenantId.From(Guid.NewGuid());
    private static readonly WorkspaceId Workspace = WorkspaceId.From(Guid.NewGuid());
    private static readonly PrincipalId Principal = PrincipalId.From(Guid.NewGuid());
    private static readonly ItemId TheItem = ItemId.From(Guid.NewGuid());

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Theory]
    [InlineData(ItemAccess.Read)]
    [InlineData(ItemAccess.Comment)]
    [InlineData(ItemAccess.Write)]
    [InlineData(ItemAccess.Manage)]
    public async Task Each_access_level_is_granted_only_by_its_own_permission(ItemAccess granted)
    {
        var gate = Gate(Item(), granted);

        foreach (var asked in Enum.GetValues<ItemAccess>())
        {
            var result = await gate.FindAsync(TheItem, asked, Cancellation);

            Assert.Equal(asked == granted, result.IsSuccess);
            if (asked != granted)
            {
                Assert.Equal("items.not_found", result.Error.Code);
            }
        }
    }

    [Fact]
    public async Task An_item_the_tree_does_not_return_is_not_found_with_the_default_detail()
    {
        var result = await Gate(null, ItemAccess.Manage).FindAsync(TheItem, ItemAccess.Read, Cancellation);

        Assert.Equal("items.not_found", result.Error.Code);
        Assert.Equal($"No item {TheItem} is visible.", result.Error.Message);
    }

    [Fact]
    public async Task The_caller_can_name_the_not_found_detail()
    {
        var result = await Gate(null, ItemAccess.Manage)
            .FindAsync(TheItem, ItemAccess.Read, Cancellation, notFoundDetail: "No movable item is visible.");

        Assert.Equal("No movable item is visible.", result.Error.Message);
    }

    [Fact]
    public async Task A_lock_is_ignored_unless_the_caller_asks_for_an_open_body()
    {
        var result = await Gate(Item(), ItemAccess.Write, locked: true).FindAsync(TheItem, ItemAccess.Write, Cancellation);

        Assert.True(result.IsSuccess);
    }

    [Fact]
    public async Task A_locked_body_is_refused_with_the_callers_detail_to_a_caller_who_may_see_the_item()
    {
        var result = await Gate(Item(), ItemAccess.Read, locked: true)
            .FindAsync(TheItem, ItemAccess.Read, Cancellation, lockedDetail: "Unlock it first.");

        Assert.Equal("items.locked", result.Error.Code);
        Assert.Equal("Unlock it first.", result.Error.Message);
    }

    [Fact]
    public async Task A_locked_item_is_not_found_not_locked_to_a_caller_without_the_access()
    {
        var result = await Gate(Item(), ItemAccess.Read, locked: true)
            .FindAsync(TheItem, ItemAccess.Write, Cancellation, lockedDetail: "Unlock it first.");

        Assert.Equal("items.not_found", result.Error.Code);
    }

    [Fact]
    public async Task An_open_body_is_returned_when_the_caller_asks_for_one()
    {
        var result = await Gate(Item(), ItemAccess.Read)
            .FindAsync(TheItem, ItemAccess.Read, Cancellation, lockedDetail: "Unlock it first.");

        Assert.Equal(TheItem, result.Value.Id);
    }

    [Fact]
    public async Task A_deleted_item_from_the_tree_is_a_broken_store_not_a_caller_error()
    {
        var gate = Gate(Item(ItemLifecycleState.Deleted), ItemAccess.Read);

        await Assert.ThrowsAsync<InvalidOperationException>(
            async () => await gate.FindAsync(TheItem, ItemAccess.Read, Cancellation));
    }

    [Fact]
    public async Task A_template_item_from_the_tree_is_a_broken_store_not_a_caller_error()
    {
        var gate = Gate(Item(template: TemplateId.From(Guid.NewGuid())), ItemAccess.Read);

        await Assert.ThrowsAsync<InvalidOperationException>(
            async () => await gate.FindAsync(TheItem, ItemAccess.Read, Cancellation));
    }

    private static VisibleItems Gate(Item? item, ItemAccess granted, bool locked = false) =>
        new(new Tree(item), new Permissions(granted), new Locks(locked));

    private static Item Item(ItemLifecycleState state = ItemLifecycleState.Active, TemplateId? template = null) => new()
    {
        Id = TheItem,
        TenantId = Tenant,
        WorkspaceId = Workspace,
        Type = "note",
        Seq = 1000,
        Properties = "{}",
        LifecycleState = state,
        TemplateId = template,
        CreatedBy = Principal,
        LastModifiedBy = Principal,
        CreatedAt = DateTimeOffset.UnixEpoch,
        LastModifiedAt = DateTimeOffset.UnixEpoch,
    };

    private sealed class Tree(Item? item) : ThrowingItemTree
    {
        public override ValueTask<Item?> FindAsync(ItemId id, CancellationToken cancellationToken) =>
            ValueTask.FromResult(item?.Id == id ? item : null);
    }

    private sealed class Permissions(ItemAccess granted) : IPermissionResolver
    {
        public ValueTask<bool> CanReadWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(granted == ItemAccess.Read);

        public ValueTask<bool> CanCommentWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(granted == ItemAccess.Comment);

        public ValueTask<bool> CanWriteWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(granted == ItemAccess.Write);

        public ValueTask<bool> CanManageWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(granted == ItemAccess.Manage);

        public ValueTask<IReadOnlyList<WorkspaceId>> ReadableWorkspacesAsync(CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask<bool> IsTenantAdministratorAsync(CancellationToken cancellationToken) =>
            throw new NotSupportedException();
    }

    private sealed class Locks(bool locked) : IItemLocks
    {
        public ValueTask<bool> MayReadBodyAsync(ItemId itemId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(!locked);

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
