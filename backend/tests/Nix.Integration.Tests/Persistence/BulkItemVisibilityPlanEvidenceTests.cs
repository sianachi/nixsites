using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Integration.Tests.Persistence;

/// <summary>Runtime-role plans for the bulk reads that apply derived item visibility.</summary>
[Trait("Category", "PlanEvidence")]
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class BulkItemVisibilityPlanEvidenceTests : IAsyncLifetime
{
    private const int CorpusSize = 3_200;
    private const int BookmarkSize = 499;

    private static readonly Guid Root = new("b17c0000-1111-4111-8111-b17c00000001");

    private readonly NixPostgresFixture _fixture;
    private readonly ITestOutputHelper _output;
    private Guid[] _itemIds = [];

    public BulkItemVisibilityPlanEvidenceTests(NixPostgresFixture fixture, ITestOutputHelper output)
    {
        _fixture = fixture;
        _output = output;
    }

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedCorpusAsync();
        _itemIds = await ReadCorpusIdsAsync();
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task The_graph_visibility_probe_stays_descendant_and_path_bounded()
    {
        var plan = await ExplainAsync(
            GraphSql.WorkspaceGraph,
            [
                Uuid("workspace_id", M0SchemaSeed.Alpha.WorkspaceId),
                Uuids("workspace_ids", [M0SchemaSeed.Alpha.WorkspaceId]),
                Integer("node_limit", 501),
                Integer("link_limit", 501),
                Uuids("lock_ids", [_itemIds[^1]]),
                Uuids("closed_lock_ids", [_itemIds[^1]]),
            ]);

        RecordAndAssert("Graph", plan);
        Assert.Contains("Limit", plan, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Search_visibility_runs_once_after_the_indexed_match_arms()
    {
        var plan = await ExplainAsync(
            SearchSql.MatchingItems,
            [
                Uuids("workspace_ids", [M0SchemaSeed.Alpha.WorkspaceId]),
                Text("title_pattern", "%visibility%"),
                Text("query", "visibility"),
                Integer("limit", 50),
                new NpgsqlParameter("pet_sources_only", NpgsqlDbType.Boolean) { Value = false },

                // No locks: the case this plan was recorded for, in which the lock probes fold
                // away. The backlink and graph cases below carry a lock and run the probe.
                Uuids("lock_ids", []),
                Uuids("closed_lock_ids", []),
            ]);

        RecordAndAssert("Search", plan);
        Assert.Contains("IX_item_tenant_id_workspace_id", plan, StringComparison.Ordinal);
        Assert.Contains("Seq Scan on item_search search", plan, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Reference_and_backlink_visibility_use_bounded_identifiers_and_target_index()
    {
        var referencePlan = await ExplainAsync(
            SearchSql.ReadableItemsById,
            [
                Uuids("workspace_ids", [M0SchemaSeed.Alpha.WorkspaceId]),
                Uuids("item_ids", _itemIds[..200]),
            ]);
        RecordAndAssert("Reference resolution", referencePlan);

        var backlinkPlan = await ExplainAsync(
            SearchSql.ItemsLinkingTo,
            [
                Uuid("target_item_id", M0SchemaSeed.Alpha.ItemId),
                Uuids("workspace_ids", [M0SchemaSeed.Alpha.WorkspaceId]),
                Integer("limit", 50),
                Uuids("lock_ids", [_itemIds[^1]]),
            ]);
        RecordAndAssert("Backlinks", backlinkPlan);
        Assert.Contains("ix_item_link_target_occurrences", backlinkPlan, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("%Visibility match%", "zzqx")]
    [InlineData("%zzqx%", "visibility")]
    [InlineData("%visibility%", "visibility")]
    public async Task Search_probes_hidden_ancestors_only_for_the_rows_that_reach_the_limit(
        string titlePattern,
        string query)
    {
        // 32 items match each arm, far more than the limit: probing before the sort would run the
        // ancestor probe once per hit, probing after it runs it once per returned row.
        const int Limit = 5;
        var plan = await ExplainAsync(
            SearchSql.MatchingItems,
            [
                Uuids("workspace_ids", [M0SchemaSeed.Alpha.WorkspaceId]),
                Text("title_pattern", titlePattern),
                Text("query", query),
                Integer("limit", Limit),
                new NpgsqlParameter("pet_sources_only", NpgsqlDbType.Boolean) { Value = false },
                Uuids("lock_ids", []),
                Uuids("closed_lock_ids", []),
            ]);

        // One arm matches nothing, so its half of the plan legitimately never executes.
        _output.WriteLine(plan);
        AssertProbeLoopsBoundedBy(plan, Limit);
    }

    [Fact]
    public async Task Backlinks_probe_hidden_ancestors_only_for_the_rows_that_reach_the_limit()
    {
        const int Limit = 5;
        var plan = await ExplainAsync(
            SearchSql.ItemsLinkingTo,
            [
                Uuid("target_item_id", M0SchemaSeed.Alpha.ItemId),
                Uuids("workspace_ids", [M0SchemaSeed.Alpha.WorkspaceId]),
                Integer("limit", Limit),
                Uuids("lock_ids", [_itemIds[^1]]),
            ]);

        RecordAndAssert("Backlink probes", plan);
        AssertProbeLoopsBoundedBy(plan, Limit);
    }

    private static void AssertProbeLoopsBoundedBy(string plan, int limit)
    {
        var loops = Regex.Matches(
                plan,
                "IX_item_closure_tenant_id_descendant_id\"[^\r\n]*loops=(\\d+)",
                RegexOptions.CultureInvariant)
            .Select(match => int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture))
            .ToList();

        Assert.NotEmpty(loops);
        Assert.All(loops, count => Assert.True(count <= limit, $"probe ran {count} times for limit {limit}:\n{plan}"));
    }

    [Fact]
    public async Task Bookmark_list_visibility_keeps_the_principal_shelf_index()
    {
        var plan = await ExplainAsync(
            BookmarkSql.ListShelf,
            [
                Uuid("principal_id", M0SchemaSeed.Alpha.PrincipalId),
                Uuids("workspace_ids", [M0SchemaSeed.Alpha.WorkspaceId]),
            ]);

        RecordAndAssert("Bookmark list", plan);
        Assert.Contains("IX_bookmark_tenant_id_principal_id_seq", plan, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Bookmark_keep_checks_visibility_inside_the_atomic_insert_select()
    {
        var plan = await ExplainAsync(
            BookmarkSql.Keep,
            [
                Uuid("principal_id", M0SchemaSeed.Alpha.PrincipalId),
                Uuid("item_id", _itemIds[^1]),
                Uuids("workspace_ids", [M0SchemaSeed.Alpha.WorkspaceId]),
            ]);

        RecordAndAssert("Bookmark keep", plan);
        Assert.Contains("Insert on bookmark", plan, StringComparison.Ordinal);
    }

    private void RecordAndAssert(string operation, string plan)
    {
        _output.WriteLine("{0}, {1} candidate items, runtime role:", operation, CorpusSize);
        _output.WriteLine(plan);

        Assert.Contains("IX_item_closure_tenant_id_descendant_id", plan, StringComparison.Ordinal);
        Assert.True(
            plan.Contains("AK_item_tenant_id_id", StringComparison.Ordinal)
            || plan.Contains(
                "Index Scan using \"PK_item\" on item visibility_ancestor",
                StringComparison.Ordinal),
            "Expected each visibility ancestor to be resolved through a point index lookup.");
        Assert.Contains("actual", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on item visibility_ancestor", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on item_closure", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("never executed", plan, StringComparison.Ordinal);
    }

    private async Task<string> ExplainAsync(string sql, IReadOnlyList<NpgsqlParameter> parameters)
    {
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var transaction = await connection.BeginTransactionAsync(TestContext.Current.CancellationToken);
            await using (transaction.ConfigureAwait(false))
            {
                var context = new NpgsqlCommand(
                    "SELECT set_config('nix.tenant_id', @tenant, true)",
                    connection,
                    transaction);
                await using (context.ConfigureAwait(false))
                {
                    context.Parameters.Add(Text(
                        "tenant",
                        M0SchemaSeed.Alpha.TenantId.ToString("D", CultureInfo.InvariantCulture)));
                    await context.ExecuteNonQueryAsync(TestContext.Current.CancellationToken);
                }

#pragma warning disable CA2100 // Justification: every statement is a production-owned static SQL constant.
                var command = new NpgsqlCommand("EXPLAIN (ANALYZE, BUFFERS) " + sql, connection, transaction);
#pragma warning restore CA2100
                await using (command.ConfigureAwait(false))
                {
                    command.Parameters.Add(Uuid("tenant_id", M0SchemaSeed.Alpha.TenantId));
                    foreach (var parameter in parameters)
                    {
                        command.Parameters.Add(parameter);
                    }

                    var output = new StringBuilder();
                    var reader = await command.ExecuteReaderAsync(TestContext.Current.CancellationToken);
                    await using (reader.ConfigureAwait(false))
                    {
                        while (await reader.ReadAsync(TestContext.Current.CancellationToken))
                        {
                            output.AppendLine(reader.GetString(0));
                        }
                    }

                    return output.ToString();
                }
            }
        }
    }

    private async Task SeedCorpusAsync()
    {
        var alphaTenant = RawSql.Literal(M0SchemaSeed.Alpha.TenantId);
        var alphaWorkspace = RawSql.Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var alphaPrincipal = RawSql.Literal(M0SchemaSeed.Alpha.PrincipalId);
        var betaTenant = RawSql.Literal(M0SchemaSeed.Beta.TenantId);
        var betaWorkspace = RawSql.Literal(M0SchemaSeed.Beta.WorkspaceId);
        var betaPrincipal = RawSql.Literal(M0SchemaSeed.Beta.PrincipalId);

        var sql = $$"""
            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                 purge_after, created_by, last_modified_by, created_at, last_modified_at)
            VALUES
                ({{RawSql.Literal(Root)}}, {{alphaTenant}}, {{alphaWorkspace}}, 'note', NULL, 599999,
                 '{"title":"Visibility root"}'::jsonb, 'active', NULL, {{alphaPrincipal}},
                 {{alphaPrincipal}}, now(), now());

            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                 purge_after, created_by, last_modified_by, created_at, last_modified_at)
            SELECT gen_random_uuid(), {{alphaTenant}}, {{alphaWorkspace}}, 'note', {{RawSql.Literal(Root)}},
                   600000 + n,
                   jsonb_build_object(
                       'title', CASE WHEN n <= 32
                                    THEN 'Visibility match ' || n
                                    ELSE 'Bulk item ' || n END),
                   'active', NULL, {{alphaPrincipal}}, {{alphaPrincipal}}, now(), now()
            FROM generate_series(1, {{CorpusSize}}) AS n;

            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                 purge_after, created_by, last_modified_by, created_at, last_modified_at)
            SELECT gen_random_uuid(), {{betaTenant}}, {{betaWorkspace}}, 'note', NULL,
                   700000 + n, jsonb_build_object('title', 'Visibility match other ' || n),
                   'active', NULL, {{betaPrincipal}}, {{betaPrincipal}}, now(), now()
            FROM generate_series(1, {{CorpusSize}}) AS n;

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT id, id, tenant_id, workspace_id, 0
            FROM item
            WHERE seq >= 599999;

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT id, {{RawSql.Literal(Root)}}, tenant_id, workspace_id, 1
            FROM item
            WHERE tenant_id = {{alphaTenant}} AND seq >= 600001;

            INSERT INTO item_search (tenant_id, item_id, seq, updated_at, body_vector)
            SELECT tenant_id, id, 1, now(),
                   to_tsvector(
                       'english',
                       CASE WHEN seq <= 600032
                            THEN 'visibility body match'
                            ELSE 'ordinary body text' END)
            FROM item
            WHERE seq >= 600001;

            INSERT INTO item_link (tenant_id, source_item_id, target_item_id, occurrences, seq)
            SELECT tenant_id, id,
                   CASE WHEN seq <= 600100
                        THEN {{RawSql.Literal(M0SchemaSeed.Alpha.ItemId)}}
                        ELSE {{RawSql.Literal(Root)}} END,
                   1, 1
            FROM item
            WHERE tenant_id = {{alphaTenant}} AND seq >= 600001;

            DELETE FROM bookmark;

            INSERT INTO bookmark (principal_id, tenant_id, item_id, created_at)
            SELECT {{alphaPrincipal}}, tenant_id, id, now()
            FROM item
            WHERE tenant_id = {{alphaTenant}}
              AND seq BETWEEN 600001 AND {{600000 + BookmarkSize}};

            INSERT INTO bookmark (principal_id, tenant_id, item_id, created_at)
            SELECT {{betaPrincipal}}, tenant_id, id, now()
            FROM item
            WHERE tenant_id = {{betaTenant}}
              AND seq BETWEEN 700001 AND {{700000 + BookmarkSize}};

            -- One lock, on a leaf, so the lock probes the bulk reads now carry run against a real
            -- row. With no locks at all the planner drives them from the empty lock table and the
            -- closure half is never executed, which would say nothing about its plan.
            INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
            SELECT id, tenant_id,
                   'pbkdf2-sha256$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
                   {{alphaPrincipal}}, now()
            FROM item
            WHERE tenant_id = {{alphaTenant}} AND seq = {{600000 + CorpusSize}};

            ANALYZE item;
            ANALYZE item_lock;
            ANALYZE item_closure;
            ANALYZE item_search;
            ANALYZE item_link;
            ANALYZE bookmark;
            """;

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    private async Task<Guid[]> ReadCorpusIdsAsync()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var command = new NpgsqlCommand(
                "SELECT id FROM item WHERE tenant_id = @tenant AND seq >= 600001 ORDER BY seq",
                connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.Add(Uuid("tenant", M0SchemaSeed.Alpha.TenantId));
                var result = new List<Guid>(CorpusSize);
                var reader = await command.ExecuteReaderAsync(TestContext.Current.CancellationToken);
                await using (reader.ConfigureAwait(false))
                {
                    while (await reader.ReadAsync(TestContext.Current.CancellationToken))
                    {
                        result.Add(reader.GetGuid(0));
                    }
                }

                return [.. result];
            }
        }
    }

    private static NpgsqlParameter Uuid(string name, Guid value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value };

    private static NpgsqlParameter Uuids(string name, Guid[] value) =>
        new(name, NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = value };

    private static NpgsqlParameter Text(string name, string value) =>
        new(name, NpgsqlDbType.Text) { Value = value };

    private static NpgsqlParameter Integer(string name, int value) =>
        new(name, NpgsqlDbType.Integer) { Value = value };
}
