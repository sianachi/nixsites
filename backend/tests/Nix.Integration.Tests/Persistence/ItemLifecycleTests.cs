using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Features.Items;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Moving, deleting and restoring, driven through the use cases a request would reach.
/// </summary>
/// <remarks>
/// The closure property test already proves the tree and its derived edges agree after any sequence
/// of moves. What is left is everything around that: the refusals, the sibling ordering, and the
/// claim that soft deletion is reversible. Those are the parts a user meets - dragging a folder into
/// its own child, deleting a note and wanting it back - so they are tested as operations rather than
/// as store calls.
/// </remarks>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class ItemLifecycleTests : IAsyncLifetime
{
    private static readonly Guid OtherWorkspace = new("3a3a3a3a-1111-4111-8111-3a3a3a3a3a3a");
    private static readonly Guid OtherWorkspaceItem = new("3b3b3b3b-1111-4111-8111-3b3b3b3b3b3b");

    private readonly NixPostgresFixture _fixture;

    public ItemLifecycleTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static WorkspaceId Workspace => WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_move_places_the_item_immediately_after_the_named_sibling()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();

            var first = await NewItemAsync(dispatcher, "First", null);
            var second = await NewItemAsync(dispatcher, "Second", null);
            var third = await NewItemAsync(dispatcher, "Third", null);

            var moved = await dispatcher.SendAsync<MoveItem, Item>(
                new MoveItem(third.Id, null, first.Id), Cancellation);
            Assert.True(moved.IsSuccess);

            var roots = await ListRootsAsync(dispatcher);

            Assert.Equal([first.Id, third.Id, second.Id], roots);
        }
    }

    [Fact]
    public async Task A_move_with_no_named_sibling_places_the_item_first()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();

            var first = await NewItemAsync(dispatcher, "First", null);
            var second = await NewItemAsync(dispatcher, "Second", null);

            Assert.True((await dispatcher.SendAsync<MoveItem, Item>(
                new MoveItem(second.Id, null, null), Cancellation)).IsSuccess);

            var roots = await ListRootsAsync(dispatcher);
            Assert.Equal(second.Id, roots[0]);
            Assert.Equal(first.Id, roots[1]);
        }
    }

    [Fact]
    public async Task Repeated_placement_at_the_front_keeps_working_after_the_gap_runs_out()
    {
        // Positions are sparse and halving the minimum closes the gap in about ten moves, so this
        // is the only test that reaches the renumber fallback. Without it the fallback is code that
        // has never run, which is the same as code that does not work.
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();

            var items = new List<ItemId>();
            for (var index = 0; index < 4; index++)
            {
                items.Add((await NewItemAsync(dispatcher, $"Item {index}", null)).Id);
            }

            // Each pass sends the current last item to the front, so the front gap halves every
            // time and eventually cannot be halved again.
            for (var pass = 0; pass < 20; pass++)
            {
                var subject = items[^1];
                Assert.True((await dispatcher.SendAsync<MoveItem, Item>(
                    new MoveItem(subject, null, null), Cancellation)).IsSuccess);

                items.RemoveAt(items.Count - 1);
                items.Insert(0, subject);

                Assert.Equal(items, await ListRootsAsync(dispatcher));
            }
        }
    }

    [Fact]
    public async Task A_listing_rejects_a_parent_from_another_readable_workspace()
    {
        await SeedOtherWorkspaceAsync();

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var page = await work.Resolve<NixDispatcher>()
                .QueryAsync<ListItems, Result<IReadOnlyList<Item>>>(
                    new ListItems(Workspace, ItemId.From(OtherWorkspaceItem), true, null, 200),
                    Cancellation);

            Assert.True(page.IsFailure);
            Assert.Equal("items.parent_not_found", page.Error.Code);
        }
    }

    [Fact]
    public async Task A_move_ordered_after_a_sibling_of_a_different_parent_is_refused()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();

            var folder = await NewItemAsync(dispatcher, "Folder", null);
            var elsewhere = await NewItemAsync(dispatcher, "Elsewhere", null);
            var subject = await NewItemAsync(dispatcher, "Subject", null);

            var moved = await dispatcher.SendAsync<MoveItem, Item>(
                new MoveItem(subject.Id, folder.Id, elsewhere.Id), Cancellation);

            Assert.True(moved.IsFailure);
            Assert.Equal("items.sibling_not_in_destination", moved.Error.Code);

            // Refused means unchanged: the item is still where it was, not half-moved.
            var unchanged = await dispatcher.QueryAsync<GetItem, Result<Item>>(
                new GetItem(subject.Id), Cancellation);
            Assert.Null(unchanged.Value.ParentId);
        }
    }

    [Fact]
    public async Task A_move_into_a_deleted_parent_is_refused()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();

            var folder = await NewItemAsync(dispatcher, "Folder", null);
            var subject = await NewItemAsync(dispatcher, "Subject", null);

            Assert.True((await dispatcher.SendAsync<DeleteItem, ItemId>(
                new DeleteItem(folder.Id), Cancellation)).IsSuccess);

            var moved = await dispatcher.SendAsync<MoveItem, Item>(
                new MoveItem(subject.Id, folder.Id, null), Cancellation);

            Assert.True(moved.IsFailure);
            // Deleted and nonexistent parents are intentionally indistinguishable at the public
            // boundary; naming the lifecycle state would disclose that the identifier is real.
            Assert.Equal("items.parent_not_found", moved.Error.Code);
        }
    }

    [Fact]
    public async Task A_move_into_another_workspace_is_refused()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var subject = await NewItemAsync(dispatcher, "Subject", null);

            // Beta's item is in another tenant entirely, so this also confirms the refusal happens
            // before anything is written rather than being caught by a constraint afterwards.
            var moved = await dispatcher.SendAsync<MoveItem, Item>(
                new MoveItem(subject.Id, ItemId.From(M0SchemaSeed.Beta.ItemId), null), Cancellation);

            Assert.True(moved.IsFailure);
            Assert.Equal("items.parent_not_found", moved.Error.Code);
        }
    }

    [Fact]
    public async Task Deleting_hides_an_item_from_listings_and_restoring_brings_it_back()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var subject = await NewItemAsync(dispatcher, "Subject", null);

            Assert.True((await dispatcher.SendAsync<DeleteItem, ItemId>(
                new DeleteItem(subject.Id), Cancellation)).IsSuccess);
            Assert.DoesNotContain(subject.Id, await ListRootsAsync(dispatcher));

            var direct = await dispatcher.QueryAsync<GetItem, Result<Item>>(
                new GetItem(subject.Id), Cancellation);
            Assert.True(direct.IsFailure);
            Assert.Equal("items.not_found", direct.Error.Code);

            // Still there when asked for deliberately: soft deletion hides, it does not destroy.
            Assert.Contains(subject.Id, await ListRootsAsync(dispatcher, includeDeleted: true));

            var restored = await dispatcher.SendAsync<RestoreItem, Item>(
                new RestoreItem(subject.Id), Cancellation);
            Assert.True(restored.IsSuccess);
            Assert.Equal(ItemLifecycleState.Active, restored.Value.LifecycleState);
            Assert.Contains(subject.Id, await ListRootsAsync(dispatcher));
        }
    }

    [Fact]
    public async Task Deleting_a_folder_leaves_its_children_in_place()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();

            var folder = await NewItemAsync(dispatcher, "Folder", null);
            var child = await NewItemAsync(dispatcher, "Child", folder.Id);

            Assert.True((await dispatcher.SendAsync<DeleteItem, ItemId>(
                new DeleteItem(folder.Id), Cancellation)).IsSuccess);

            // The child row is untouched: still active, still parented. Ordinary reads cannot see
            // through the deleted folder, while the lifecycle-only store seam proves nothing was
            // rewritten and restoring the folder remains one flag flip.
            var hidden = await dispatcher.QueryAsync<GetItem, Result<Item>>(
                new GetItem(child.Id), Cancellation);
            Assert.True(hidden.IsFailure);
            Assert.Equal("items.not_found", hidden.Error.Code);

            var stillThere = await work.Resolve<IItemTree>().FindStoredAsync(child.Id, Cancellation);
            Assert.NotNull(stillThere);
            Assert.Equal(ItemLifecycleState.Active, stillThere.LifecycleState);
            Assert.Equal(folder.Id, stillThere.ParentId);

            var children = await dispatcher.QueryAsync<ListItems, Result<IReadOnlyList<Item>>>(
                new ListItems(Workspace, folder.Id, true, null, 200), Cancellation);
            Assert.True(children.IsFailure);
            Assert.Equal("items.parent_not_found", children.Error.Code);
        }
    }

    [Fact]
    public async Task An_active_child_hidden_below_a_deleted_parent_cannot_be_deleted_by_identifier()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var folder = await NewItemAsync(dispatcher, "Folder", null);
            var child = await NewItemAsync(dispatcher, "Child", folder.Id);

            Assert.True((await dispatcher.SendAsync<DeleteItem, ItemId>(
                new DeleteItem(folder.Id), Cancellation)).IsSuccess);

            var deleted = await dispatcher.SendAsync<DeleteItem, ItemId>(
                new DeleteItem(child.Id), Cancellation);

            Assert.True(deleted.IsFailure);
            Assert.Equal("items.not_found", deleted.Error.Code);
            Assert.Equal(
                ItemLifecycleState.Active,
                (await work.Resolve<IItemTree>().FindStoredAsync(child.Id, Cancellation))?.LifecycleState);
        }
    }

    [Fact]
    public async Task An_active_child_hidden_below_a_deleted_parent_cannot_be_restored_by_identifier()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var folder = await NewItemAsync(dispatcher, "Folder", null);
            var child = await NewItemAsync(dispatcher, "Child", folder.Id);

            Assert.True((await dispatcher.SendAsync<DeleteItem, ItemId>(
                new DeleteItem(folder.Id), Cancellation)).IsSuccess);

            var restored = await dispatcher.SendAsync<RestoreItem, Item>(
                new RestoreItem(child.Id), Cancellation);

            Assert.True(restored.IsFailure);
            Assert.Equal("items.not_found", restored.Error.Code);
            Assert.Equal(
                ItemLifecycleState.Active,
                (await work.Resolve<IItemTree>().FindStoredAsync(child.Id, Cancellation))?.LifecycleState);
        }
    }

    [Fact]
    public async Task Restoring_a_child_below_a_deleted_parent_succeeds_but_keeps_it_hidden()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var folder = await NewItemAsync(dispatcher, "Folder", null);
            var child = await NewItemAsync(dispatcher, "Child", folder.Id);

            Assert.True((await dispatcher.SendAsync<DeleteItem, ItemId>(
                new DeleteItem(child.Id), Cancellation)).IsSuccess);
            Assert.True((await dispatcher.SendAsync<DeleteItem, ItemId>(
                new DeleteItem(folder.Id), Cancellation)).IsSuccess);

            var restored = await dispatcher.SendAsync<RestoreItem, Item>(
                new RestoreItem(child.Id), Cancellation);

            Assert.True(restored.IsSuccess);
            Assert.Equal(ItemLifecycleState.Active, restored.Value.LifecycleState);

            var hidden = await dispatcher.QueryAsync<GetItem, Result<Item>>(
                new GetItem(child.Id), Cancellation);
            Assert.True(hidden.IsFailure);
            Assert.Equal("items.not_found", hidden.Error.Code);
        }
    }

    [Theory]
    [InlineData(ItemLifecycleState.Deleted)]
    [InlineData(ItemLifecycleState.Purged)]
    [InlineData(ItemLifecycleState.Provisioning)]
    public async Task An_active_child_below_a_nonactive_ancestor_is_not_visible(
        ItemLifecycleState ancestorState)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var folder = await NewItemAsync(dispatcher, "Folder", null);
            var child = await NewItemAsync(dispatcher, "Child", folder.Id);
            var tree = work.Resolve<IItemTree>();

            await tree.SetLifecycleAsync(
                folder.Id,
                ancestorState,
                folder.LastModifiedBy,
                DateTimeOffset.UtcNow,
                Cancellation);

            Assert.Null(await tree.FindAsync(child.Id, Cancellation));
            Assert.Equal(
                ItemLifecycleState.Active,
                (await tree.FindStoredAsync(child.Id, Cancellation))?.LifecycleState);
        }
    }

    [Fact]
    public async Task An_active_ordinary_child_below_a_template_owned_ancestor_is_not_visible()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var folder = await NewItemAsync(dispatcher, "Folder", null);
            var child = await NewItemAsync(dispatcher, "Child", folder.Id);

            await work.DbContext.Items
                .IgnoreQueryFilters()
                .Where(item => item.Id == folder.Id)
                .ExecuteUpdateAsync(
                    update => update
                        .SetProperty(
                            item => item.TemplateId,
                            TemplateId.From(M0SchemaSeed.Alpha.TemplateId))
                        .SetProperty(item => item.TemplateSourceId, Guid.NewGuid()),
                    Cancellation);

            var tree = work.Resolve<IItemTree>();
            Assert.Null(await tree.FindAsync(child.Id, Cancellation));
            Assert.Equal(
                ItemLifecycleState.Active,
                (await tree.FindStoredAsync(child.Id, Cancellation))?.LifecycleState);
        }
    }

    [Fact]
    public async Task Deleting_twice_succeeds_the_second_time()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var subject = await NewItemAsync(dispatcher, "Subject", null);

            Assert.True((await dispatcher.SendAsync<DeleteItem, ItemId>(
                new DeleteItem(subject.Id), Cancellation)).IsSuccess);

            // A client retrying after a dropped response asked for a state, and the state holds.
            Assert.True((await dispatcher.SendAsync<DeleteItem, ItemId>(
                new DeleteItem(subject.Id), Cancellation)).IsSuccess);
        }
    }

    [Fact]
    public async Task A_purged_item_cannot_be_restored()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var subject = await NewItemAsync(dispatcher, "Subject", null);

            await work.Resolve<IItemTree>().SetLifecycleAsync(
                subject.Id,
                ItemLifecycleState.Purged,
                subject.CreatedBy,
                DateTimeOffset.UtcNow,
                Cancellation);

            var restored = await dispatcher.SendAsync<RestoreItem, Item>(
                new RestoreItem(subject.Id), Cancellation);

            Assert.True(restored.IsFailure);
            Assert.Equal("items.lifecycle_conflict", restored.Error.Code);
        }
    }

    [Fact]
    public async Task None_of_these_operations_reach_an_item_in_another_tenant()
    {
        var betaItem = ItemId.From(M0SchemaSeed.Beta.ItemId);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();

            var moved = await dispatcher.SendAsync<MoveItem, Item>(
                new MoveItem(betaItem, null, null), Cancellation);
            Assert.Equal("items.not_found", moved.Error.Code);

            var deleted = await dispatcher.SendAsync<DeleteItem, ItemId>(
                new DeleteItem(betaItem), Cancellation);
            Assert.Equal("items.not_found", deleted.Error.Code);

            var restored = await dispatcher.SendAsync<RestoreItem, Item>(
                new RestoreItem(betaItem), Cancellation);
            Assert.Equal("items.not_found", restored.Error.Code);
        }
    }

    [Fact]
    public async Task An_item_with_no_children_says_so()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var leaf = await NewItemAsync(dispatcher, "Leaf", null);

            var withChildren = await dispatcher.QueryAsync<ItemsWithChildren, IReadOnlySet<ItemId>>(
                new ItemsWithChildren(Workspace, [leaf.Id]), Cancellation);

            // The whole point. Every item can hold children, so the tree would otherwise have to
            // offer an expand control on all of them - and every leaf would expand to nothing.
            Assert.DoesNotContain(leaf.Id, withChildren);
        }
    }

    [Fact]
    public async Task An_item_with_a_child_says_so()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var parent = await NewItemAsync(dispatcher, "Parent", null);
            await NewItemAsync(dispatcher, "Child", parent.Id);

            var withChildren = await dispatcher.QueryAsync<ItemsWithChildren, IReadOnlySet<ItemId>>(
                new ItemsWithChildren(Workspace, [parent.Id]), Cancellation);

            Assert.Contains(parent.Id, withChildren);
        }
    }

    [Fact]
    public async Task An_item_whose_only_child_is_deleted_has_no_children()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var parent = await NewItemAsync(dispatcher, "Parent", null);
            var child = await NewItemAsync(dispatcher, "Child", parent.Id);

            await dispatcher.SendAsync<DeleteItem, ItemId>(new DeleteItem(child.Id), Cancellation);

            // Deletion is soft, so the row is still there. Counting it would leave an expand
            // control on a parent whose contents are all in the bin, and expanding would show
            // nothing - which is the dishonest state this exists to prevent, arriving by the back
            // door.
            var withChildren = await dispatcher.QueryAsync<ItemsWithChildren, IReadOnlySet<ItemId>>(
                new ItemsWithChildren(Workspace, [parent.Id]), Cancellation);

            Assert.DoesNotContain(parent.Id, withChildren);
        }
    }

    [Fact]
    public async Task Restoring_the_child_brings_the_expand_control_back()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var parent = await NewItemAsync(dispatcher, "Parent", null);
            var child = await NewItemAsync(dispatcher, "Child", parent.Id);

            await dispatcher.SendAsync<DeleteItem, ItemId>(new DeleteItem(child.Id), Cancellation);
            await dispatcher.SendAsync<RestoreItem, Item>(new RestoreItem(child.Id), Cancellation);

            var withChildren = await dispatcher.QueryAsync<ItemsWithChildren, IReadOnlySet<ItemId>>(
                new ItemsWithChildren(Workspace, [parent.Id]), Cancellation);

            Assert.Contains(parent.Id, withChildren);
        }
    }

    [Fact]
    public async Task A_page_is_answered_in_one_question()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var withKids = await NewItemAsync(dispatcher, "Has children", null);
            var leafOne = await NewItemAsync(dispatcher, "Leaf one", null);
            var leafTwo = await NewItemAsync(dispatcher, "Leaf two", null);
            await NewItemAsync(dispatcher, "Child", withKids.Id);

            var withChildren = await dispatcher.QueryAsync<ItemsWithChildren, IReadOnlySet<ItemId>>(
                new ItemsWithChildren(Workspace, [withKids.Id, leafOne.Id, leafTwo.Id]), Cancellation);

            // Only the ones that have children come back, so the answer is the size of the answer
            // rather than the size of the question.
            Assert.Equal([withKids.Id], withChildren);
        }
    }

    [Fact]
    public async Task Asking_about_nothing_is_not_a_query()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();

            // An empty workspace lists no items, and the page-level lookup must not build a
            // statement with an empty array for it.
            var withChildren = await dispatcher.QueryAsync<ItemsWithChildren, IReadOnlySet<ItemId>>(
                new ItemsWithChildren(Workspace, []), Cancellation);

            Assert.Empty(withChildren);
        }
    }

    private static async Task<Item> NewItemAsync(NixDispatcher dispatcher, string title, ItemId? parentId)
    {
        var result = await dispatcher.SendAsync<CreateItem, Item>(
            new CreateItem(Workspace, "note", title, parentId, null), Cancellation);
        Assert.True(result.IsSuccess);
        return result.Value;
    }

    private async Task SeedOtherWorkspaceAsync()
    {
        var tenant = RawSql.Literal(M0SchemaSeed.Alpha.TenantId);
        var workspace = RawSql.Literal(OtherWorkspace);
        var item = RawSql.Literal(OtherWorkspaceItem);
        var principal = RawSql.Literal(M0SchemaSeed.Alpha.PrincipalId);

        var sql = $"""
            INSERT INTO workspace
                (workspace_id, tenant_id, name, version_retention_days, coalesce_window_min,
                 storage_quota_bytes, created_at)
            VALUES ({workspace}, {tenant}, 'other workspace', 30, 10, 1073741824, now());

            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                 purge_after, created_by, last_modified_by, created_at, last_modified_at)
            VALUES ({item}, {tenant}, {workspace}, 'note', NULL, 1000,
                    jsonb_build_object('title', 'Other parent'), 'active', NULL,
                    {principal}, {principal}, now(), now());

            INSERT INTO item_closure
                (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            VALUES ({item}, {item}, {tenant}, {workspace}, 0);
            """;

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    /// <summary>
    /// The workspace roots in sibling order, minus the row the schema seed placed there.
    /// </summary>
    private static async Task<IReadOnlyList<ItemId>> ListRootsAsync(
        NixDispatcher dispatcher,
        bool includeDeleted = false)
    {
        var seeded = ItemId.From(M0SchemaSeed.Alpha.ItemId);
        var page = await dispatcher.QueryAsync<ListItems, Result<IReadOnlyList<Item>>>(
            new ListItems(Workspace, null, includeDeleted, null, 200), Cancellation);

        Assert.True(page.IsSuccess);
        return [.. page.Value.Select(item => item.Id).Where(id => id != seeded)];
    }
}
