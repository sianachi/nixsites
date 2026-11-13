using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Abstractions.Workers;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Automations;
using Nix.Features.Items;
using Nix.Features.Locks;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence.Templates;
using Nix.Persistence.Workspaces;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresCollectionDefinition.Name)]
public sealed class WorkspaceItemMoveTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static readonly WorkspaceId Destination = WorkspaceId.From(new Guid("d1000000-0000-4000-8000-000000000001"));
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        var alpha = M0SchemaSeed.Alpha;
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, $"""
                DELETE FROM tenant_role WHERE tenant_id = '{alpha.TenantId}'::uuid;
                -- The isolation seed gives the root a reference to itself; a transfer is refused while
                -- any reference touches the subtree, and these tests are not about references.
                DELETE FROM item_reference WHERE tenant_id = '{alpha.TenantId}'::uuid;
                -- M0's isolation corpus includes live template operations over its root.
                -- These move tests start after those operations have finished.
                UPDATE template_operation SET state = 'aborted' WHERE tenant_id = '{alpha.TenantId}'::uuid;
                UPDATE template_application SET state = 'aborted' WHERE tenant_id = '{alpha.TenantId}'::uuid;
                INSERT INTO workspace (workspace_id, tenant_id, name, version_retention_days,
                    coalesce_window_min, storage_quota_bytes, created_at, lifecycle_state)
                VALUES ('{Destination.Value}'::uuid, '{alpha.TenantId}'::uuid, 'Destination', 90, 10,
                    10737418240, now(), 'active');
                INSERT INTO workspace_member (workspace_id, tenant_id, subject_type, subject_id, role, granted_by, granted_at)
                VALUES ('{Destination.Value}'::uuid, '{alpha.TenantId}'::uuid, 'principal',
                    '{alpha.PrincipalId}'::uuid, 'editor', '{alpha.PrincipalId}'::uuid, now());
                """);
        }
    }
    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Transfer_preserves_subtree_document_log_and_identity_with_destination_containment()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var created = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId), "note", "Child", ItemId.From(M0SchemaSeed.Alpha.ItemId), null), Cancellation);
            Assert.True(created.IsSuccess);
            var before = await work.DbContext.ContentDocs.AsNoTracking().SingleAsync(Cancellation);
            var fileVersions = await work.DbContext.FileVersions.AsNoTracking().ToArrayAsync(Cancellation);
            var snapshots = await work.DbContext.ContentSnapshots.AsNoTracking().CountAsync(Cancellation);
            var result = await dispatcher.SendAsync<MoveItem, Item>(
                new MoveItem(ItemId.From(M0SchemaSeed.Alpha.ItemId), null, null, Destination), Cancellation);
            Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : null);
            Assert.Equal(M0SchemaSeed.Alpha.ItemId, result.Value.Id.Value);
            Assert.Equal(Destination, result.Value.WorkspaceId);
            Assert.Null(result.Value.ParentId);
            var child = await work.Resolve<IItemTree>().FindAsync(created.Value.Id, Cancellation);
            Assert.NotNull(child);
            Assert.Equal(Destination, child.WorkspaceId);
            Assert.Equal(result.Value.Id, child.ParentId);
            var after = await work.DbContext.ContentDocs.AsNoTracking().SingleAsync(Cancellation);
            Assert.Equal(before.Id, after.Id);
            Assert.Equal(before.HeadSeq, after.HeadSeq);
            Assert.Equal(Destination, after.WorkspaceId);
            Assert.All(await work.DbContext.FileVersions.AsNoTracking().ToArrayAsync(Cancellation), version => Assert.Equal(Destination, version.WorkspaceId));
            Assert.All(await work.DbContext.FileBodies.AsNoTracking().ToArrayAsync(Cancellation), body => Assert.Equal(Destination, body.WorkspaceId));
            Assert.Equal(fileVersions.Select(version => version.ObjectKey),
                (await work.DbContext.FileVersions.AsNoTracking().ToArrayAsync(Cancellation)).Select(version => version.ObjectKey));
            Assert.Equal(snapshots, await work.DbContext.ContentSnapshots.AsNoTracking().CountAsync(Cancellation));
            Assert.All(await work.DbContext.AclEntries.AsNoTracking().ToArrayAsync(Cancellation), entry => Assert.Equal(Destination, entry.WorkspaceId));
            Assert.All(await work.DbContext.ItemClosure.Where(edge => edge.AncestorId == result.Value.Id).ToArrayAsync(Cancellation), edge => Assert.Equal(Destination, edge.WorkspaceId));
            await work.CommitAsync(Cancellation);
        }
    }

    [Theory]
    [InlineData("download")]
    [InlineData("metadata")]
    [InlineData("history")]
    public async Task File_authorization_holds_containment_until_its_request_commits(string surface)
    {
        var alpha = M0SchemaSeed.Alpha;
        await using (var changing = await fixture.OpenMigratorConnectionAsync())
        {
            await RawSql.ExecuteAsync(changing, null,
                $"UPDATE item SET type = 'file' WHERE id = '{alpha.ItemId:D}'::uuid;");
        }
        await using var reading = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var files = reading.Resolve<IFileStore>();
        object? authorized = surface switch
        {
            "download" => await files.AuthorizeDownloadAsync(ItemId.From(alpha.ItemId), null, Cancellation),
            "metadata" => await files.GetAsync(ItemId.From(alpha.ItemId), Cancellation),
            _ => await files.AuthorizeVersionHistoryAsync(ItemId.From(alpha.ItemId), Cancellation),
        };
        Assert.NotNull(authorized);
        await using var transfer = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var pid = ((NpgsqlConnection)transfer.DbContext.Database.GetDbConnection()).ProcessID;
        var pending = transfer.Resolve<NixDispatcher>().SendAsync<MoveItem, Item>(
            new MoveItem(ItemId.From(alpha.ItemId), null, null, Destination), Cancellation).AsTask();
        await WaitForDatabaseLockAsync(pid);
        await reading.CommitAsync(Cancellation);
        Assert.True((await pending.WaitAsync(TimeSpan.FromSeconds(10), Cancellation)).IsSuccess);
        await transfer.CommitAsync(Cancellation);
    }

    [Theory]
    [InlineData("download")]
    [InlineData("metadata")]
    [InlineData("history")]
    public async Task File_authorization_waiting_for_transfer_refuses_the_destination_after_access_is_removed(string surface)
    {
        var alpha = M0SchemaSeed.Alpha;
        await using (var changing = await fixture.OpenMigratorConnectionAsync())
        {
            await RawSql.ExecuteAsync(changing, null,
                $"UPDATE item SET type = 'file' WHERE id = '{alpha.ItemId:D}'::uuid;");
        }
        await using var transfer = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var moved = await transfer.Resolve<NixDispatcher>().SendAsync<MoveItem, Item>(
            new MoveItem(ItemId.From(alpha.ItemId), null, null, Destination), Cancellation);
        Assert.True(moved.IsSuccess, moved.IsFailure ? moved.Error.Message : null);
        await using var reading = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var pid = ((NpgsqlConnection)reading.DbContext.Database.GetDbConnection()).ProcessID;
        var pending = AuthorizeAsync(reading.Resolve<IFileStore>());
        await WaitForDatabaseLockAsync(pid);
        await transfer.DbContext.Database.ExecuteSqlInterpolatedAsync(
            $"DELETE FROM workspace_member WHERE workspace_id = {Destination.Value} AND subject_id = {alpha.PrincipalId}", Cancellation);
        await transfer.CommitAsync(Cancellation);
        Assert.Null(await pending.WaitAsync(TimeSpan.FromSeconds(10), Cancellation));

        async Task<object?> AuthorizeAsync(IFileStore files) => surface switch
        {
            "download" => await files.AuthorizeDownloadAsync(ItemId.From(alpha.ItemId), null, Cancellation),
            "metadata" => await files.GetAsync(ItemId.From(alpha.ItemId), Cancellation),
            _ => await files.AuthorizeVersionHistoryAsync(ItemId.From(alpha.ItemId), Cancellation),
        };
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task Transfer_waiting_for_topology_rechecks_removed_or_demoted_membership(bool source, bool remove)
    {
        var alpha = M0SchemaSeed.Alpha;
        var sourceId = WorkspaceId.From(alpha.WorkspaceId);
        await using var blocking = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await blocking.Resolve<IStructuralLock>().AcquireWorkspaceTopologyAsync(sourceId, Cancellation);
        await using var transfer = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var pid = ((NpgsqlConnection)transfer.DbContext.Database.GetDbConnection()).ProcessID;
        var pending = transfer.Resolve<NixDispatcher>().SendAsync<MoveItem, Item>(
            new MoveItem(ItemId.From(alpha.ItemId), null, null, Destination), Cancellation).AsTask();
        await WaitForDatabaseLockAsync(pid);
        var revokedWorkspace = source ? sourceId : Destination;
        await using (var changing = await fixture.OpenMigratorConnectionAsync())
        {
            await using var transaction = await changing.BeginTransactionAsync(Cancellation);
            await RawSql.ExecuteAsync(changing, transaction,
                $"SELECT workspace_id FROM workspace WHERE workspace_id = '{revokedWorkspace.Value:D}'::uuid FOR UPDATE;");
            var change = remove ? "DELETE FROM workspace_member" : "UPDATE workspace_member SET role = 'viewer'";
            await RawSql.ExecuteAsync(changing, transaction,
                $"{change} WHERE workspace_id = '{revokedWorkspace.Value:D}'::uuid AND subject_type = 'principal' AND subject_id = '{alpha.PrincipalId:D}'::uuid;");
            await transaction.CommitAsync(Cancellation);
        }
        await blocking.CommitAsync(Cancellation);
        var result = await pending.WaitAsync(TimeSpan.FromSeconds(10), Cancellation);
        Assert.True(result.IsFailure);
        Assert.Equal(sourceId,
            (await transfer.Resolve<IItemTree>().FindAsync(ItemId.From(alpha.ItemId), Cancellation))!.WorkspaceId);
    }

    [Fact]
    public async Task Transfer_refuses_an_active_job_and_rolls_back_the_closure_detach()
    {
        var alpha = M0SchemaSeed.Alpha;
        await using (var queue = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            await queue.Resolve<IWorkerJobStore>().CreateAsync(TenantId.From(alpha.TenantId), PrincipalId.From(alpha.PrincipalId),
                WorkspaceId.From(alpha.WorkspaceId), "transcribe", "move-active-job",
                $$"""{"audioItemId":"{{alpha.ItemId:D}}"}""", Cancellation);
            await queue.CommitAsync(Cancellation);
        }
        await using (var transfer = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var result = await transfer.Resolve<NixDispatcher>().SendAsync<MoveItem, Item>(
                new MoveItem(ItemId.From(alpha.ItemId), null, null, Destination), Cancellation);
            Assert.True(result.IsFailure);
            Assert.Equal("items.transfer_conflict", result.Error.Code);
        }
        await using var checking = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        Assert.Equal(WorkspaceId.From(alpha.WorkspaceId),
            (await checking.Resolve<IItemTree>().FindAsync(ItemId.From(alpha.ItemId), Cancellation))!.WorkspaceId);
        Assert.NotEmpty(await checking.DbContext.ItemClosure.Where(edge => edge.AncestorId == ItemId.From(alpha.ItemId)).ToArrayAsync(Cancellation));
    }

    [Fact]
    public async Task Transferred_file_bytes_are_withheld_after_destination_membership_is_removed()
    {
        var alpha = M0SchemaSeed.Alpha;
        await using (var transfer = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var result = await transfer.Resolve<NixDispatcher>().SendAsync<MoveItem, Item>(
                new MoveItem(ItemId.From(alpha.ItemId), null, null, Destination), Cancellation);
            Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : null);
            await transfer.CommitAsync(Cancellation);
        }
        await using (var changing = await fixture.OpenMigratorConnectionAsync())
        {
            await RawSql.ExecuteAsync(changing, null,
                $"DELETE FROM workspace_member WHERE workspace_id = '{Destination.Value:D}'::uuid;");
        }
        await using var checking = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        Assert.Null(await checking.Resolve<IFileStore>().GetAsync(ItemId.From(alpha.ItemId), Cancellation));
        Assert.Null(await checking.Resolve<IFileStore>().AuthorizeDownloadAsync(ItemId.From(alpha.ItemId), null, Cancellation));
    }

    [Fact]
    public async Task Automation_creation_waiting_for_transfer_rejects_a_scope_that_left_its_workspace()
    {
        var alpha = M0SchemaSeed.Alpha;
        await using var transfer = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var moved = await transfer.Resolve<NixDispatcher>().SendAsync<MoveItem, Item>(
            new MoveItem(ItemId.From(alpha.ItemId), null, null, Destination), Cancellation);
        Assert.True(moved.IsSuccess, moved.IsFailure ? moved.Error.Message : null);
        await using var saving = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var pid = ((NpgsqlConnection)saving.DbContext.Database.GetDbConnection()).ProcessID;
        var pending = saving.Resolve<NixDispatcher>().SendAsync<CreateAutomation, AutomationRuleResponse>(
            new CreateAutomation(WorkspaceId.From(alpha.WorkspaceId), new AutomationRuleInput(
                "Scope race", true, alpha.ItemId,
                JsonNode.Parse("""{"type":"property_changed","key":"status"}""")!.AsObject(),
                null, JsonNode.Parse("""[{"type":"notify","title":"Changed"}]""")!.AsArray())), Cancellation).AsTask();
        await WaitForDatabaseLockAsync(pid);
        await transfer.CommitAsync(Cancellation);
        var result = await pending;
        Assert.True(result.IsFailure);
        Assert.DoesNotContain(await saving.DbContext.Set<Nix.Domain.Automations.AutomationRule>().AsNoTracking().ToArrayAsync(Cancellation),
            rule => rule.Name == "Scope race");
    }

    [Fact]
    public async Task Lock_creation_waiting_for_transfer_refuses_the_moved_item()
    {
        var alpha = M0SchemaSeed.Alpha;
        await using var transfer = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var moved = await transfer.Resolve<NixDispatcher>().SendAsync<MoveItem, Item>(
            new MoveItem(ItemId.From(alpha.ItemId), null, null, Destination), Cancellation);
        Assert.True(moved.IsSuccess, moved.IsFailure ? moved.Error.Message : null);
        await using var locking = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var pid = ((NpgsqlConnection)locking.DbContext.Database.GetDbConnection()).ProcessID;
        var pending = locking.Resolve<NixDispatcher>().SendAsync<LockItem, bool>(
            new LockItem(ItemId.From(alpha.ItemId), "transfer-passphrase", null), Cancellation).AsTask();
        await WaitForDatabaseLockAsync(pid);
        await transfer.CommitAsync(Cancellation);
        Assert.True((await pending).IsFailure);
    }

    [Fact]
    public async Task Protection_update_waiting_for_transfer_refuses_the_moved_item()
    {
        var alpha = M0SchemaSeed.Alpha;
        await using var transfer = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var moved = await transfer.Resolve<NixDispatcher>().SendAsync<MoveItem, Item>(
            new MoveItem(ItemId.From(alpha.ItemId), null, null, Destination), Cancellation);
        Assert.True(moved.IsSuccess, moved.IsFailure ? moved.Error.Message : null);
        await using var protecting = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var pid = ((NpgsqlConnection)protecting.DbContext.Database.GetDbConnection()).ProcessID;
        var pending = protecting.Resolve<NixDispatcher>().SendAsync<SetItemProtection, Item>(
            new SetItemProtection(ItemId.From(alpha.ItemId), null, true), Cancellation).AsTask();
        await WaitForDatabaseLockAsync(pid);
        await transfer.CommitAsync(Cancellation);
        Assert.True((await pending).IsFailure);
    }

    [Fact]
    public async Task Template_capture_waiting_for_transfer_refuses_the_moved_source()
    {
        var alpha = M0SchemaSeed.Alpha;
        await using var transfer = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var moved = await transfer.Resolve<NixDispatcher>().SendAsync<MoveItem, Item>(
            new MoveItem(ItemId.From(alpha.ItemId), null, null, Destination), Cancellation);
        Assert.True(moved.IsSuccess, moved.IsFailure ? moved.Error.Message : null);
        await using var capturing = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var pid = ((NpgsqlConnection)capturing.DbContext.Database.GetDbConnection()).ProcessID;
        var pending = capturing.Resolve<TemplateStore>().BeginCaptureAsync(WorkspaceId.From(alpha.WorkspaceId),
            ItemId.From(alpha.ItemId), "Capture race", null, false, false, "move-capture-race", Cancellation).AsTask();
        await WaitForDatabaseLockAsync(pid);
        await transfer.CommitAsync(Cancellation);
        Assert.True((await pending).IsFailure);
        Assert.DoesNotContain(await capturing.DbContext.TemplateOperations.AsNoTracking().ToArrayAsync(Cancellation),
            operation => operation.IdempotencyKey == "move-capture-race");
    }

    [Fact]
    public async Task Destination_archive_waits_for_transfer_commit()
    {
        var alpha = M0SchemaSeed.Alpha;
        await using var transfer = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var moved = await transfer.Resolve<NixDispatcher>().SendAsync<MoveItem, Item>(
            new MoveItem(ItemId.From(alpha.ItemId), null, null, Destination), Cancellation);
        Assert.True(moved.IsSuccess, moved.IsFailure ? moved.Error.Message : null);
        await using var archiving = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var pid = ((NpgsqlConnection)archiving.DbContext.Database.GetDbConnection()).ProcessID;
        var pending = archiving.DbContext.Workspaces.Where(workspace => workspace.Id == Destination)
            .ExecuteUpdateAsync(update => update.SetProperty(workspace => workspace.LifecycleState, WorkspaceLifecycleState.Archived), Cancellation);
        await WaitForDatabaseLockAsync(pid);
        await transfer.CommitAsync(Cancellation);
        Assert.Equal(1, await pending);
        await archiving.CommitAsync(Cancellation);
    }

    private async Task WaitForDatabaseLockAsync(int processId)
    {
        await using var connection = await fixture.OpenMigratorConnectionAsync();
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (DateTime.UtcNow < deadline)
        {
            var waiting = await RawSql.CountAsync(connection, null,
                $"SELECT count(*) FROM pg_locks WHERE pid = {processId} AND NOT granted");
            if (waiting > 0)
            {
                return;
            }
            await Task.Delay(10, Cancellation);
        }
        Assert.Fail("The competing database operation did not wait for its containment lock.");
    }

    [Fact]
    public async Task Destination_pages_exclude_read_only_source_and_other_tenant_workspaces_before_limiting()
    {
        var alpha = M0SchemaSeed.Alpha;
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, $"""
                INSERT INTO workspace (workspace_id, tenant_id, name, version_retention_days,
                    coalesce_window_min, storage_quota_bytes, created_at, lifecycle_state)
                SELECT md5('move-page-' || n)::uuid, '{alpha.TenantId}'::uuid, 'Read only ' || n,
                    90, 10, 10737418240, now() + (n || ' seconds')::interval, 'active'
                FROM generate_series(1, 150) n;
                INSERT INTO workspace_member (workspace_id, tenant_id, subject_type, subject_id, role, granted_by, granted_at)
                SELECT md5('move-page-' || n)::uuid, '{alpha.TenantId}'::uuid, 'principal',
                    '{alpha.PrincipalId}'::uuid, 'viewer', '{alpha.PrincipalId}'::uuid, now()
                FROM generate_series(1, 150) n;
                """);
        }
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var page = await work.Resolve<NixDispatcher>().QueryAsync<ListItemMoveWorkspaces, Result<ItemMoveWorkspacePage>>(
                new ListItemMoveWorkspaces(ItemId.From(alpha.ItemId), null, null, 1), Cancellation);
            Assert.True(page.IsSuccess);
            Assert.Equal(Destination.Value, Assert.Single(page.Value.Items).Id);
            Assert.Null(page.Value.NextCursor);
            await work.DbContext.WorkspaceMembers.Where(member => member.WorkspaceId == Destination)
                .ExecuteUpdateAsync(update => update.SetProperty(member => member.Role, "viewer"), Cancellation);
            var empty = await work.Resolve<WorkspaceAdministrationStore>().ListTransferDestinationsAsync(
                WorkspaceId.From(alpha.WorkspaceId), null, null, 100, Cancellation);
            Assert.Empty(empty);
        }
    }
}
