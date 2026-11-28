using System.Globalization;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Bookmarks;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// A shelf belongs to one person, and it outlives access to what is on it.
/// </summary>
/// <remarks>
/// <para>
/// Two properties make this worth its own suite. A bookmark is <i>personal</i>, so one principal
/// reading another's shelf is a breach even inside one tenant and even between two people who share
/// every workspace. And a bookmark <i>persists</i> when access does not - losing membership does not
/// delete rows - so the list is the only thing standing between a stale row and the title of a
/// document somebody has been removed from.
/// </para>
/// <para>
/// Two tenants, and inside one tenant two principals who are members of the same workspace. The
/// second pair is the interesting one: row-level security has nothing to say about them, and only
/// the statement's principal predicate keeps one shelf out of the other's answer.
/// </para>
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class BookmarkShelfAuthorizationTests : IAsyncLifetime
{
    /// <summary>A second workspace in Alpha's tenant that only <see cref="Keeper"/> belongs to.</summary>
    private static readonly Guid PrivateWorkspace = new("8c6c6000-3333-4333-8333-8c6c60000001");

    /// <summary>An item in the shared workspace.</summary>
    private static readonly Guid SharedItem = new("8c6c6000-3333-4333-8333-8c6c60000002");

    /// <summary>A second item in the shared workspace.</summary>
    private static readonly Guid OtherItem = new("8c6c6000-3333-4333-8333-8c6c60000003");

    /// <summary>An item only <see cref="Keeper"/> can see.</summary>
    private static readonly Guid PrivateItem = new("8c6c6000-3333-4333-8333-8c6c60000004");

    /// <summary>An item that has been moved to the trash.</summary>
    private static readonly Guid TrashedItem = new("8c6c6000-3333-4333-8333-8c6c60000005");

    /// <summary>The principal whose shelf these tests are about.</summary>
    private static readonly Guid Keeper = new("8c6c6000-3333-4333-8333-8c6c60000006");

    /// <summary>Another member of the same workspace, with a shelf of their own.</summary>
    private static readonly Guid Neighbour = new("8c6c6000-3333-4333-8333-8c6c60000007");

    private readonly NixPostgresFixture _fixture;

    public BookmarkShelfAuthorizationTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static NixSessionContext KeeperContext => TestTenants.ContextFor(
        M0SchemaSeed.Alpha.TenantId,
        M0SchemaSeed.Alpha.WorkspaceId,
        Keeper);

    private static NixSessionContext NeighbourContext => TestTenants.ContextFor(
        M0SchemaSeed.Alpha.TenantId,
        M0SchemaSeed.Alpha.WorkspaceId,
        Neighbour);

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedShelvesAsync();
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task What_is_kept_comes_back_with_the_item_s_own_title()
    {
        await KeepAsync(KeeperContext, SharedItem);

        var shelf = await ReadAsync(KeeperContext);

        var kept = Assert.Single(shelf.Items);
        Assert.Equal(ItemId.From(SharedItem), kept.ItemId);
        Assert.Equal("Quarterly notes", kept.Title);
        Assert.Equal("note", kept.Type);
    }

    /// <summary>
    /// The reason a bookmark stores a reference and not a copy: a title is the item's, and it moves.
    /// </summary>
    [Fact]
    public async Task A_renamed_item_shows_its_new_name_on_the_shelf()
    {
        await KeepAsync(KeeperContext, SharedItem);
        await RenameAsync(SharedItem, "Renamed after keeping");

        var shelf = await ReadAsync(KeeperContext);

        Assert.Equal("Renamed after keeping", Assert.Single(shelf.Items).Title);
    }

    [Fact]
    public async Task Keeping_the_same_item_twice_leaves_one_row()
    {
        await KeepAsync(KeeperContext, SharedItem);
        await KeepAsync(KeeperContext, SharedItem);

        Assert.Single((await ReadAsync(KeeperContext)).Items);
    }

    [Fact]
    public async Task The_most_recently_kept_comes_first()
    {
        await KeepAsync(KeeperContext, SharedItem);
        await KeepAsync(KeeperContext, OtherItem);

        var shelf = await ReadAsync(KeeperContext);

        Assert.Equal(
            [ItemId.From(OtherItem), ItemId.From(SharedItem)],
            shelf.Items.Select(item => item.ItemId).ToList());
    }

    [Fact]
    public async Task Releasing_takes_it_off_and_releasing_again_is_not_an_error()
    {
        await KeepAsync(KeeperContext, SharedItem);
        await ReleaseAsync(KeeperContext, SharedItem);
        await ReleaseAsync(KeeperContext, SharedItem);

        Assert.Empty((await ReadAsync(KeeperContext)).Items);
    }

    /// <summary>
    /// The crown jewel of this feature. Same tenant, same workspace, both members - row-level
    /// security has nothing to say here, and only the statement's principal predicate separates
    /// them.
    /// </summary>
    [Fact]
    public async Task One_principal_never_sees_another_s_shelf()
    {
        await KeepAsync(KeeperContext, SharedItem);

        var neighbour = await ReadAsync(NeighbourContext);

        Assert.Empty(neighbour.Items);
        Assert.Equal(0, neighbour.Hidden);
    }

    [Fact]
    public async Task Releasing_cannot_reach_another_principal_s_row()
    {
        await KeepAsync(KeeperContext, SharedItem);
        await ReleaseAsync(NeighbourContext, SharedItem);

        // The neighbour's delete matched nothing, because the statement is scoped to their own
        // principal. The keeper's row is untouched.
        Assert.Single((await ReadAsync(KeeperContext)).Items);
    }

    /// <summary>
    /// A shelf must not become an oracle. Without the insert selecting the item, anybody could put
    /// any identifier on their own shelf and read its title back from the list.
    /// </summary>
    [Fact]
    public async Task An_item_the_caller_cannot_read_cannot_be_kept()
    {
        await KeepAsync(NeighbourContext, PrivateItem);

        var shelf = await ReadAsync(NeighbourContext);

        Assert.Empty(shelf.Items);
        Assert.Equal(0, shelf.Hidden);
    }

    [Fact]
    public async Task Something_already_in_the_trash_cannot_be_kept_at_all()
    {
        await KeepAsync(KeeperContext, TrashedItem);

        var shelf = await ReadAsync(KeeperContext);

        // Not merely absent from the list - no row was written, so nothing is hidden either. The
        // insert selects the item and the item is not active.
        Assert.Empty(shelf.Items);
        Assert.Equal(0, shelf.Hidden);
    }

    /// <summary>
    /// The ordinary way a shelf goes stale: something kept while it was live is trashed afterwards.
    /// The row stays, because a trashed item can be restored and a shelf that quietly forgot it
    /// would be worse than one that says it is holding something it cannot show.
    /// </summary>
    [Fact]
    public async Task An_item_trashed_after_it_was_kept_leaves_the_list_and_is_counted_as_hidden()
    {
        await KeepAsync(KeeperContext, SharedItem);
        Assert.Single((await ReadAsync(KeeperContext)).Items);

        await TrashAsync(SharedItem);

        var shelf = await ReadAsync(KeeperContext);

        Assert.Empty(shelf.Items);
        Assert.Equal(1, shelf.Hidden);
    }

    [Fact]
    public async Task A_bookmarked_active_descendant_below_a_deleted_ancestor_is_counted_as_hidden()
    {
        await KeepAsync(KeeperContext, SharedItem);
        await HideBelowTrashedItemAsync(SharedItem);

        var shelf = await ReadAsync(KeeperContext);

        Assert.Empty(shelf.Items);
        Assert.Equal(1, shelf.Hidden);
    }

    [Fact]
    public async Task An_active_descendant_below_a_deleted_ancestor_cannot_be_kept()
    {
        await HideBelowTrashedItemAsync(SharedItem);

        await KeepAsync(KeeperContext, SharedItem);

        var shelf = await ReadAsync(KeeperContext);
        Assert.Empty(shelf.Items);
        Assert.Equal(0, shelf.Hidden);
    }

    [Fact]
    public async Task A_hidden_bookmark_can_still_be_released()
    {
        await KeepAsync(KeeperContext, SharedItem);
        await HideBelowTrashedItemAsync(SharedItem);

        await ReleaseAsync(KeeperContext, SharedItem);

        var shelf = await ReadAsync(KeeperContext);
        Assert.Empty(shelf.Items);
        Assert.Equal(0, shelf.Hidden);
    }

    /// <summary>
    /// The case the hidden count exists for. The row survives losing access, so the list must not
    /// carry it - and the reader must still be told their shelf is larger than what they can see.
    /// </summary>
    [Fact]
    public async Task An_item_the_caller_has_lost_access_to_is_hidden_rather_than_listed_or_dropped()
    {
        await KeepAsync(KeeperContext, PrivateItem);
        Assert.Single((await ReadAsync(KeeperContext)).Items);

        await RevokeMembershipAsync(Keeper, PrivateWorkspace);

        var shelf = await ReadAsync(KeeperContext);

        Assert.Empty(shelf.Items);
        Assert.Equal(1, shelf.Hidden);
    }

    [Fact]
    public async Task A_shelf_that_is_wholly_readable_reports_nothing_hidden()
    {
        await KeepAsync(KeeperContext, SharedItem);
        await KeepAsync(KeeperContext, OtherItem);

        var shelf = await ReadAsync(KeeperContext);

        Assert.Equal(2, shelf.Items.Count);
        Assert.Equal(0, shelf.Hidden);
    }

    /// <summary>
    /// The cross-tenant backstop, asserted by handing the store a readable set it has no business
    /// being given inside a session established for the other tenant. Nothing but row-level
    /// security is left to refuse it.
    /// </summary>
    [Fact]
    public async Task One_tenant_never_reads_another_tenant_s_shelf()
    {
        await KeepAsync(KeeperContext, SharedItem);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var alpha = WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);

            var kept = await work.Resolve<IBookmarkShelf>().ListAsync([alpha], Cancellation);

            Assert.Empty(kept);
        }
    }

    [Fact]
    public async Task A_principal_who_may_read_nowhere_has_an_empty_shelf()
    {
        await KeepAsync(KeeperContext, SharedItem);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(KeeperContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            Assert.Empty(await work.Resolve<IBookmarkShelf>().ListAsync([], Cancellation));
        }
    }

    private async Task<ShelfResults> ReadAsync(NixSessionContext context)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<GetShelf, Result<ShelfResults>>(new GetShelf(), Cancellation);

            Assert.True(result.IsSuccess);
            return result.Value;
        }
    }

    private async Task KeepAsync(NixSessionContext context, Guid itemId)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            await work.Resolve<NixDispatcher>()
                .SendAsync<KeepItem, bool>(new KeepItem(ItemId.From(itemId)), Cancellation);

            await work.CommitAsync(Cancellation);
        }
    }

    private async Task ReleaseAsync(NixSessionContext context, Guid itemId)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            await work.Resolve<NixDispatcher>()
                .SendAsync<ReleaseItem, bool>(new ReleaseItem(ItemId.From(itemId)), Cancellation);

            await work.CommitAsync(Cancellation);
        }
    }

    private async Task RenameAsync(Guid itemId, string title)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $"""
                 UPDATE item
                    SET properties = properties || jsonb_build_object('title', '{title}')
                  WHERE id = {RawSql.Literal(itemId)};
                 """);
        }
    }

    private async Task TrashAsync(Guid itemId)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $"UPDATE item SET lifecycle_state = 'deleted' WHERE id = {RawSql.Literal(itemId)};");
        }
    }

    private async Task HideBelowTrashedItemAsync(Guid itemId)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $$"""
                  UPDATE item
                     SET parent_id = {{RawSql.Literal(TrashedItem)}}
                   WHERE id = {{RawSql.Literal(itemId)}};

                  INSERT INTO item_closure
                      (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
                  VALUES
                      ({{RawSql.Literal(itemId)}}, {{RawSql.Literal(TrashedItem)}},
                       {{RawSql.Literal(M0SchemaSeed.Alpha.TenantId)}},
                       {{RawSql.Literal(M0SchemaSeed.Alpha.WorkspaceId)}}, 1);
                  """);
        }
    }

    private async Task RevokeMembershipAsync(Guid principal, Guid workspace)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $"""
                 DELETE FROM workspace_member
                  WHERE workspace_id = {RawSql.Literal(workspace)}
                    AND subject_id = {RawSql.Literal(principal)};
                 """);
        }
    }

    /// <summary>
    /// Seeds two principals, a workspace only one of them belongs to, and the items involved.
    /// </summary>
    private async Task SeedShelvesAsync()
    {
        var tenant = RawSql.Literal(M0SchemaSeed.Alpha.TenantId);
        var shared = RawSql.Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var closed = RawSql.Literal(PrivateWorkspace);
        var granter = RawSql.Literal(M0SchemaSeed.Alpha.PrincipalId);

        var sql = $$"""
            INSERT INTO principal
                (principal_id, tenant_id, external_subject, kind, display_name, email, status,
                 deprovisioned_at)
            VALUES
                ({{RawSql.Literal(Keeper)}}, {{tenant}}, 'alpha-keeper', 'user', 'Keeper',
                 'keeper@example.test', 'active', NULL),
                ({{RawSql.Literal(Neighbour)}}, {{tenant}}, 'alpha-neighbour', 'user', 'Neighbour',
                 'neighbour@example.test', 'active', NULL);

            INSERT INTO workspace
                (workspace_id, tenant_id, name, version_retention_days, coalesce_window_min,
                 storage_quota_bytes, created_at)
            VALUES ({{closed}}, {{tenant}}, 'Alpha private', 30, 10, 1073741824, now());

            -- Both belong to the shared workspace; only the keeper belongs to the private one.
            INSERT INTO workspace_member
                (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES
                ({{shared}}, 'principal', {{RawSql.Literal(Keeper)}}, {{tenant}}, 'viewer', {{granter}}, now()),
                ({{shared}}, 'principal', {{RawSql.Literal(Neighbour)}}, {{tenant}}, 'viewer', {{granter}}, now()),
                ({{closed}}, 'principal', {{RawSql.Literal(Keeper)}}, {{tenant}}, 'viewer', {{granter}}, now());

            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                 purge_after, created_by, last_modified_by, created_at, last_modified_at)
            VALUES
                ({{RawSql.Literal(SharedItem)}}, {{tenant}}, {{shared}}, 'note', NULL, 1000,
                 '{"title": "Quarterly notes"}'::jsonb, 'active', NULL, {{granter}}, {{granter}},
                 now(), now()),
                ({{RawSql.Literal(OtherItem)}}, {{tenant}}, {{shared}}, 'note', NULL, 2000,
                 '{"title": "Ledger review"}'::jsonb, 'active', NULL, {{granter}}, {{granter}},
                 now(), now()),
                ({{RawSql.Literal(PrivateItem)}}, {{tenant}}, {{closed}}, 'note', NULL, 3000,
                 '{"title": "Confidential ledger"}'::jsonb, 'active', NULL, {{granter}}, {{granter}},
                 now(), now()),
                ({{RawSql.Literal(TrashedItem)}}, {{tenant}}, {{shared}}, 'note', NULL, 4000,
                 '{"title": "Old draft"}'::jsonb, 'deleted', NULL, {{granter}}, {{granter}},
                 now(), now());

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            VALUES
                ({{RawSql.Literal(SharedItem)}}, {{RawSql.Literal(SharedItem)}}, {{tenant}}, {{shared}}, 0),
                ({{RawSql.Literal(OtherItem)}}, {{RawSql.Literal(OtherItem)}}, {{tenant}}, {{shared}}, 0),
                ({{RawSql.Literal(PrivateItem)}}, {{RawSql.Literal(PrivateItem)}}, {{tenant}}, {{closed}}, 0),
                ({{RawSql.Literal(TrashedItem)}}, {{RawSql.Literal(TrashedItem)}}, {{tenant}}, {{shared}}, 0);
            """;

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }
}
