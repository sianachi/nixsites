using System.Globalization;
using System.Text;
using Nix.Abstractions;
using Nix.Domain.Authorization;
using Nix.Integration.Tests.Harness;
using Nix.Persistence;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The native sync statements over a 50,000-item workspace six levels deep with 200,000 change
/// markers, planned and run as the runtime role under row-level security.
/// </summary>
[Trait("Category", "PlanEvidence")]
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class WorkspaceSyncPlanEvidenceTests(NixPostgresFixture fixture, ITestOutputHelper output) : IAsyncLifetime
{
    private const int Items = 50_000;
    private const int Changes = 200_000;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        await SeedAsync();
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task The_snapshot_page_reads_one_page_of_items_not_the_workspace()
    {
        var plan = await ExplainAsync(WorkspaceSyncSql.Snapshot,
            new("cursor", NpgsqlDbType.Uuid) { Value = DBNull.Value }, new NpgsqlParameter<int>("limit", 201));
        output.WriteLine(plan);
        Assert.Contains("actual", plan, StringComparison.Ordinal);
        Assert.Matches(@"Limit .*actual time=[\d.]+\.\.[\d.]+ rows=201 ", plan);
        Assert.DoesNotContain("Seq Scan on item_closure", plan, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_changes_page_reads_one_page_of_markers()
    {
        var plan = await ExplainAsync(WorkspaceSyncSql.Changes,
            new NpgsqlParameter<long>("after", 100_000), new NpgsqlParameter<long>("boundary", Changes),
            new NpgsqlParameter<int>("limit", 201));
        output.WriteLine(plan);
        Assert.Contains("actual", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on workspace_sync_change", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on item_closure", plan, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_boundary_reads_the_retention_edge_not_every_marker()
    {
        var plan = await ExplainAsync(WorkspaceSyncSql.Boundary, new NpgsqlParameter<long>("after", 100_000));
        output.WriteLine(plan);
        Assert.Contains("actual", plan, StringComparison.Ordinal);
        Assert.Contains("workspace_sync_change_permission", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on workspace_sync_change", plan, StringComparison.Ordinal);
    }

    private async Task<string> ExplainAsync(string statement, params NpgsqlParameter[] extras)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var roles = Enum.GetValues<WorkspaceRole>();
        NpgsqlParameter[] parameters =
        [
            new NpgsqlParameter<Guid>("tenant_id", M0SchemaSeed.Alpha.TenantId),
            new NpgsqlParameter<Guid>("principal_id", M0SchemaSeed.Alpha.PrincipalId),
            new NpgsqlParameter<Guid>("workspace_id", M0SchemaSeed.Alpha.WorkspaceId),
            new NpgsqlParameter<string[]>("read_roles", roles.Select(WorkspaceRoles.ToText).ToArray()),
            new NpgsqlParameter<string[]>("write_roles", roles.Where(static role => role.GrantsWrite()).Select(WorkspaceRoles.ToText).ToArray()),
            new NpgsqlParameter<bool>("may_write", true),
            new NpgsqlParameter<DateTimeOffset>("now", DateTimeOffset.UtcNow),
            new NpgsqlParameter<Guid>("credential_id", Guid.NewGuid()),
            .. extras,
        ];
        var plan = new StringBuilder();
        await foreach (var line in work.Resolve<NixSqlExecutor>().QueryAsync<string, PlanMapper>(
            "EXPLAIN (ANALYZE, BUFFERS) " + statement, default, parameters, Cancellation))
        {
            plan.AppendLine(line);
        }
        return plan.ToString();
    }

    private async Task SeedAsync()
    {
        var t = M0SchemaSeed.Alpha.TenantId.ToString("D", CultureInfo.InvariantCulture);
        var w = M0SchemaSeed.Alpha.WorkspaceId.ToString("D", CultureInfo.InvariantCulture);
        var p = M0SchemaSeed.Alpha.PrincipalId.ToString("D", CultureInfo.InvariantCulture);
        var root = M0SchemaSeed.Alpha.ItemId.ToString("D", CultureInfo.InvariantCulture);
        // Item n has parent (n + 6) / 8 in an 8-ary heap hanging under the seeded root: 50,000 items are six levels deep.
        await using var connection = await fixture.OpenSuperuserConnectionAsync();
        await RawSql.ExecuteAsync(connection, null, $"""
            SET session_replication_role = replica;
            DELETE FROM workspace_sync_change; DELETE FROM workspace_sync_item_revision;
            CREATE TEMP TABLE scale_item AS
              SELECT n, md5('scale-' || n)::uuid AS id,
                     CASE WHEN n = 1 THEN '{root}'::uuid ELSE md5('scale-' || ((n + 6) / 8))::uuid END AS parent_id
              FROM generate_series(1, {Items}) n;
            INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                              created_by, last_modified_by, created_at, last_modified_at)
              SELECT id, '{t}', '{w}', 'note', parent_id, 1000 + n, jsonb_build_object('title', 'Scale ' || n),
                     'active', '{p}', '{p}', now(), now() FROM scale_item;
            INSERT INTO item_closure (tenant_id, workspace_id, descendant_id, ancestor_id, depth)
              WITH RECURSIVE walk(descendant_id, ancestor_id, depth) AS (
                  SELECT id, id, 0 FROM scale_item
                  UNION ALL
                  SELECT walk.descendant_id, item.parent_id, walk.depth + 1
                  FROM walk JOIN item ON item.id = walk.ancestor_id AND item.tenant_id = '{t}'
                  WHERE item.parent_id IS NOT NULL AND walk.depth < 20)
              SELECT '{t}', '{w}', descendant_id, ancestor_id, depth FROM walk WHERE depth > 0 OR true
              ON CONFLICT DO NOTHING;
            INSERT INTO workspace_sync_item_revision (tenant_id, workspace_id, item_id, seq)
              SELECT '{t}', '{w}', id, 1 + n % 5 FROM scale_item;
            INSERT INTO workspace_sync_change (tenant_id, workspace_id, seq, item_id, metadata_revision, created_at)
              SELECT '{t}', '{w}', s, md5('scale-' || (1 + s % {Items}))::uuid, s % 3 = 0,
                     now() - make_interval(secs => ({Changes} - s) * 10)
              FROM generate_series(1, {Changes}) s;
            INSERT INTO workspace_sync_revision (tenant_id, workspace_id, seq) VALUES ('{t}', '{w}', {Changes})
              ON CONFLICT (tenant_id, workspace_id) DO UPDATE SET seq = {Changes};
            ANALYZE item, item_closure, workspace_sync_item_revision, workspace_sync_change, workspace_sync_revision;
            """, commandTimeoutSeconds: 600);
    }

    private readonly struct PlanMapper : INixRowMapper<string>
    {
        public string Map(NpgsqlDataReader reader) => reader.GetString(0);
    }
}
