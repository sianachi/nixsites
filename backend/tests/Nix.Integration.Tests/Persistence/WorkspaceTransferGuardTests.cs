using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Features.Items;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence.Migrations;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>Real PostgreSQL security, queue growth and active-job plan proof for workspace transfers.</summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class WorkspaceTransferGuardTests(NixPostgresFixture fixture, ITestOutputHelper output) : IAsyncLifetime
{
    private const int ChainSize = 128;
    private const int JobCount = 3200;
    private static readonly Guid Destination = new("d2000000-0000-4000-8000-000000000001");
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        var alpha = M0SchemaSeed.Alpha;
        await using var connection = await fixture.OpenMigratorConnectionAsync();
        await RawSql.ExecuteAsync(connection, null, $"""
            INSERT INTO workspace (workspace_id, tenant_id, name, version_retention_days,
                coalesce_window_min, storage_quota_bytes, created_at, lifecycle_state)
            VALUES ('{Destination:D}'::uuid, '{alpha.TenantId:D}'::uuid, 'Transfer guard destination',
                90, 10, 10737418240, now(), 'active');
            INSERT INTO workspace_member (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES ('{Destination:D}'::uuid, 'principal', '{alpha.PrincipalId:D}'::uuid, '{alpha.TenantId:D}'::uuid,
                'owner', '{alpha.PrincipalId:D}'::uuid, now());
            DELETE FROM worker_job;
            """);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Theory]
    [InlineData("queued", true)]
    [InlineData("running", true)]
    [InlineData("completed", false)]
    [InlineData("cancelled", false)]
    public async Task Nested_uppercase_uuid_substrings_block_only_active_source_workspace_jobs(string status, bool blocked)
    {
        var alpha = M0SchemaSeed.Alpha;
        await SeedChainAsync();
        // Arbitrary nested strings remain conservative references, including a UUID inside prose.
        var payload = JsonSerializer.Serialize(new { nested = new[] { new { reference = $"prefix{ChainItem(ChainSize):D}suffix".ToUpperInvariant() } } });
        await using (var connection = await fixture.OpenMigratorConnectionAsync())
        {
            await InsertJobAsync(connection, alpha, alpha.WorkspaceId, status, payload);
        }
        await using var transfer = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var result = await transfer.Resolve<NixDispatcher>().SendAsync<MoveItem, Item>(
            new MoveItem(ItemId.From(ChainItem(1)), null, null, WorkspaceId.From(Destination)), Cancellation);
        Assert.Equal(!blocked, result.IsSuccess);
        if (blocked)
        {
            Assert.Equal("items.transfer_conflict", result.Error.Code);
        }
        else
        {
            await transfer.CommitAsync(Cancellation);
        }
    }

    [Fact]
    public async Task Matching_jobs_in_other_workspaces_or_tenants_do_not_block_transfer()
    {
        var alpha = M0SchemaSeed.Alpha;
        await SeedChainAsync();
        var payload = JsonSerializer.Serialize(new { arbitrary = ChainItem(ChainSize) });
        await using (var connection = await fixture.OpenMigratorConnectionAsync())
        {
            await InsertJobAsync(connection, alpha, Destination, "queued", payload);
            await InsertJobAsync(connection, M0SchemaSeed.Beta, M0SchemaSeed.Beta.WorkspaceId, "running", payload);
        }
        await using var transfer = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var result = await transfer.Resolve<NixDispatcher>().SendAsync<MoveItem, Item>(
            new MoveItem(ItemId.From(ChainItem(1)), null, null, WorkspaceId.From(Destination)), Cancellation);
        Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : null);
        await transfer.CommitAsync(Cancellation);
    }

    [Fact]
    public async Task Deep_transfer_with_thousands_of_jobs_completes()
    {
        await SeedChainAsync();
        await SeedJobsAsync();
        var watch = Stopwatch.StartNew();
        await using (var transfer = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var result = await transfer.Resolve<NixDispatcher>().SendAsync<MoveItem, Item>(
                new MoveItem(ItemId.From(ChainItem(1)), null, null, WorkspaceId.From(Destination)), Cancellation);
            Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : null);
            await transfer.CommitAsync(Cancellation);
        }
        watch.Stop();
        output.WriteLine("Moved {0} levels with {1} active jobs in each tenant: {2} ms.",
            ChainSize, JobCount, watch.ElapsedMilliseconds);
    }

    [Fact]
    public async Task Active_job_plan_extracts_each_source_job_once_instead_of_once_per_descendant()
    {
        await SeedChainAsync();
        await SeedJobsAsync();
        await using var connection = await fixture.OpenMigratorConnectionAsync();
        await using var transaction = await connection.BeginTransactionAsync(Cancellation);
        // The trigger is SECURITY DEFINER; explain as its owner, with the exact transition query.
        await RawSql.ExecuteAsync(connection, transaction, $"""
            SELECT set_config('nix.tenant_id', '{M0SchemaSeed.Alpha.TenantId:D}', true);
            CREATE TEMP TABLE old_items ON COMMIT DROP AS SELECT id, tenant_id, workspace_id
                FROM item WHERE tenant_id = '{M0SchemaSeed.Alpha.TenantId:D}'::uuid AND seq >= 200000;
            CREATE TEMP TABLE new_items ON COMMIT DROP AS SELECT id, tenant_id, '{Destination:D}'::uuid AS workspace_id FROM old_items;
            ANALYZE old_items;
            ANALYZE new_items;
            ANALYZE worker_job;
            """);
        var plan = await RawSql.TextAsync(connection, transaction,
            "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + ItemWorkspaceTransferJobGuardSql.ActiveJobReferences);
        Assert.NotNull(plan);
        output.WriteLine(plan);
        using var parsed = JsonDocument.Parse(plan);
        var functions = FindPlans(parsed.RootElement[0].GetProperty("Plan"), "Function Scan")
            .Where(node => node.GetProperty("Function Name").GetString() == "regexp_matches").ToArray();
        var extraction = Assert.Single(functions);
        Assert.Equal(JobCount, extraction.GetProperty("Actual Loops").GetInt32());
        Assert.Equal(1, extraction.GetProperty("Actual Rows").GetInt32());
        Assert.True(parsed.RootElement[0].GetProperty("Plan").GetProperty("Shared Hit Blocks").GetInt64() > 0);
    }

    [Fact]
    public async Task Ten_thousand_bulk_children_commit_and_the_parent_probe_uses_the_existing_index()
    {
        var alpha = M0SchemaSeed.Alpha;
        var watch = Stopwatch.StartNew();
        await using (var seed = await fixture.OpenMigratorConnectionAsync())
        {
            await RawSql.ExecuteAsync(seed, null, $"""
                INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties,
                    lifecycle_state, created_by, last_modified_by, created_at, last_modified_at)
                SELECT gen_random_uuid(), '{alpha.TenantId:D}'::uuid, '{alpha.WorkspaceId:D}'::uuid, 'note',
                    '{alpha.ItemId:D}'::uuid, 200000 + n, jsonb_build_object(), 'active',
                    '{alpha.PrincipalId:D}'::uuid, '{alpha.PrincipalId:D}'::uuid, now(), now()
                FROM generate_series(1, 10000) n;
                INSERT INTO item_closure (tenant_id, workspace_id, ancestor_id, descendant_id, depth)
                SELECT tenant_id, workspace_id, id, id, 0 FROM item WHERE seq >= 200000;
                INSERT INTO item_closure (tenant_id, workspace_id, ancestor_id, descendant_id, depth)
                SELECT tenant_id, workspace_id, parent_id, id, 1 FROM item WHERE seq >= 200000;
                ANALYZE item;
                """);
        }
        watch.Stop();
        output.WriteLine("10,000 children, closure and deferred containment checks committed in {0} ms.", watch.ElapsedMilliseconds);
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(30), "Bulk creation exceeded the fixture command bound.");
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var connection = (NpgsqlConnection)work.DbContext.Database.GetDbConnection();
        var transaction = (NpgsqlTransaction)work.DbContext.Database.CurrentTransaction!.GetDbTransaction();
        var leaf = await RawSql.TextAsync(connection, transaction,
            $"SELECT id::text FROM item WHERE tenant_id = '{alpha.TenantId:D}'::uuid AND seq = 200001");
        var plan = await RawSql.TextAsync(connection, transaction, $"""
            EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
            SELECT 1 FROM public.item child WHERE child.tenant_id = '{alpha.TenantId:D}'::uuid
                AND child.parent_id = '{leaf}'::uuid AND child.workspace_id <> '{alpha.WorkspaceId:D}'::uuid
            """);
        Assert.NotNull(plan);
        output.WriteLine(plan);
        Assert.Contains("IX_item_tenant_id_parent_id", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan", plan, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Inserted_child_in_another_workspace_is_rejected_at_commit_and_rolled_back()
    {
        var alpha = M0SchemaSeed.Alpha;
        var child = Guid.NewGuid();
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            await work.DbContext.Database.ExecuteSqlInterpolatedAsync($"""
                INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, lifecycle_state,
                    created_by, last_modified_by, created_at, last_modified_at)
                VALUES ({child}, {alpha.TenantId}, {Destination}, 'note', {alpha.ItemId}, 200000,
                    'active', {alpha.PrincipalId}, {alpha.PrincipalId}, now(), now())
                """, Cancellation);
            var refusal = await Assert.ThrowsAsync<PostgresException>(() => work.CommitAsync(Cancellation));
            Assert.Equal("item_workspace_parent", refusal.ConstraintName);
        }
        await using var connection = await fixture.OpenMigratorConnectionAsync();
        Assert.Equal(0, await RawSql.CountAsync(connection, null, $"SELECT count(*) FROM item WHERE id = '{child:D}'::uuid"));
    }

    [Fact]
    public async Task Parent_workspace_update_leaving_a_child_behind_is_rejected_and_envelope_rolls_back()
    {
        var alpha = M0SchemaSeed.Alpha;
        await SeedChainAsync();
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            await work.DbContext.Items.Where(item => item.Id == ItemId.From(ChainItem(1)))
                .ExecuteUpdateAsync(update => update.SetProperty(item => item.WorkspaceId, WorkspaceId.From(Destination)), Cancellation);
            var refusal = await Assert.ThrowsAsync<PostgresException>(() => work.CommitAsync(Cancellation));
            Assert.Equal("item_workspace_parent", refusal.ConstraintName);
        }
        await using var checking = await fixture.OpenMigratorConnectionAsync();
        Assert.Equal(ChainSize, await RawSql.CountAsync(checking, null,
            $"SELECT count(*) FROM item WHERE tenant_id = '{alpha.TenantId:D}'::uuid AND seq >= 200000 AND workspace_id = '{alpha.WorkspaceId:D}'::uuid"));
    }

    [Fact]
    public async Task Upgrade_keeps_definer_functions_private_and_rollback_restores_active_job_guard()
    {
        await using var connection = await fixture.OpenMigratorConnectionAsync();
        Assert.Equal(2, await RawSql.CountAsync(connection, null, """
            SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname IN ('nix_follow_item_workspace', 'nix_guard_workspace_transfer_jobs')
              AND p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']
              AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) grant_row WHERE grant_row.grantee = 0 AND grant_row.privilege_type = 'EXECUTE')
            """));
        await using var transaction = await connection.BeginTransactionAsync(Cancellation);
        var statements = new List<string>();
        ItemWorkspaceTransferJobGuardSql.Revert(statements.Add);
        foreach (var statement in statements)
        {
            await RawSql.ExecuteAsync(connection, transaction, statement);
        }
        var restored = await RawSql.TextAsync(connection, transaction,
            "SELECT pg_get_functiondef('public.nix_follow_item_workspace()'::regprocedure)");
        Assert.Contains("strpos(job.payload::text, NEW.id::text)", restored, StringComparison.Ordinal);
        await transaction.RollbackAsync(Cancellation);
    }

    private async Task SeedChainAsync()
    {
        var alpha = M0SchemaSeed.Alpha;
        await using var connection = await fixture.OpenMigratorConnectionAsync();
        await RawSql.ExecuteAsync(connection, null, $"""
            INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties,
                lifecycle_state, created_by, last_modified_by, created_at, last_modified_at)
            SELECT ('aaaaaaaa-aaaa-4aaa-8aaa-' || lpad(n::text, 12, '0'))::uuid,
                '{alpha.TenantId:D}'::uuid, '{alpha.WorkspaceId:D}'::uuid, 'note',
                CASE WHEN n = 1 THEN NULL ELSE ('aaaaaaaa-aaaa-4aaa-8aaa-' || lpad((n - 1)::text, 12, '0'))::uuid END,
                200000 + n, jsonb_build_object('title', 'Transfer chain ' || n), 'active',
                '{alpha.PrincipalId:D}'::uuid, '{alpha.PrincipalId:D}'::uuid, now(), now()
            FROM generate_series(1, {ChainSize}) n;
            INSERT INTO item_closure (tenant_id, workspace_id, ancestor_id, descendant_id, depth)
            SELECT '{alpha.TenantId:D}'::uuid, '{alpha.WorkspaceId:D}'::uuid,
                ('aaaaaaaa-aaaa-4aaa-8aaa-' || lpad(ancestor::text, 12, '0'))::uuid,
                ('aaaaaaaa-aaaa-4aaa-8aaa-' || lpad(descendant::text, 12, '0'))::uuid, descendant - ancestor
            FROM generate_series(1, {ChainSize}) descendant CROSS JOIN LATERAL generate_series(1, descendant) ancestor;
            """);
    }

    private async Task SeedJobsAsync()
    {
        await using var connection = await fixture.OpenMigratorConnectionAsync();
        foreach (var tenant in new[] { M0SchemaSeed.Alpha, M0SchemaSeed.Beta })
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                INSERT INTO worker_job (job_id, tenant_id, workspace_id, actor_id, kind, idempotency_key,
                    payload, status, attempts, cancellation_requested, created_at, updated_at)
                SELECT gen_random_uuid(), '{tenant.TenantId:D}'::uuid, '{tenant.WorkspaceId:D}'::uuid,
                    '{tenant.PrincipalId:D}'::uuid, 'transcribe', 'guard-job-' || n,
                    jsonb_build_object('nested', jsonb_build_array(jsonb_build_object('id', md5('guard-job-' || n)::uuid))),
                    'queued', 0, false, now(), now() FROM generate_series(1, {JobCount}) n;
                """);
        }
    }

    private static Guid ChainItem(int index) => new("aaaaaaaa-aaaa-4aaa-8aaa-" + index.ToString("D12", CultureInfo.InvariantCulture));

    private static IEnumerable<JsonElement> FindPlans(JsonElement plan, string nodeType)
    {
        if (plan.GetProperty("Node Type").GetString() == nodeType)
        {
            yield return plan;
        }
        if (plan.TryGetProperty("Plans", out var children))
        {
            foreach (var child in children.EnumerateArray())
            {
                foreach (var found in FindPlans(child, nodeType))
                {
                    yield return found;
                }
            }
        }
    }

    private static async Task InsertJobAsync(NpgsqlConnection connection, M0TenantRows tenant, Guid workspace, string status, string payload)
    {
        // Test-only constants/serialized values; use parameters even for fixture JSON and status.
        await using var command = new NpgsqlCommand("""
            INSERT INTO worker_job (job_id, tenant_id, workspace_id, actor_id, kind, idempotency_key,
                payload, status, attempts, cancellation_requested, created_at, updated_at)
            VALUES (gen_random_uuid(), @tenant, @workspace, @actor, 'transcribe', @key,
                @payload::jsonb, @status, 0, false, now(), now())
            """, connection);
        command.Parameters.AddWithValue("tenant", tenant.TenantId);
        command.Parameters.AddWithValue("workspace", workspace);
        command.Parameters.AddWithValue("actor", tenant.PrincipalId);
        command.Parameters.AddWithValue("key", Guid.NewGuid().ToString("D"));
        command.Parameters.AddWithValue("payload", payload);
        command.Parameters.AddWithValue("status", status);
        await command.ExecuteNonQueryAsync(Cancellation);
    }
}
