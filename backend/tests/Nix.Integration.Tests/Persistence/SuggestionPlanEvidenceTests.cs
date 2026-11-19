using System.Globalization;
using System.Text;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Runtime-role plans for the two suggestion reads: mention matching (<c>ItemsTitledAs</c>) and
/// related items (<c>CoCitedItems</c>).
/// </summary>
/// <remarks>
/// <para>
/// The sibling of <see cref="BulkItemVisibilityPlanEvidenceTests"/>, and for the same reason: a
/// documented index is not proof it is used, and both statements were shaped against a planner
/// that, left alone, chose a corpus scan or paid for JIT compilation. Each test runs the statement
/// as the runtime role under RLS with a closed lock in force, prints the plan, and asserts the
/// shape the statement's remarks claim - the indexes it drives from, the stages that bound it, a
/// lock and visibility probe per surviving row through point indexes, and no JIT.
/// </para>
/// <para>
/// The corpus is small enough for the shared fixture (3,200 items, a hub linked from 300 sources
/// that each link to ten more). The production-scale numbers - a 150,000-item workspace and a
/// 3,000-source hub - are recorded in <c>SearchSql</c>, measured on a throwaway database.
/// </para>
/// </remarks>
[Trait("Category", "PlanEvidence")]
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class SuggestionPlanEvidenceTests : IAsyncLifetime
{
    private const int CorpusSize = 3_200;
    private const int HubSources = 300;
    private const int ClosedLockCount = 30;

    private static readonly Guid Root = new("5a9e0000-1111-4111-8111-5a9e00000001");

    private readonly NixPostgresFixture _fixture;
    private readonly ITestOutputHelper _output;
    private Guid[] _itemIds = [];

    public SuggestionPlanEvidenceTests(NixPostgresFixture fixture, ITestOutputHelper output)
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
    public async Task Mention_matching_scans_one_workspace_caps_each_phrase_and_probes_only_candidates()
    {
        var phrases = new List<string> { "weekly review", "planning", "quarterly planning" };
        for (var index = 1; index <= 3_997; index++)
        {
            phrases.Add(string.Create(CultureInfo.InvariantCulture, $"absent phrase {index}"));
        }

        var plan = await ExplainAsync(
            SearchSql.ItemsTitledAs,
            [
                Uuids("workspace_ids", [M0SchemaSeed.Alpha.WorkspaceId]),
                new NpgsqlParameter("phrases", NpgsqlDbType.Array | NpgsqlDbType.Text) { Value = phrases.ToArray() },
                Uuids("exclude_ids", _itemIds[..256]),
                Integer("per_phrase_limit", 3),
                Integer("candidate_limit", 200),
                Integer("limit", 20),
                Uuids("closed_lock_ids", ClosedLockIds()),
            ]);

        RecordAndAssert("Mentions", plan);
        Assert.Contains("IX_item_tenant_id_workspace_id", plan, StringComparison.Ordinal);
        Assert.Contains("WindowAgg", plan, StringComparison.Ordinal);
        Assert.Contains("CTE matches", plan, StringComparison.Ordinal);
        Assert.Contains("CTE candidates", plan, StringComparison.Ordinal);

        // The per-phrase cap: "Weekly review" titles 400 items, and at most three survive it.
        Assert.Contains("Run Condition: (row_number() OVER (?) <= ", plan, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Related_items_drive_from_the_ordered_target_index_and_probe_each_source_s_edges()
    {
        var plan = await ExplainAsync(
            SearchSql.CoCitedItems,
            [
                Uuid("target_item_id", M0SchemaSeed.Alpha.ItemId),
                Uuids("workspace_ids", [M0SchemaSeed.Alpha.WorkspaceId]),
                Integer("source_limit", 200),
                Integer("candidate_limit", 200),
                Integer("limit", 10),
                Uuids("lock_ids", ClosedLockIds()),
                Uuids("closed_lock_ids", ClosedLockIds()),
            ]);

        RecordAndAssert("Related items", plan);
        Assert.Contains("ix_item_link_target_occurrences", plan, StringComparison.Ordinal);
        Assert.Contains("PK_item_link", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on item_link", plan, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("zzqx", false)]
    [InlineData("weekly review", true)]
    public async Task Search_with_closed_locks_reads_the_hidden_set_once_and_anti_joins_the_title_arm(string query, bool petSourcesOnly)
    {
        // The data review's case: a query matching nothing, by someone with closed locks. A per-row
        // lock probe in the title arm was costed against the whole scan and JIT-compiled every
        // search; the materialised hidden set is read once and costs one anti-join.
        var plan = await ExplainAsync(
            SearchSql.MatchingItems,
            [
                Uuids("workspace_ids", [M0SchemaSeed.Alpha.WorkspaceId]),
                Text("title_pattern", $"%{query}%"),
                Text("query", query),
                Integer("limit", 50),
                new NpgsqlParameter("pet_sources_only", NpgsqlDbType.Boolean) { Value = petSourcesOnly },
                Uuids("lock_ids", ClosedLockIds()),
                Uuids("closed_lock_ids", ClosedLockIds()),
            ]);

        _output.WriteLine("Search q={0} with closed locks, runtime role:", query);
        _output.WriteLine(plan);
        Assert.Contains("CTE closed_lock_descendants", plan, StringComparison.Ordinal);
        Assert.Contains("IX_item_closure_tenant_id_ancestor_id_depth", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("JIT:", plan, StringComparison.Ordinal);
    }

    private Guid[] ClosedLockIds() => _itemIds[^ClosedLockCount..];

    [Fact]
    public async Task Graph_with_closed_locks_excludes_hidden_nodes_without_jit()
    {
        var plan = await ExplainAsync(
            GraphSql.WorkspaceGraph,
            [
                Uuid("workspace_id", M0SchemaSeed.Alpha.WorkspaceId),
                Uuids("workspace_ids", [M0SchemaSeed.Alpha.WorkspaceId]),
                Integer("node_limit", 2_001),
                Integer("link_limit", 4_001),
                Uuids("lock_ids", ClosedLockIds()),
                Uuids("closed_lock_ids", ClosedLockIds()),
            ]);

        RecordAndAssert("Graph with closed locks", plan);
        Assert.Contains("CTE closed_lock_descendants", plan, StringComparison.Ordinal);
        Assert.Contains("CTE body_locked_nodes", plan, StringComparison.Ordinal);
    }

    private void RecordAndAssert(string operation, string plan)
    {
        _output.WriteLine("{0}, {1} items, runtime role:", operation, CorpusSize);
        _output.WriteLine(plan);

        Assert.Contains("actual", plan, StringComparison.Ordinal);
        Assert.Contains("IX_item_closure_tenant_id_descendant_id", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on item_closure", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on item visibility_ancestor", plan, StringComparison.Ordinal);

        // The statements are staged precisely so the planner never costs a per-row probe against
        // a guessed corpus; JIT compilation is the symptom when it does.
        Assert.DoesNotContain("JIT:", plan, StringComparison.Ordinal);
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

    /// <summary>
    /// Seeds, as the migrator: a root in the Alpha workspace with 3,200 children (400 titled
    /// "Weekly review", 40 "Planning", the rest distinct), the same count in the other tenant
    /// under the same titles, a hub (the seeded Alpha item) linked from 300 of the children that
    /// each link to ten others, and 30 closed locks, one with two children, so the exclusion sets contain real rows.
    /// </summary>
    private async Task SeedCorpusAsync()
    {
        var alphaTenant = Literal(M0SchemaSeed.Alpha.TenantId);
        var alphaWorkspace = Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var alphaPrincipal = Literal(M0SchemaSeed.Alpha.PrincipalId);
        var betaTenant = Literal(M0SchemaSeed.Beta.TenantId);
        var betaWorkspace = Literal(M0SchemaSeed.Beta.WorkspaceId);
        var betaPrincipal = Literal(M0SchemaSeed.Beta.PrincipalId);

        var sql = $$"""
            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                 purge_after, created_by, last_modified_by, created_at, last_modified_at)
            VALUES
                ({{Literal(Root)}}, {{alphaTenant}}, {{alphaWorkspace}}, 'note', NULL, 599999,
                 '{"title":"Suggestion root"}'::jsonb, 'active', NULL, {{alphaPrincipal}},
                 {{alphaPrincipal}}, now(), now());

            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                 purge_after, created_by, last_modified_by, created_at, last_modified_at)
            SELECT gen_random_uuid(), {{alphaTenant}}, {{alphaWorkspace}}, 'note', {{Literal(Root)}},
                   600000 + n,
                   jsonb_build_object(
                       'title', CASE WHEN n % 8 = 0 THEN 'Weekly review'
                                     WHEN n % 80 = 1 THEN 'Planning'
                                     ELSE 'Suggestion item ' || n END),
                   'active', NULL, {{alphaPrincipal}}, {{alphaPrincipal}}, now(),
                   now() - make_interval(mins => n)
            FROM generate_series(1, {{CorpusSize}}) AS n;

            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                 purge_after, created_by, last_modified_by, created_at, last_modified_at)
            SELECT gen_random_uuid(), {{betaTenant}}, {{betaWorkspace}}, 'note', NULL,
                   700000 + n,
                   jsonb_build_object('title', CASE WHEN n % 8 = 0 THEN 'Weekly review' ELSE 'Other ' || n END),
                   'active', NULL, {{betaPrincipal}}, {{betaPrincipal}}, now(), now()
            FROM generate_series(1, {{CorpusSize}}) AS n;

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT id, id, tenant_id, workspace_id, 0
            FROM item
            WHERE seq >= 599999;

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT id, {{Literal(Root)}}, tenant_id, workspace_id, 1
            FROM item
            WHERE tenant_id = {{alphaTenant}} AND seq >= 600001;

            -- The hub: the first 300 children link to it, a varying number of times.
            INSERT INTO item_link (tenant_id, source_item_id, target_item_id, occurrences, seq)
            SELECT tenant_id, id, {{Literal(M0SchemaSeed.Alpha.ItemId)}}, 1 + (seq % 5)::int, 1
            FROM item
            WHERE tenant_id = {{alphaTenant}} AND seq BETWEEN 600001 AND {{600000 + HubSources}};

            -- Each of those links to ten more children, so co-citations overlap.
            INSERT INTO item_link (tenant_id, source_item_id, target_item_id, occurrences, seq)
            SELECT source.tenant_id, source.id, target.id, 1, 1
            FROM item AS source
            CROSS JOIN generate_series(1, 10) AS k
            JOIN item AS target
              ON target.tenant_id = source.tenant_id
             AND target.seq = 600000 + {{HubSources}} + 1 + ((source.seq * 7 + k * 13) % 2000)
            WHERE source.tenant_id = {{alphaTenant}}
              AND source.seq BETWEEN 600001 AND {{600000 + HubSources}}
            ON CONFLICT DO NOTHING;

            INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
            SELECT id, tenant_id,
                   'pbkdf2-sha256$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
                   {{alphaPrincipal}}, now()
            FROM item
            WHERE tenant_id = {{alphaTenant}}
              AND seq BETWEEN {{600000 + CorpusSize - ClosedLockCount + 1}} AND {{600000 + CorpusSize}};

            -- Two children under a closed lock exercise both node and body exclusion sets.
            UPDATE item SET parent_id = (
                SELECT id FROM item WHERE tenant_id = {{alphaTenant}} AND seq = {{600000 + CorpusSize}}
            )
            WHERE tenant_id = {{alphaTenant}} AND seq IN (600001, 600002);

            UPDATE item_closure SET depth = 2
            WHERE tenant_id = {{alphaTenant}}
              AND ancestor_id = {{Literal(Root)}}
              AND descendant_id IN (
                  SELECT id FROM item WHERE tenant_id = {{alphaTenant}} AND seq IN (600001, 600002)
              );

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT child.id, parent.id, child.tenant_id, child.workspace_id, 1
            FROM item AS child
            JOIN item AS parent ON parent.tenant_id = child.tenant_id AND parent.id = child.parent_id
            WHERE child.tenant_id = {{alphaTenant}} AND child.seq IN (600001, 600002);

            ANALYZE item;
            ANALYZE item_lock;
            ANALYZE item_closure;
            ANALYZE item_link;
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

    private static string Literal(Guid value) =>
        $"'{value.ToString("D", CultureInfo.InvariantCulture)}'::uuid";
}
