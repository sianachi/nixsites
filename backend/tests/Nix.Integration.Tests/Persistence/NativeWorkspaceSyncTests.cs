using System.Globalization;
using System.Text;
using Nix.Abstractions;
using Nix.Domain.Authorization;
using Nix.Domain.Items;
using Nix.Domain.Sync;
using Nix.Domain.Tenancy;
using Nix.Features.Items;
using Nix.Features.Workspaces;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Nix.Persistence.Workspaces;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Integration.Tests.Persistence;

/// <summary>Native metadata synchronization against Postgres commit order and current permissions.</summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class NativeWorkspaceSyncTests(NixPostgresFixture fixture, ITestOutputHelper output) : IAsyncLifetime
{
    private static readonly Guid Member = new("7c500000-1111-4111-8111-7c5000000001");
    private static readonly Guid Credential = new("7c500000-1111-4111-8111-7c5000000002");
    private static readonly Guid Missing = new("7c500000-1111-4111-8111-7c5000000003");

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;
    private static WorkspaceId Workspace => WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);
    private static ItemId Root => ItemId.From(M0SchemaSeed.Alpha.ItemId);
    private static NixSessionContext MemberContext => TestTenants.ContextFor(
        M0SchemaSeed.Alpha.TenantId, M0SchemaSeed.Alpha.WorkspaceId, Member);

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Private_pending_markers_have_no_runtime_read_grant_even_in_an_active_tenant()
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var failure = await Assert.ThrowsAsync<PostgresException>(() => work.Resolve<NixSqlExecutor>()
            .ScalarOrDefaultAsync<long>("SELECT count(*) FROM workspace_sync_pending", cancellationToken: Cancellation).AsTask());
        Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, failure.SqlState);
    }

    [Fact]
    public async Task Snapshot_contains_unchanged_rows_even_after_their_change_markers_are_pruned()
    {
        var newer = await CreateAsync("Newer", null);
        var revisions = (await SnapshotAsync()).Items.ToDictionary(item => item.Id, item => item.Revision);
        await ExecuteAsync("DELETE FROM workspace_sync_change WHERE workspace_id = @workspace",
            new NpgsqlParameter("workspace", Workspace.Value));

        var page = await SnapshotAsync();

        Assert.Equal(new[] { Root.Value, newer.Value }.Order(), page.Items.Select(item => item.Id).Order());
        Assert.True(page.Complete);
        Assert.Null(page.NextCursor);
        Assert.All(page.Items, item => Assert.Equal(revisions[item.Id], item.Revision));
        Assert.DoesNotContain(page.Items, item => item.Id == M0SchemaSeed.Beta.ItemId);
        await RenameAsync(newer.Value, "Next metadata revision");
        var renamed = (await SnapshotAsync()).Items.Single(item => item.Id == newer.Value);
        Assert.Equal(Sequence(revisions[newer.Value]) + 1, Sequence(renamed.Revision));
    }

    [Fact]
    public async Task Snapshot_pages_keep_their_boundary_and_replay_a_write_to_an_already_read_row()
    {
        await CreateAsync("Second", null);
        var first = await SnapshotAsync(limit: 1);
        Assert.False(first.Complete);
        Assert.NotNull(first.NextCursor);
        var alreadyRead = Assert.Single(first.Items).Id;
        await RenameAsync(alreadyRead, "Changed after first page");

        var last = await SnapshotAsync(Sequence(first.Boundary), first.NextCursor, 1);
        Assert.Equal(first.Boundary, last.Boundary);
        Assert.True(last.Complete);
        Assert.Single(last.Items);
        Assert.NotEqual(alreadyRead, last.Items[0].Id);

        var replay = await ChangesAsync(Sequence(first.Boundary));
        Assert.False(replay.Resync);
        Assert.Equal(alreadyRead, Assert.Single(replay.Items).Id);
        Assert.True(Sequence(replay.Cursor) > Sequence(first.Boundary));
    }

    [Fact]
    public async Task A_lock_change_between_snapshot_pages_invalidates_the_original_enumeration()
    {
        await CreateAsync("Descendant", Root);
        var first = await SnapshotAsync(limit: 1);
        Assert.False(first.Complete);
        Assert.False(first.Resync);
        await SeedLockAsync(Root);

        var next = await SnapshotAsync(Sequence(first.Boundary), first.NextCursor, 1);

        Assert.True(next.Resync);
        Assert.False(next.Complete);
        Assert.Empty(next.Items);
        Assert.Null(next.NextCursor);
    }

    [Fact]
    public async Task A_cursor_never_passes_an_uncommitted_writer_and_replays_both_commits()
    {
        var secondItem = await CreateAsync("Second writer", null);
        var boundary = Sequence((await SnapshotAsync()).Boundary);
        await using var firstConnection = await fixture.OpenMigratorConnectionAsync();
        await using var secondConnection = await fixture.OpenMigratorConnectionAsync();
        await using var firstTransaction = await firstConnection.BeginTransactionAsync(Cancellation);
        await using var secondTransaction = await secondConnection.BeginTransactionAsync(Cancellation);

        await using var firstWrite = RenameCommand(firstConnection, firstTransaction, Root.Value, "First commit");
        await firstWrite.ExecuteNonQueryAsync(Cancellation);
        await RawSql.ExecuteAsync(firstConnection, firstTransaction, "SET CONSTRAINTS native_sync_flush IMMEDIATE");
        await using var secondWrite = RenameCommand(secondConnection, secondTransaction, secondItem.Value, "Second commit");
        await secondWrite.ExecuteNonQueryAsync(Cancellation);
        var pending = secondTransaction.CommitAsync(Cancellation);
        try
        {
            await AssertBlockedAsync(secondConnection.ProcessID);
            var beforeCommit = await ChangesAsync(boundary);
            Assert.Empty(beforeCommit.Items);
            Assert.Equal(boundary, Sequence(beforeCommit.Cursor));
            Assert.False(beforeCommit.Resync);
        }
        finally
        {
            await firstTransaction.CommitAsync(Cancellation);
            await pending.WaitAsync(TimeSpan.FromSeconds(20), Cancellation);
        }

        var afterFirst = await ChangesAsync(boundary, limit: 1);
        Assert.Equal(Root.Value, Assert.Single(afterFirst.Items).Id);
        Assert.False(afterFirst.Resync);
        Assert.True(afterFirst.HasMore);
        var firstCursor = Sequence(afterFirst.Cursor);
        Assert.True(firstCursor > boundary);

        var afterSecond = await ChangesAsync(firstCursor);
        Assert.Equal(secondItem.Value, Assert.Single(afterSecond.Items).Id);
        Assert.False(afterSecond.Resync);
        Assert.True(Sequence(afterSecond.Cursor) > firstCursor);
        Assert.Empty((await ChangesAsync(Sequence(afterSecond.Cursor))).Items);
    }

    [Fact]
    public async Task Multi_item_writers_do_not_lock_the_revision_counter_before_their_last_item_write()
    {
        var secondItem = await CreateAsync("Second item", null);
        await using var firstConnection = await fixture.OpenMigratorConnectionAsync();
        await using var secondConnection = await fixture.OpenMigratorConnectionAsync();
        await using var firstTransaction = await firstConnection.BeginTransactionAsync(Cancellation);
        await using var secondTransaction = await secondConnection.BeginTransactionAsync(Cancellation);
        await using var firstWrite = RenameCommand(firstConnection, firstTransaction, Root.Value, "A first");
        await firstWrite.ExecuteNonQueryAsync(Cancellation);
        await using var competingWrite = RenameCommand(secondConnection, secondTransaction, secondItem.Value, "B first");
        await competingWrite.ExecuteNonQueryAsync(Cancellation);

        await using var finalWrite = RenameCommand(firstConnection, firstTransaction, secondItem.Value, "A second");
        var pending = finalWrite.ExecuteNonQueryAsync(Cancellation);
        try
        {
            await AssertBlockedAsync(firstConnection.ProcessID);
            await secondTransaction.CommitAsync(Cancellation).WaitAsync(TimeSpan.FromSeconds(20), Cancellation);
            await pending.WaitAsync(TimeSpan.FromSeconds(20), Cancellation);
            await firstTransaction.CommitAsync(Cancellation);
        }
        finally
        {
            await pending.WaitAsync(TimeSpan.FromSeconds(20), Cancellation);
        }

        var page = await SnapshotAsync();
        Assert.Equal("A first", page.Items.Single(item => item.Id == Root.Value).Title);
        Assert.Equal("A second", page.Items.Single(item => item.Id == secondItem.Value).Title);
    }

    [Fact]
    public async Task Opposite_workspace_write_orders_publish_both_concurrent_commits()
    {
        WorkspaceId other;
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var created = await work.Resolve<NixDispatcher>().SendAsync<CreateWorkspace, WorkspaceSnapshot>(
                new("Cross-workspace publication"), Cancellation);
            Assert.True(created.IsSuccess);
            other = created.Value.Id;
            await work.CommitAsync(Cancellation);
        }
        var firstA = await CreateAsync("First A", null);
        var secondA = await CreateAsync("Second A", null);
        var firstB = await CreateAsync("First B", null, other);
        var secondB = await CreateAsync("Second B", null, other);
        var boundaryA = Sequence((await SnapshotAsync()).Boundary);
        var boundaryB = Sequence((await SnapshotAsync(workspace: other)).Boundary);
        await using var firstConnection = await fixture.OpenMigratorConnectionAsync();
        await using var secondConnection = await fixture.OpenMigratorConnectionAsync();
        await using var firstTransaction = await firstConnection.BeginTransactionAsync(Cancellation);
        await using var secondTransaction = await secondConnection.BeginTransactionAsync(Cancellation);
        await using var writeA1 = RenameCommand(firstConnection, firstTransaction, firstA.Value, "A1 committed");
        await using var writeB1 = RenameCommand(firstConnection, firstTransaction, firstB.Value, "B1 committed");
        await using var writeB2 = RenameCommand(secondConnection, secondTransaction, secondB.Value, "B2 committed");
        await using var writeA2 = RenameCommand(secondConnection, secondTransaction, secondA.Value, "A2 committed");
        await writeA1.ExecuteNonQueryAsync(Cancellation);
        await writeB1.ExecuteNonQueryAsync(Cancellation);
        await writeB2.ExecuteNonQueryAsync(Cancellation);
        await writeA2.ExecuteNonQueryAsync(Cancellation);
        await Task.WhenAll(firstTransaction.CommitAsync(Cancellation), secondTransaction.CommitAsync(Cancellation))
            .WaitAsync(TimeSpan.FromSeconds(20), Cancellation);

        var changesA = await ChangesAsync(boundaryA);
        var changesB = await ChangesAsync(boundaryB, workspace: other);
        Assert.False(changesA.Resync);
        Assert.False(changesB.Resync);
        Assert.Equal(new[] { firstA.Value, secondA.Value }.Order(), changesA.Items.Select(item => item.Id).Order());
        Assert.Equal(new[] { firstB.Value, secondB.Value }.Order(), changesB.Items.Select(item => item.Id).Order());
        Assert.True(Sequence(changesA.Cursor) > boundaryA);
        Assert.True(Sequence(changesB.Cursor) > boundaryB);
    }

    [Fact]
    public async Task Membership_loss_hides_the_workspace_and_reconciles_only_the_supplied_ids()
    {
        await SeedMemberAsync();
        var initial = await SnapshotAsync(context: MemberContext);
        Assert.Equal(Root.Value, Assert.Single(initial.Items).Id);
        await ExecuteAsync("DELETE FROM workspace_member WHERE workspace_id = @workspace AND subject_id = @member",
            new NpgsqlParameter("workspace", Workspace.Value), new NpgsqlParameter("member", Member));

        await using var work = await fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        var sync = work.Resolve<IWorkspaceSync>();
        Assert.Null(await sync.SnapshotAsync(Workspace, null, null, 100, Cancellation));
        Assert.Null(await sync.ChangesAsync(Workspace, Sequence(initial.Boundary), 100, Cancellation));
        var supplied = new[] { Root.Value, Missing, M0SchemaSeed.Beta.ItemId };
        var reconciled = await sync.ReconcileAsync(Workspace, supplied, Cancellation);

        Assert.Equal(supplied.Order(), reconciled.Removed.Select(item => item.ItemId).Order());
        Assert.All(reconciled.Removed, item => Assert.Equal("inaccessible", item.Reason));
    }

    [Fact]
    public async Task A_tenant_administrator_who_is_not_a_member_reads_nothing()
    {
        await SeedMemberAsync();
        await ExecuteAsync("DELETE FROM workspace_member WHERE workspace_id = @workspace AND subject_id = @member",
            new NpgsqlParameter("workspace", Workspace.Value), new NpgsqlParameter("member", Member));
        await ExecuteAsync(
            "INSERT INTO tenant_role (tenant_id, subject_type, subject_id, role, granted_by, granted_at) VALUES (@tenant, 'principal', @member, 'admin', @principal, now())",
            new NpgsqlParameter("tenant", M0SchemaSeed.Alpha.TenantId), new NpgsqlParameter("member", Member),
            new NpgsqlParameter("principal", M0SchemaSeed.Alpha.PrincipalId));

        await using var work = await fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        var sync = work.Resolve<IWorkspaceSync>();
        Assert.Null(await sync.SnapshotAsync(Workspace, null, null, 100, Cancellation));
        Assert.Null(await sync.ChangesAsync(Workspace, 0, 100, Cancellation));
        var reconciled = await sync.ReconcileAsync(Workspace, [Root.Value], Cancellation);
        Assert.Empty(reconciled.Items);
        Assert.Equal(Root.Value, Assert.Single(reconciled.Removed).ItemId);
    }

    [Fact]
    public async Task Every_existing_write_path_records_a_marker_in_its_own_transaction()
    {
        var item = await CreateAsync("Tracked", null);
        var cursor = Sequence((await SnapshotAsync()).Boundary);

        // Each command commits on its own; its marker must be readable straight after.
        async Task<WorkspaceSyncChanges> AfterAsync<TCommand>(TCommand command) where TCommand : ICommand<Item>
        {
            await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
            {
                Assert.True((await work.Resolve<NixDispatcher>().SendAsync<TCommand, Item>(command, Cancellation)).IsSuccess);
                await work.CommitAsync(Cancellation);
            }
            var page = await ChangesAsync(cursor);
            cursor = Sequence(page.Cursor);
            return page;
        }

        foreach (var page in new[]
        {
            await AfterAsync(new RenameItem(item, "Renamed")),
            await AfterAsync(new Nix.Features.Properties.SetItemProperties(item, "{\"note\":\"x\"}")),
            await AfterAsync(new SetItemProtection(item, true, null)),
        })
        {
            Assert.False(page.Resync);
            Assert.Contains(page.Items, changed => changed.Id == item.Value);
        }
        Assert.True((await SnapshotAsync()).Items.Single(changed => changed.Id == item.Value).NoDelete);

        // A move changes who can see what is under it, so it asks every device for a new snapshot.
        Assert.True((await AfterAsync(new MoveItem(item, Root, null))).Resync);
    }

    [Fact]
    public async Task A_foreign_or_absent_workspace_answers_the_same_way()
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var sync = work.Resolve<IWorkspaceSync>();
        var supplied = new[] { Root.Value, M0SchemaSeed.Beta.ItemId, Missing };
        foreach (var workspace in new[] { WorkspaceId.From(M0SchemaSeed.Beta.WorkspaceId), WorkspaceId.From(Missing) })
        {
            Assert.Null(await sync.SnapshotAsync(workspace, null, null, 100, Cancellation));
            Assert.Null(await sync.ChangesAsync(workspace, 0, 100, Cancellation));
            var reconciled = await sync.ReconcileAsync(workspace, supplied, Cancellation);
            Assert.Empty(reconciled.Items);
            Assert.Equal(supplied.Order(), reconciled.Removed.Select(item => item.ItemId).Order());
            Assert.All(reconciled.Removed, item => Assert.Equal("inaccessible", item.Reason));
        }
    }

    [Fact]
    public async Task A_cursor_older_than_retention_requires_a_new_snapshot()
    {
        var boundary = Sequence((await SnapshotAsync()).Boundary);
        Assert.True(boundary > 0);
        await ExecuteAsync("UPDATE workspace_sync_revision SET retained_floor = seq WHERE workspace_id = @workspace",
            new NpgsqlParameter("workspace", Workspace.Value));

        var page = await ChangesAsync(boundary - 1);

        Assert.True(page.Resync);
        Assert.Empty(page.Items);
    }

    [Fact]
    public async Task Closed_locks_exclude_descendants_and_reconciliation_never_describes_the_refusal()
    {
        var child = await CreateAsync("Secret child title", Root);
        var loose = await CreateAsync("Readable", null);
        var unlockedRoot = (await SnapshotAsync()).Items.Single(item => item.Id == Root.Value);
        Assert.NotNull(unlockedRoot.BodyDocId);
        Assert.NotNull(unlockedRoot.File);
        await SeedLockAsync(Root);

        var page = await SnapshotAsync();
        Assert.Contains(page.Items, item => item.Id == Root.Value);
        Assert.Contains(page.Items, item => item.Id == loose.Value);
        Assert.DoesNotContain(page.Items, item => item.Id == child.Value);
        var lockedRoot = page.Items.Single(item => item.Id == Root.Value);
        Assert.True(lockedRoot.Locked);
        Assert.False(lockedRoot.CanPersistBody);
        Assert.Null(lockedRoot.UpdatedAt);
        Assert.Null(lockedRoot.BodyDocId);
        Assert.Null(lockedRoot.File);

        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var supplied = new[] { child.Value, Missing, M0SchemaSeed.Beta.ItemId };
        var reconciled = await work.Resolve<IWorkspaceSync>().ReconcileAsync(
            Workspace, [loose.Value, .. supplied], Cancellation);
        Assert.Equal(loose.Value, Assert.Single(reconciled.Items).Id);
        Assert.Equal(supplied.Order(), reconciled.Removed.Select(item => item.ItemId).Order());
        Assert.All(reconciled.Removed, item => Assert.Equal("inaccessible", item.Reason));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task A_locked_roots_body_activity_does_not_change_its_metadata_revision_or_enter_the_feed(bool unlocked)
    {
        await SeedLockAsync(Root);
        if (unlocked)
        {
            await ExecuteAsync(
                """
                INSERT INTO item_unlock (item_id, credential_id, tenant_id, principal_id, expires_at)
                VALUES (@root, @credential, @tenant, @principal, now() + interval '1 hour');
                """,
                new NpgsqlParameter("root", Root.Value), new NpgsqlParameter("credential", Credential),
                new NpgsqlParameter("tenant", M0SchemaSeed.Alpha.TenantId),
                new NpgsqlParameter("principal", M0SchemaSeed.Alpha.PrincipalId));
        }
        var before = await SnapshotAsync(credential: Credential);
        var previousRoot = Assert.Single(before.Items);
        await ExecuteAsync(
            """
            UPDATE content_doc SET head_seq = head_seq + 1 WHERE item_id = @root;
            UPDATE item SET last_modified_at = clock_timestamp() WHERE id = @root;
            """,
            new NpgsqlParameter("root", Root.Value));

        var currentRoot = Assert.Single((await SnapshotAsync(credential: Credential)).Items);
        Assert.Equal(previousRoot.Revision, currentRoot.Revision);
        Assert.Null(currentRoot.UpdatedAt);
        var changes = await ChangesAsync(Sequence(before.Boundary), credential: Credential);
        Assert.False(changes.Resync);
        Assert.Empty(changes.Items);
        Assert.Equal(before.Boundary, changes.Cursor);
    }

    [Fact]
    public async Task Nested_unlocks_bound_metadata_to_the_earliest_grant_and_expiry_is_reconciled()
    {
        var child = await CreateAsync("Nested lock", Root);
        var grandchild = await CreateAsync("Nested body", child);
        await SeedLockAsync(Root);
        await SeedLockAsync(child);
        var firstExpiry = DateTimeOffset.FromUnixTimeMilliseconds(DateTimeOffset.UtcNow.AddSeconds(5).ToUnixTimeMilliseconds());
        await ExecuteAsync(
            """
            INSERT INTO content_doc (doc_id, tenant_id, item_id, workspace_id, schema_version, head_seq, created_at)
            VALUES (@doc, @tenant, @item, @workspace, 1, 0, now());
            INSERT INTO item_unlock (item_id, credential_id, tenant_id, principal_id, expires_at)
            VALUES (@root, @credential, @tenant, @principal, @first_expiry),
                   (@child, @credential, @tenant, @principal, @last_expiry);
            """,
            new NpgsqlParameter("doc", Guid.NewGuid()), new NpgsqlParameter("tenant", M0SchemaSeed.Alpha.TenantId),
            new NpgsqlParameter("item", grandchild.Value), new NpgsqlParameter("workspace", Workspace.Value),
            new NpgsqlParameter("root", Root.Value), new NpgsqlParameter("child", child.Value),
            new NpgsqlParameter("credential", Credential), new NpgsqlParameter("principal", M0SchemaSeed.Alpha.PrincipalId),
            new NpgsqlParameter("first_expiry", firstExpiry), new NpgsqlParameter("last_expiry", firstExpiry.AddHours(1)));

        var page = await SnapshotAsync(credential: Credential);
        var visible = Assert.Single(page.Items, item => item.Id == grandchild.Value);
        Assert.Equal(firstExpiry, visible.MetadataExpiresAt);
        Assert.True(visible.Locked);
        Assert.False(visible.CanPersistBody);
        Assert.Null(visible.BodyDocId);
        var boundary = Sequence(page.Boundary);
        var untilExpiry = firstExpiry - DateTimeOffset.UtcNow + TimeSpan.FromMilliseconds(100);
        if (untilExpiry > TimeSpan.Zero)
        {
            await Task.Delay(untilExpiry, Cancellation);
        }

        var changes = await ChangesAsync(boundary, credential: Credential);
        Assert.False(changes.Resync);
        Assert.Empty(changes.Items);
        Assert.Equal(boundary, Sequence(changes.Cursor));
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        work.Resolve<CredentialSessionContext>().Set(Credential);
        var removed = await work.Resolve<IWorkspaceSync>().ReconcileAsync(Workspace, [grandchild.Value], Cancellation);
        Assert.Equal(grandchild.Value, Assert.Single(removed.Removed).ItemId);
        Assert.Equal("inaccessible", removed.Removed[0].Reason);
    }

    [Fact]
    public async Task A_permission_marker_requests_a_new_snapshot_without_item_data()
    {
        var boundary = Sequence((await SnapshotAsync()).Boundary);
        await ExecuteAsync("UPDATE acl_entry SET breaks_inheritance = true WHERE acl_entry_id = @entry",
            new NpgsqlParameter("entry", M0SchemaSeed.Alpha.AclEntryId));

        var page = await ChangesAsync(boundary);

        Assert.True(page.Resync);
        Assert.Empty(page.Items);
        Assert.True(Sequence(page.Cursor) > boundary);
    }

    [Fact]
    public async Task A_runtime_snapshot_pages_ten_thousand_locked_children_through_point_indexes()
    {
        await SeedMemberAsync();
        await using (var connection = await fixture.OpenMigratorConnectionAsync())
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                WITH inserted AS (
                    INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties,
                        lifecycle_state, created_by, last_modified_by, created_at, last_modified_at)
                    SELECT gen_random_uuid(), '{M0SchemaSeed.Alpha.TenantId:D}'::uuid, '{Workspace.Value:D}'::uuid,
                        'note', '{Root.Value:D}'::uuid, 1000 + n, jsonb_build_object('title', 'Native snapshot ' || n),
                        'active', '{M0SchemaSeed.Alpha.PrincipalId:D}'::uuid, '{M0SchemaSeed.Alpha.PrincipalId:D}'::uuid,
                        now(), now()
                    FROM generate_series(1, 10000) n
                    RETURNING id
                )
                INSERT INTO item_closure (tenant_id, workspace_id, descendant_id, ancestor_id, depth)
                SELECT '{M0SchemaSeed.Alpha.TenantId:D}'::uuid, '{Workspace.Value:D}'::uuid, id, id, 0 FROM inserted
                UNION ALL
                SELECT '{M0SchemaSeed.Alpha.TenantId:D}'::uuid, '{Workspace.Value:D}'::uuid, id, '{Root.Value:D}'::uuid, 1 FROM inserted;
                ANALYZE item, item_closure, workspace_sync_item_revision, workspace_member;
                """, commandTimeoutSeconds: 120);
        }
        await SeedLockAsync(Root);
        await ExecuteAsync(
            """
            INSERT INTO item_unlock (item_id, credential_id, tenant_id, principal_id, expires_at)
            VALUES (@root, @credential, @tenant, @member, now() + interval '1 hour');
            ANALYZE item_lock, item_unlock;
            """,
            new NpgsqlParameter("root", Root.Value), new NpgsqlParameter("credential", Credential),
            new NpgsqlParameter("tenant", M0SchemaSeed.Alpha.TenantId), new NpgsqlParameter("member", Member));
        var page = await SnapshotAsync(limit: 200, context: MemberContext, credential: Credential);
        Assert.Equal(200, page.Items.Count);
        Assert.False(page.Complete);
        Assert.All(page.Items, item => Assert.False(item.CanWrite));
        Assert.All(page.Items, item => Assert.False(item.CanPersistBody));

        await using var work = await fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        var roles = Enum.GetValues<WorkspaceRole>();
        var parameters = new NpgsqlParameter[]
        {
            new NpgsqlParameter<Guid>("tenant_id", M0SchemaSeed.Alpha.TenantId),
            new NpgsqlParameter<Guid>("principal_id", Member),
            new NpgsqlParameter<Guid>("workspace_id", Workspace.Value),
            new NpgsqlParameter<string[]>("read_roles", roles.Select(WorkspaceRoles.ToText).ToArray()),
            new NpgsqlParameter<string[]>("write_roles", roles.Where(static role => role.GrantsWrite()).Select(WorkspaceRoles.ToText).ToArray()),
            new NpgsqlParameter<bool>("may_write", true),
            new NpgsqlParameter<DateTimeOffset>("now", DateTimeOffset.UtcNow),
            new NpgsqlParameter<Guid>("credential_id", Credential),
            new("cursor", NpgsqlDbType.Uuid) { Value = DBNull.Value },
            new NpgsqlParameter<int>("limit", 201),
        };
        var plan = new StringBuilder();
        await foreach (var line in work.Resolve<NixSqlExecutor>().QueryAsync<string, PlanMapper>(
            "EXPLAIN (ANALYZE, BUFFERS) " + WorkspaceSyncSql.Snapshot, default, parameters, Cancellation))
        {
            plan.AppendLine(line);
        }
        var evidence = plan.ToString();
        output.WriteLine("Native snapshot, 10,000 descendants, viewer permission and an open ancestor lock, runtime role:");
        output.WriteLine(evidence);
        var itemScan = Assert.Single(evidence.Split('\n'), line => line.Contains(" on item  (", StringComparison.Ordinal));
        Assert.Contains("Index Scan", itemScan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on item_closure", evidence, StringComparison.Ordinal);
        Assert.Contains("actual", evidence, StringComparison.Ordinal);
        Assert.Contains("Buffers:", evidence, StringComparison.Ordinal);
    }

    private async Task<WorkspaceSyncSnapshot> SnapshotAsync(
        long? boundary = null, Guid? cursor = null, int limit = 100,
        NixSessionContext? context = null, Guid? credential = null, WorkspaceId? workspace = null)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(context ?? TestTenants.AlphaContext, Cancellation);
        if (credential is { } value)
        {
            work.Resolve<CredentialSessionContext>().Set(value);
        }
        var page = await work.Resolve<IWorkspaceSync>().SnapshotAsync(workspace ?? Workspace, boundary, cursor, limit, Cancellation);
        Assert.NotNull(page);
        return page;
    }

    private async Task<WorkspaceSyncChanges> ChangesAsync(long after, Guid? credential = null, int limit = 100, WorkspaceId? workspace = null)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        if (credential is { } value)
        {
            work.Resolve<CredentialSessionContext>().Set(value);
        }
        var page = await work.Resolve<IWorkspaceSync>().ChangesAsync(workspace ?? Workspace, after, limit, Cancellation);
        Assert.NotNull(page);
        return page;
    }

    private async Task<ItemId> CreateAsync(string title, ItemId? parent, WorkspaceId? workspace = null)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var created = await work.Resolve<NixDispatcher>().SendAsync<CreateItem, Item>(new(workspace ?? Workspace, "note", title, parent, null), Cancellation);
        Assert.True(created.IsSuccess);
        await work.CommitAsync(Cancellation);
        return created.Value.Id;
    }

    private async Task RenameAsync(Guid item, string title)
    {
        await using var connection = await fixture.OpenMigratorConnectionAsync();
        await using var command = RenameCommand(connection, null, item, title);
        await command.ExecuteNonQueryAsync(Cancellation);
    }

    private static NpgsqlCommand RenameCommand(NpgsqlConnection connection, NpgsqlTransaction? transaction, Guid item, string title)
    {
        var command = new NpgsqlCommand(
            "UPDATE item SET properties = jsonb_build_object('title', @title), last_modified_at = clock_timestamp() WHERE id = @item",
            connection, transaction);
        command.Parameters.AddWithValue("item", item);
        command.Parameters.AddWithValue("title", title);
        return command;
    }

    private async Task AssertBlockedAsync(int processId)
    {
        await using var monitor = await fixture.OpenMigratorConnectionAsync();
        await using var command = new NpgsqlCommand("SELECT cardinality(pg_blocking_pids(@pid)) > 0", monitor);
        command.Parameters.AddWithValue("pid", processId);
        var deadline = DateTimeOffset.UtcNow.AddSeconds(20);
        while (DateTimeOffset.UtcNow < deadline)
        {
            if (await command.ExecuteScalarAsync(Cancellation) is true)
            {
                return;
            }
            await Task.Delay(20, Cancellation);
        }
        Assert.Fail("The concurrent transaction did not block the expected write or publication.");
    }

    private async Task SeedMemberAsync() => await ExecuteAsync(
        """
        INSERT INTO principal (principal_id, tenant_id, external_issuer, external_subject, kind, display_name, status, email_verified)
        VALUES (@member, @tenant, 'https://native-sync.test', 'member', 'user', 'Native member', 'active', false);
        INSERT INTO workspace_member (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
        VALUES (@workspace, 'principal', @member, @tenant, 'viewer', @principal, now());
        """,
        new NpgsqlParameter("member", Member), new NpgsqlParameter("tenant", M0SchemaSeed.Alpha.TenantId),
        new NpgsqlParameter("workspace", Workspace.Value), new NpgsqlParameter("principal", M0SchemaSeed.Alpha.PrincipalId));

    private async Task SeedLockAsync(ItemId item) => await ExecuteAsync(
        """
        INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
        VALUES (@item, @tenant, 'pbkdf2-sha256$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', @principal, now());
        """,
        new NpgsqlParameter("item", item.Value), new NpgsqlParameter("tenant", M0SchemaSeed.Alpha.TenantId),
        new NpgsqlParameter("principal", M0SchemaSeed.Alpha.PrincipalId));

    private async Task ExecuteAsync(string sql, params NpgsqlParameter[] parameters)
    {
        await using var connection = await fixture.OpenMigratorConnectionAsync();
#pragma warning disable CA2100 // SQL is static test text, and every varying value is bound as a parameter.
        await using var command = new NpgsqlCommand(sql, connection);
#pragma warning restore CA2100
        command.Parameters.AddRange(parameters);
        await command.ExecuteNonQueryAsync(Cancellation);
    }

    private static long Sequence(string value) => long.Parse(value, CultureInfo.InvariantCulture);

    private readonly struct PlanMapper : INixRowMapper<string>
    {
        public string Map(NpgsqlDataReader reader) => reader.GetString(0);
    }
}
