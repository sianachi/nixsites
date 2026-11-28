using System.Globalization;
using System.Text;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Plan evidence for the rollup and chart folds (goals 2.2, 2.3, and 2.4's performance row).
/// </summary>
/// <remarks>
/// <para>
/// <b>As the runtime role, under row security, against a corpus big enough that the planner has a
/// real choice</b> - the standard <see cref="TaskSemanticsPlanEvidenceTests"/> sets and the reason
/// it sets it: a plan gathered over the migrator connection bypasses the policy, and at three
/// thousand rows Postgres seq-scans whatever the indexes say.
/// </para>
/// <para>
/// The corpus: 400 containers under tenant Alpha with 120,000 children between them - 300 each -
/// each child carrying a numeric <c>estimate</c>, a boolean <c>completion</c> and a <c>status</c>
/// to group by. 5,000 rows under tenant Beta so the policy has something to exclude. A page folds
/// 50 of the 400 containers, so the rows it wants are about a tenth of the workspace.
/// </para>
/// <para>
/// <b>What the plan has to show, and what the first corpus got wrong.</b> A fold reads every child
/// of every parent on the page - that is what an aggregate is - so the claim is not "few rows were
/// read" but that the cost is proportional to the children of the parents <em>asked about</em>
/// rather than to the size of the workspace. That is what
/// <c>IX_item_workspace_id_parent_id_seq</c> buys, and it is why the corpus has to hold containers
/// the page does not name. The first version of this file did not: it put 60,000 children under
/// exactly the 50 containers being folded, so the fold wanted 96% of the workspace and Postgres
/// correctly chose a parallel sequential scan - a plan that says nothing about the statement,
/// because there was nothing for an index to skip. The measurement is the evidence; a doc comment
/// naming an index is a hypothesis.
/// </para>
/// </remarks>
[Trait("Category", "PlanEvidence")]
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class RollupPlanEvidenceTests : IAsyncLifetime
{
    private const int Containers = 400;
    private const int AlphaChildren = 120_000;

    /// <summary>How many containers one page folds at once - the shape a listing actually has.</summary>
    private const int PageSize = 50;
    private const int BetaItems = 5_000;

    private static readonly Guid AlphaRoot = new("70110000-1111-4111-8111-701100000001");

    /// <summary>
    /// One container far larger than the rest, under a root of its own so the page of ordinary
    /// containers above is unchanged: the case a chart over years of daily entries is.
    /// </summary>
    private static readonly Guid BigRoot = new("70110000-1111-4111-8111-701100000003");
    private static readonly Guid BigContainer = new("70110000-1111-4111-8111-701100000004");
    private const int BigChildren = 60_000;

    /// <summary>
    /// A container in the other tenant, with children of its own carrying the folded property.
    /// </summary>
    /// <remarks>
    /// It has children on purpose. The first version of this file gave Beta only parentless rows,
    /// which meant no Beta row could satisfy <c>c.parent_id = container.id</c> under any scoping at all -
    /// so the isolation assertion was true by construction of the corpus and would have stayed
    /// green with the tenant predicate deleted. Found in the security review of goal 2.2.
    /// </remarks>
    private static readonly Guid BetaContainer = new("70110000-2222-4222-8222-701100000002");

    /// <summary>
    /// A closed lock on nothing in the corpus, so the fold's lock probe runs rather than folding
    /// away as it does when nothing is locked.
    /// </summary>
    private static readonly Guid ClosedLockStandIn = new("10c10c10-0000-4000-8000-10c10c10c10c");

    private readonly NixPostgresFixture _fixture;
    private readonly ITestOutputHelper _output;

    public RollupPlanEvidenceTests(NixPostgresFixture fixture, ITestOutputHelper output)
    {
        _fixture = fixture;
        _output = output;
    }

    private static readonly SeedOnce Seeded = new();

    public ValueTask InitializeAsync() => new(Seeded.RunAsync(async () =>
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedCorpusAsync();
    }));

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task The_fold_reaches_each_parent_children_through_the_parent_index()
    {
        var parents = await PageOfContainerIdsAsync();

        var plan = await ExplainAsRuntimeRoleAsync(
            RollupSql.AggregateChildProperties,
            [
                Uuid("tenant_id", M0SchemaSeed.Alpha.TenantId),
                Uuid("workspace_id", M0SchemaSeed.Alpha.WorkspaceId),
                UuidArray("parent_ids", parents),
                TextArray("keys", ["estimate", "completion"]),
                UuidArray("closed_lock_ids", [ClosedLockStandIn]),
            ]);

        _output.WriteLine(
            "Rollup fold, {0} of {1} containers x 2 keys, {2} readable children in the workspace, "
                + "runtime role:",
            parents.Length,
            Containers,
            AlphaChildren);
        _output.WriteLine(plan);

        // The parents drive: one index range per parent, not a scan of the table with the other
        // seven eighths thrown away. The index named is the one the planner actually chooses -
        // the lateral's condition is tenant and parent, and the workspace is a filter on top.
        Assert.Contains("Nested Loop", plan, StringComparison.Ordinal);
        Assert.Contains("Index Scan using \"IX_item_tenant_id_parent_id\"", plan, StringComparison.Ordinal);
        Assert.Contains("Index Cond:", plan, StringComparison.Ordinal);
        Assert.Contains("parent_id = container.id", plan, StringComparison.Ordinal);

        // The plan this replaced. A sequential scan here is not slower at this size - it measured
        // faster - it is a plan whose cost grows with the workspace instead of with the page, and
        // that is the one that ends a phase two sizes from now.
        Assert.DoesNotContain("Seq Scan on item c", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Parallel Seq Scan", plan, StringComparison.Ordinal);

        // The row-security qual is pinned as present rather than left incidental: a change that
        // let the fold be served above the policy would keep every shape assertion green.
        Assert.Contains("nix.tenant_id", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("never executed", plan, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_fold_answers_only_for_the_tenant_it_runs_as()
    {
        // The plan half above could be green while a mis-scoped read leaked.
        var parents = await AllContainerIdsAsync();

        var rows = await FoldAsRuntimeRoleAsync(parents, ["estimate"]);

        Assert.NotEmpty(rows);
        Assert.All(rows, row => Assert.True(row.Children > 0));

        // Every one of Alpha's children, and not one of Beta's - which sit in the same table.
        Assert.Equal(AlphaChildren, rows.Sum(row => row.Children));
    }

    [Fact]
    public async Task The_fold_refuses_a_parent_in_another_tenant_that_really_does_have_children()
    {
        // The assertion that can fail. Beta's container has a child carrying the folded property,
        // so a row is available to match on and only the tenant predicate and the row-security
        // policy stand between it and the answer.
        var rows = await FoldAsRuntimeRoleAsync([BetaContainer], ["estimate"]);

        Assert.Empty(rows);
    }

    [Fact]
    public async Task A_child_whose_value_is_not_a_number_is_left_out_rather_than_failing_the_fold()
    {
        // A property bag is client-influenced data. The corpus deliberately holds text where a
        // number belongs on about one child in ninety-seven; an unguarded cast would fail the
        // whole statement, so one bad value would cost every rollup on the page.
        var parents = await AllContainerIdsAsync();

        var rows = await FoldAsRuntimeRoleAsync(parents, ["estimate"]);

        Assert.All(rows, row => Assert.True(row.Numbers < row.Children));
        Assert.All(rows, row => Assert.True(row.Numbers > 0));
    }

    [Fact]
    public async Task The_chart_bucketing_reaches_one_container_children_through_the_parent_index()
    {
        var parents = await PageOfContainerIdsAsync();

        var plan = await ExplainAsRuntimeRoleAsync(
            RollupSql.BucketChildrenByProperty,
            [
                Uuid("tenant_id", M0SchemaSeed.Alpha.TenantId),
                Uuid("workspace_id", M0SchemaSeed.Alpha.WorkspaceId),
                Uuid("parent_id", parents[0]),
                Text("group_key", "status"),
                Text("measure_key", "estimate"),
                Int("limit", 100),
            ]);

        _output.WriteLine(
            "Chart bucketing, one container of ~{0} children out of {1} in the workspace, "
                + "runtime role:",
            AlphaChildren / Containers,
            AlphaChildren);
        _output.WriteLine(plan);

        Assert.Contains("Index Scan using \"IX_item_tenant_id_parent_id\"", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on item c", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Parallel Seq Scan", plan, StringComparison.Ordinal);
        Assert.Contains("nix.tenant_id", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("never executed", plan, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(nameof(RollupSql.BucketChildrenByPropertyAndSeries))]
    [InlineData(nameof(RollupSql.BucketChildrenByDay))]
    public async Task The_chart_cell_reads_reach_one_container_children_through_the_parent_index(string name)
    {
        var parents = await PageOfContainerIdsAsync();
        var bySeries = name == nameof(RollupSql.BucketChildrenByPropertyAndSeries);

        var plan = await ExplainAsRuntimeRoleAsync(
            bySeries ? RollupSql.BucketChildrenByPropertyAndSeries : RollupSql.BucketChildrenByDay,
            bySeries
                ?
                [
                    Uuid("tenant_id", M0SchemaSeed.Alpha.TenantId),
                    Uuid("workspace_id", M0SchemaSeed.Alpha.WorkspaceId),
                    Uuid("parent_id", parents[0]),
                    Text("group_key", "status"),
                    Text("split_key", "title"),
                    Text("measure_key", "estimate"),
                    Int("series_limit", 6),
                    Int("bucket_limit", 100),
                    Int("cell_limit", 10_000),
                ]
                :
                [
                    Uuid("tenant_id", M0SchemaSeed.Alpha.TenantId),
                    Uuid("workspace_id", M0SchemaSeed.Alpha.WorkspaceId),
                    Uuid("parent_id", parents[0]),
                    Text("group_key", "title"),
                    Text("split_key", "status"),
                    Text("measure_key", "estimate"),
                    Text("from_day", "2026-01-01"),
                    Text("to_day", "2026-12-31"),
                    Int("series_limit", 6),
                    Int("cell_limit", 10_000),
                ]);

        _output.WriteLine(
            "{0}, one container of ~{1} children out of {2} in the workspace, runtime role:",
            name,
            AlphaChildren / Containers,
            AlphaChildren);
        _output.WriteLine(plan);

        AssertReachedThroughParentIndex(plan);
    }

    [Theory]
    [InlineData(nameof(RollupSql.BucketChildrenByPropertyAndSeries), "category", "note", null, null)]
    [InlineData(nameof(RollupSql.BucketChildrenByDay), "date", "note", null, null)]
    [InlineData(nameof(RollupSql.BucketChildrenByDay), "date", "category", "2025-10-13", "2026-10-11")]
    public async Task The_chart_cell_reads_stay_on_the_parent_index_for_a_large_container(
        string name,
        string groupKey,
        string splitKey,
        string? from,
        string? to)
    {
        var bySeries = name == nameof(RollupSql.BucketChildrenByPropertyAndSeries);
        NpgsqlParameter[] common =
        [
            Uuid("tenant_id", M0SchemaSeed.Alpha.TenantId),
            Uuid("workspace_id", M0SchemaSeed.Alpha.WorkspaceId),
            Uuid("parent_id", BigContainer),
            Text("group_key", groupKey),
            Text("split_key", splitKey),
            Text("measure_key", "amount"),
            Int("series_limit", 6),
            Int("cell_limit", 10_000),
        ];

        var plan = await ExplainAsRuntimeRoleAsync(
            bySeries ? RollupSql.BucketChildrenByPropertyAndSeries : RollupSql.BucketChildrenByDay,
            bySeries
                ? [.. common, Int("bucket_limit", 100)]
                : [.. common, NullableText("from_day", from), NullableText("to_day", to)]);

        _output.WriteLine(
            "{0} by {1} split by {2}, window {3} to {4}, one container of {5} children, runtime role:",
            name,
            groupKey,
            splitKey,
            from ?? "open",
            to ?? "open",
            BigChildren);
        _output.WriteLine(plan);

        AssertReachedThroughParentIndex(plan);
        // A split with one distinct value per child must match the ranks in one pass rather
        // than comparing every child with every series. This is the production runtime plan.
        Assert.Contains("Hash Cond:", plan, StringComparison.Ordinal);
    }

    /// <summary>
    /// The container's children are reached through the parent index - as an index scan or a
    /// bitmap heap scan over it, whichever the planner picks for the size - and the item table is
    /// never scanned whole.
    /// </summary>
    private static void AssertReachedThroughParentIndex(string plan)
    {
        Assert.Contains("IX_item_tenant_id_parent_id", plan, StringComparison.Ordinal);
        Assert.DoesNotMatch(@"Seq Scan on item\s", plan);
        Assert.DoesNotContain("Parallel Seq Scan", plan, StringComparison.Ordinal);
        Assert.Contains("nix.tenant_id", plan, StringComparison.Ordinal);
    }

    private readonly record struct FoldRow(long Children, long Present, long Numbers);

    private async Task<List<FoldRow>> FoldAsRuntimeRoleAsync(Guid[] parents, string[] keys)
    {
        var rows = new List<FoldRow>();

        await AsRuntimeRoleAsync(async (connection, transaction) =>
        {
#pragma warning disable CA2100 // Justification: the text is a statement this codebase compiled; every value is bound.
            var command = new NpgsqlCommand(RollupSql.AggregateChildProperties, connection, transaction);
#pragma warning restore CA2100
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.Add(Uuid("tenant_id", M0SchemaSeed.Alpha.TenantId));
                command.Parameters.Add(Uuid("workspace_id", M0SchemaSeed.Alpha.WorkspaceId));
                command.Parameters.Add(UuidArray("parent_ids", parents));
                command.Parameters.Add(TextArray("keys", keys));
                command.Parameters.Add(UuidArray("closed_lock_ids", [ClosedLockStandIn]));

                var reader = await command.ExecuteReaderAsync(TestContext.Current.CancellationToken);
                await using (reader.ConfigureAwait(false))
                {
                    while (await reader.ReadAsync(TestContext.Current.CancellationToken))
                    {
                        rows.Add(new FoldRow(reader.GetInt64(2), reader.GetInt64(3), reader.GetInt64(4)));
                    }
                }
            }
        });

        return rows;
    }

    /// <summary>The containers one page would fold: fifty of the four hundred that exist.</summary>
    private async Task<Guid[]> PageOfContainerIdsAsync() =>
        [.. (await AllContainerIdsAsync()).Take(PageSize)];

    private async Task<Guid[]> AllContainerIdsAsync()
    {
        var ids = new List<Guid>(Containers);

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var command = new NpgsqlCommand(
                "SELECT id FROM item WHERE parent_id = @root ORDER BY seq",
                connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.Add(Uuid("root", AlphaRoot));

                var reader = await command.ExecuteReaderAsync(TestContext.Current.CancellationToken);
                await using (reader.ConfigureAwait(false))
                {
                    while (await reader.ReadAsync(TestContext.Current.CancellationToken))
                    {
                        ids.Add(reader.GetGuid(0));
                    }
                }
            }
        }

        return [.. ids];
    }

    /// <summary>
    /// EXPLAINs a statement as the runtime role, under the one setting the policy reads.
    /// </summary>
    private async Task<string> ExplainAsRuntimeRoleAsync(
        string sql,
        IReadOnlyList<NpgsqlParameter> parameters)
    {
        var plan = new StringBuilder();

        await AsRuntimeRoleAsync(async (connection, transaction) =>
        {
#pragma warning disable CA2100 // Justification: the text is a statement this codebase compiled; every value is bound.
            var command = new NpgsqlCommand("EXPLAIN (ANALYZE, BUFFERS) " + sql, connection, transaction);
#pragma warning restore CA2100
            await using (command.ConfigureAwait(false))
            {
                foreach (var parameter in parameters)
                {
                    command.Parameters.Add(parameter.Clone());
                }

                var reader = await command.ExecuteReaderAsync(TestContext.Current.CancellationToken);
                await using (reader.ConfigureAwait(false))
                {
                    while (await reader.ReadAsync(TestContext.Current.CancellationToken))
                    {
                        plan.AppendLine(reader.GetString(0));
                    }
                }
            }
        });

        return plan.ToString();
    }

    /// <summary>
    /// Runs work as <c>nix_app</c> in a transaction with <c>SET LOCAL nix.tenant_id</c>: the exact
    /// context the middleware establishes, and the only one under which a plan means anything.
    /// </summary>
    private async Task AsRuntimeRoleAsync(Func<NpgsqlConnection, NpgsqlTransaction, Task> work)
    {
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var transaction = await connection.BeginTransactionAsync(TestContext.Current.CancellationToken);
            await using (transaction.ConfigureAwait(false))
            {
                // set_config with is_local = true is the parameterisable spelling of SET LOCAL.
                var context = new NpgsqlCommand(
                    "SELECT set_config('nix.tenant_id', @tenant, true)",
                    connection,
                    transaction);
                await using (context.ConfigureAwait(false))
                {
                    context.Parameters.Add(new NpgsqlParameter("tenant", NpgsqlDbType.Text)
                    {
                        Value = M0SchemaSeed.Alpha.TenantId.ToString("D", CultureInfo.InvariantCulture),
                    });
                    await context.ExecuteNonQueryAsync(TestContext.Current.CancellationToken);
                }

                await work(connection, transaction).ConfigureAwait(false);
            }
        }
    }

    private static NpgsqlParameter Uuid(string name, Guid value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value };

    private static NpgsqlParameter UuidArray(string name, Guid[] values) =>
        new(name, NpgsqlDbType.Uuid | NpgsqlDbType.Array) { Value = values };

    private static NpgsqlParameter TextArray(string name, string[] values) =>
        new(name, NpgsqlDbType.Text | NpgsqlDbType.Array) { Value = values };

    private static NpgsqlParameter Text(string name, string value) =>
        new(name, NpgsqlDbType.Text) { Value = value };

    private static NpgsqlParameter NullableText(string name, string? value) =>
        new(name, NpgsqlDbType.Text) { Value = value is null ? DBNull.Value : value };

    private static NpgsqlParameter Int(string name, int value) =>
        new(name, NpgsqlDbType.Integer) { Value = value };

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
                (id, tenant_id, workspace_id, type, parent_id, seq, properties,
                 lifecycle_state, purge_after, created_by, last_modified_by, created_at,
                 last_modified_at)
            VALUES
                ({{RawSql.Literal(AlphaRoot)}}, {{alphaTenant}}, {{alphaWorkspace}}, 'note', NULL, 199999,
                 '{"title":"Rollup corpus root"}'::jsonb, 'active', NULL, {{alphaPrincipal}},
                 {{alphaPrincipal}}, now(), now());

            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties,
                 lifecycle_state, purge_after, created_by, last_modified_by, created_at, last_modified_at)
            SELECT gen_random_uuid(), {{alphaTenant}}, {{alphaWorkspace}}, 'note',
                   {{RawSql.Literal(AlphaRoot)}}, 200000 + n,
                   jsonb_build_object('title', 'Container ' || n),
                   'active', NULL, {{alphaPrincipal}}, {{alphaPrincipal}}, now(), now()
            FROM generate_series(1, {{Containers}}) AS n;

            -- Roughly one child in ninety-seven holds text where a number belongs, so the type
            -- guard is exercised by the corpus rather than only by the statement's own reading.
            -- Ninety-seven rather than fifty: the children are spread across the containers by
            -- `n % 50`, so a bad value every fiftieth row would land every one of them in the same
            -- container and leave the other forty-nine untested.
            -- Resolve the parents once. A join against reset-table statistics can make fixture
            -- construction scan the whole child series once per parent before ANALYZE runs.
            -- MATERIALIZED because a CTE referenced once is otherwise inlined, and the planner may
            -- then put the aggregate on the inner side of the join and recompute it per child.
            WITH container_ids AS MATERIALIZED (
                SELECT array_agg(id ORDER BY seq) AS ids
                FROM item
                WHERE tenant_id = {{alphaTenant}}
                  AND seq BETWEEN 200001 AND {{200000 + Containers}}
            )
            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties,
                 lifecycle_state, purge_after, created_by, last_modified_by, created_at, last_modified_at)
            SELECT gen_random_uuid(), {{alphaTenant}}, {{alphaWorkspace}}, 'note',
                   container.ids[1 + (n % {{Containers}})],
                   300000 + n,
                   jsonb_build_object('title', 'Task ' || n)
                   || CASE WHEN n % 97 = 0
                           THEN jsonb_build_object('estimate', 'soon')
                           ELSE jsonb_build_object('estimate', (n % 13)) END
                   || jsonb_build_object(
                          'completion', (n % 3 = 0),
                          -- Seven, not four: the children are spread across the containers by
                          -- `n % 400`, and four divides four hundred - so a four-value status
                          -- would give every child of a container the same one and leave the
                          -- bucketing measured against a single group. Seven is coprime with it.
                          'status', (ARRAY['Todo','Doing','Done','Blocked','Waiting','Parked','Dropped'])[1 + (n % 7)]),
                   'active', NULL, {{alphaPrincipal}}, {{alphaPrincipal}}, now(), now()
            FROM container_ids AS container
            CROSS JOIN generate_series(1, {{AlphaChildren}}) AS n;

            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties,
                 lifecycle_state, purge_after, created_by, last_modified_by, created_at,
                 last_modified_at)
            VALUES
                ({{RawSql.Literal(BetaContainer)}}, {{betaTenant}}, {{betaWorkspace}}, 'note', NULL, 399999,
                 '{"title":"Other tenant container"}'::jsonb, 'active', NULL, {{betaPrincipal}},
                 {{betaPrincipal}}, now(), now());

            -- Beta's rows hang off a container of their own, so a cross-tenant fold naming that
            -- container has something it could match if the scoping were wrong.
            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties,
                 lifecycle_state, purge_after, created_by, last_modified_by, created_at, last_modified_at)
            SELECT gen_random_uuid(), {{betaTenant}}, {{betaWorkspace}}, 'note',
                   {{RawSql.Literal(BetaContainer)}}, 400000 + n,
                   jsonb_build_object('title', 'Other tenant ' || n, 'estimate', (n % 7)),
                   'active', NULL, {{betaPrincipal}}, {{betaPrincipal}}, now(), now()
            FROM generate_series(1, {{BetaItems}}) AS n;

            -- The large container: a date on every child across five years, a category with six
            -- values, and a free-text note with a value per child - the high-cardinality split.
            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties,
                 lifecycle_state, purge_after, created_by, last_modified_by, created_at,
                 last_modified_at)
            VALUES
                ({{RawSql.Literal(BigRoot)}}, {{alphaTenant}}, {{alphaWorkspace}}, 'note', NULL, 299998,
                 '{"title":"Large corpus root"}'::jsonb, 'active', NULL, {{alphaPrincipal}},
                 {{alphaPrincipal}}, now(), now()),
                ({{RawSql.Literal(BigContainer)}}, {{alphaTenant}}, {{alphaWorkspace}}, 'note',
                 {{RawSql.Literal(BigRoot)}}, 299999, '{"title":"Large container"}'::jsonb, 'active', NULL,
                 {{alphaPrincipal}}, {{alphaPrincipal}}, now(), now());

            -- The new parent follows 125k rows. Refresh the cached foreign-key lookup plans
            -- before inserting its children: a plan chosen for the initially empty table can
            -- otherwise scan those rows for every child to find the parent near the end.
            ANALYZE item;

            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties,
                 lifecycle_state, purge_after, created_by, last_modified_by, created_at, last_modified_at)
            SELECT gen_random_uuid(), {{alphaTenant}}, {{alphaWorkspace}}, 'note',
                   {{RawSql.Literal(BigContainer)}}, 500000 + n,
                   jsonb_build_object(
                       'title', 'Entry ' || n,
                       'date', to_char(date '2021-10-01' + (n % 1826), 'YYYY-MM-DD'),
                       'category', (ARRAY['Food','Rent','Travel','Fun','Health','Other'])[1 + (n % 6)],
                       'note', 'free text ' || n,
                       'amount', (n % 50)),
                   'active', NULL, {{alphaPrincipal}}, {{alphaPrincipal}}, now(), now()
            FROM generate_series(1, {{BigChildren}}) AS n;

            -- Refresh the item statistics before closure foreign-key probes use the new corpus.
            -- Respawn leaves the previous fixture's planner statistics behind.
            ANALYZE item;

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT id, id, tenant_id, workspace_id, 0
            FROM item
            WHERE seq >= 199999;

            -- Beta's own closure, so its container is visible in its own tenant and the refusal
            -- above is the tenant boundary rather than a missing edge.
            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT child.id, {{RawSql.Literal(BetaContainer)}}, child.tenant_id, child.workspace_id, 1
            FROM item AS child
            WHERE child.tenant_id = {{betaTenant}}
              AND child.seq >= 400001;

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT id, {{RawSql.Literal(AlphaRoot)}}, tenant_id, workspace_id, 1
            FROM item
            WHERE tenant_id = {{alphaTenant}}
              AND seq BETWEEN 200001 AND {{200000 + Containers}};

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT child.id, child.parent_id, child.tenant_id, child.workspace_id, 1
            FROM item AS child
            WHERE child.tenant_id = {{alphaTenant}}
              AND child.seq >= 300001;

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT child.id, {{RawSql.Literal(AlphaRoot)}}, child.tenant_id, child.workspace_id, 2
            FROM item AS child
            WHERE child.tenant_id = {{alphaTenant}}
              AND child.seq BETWEEN 300001 AND 399999;

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT id, {{RawSql.Literal(BigRoot)}}, tenant_id, workspace_id, 1
            FROM item
            WHERE id = {{RawSql.Literal(BigContainer)}};

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT child.id, {{RawSql.Literal(BigRoot)}}, child.tenant_id, child.workspace_id, 2
            FROM item AS child
            WHERE child.tenant_id = {{alphaTenant}}
              AND child.seq >= 500001;

            ANALYZE item;
            ANALYZE item_closure;
            """;

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            // Respawn empties the tables with DELETE, so the previous class's corpus is still on
            // disk as dead rows, under that class's statistics. Start from a vacuumed table with
            // fresh statistics so the seed's plans do not depend on which class ran before it -
            // on CI the children insert ran past two minutes against a table left that way.
            // VACUUM cannot share the pipelined batch below, so each runs on its own.
            foreach (var table in (string[])["item", "item_closure"])
            {
                await RawSql.ExecuteAsync(connection, transaction: null, $"VACUUM (ANALYZE) {table}", commandTimeoutSeconds: 120);
            }

            // Bulk fixture setup can exceed the default 30 seconds on shared CI runners.
            // Keep the measured runtime queries on their normal timeout.
            await RawSql.ExecuteAsync(connection, transaction: null, sql, commandTimeoutSeconds: 600);
        }
    }
}
