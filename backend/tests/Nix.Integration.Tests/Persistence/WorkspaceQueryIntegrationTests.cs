using System.Collections.Immutable;
using System.Globalization;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Query;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using Nix.Features.Query;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The ad-hoc workspace query and its aggregate on real Postgres, through the dispatcher - so the
/// permission resolver, row-level security, the lifecycle and lock filters and the compiled
/// statement all take part, as they do for a request.
/// </summary>
/// <remarks>
/// <para>
/// Every operator, structural field, token and group is a claim about what Postgres does with the
/// emitted text: that an escaped <c>%</c> matches only itself, that a word in a number column is
/// skipped rather than thrown on, that absence lands in the empty bucket, that the closure answers
/// "inside". The corpus is small and every expectation is spelled out row by row.
/// </para>
/// <para>
/// The crown-jewel assertions are the permission ones: a deleted row, a row in a workspace the
/// caller cannot read and a row in another tenant all match the rules and never appear - not as
/// rows, not in a group's count, not in an aggregate's total - and a scope container the caller
/// cannot see answers exactly what reading that item would.
/// </para>
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class WorkspaceQueryIntegrationTests : IAsyncLifetime
{
    private const string TodayText = "2026-08-15";

    private static readonly Guid PrivateWorkspace = new("8c8c8000-1111-4111-8111-8c8c80000000");
    private static readonly Guid Member = new("8c8c8000-1111-4111-8111-8c8c80000001");

    private static readonly Guid Work = new("8c8c8000-1111-4111-8111-8c8c80000010");
    private static readonly Guid TaskA = new("8c8c8000-1111-4111-8111-8c8c80000011");
    private static readonly Guid TaskB = new("8c8c8000-1111-4111-8111-8c8c80000012");
    private static readonly Guid Sub = new("8c8c8000-1111-4111-8111-8c8c80000013");
    private static readonly Guid TaskC = new("8c8c8000-1111-4111-8111-8c8c80000014");
    private static readonly Guid Loose = new("8c8c8000-1111-4111-8111-8c8c80000015");

    /// <summary>
    /// The folder <see cref="M0SchemaSeed"/> puts at the open workspace's root: no properties at
    /// all, so it is the corpus's "absent everything" row. Its timestamps are pinned in the seed.
    /// </summary>
    private static readonly Guid Seed = M0SchemaSeed.Alpha.ItemId;

    /// <summary>Matches almost every rule below, and is deleted.</summary>
    private static readonly Guid Deleted = new("8c8c8000-1111-4111-8111-8c8c80000016");

    /// <summary>Matches almost every rule below, in a workspace the member cannot read.</summary>
    private static readonly Guid PrivateTask = new("8c8c8000-1111-4111-8111-8c8c80000017");
    private static readonly Guid PrivateFolder = new("8c8c8000-1111-4111-8111-8c8c80000018");

    /// <summary>Matches almost every rule below, in the other tenant.</summary>
    private static readonly Guid BetaTask = new("8c8c8000-2222-4222-8222-8c8c80000019");

    private readonly NixPostgresFixture _fixture;

    public WorkspaceQueryIntegrationTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static NixSessionContext MemberContext => TestTenants.ContextFor(
        M0SchemaSeed.Alpha.TenantId,
        M0SchemaSeed.Alpha.WorkspaceId,
        Member);

    private static WorkspaceId OpenWorkspace => WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedAsync();
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Contains_is_case_insensitive_and_its_wildcards_are_escaped()
    {
        Assert.Equal(Set(TaskA, TaskC), await Ids(Rule("title", "contains", "PLAN")));

        // Unescaped, '%' would match every title and '_' any one character.
        Assert.Equal(Set(TaskB), await Ids(Rule("title", "contains", "50%_off")));
        Assert.Equal(Set(TaskB), await Ids(Rule("title", "contains", "%")));
        Assert.Equal(Set(TaskB), await Ids(Rule("title", "contains", "_")));
    }

    [Fact]
    public async Task Contains_on_a_list_is_exact_option_membership()
    {
        Assert.Equal(Set(TaskA), await Ids(Rule("tags", "contains", "Urgent")));
        Assert.Empty(await Ids(Rule("tags", "contains", "Urg")));
    }

    [Fact]
    public async Task Not_contains_admits_an_absent_property()
    {
        Assert.Equal(Set(Seed, Work, TaskB, Sub, Loose), await Ids(Rule("title", "not-contains", "plan")));
        Assert.Equal(Set(Seed, Work, TaskB, Sub, TaskC, Loose), await Ids(Rule("tags", "not-contains", "Urgent")));
    }

    [Fact]
    public async Task Numeric_comparisons_read_json_numbers_only_and_skip_text_without_failing()
    {
        // TaskA stores 5, TaskB the text "7", TaskC the word "lots", Loose 2.5. Text is not a
        // number, however it looks - the rollups' rule.
        Assert.Equal(Set(TaskA), await Ids(Rule("points", "greater-than", "3")));
        Assert.Equal(Set(Loose), await Ids(Rule("points", "less-than", "3")));
        Assert.Empty(await Ids(Rule("points", "greater-than", "1e300")));
    }

    [Fact]
    public async Task Empty_is_absence_null_and_empty_text_in_one_bucket()
    {
        // Work and Sub have no status, Seed has no bag at all, Loose stores null; TaskC stores
        // notes as "".
        Assert.Equal(Set(Seed, Work, Sub, Loose), await Ids(Rule("status", "is-empty", string.Empty)));
        Assert.Equal(Set(TaskA, TaskB, TaskC), await Ids(Rule("status", "is-not-empty", string.Empty)));
        Assert.Equal(Set(Seed, Work, TaskA, TaskB, Sub, TaskC, Loose), await Ids(Rule("notes", "is-empty", string.Empty)));
    }

    [Fact]
    public async Task Type_inside_and_done_are_structural()
    {
        Assert.Equal(Set(TaskA, TaskB, TaskC), await Ids(Rule("$type", "equals", "task")));
        Assert.Equal(Set(Seed, Work, Sub, Loose), await Ids(Rule("$type", "not-equals", "task")));

        Assert.Equal(Set(TaskA, TaskB, Sub, TaskC), await Ids(Rule("$inside", "equals", Work.ToString())));
        Assert.Equal(Set(TaskC), await Ids(Rule("$inside", "equals", Sub.ToString())));
        Assert.Equal(Set(Seed, Work, Loose), await Ids(Rule("$inside", "not-equals", Work.ToString())));

        // Inside a container the caller cannot see is nothing, not an error that confirms it.
        Assert.Empty(await Ids(Rule("$inside", "equals", PrivateFolder.ToString())));

        Assert.Equal(Set(TaskB), await Ids(Rule("$done", "equals", "true")));
        Assert.Equal(Set(Seed, Work, TaskA, Sub, TaskC, Loose), await Ids(Rule("$done", "equals", "false")));
    }

    [Fact]
    public async Task Created_and_modified_compare_utc_days_with_tokens_and_windows()
    {
        Assert.Equal(Set(Seed, Work, TaskA, Sub), await Ids(Rule("$created", "before", "2026-08-12")));

        // 23:30 UTC on the 14th is the 14th.
        Assert.Equal(Set(TaskB), await Ids(Rule("$created", "on", "2026-08-14")));

        // Today is Saturday 2026-08-15; the week started Monday the 10th.
        Assert.Equal(Set(TaskB, TaskC, Loose), await Ids(Rule("$created", "on-or-after", "start-of-week")));
        Assert.Equal(Set(TaskB, TaskC, Loose), await Ids(Rule("$modified", "within-last", "1")));
    }

    [Fact]
    public async Task Day_tokens_and_within_last_read_stored_dates()
    {
        Assert.Equal(Set(TaskA, TaskB), await Ids(Rule("due_date", "on-or-after", "start-of-month")));
        Assert.Equal(Set(TaskA, TaskB), await Ids(Rule("due_date", "on-or-after", "start-of-week")));
        Assert.Empty(await Ids(Rule("due_date", "before", "same-day-last-week")));
        Assert.Equal(Set(TaskA), await Ids(Rule("due_date", "within-last", "7")));
    }

    [Fact]
    public async Task An_any_of_group_ors_inside_and_ands_with_its_neighbours()
    {
        var group = FilterRule.Group(
        [
            new FilterRule("status", "equals", "Doing"),
            new FilterRule("points", "greater-than", "6"),
        ]);

        Assert.Equal(Set(TaskA, TaskC), await Ids([group]));
        Assert.Equal(Set(TaskA, TaskC), await Ids([group, Rule("$done", "not-equals", "true")]));
        Assert.Equal(Set(TaskA, TaskB, TaskC), await Ids([FilterRule.Group([new FilterRule("status", "equals", "Doing"), new FilterRule("status", "equals", "Todo")])]));
    }

    [Fact]
    public async Task A_scope_reads_the_subtree_or_the_direct_children()
    {
        Assert.Equal(Set(TaskA, TaskB, Sub, TaskC), await Ids([], parent: ItemId.From(Work)));
        Assert.Equal(Set(TaskA, TaskB, Sub), await Ids([], parent: ItemId.From(Work), descendants: false));
    }

    [Fact]
    public async Task A_scope_container_the_caller_cannot_read_answers_the_item_reads_own_404()
    {
        foreach (var hidden in new[] { PrivateFolder, BetaTask, Guid.NewGuid() })
        {
            var result = await Run(Input([], parent: ItemId.From(hidden)));

            Assert.True(result.IsFailure);
            Assert.Equal("items.not_found", result.Error.Code);
            Assert.Equal($"No item {hidden} is visible.", result.Error.Message);
        }
    }

    [Fact]
    public async Task A_workspace_the_caller_cannot_read_is_not_found_for_rows_and_aggregates()
    {
        var rows = await Run(Input([], workspace: WorkspaceId.From(PrivateWorkspace)));
        var folded = await Aggregate(Input([], workspace: WorkspaceId.From(PrivateWorkspace)), "count", null);

        Assert.Equal("workspaces.not_found", rows.Error.Code);
        Assert.Equal("workspaces.not_found", folded.Error.Code);
    }

    [Fact]
    public async Task Hidden_rows_never_appear_and_never_spend_the_limit()
    {
        // Deleted, PrivateTask and BetaTask all match (Seed has no title). Six readable rows match; a limit of six
        // returns all six, untruncated - a limit spent on hidden rows would come back short.
        var result = await Run(Input([Rule("title", "is-not-empty", string.Empty)]), limit: 6);

        Assert.True(result.IsSuccess);
        Assert.Equal(Set(Work, TaskA, TaskB, Sub, TaskC, Loose), result.Value.Results.Items.Select(item => item.Id.Value).ToHashSet());
        Assert.False(result.Value.Results.Truncated);

        var cut = await Run(Input([Rule("title", "is-not-empty", string.Empty)]), limit: 5);
        Assert.True(cut.Value.Results.Truncated);
    }

    [Fact]
    public async Task Grouped_rows_arrive_group_by_group_in_the_asked_order_before_the_limit()
    {
        var input = Input([Rule("$type", "equals", "task")]) with
        {
            GroupBy = "status",
            GroupOrder = ["Todo", "Doing"],
        };

        var all = await Run(input);
        Assert.Equal([TaskB, TaskC, TaskA], all.Value.Results.Items.Select(item => item.Id.Value));
        Assert.Equal(["Todo", "Doing", "Doing"], all.Value.Results.Items.Select(item => item.Group));
        Assert.Equal([new QueryGroup("Todo", 1), new QueryGroup("Doing", 2)], all.Value.Results.Groups);

        // Cut mid-group, the last group still says how big it is.
        var cut = await Run(input, limit: 2);
        Assert.True(cut.Value.Results.Truncated);
        Assert.Equal([new QueryGroup("Todo", 1), new QueryGroup("Doing", 2)], cut.Value.Results.Groups);
    }

    [Fact]
    public async Task Rows_with_no_value_group_last()
    {
        var result = await Run(Input([]) with { GroupBy = "status" });

        Assert.Equal(
            [new QueryGroup("Doing", 2), new QueryGroup("Todo", 1), new QueryGroup(null, 4)],
            result.Value.Results.Groups);
    }

    [Fact]
    public async Task A_grouped_sum_folds_only_readable_numbers_and_reports_what_it_skipped()
    {
        // Deleted (100), PrivateTask (1000) and BetaTask (1000) all have points and a status;
        // none may reach a group or the total.
        var result = await Aggregate(Input([]) with { GroupBy = "status", GroupOrder = ["Todo", "Doing"] }, "sum", "points");

        Assert.True(result.IsSuccess);
        var folded = result.Value.Results;
        Assert.Equal(
            [
                new QueryAggregateGroup("Todo", null, 1, 1),
                new QueryAggregateGroup("Doing", 5m, 2, 1),
                new QueryAggregateGroup(null, 2.5m, 4, 0),
            ],
            folded.Groups);
        Assert.Equal(7.5m, folded.Total);
        Assert.Equal(7, folded.Count);
        Assert.Equal(2, folded.Skipped);
        Assert.Equal(3, folded.GroupCount);
        Assert.False(folded.Truncated);
    }

    [Theory]
    [InlineData("avg", "3.75")]
    [InlineData("min", "2.5")]
    [InlineData("max", "5")]
    public async Task Ungrouped_folds_cover_every_readable_number(string function, string expected)
    {
        var result = await Aggregate(Input([]), function, "points");

        Assert.Equal(decimal.Parse(expected, CultureInfo.InvariantCulture), result.Value.Results.Total);
        Assert.Empty(result.Value.Results.Groups);
        Assert.Equal(2, result.Value.Results.Skipped);
    }

    [Fact]
    public async Task Strings_that_postgres_would_refuse_to_cast_are_skipped_and_never_fail_the_statement()
    {
        // Data review B1: "5" with an ideographic space, and "1e5 ", once passed a text pattern
        // that the numeric cast then refused with 22P02, failing every query over the key.
        await ExecuteAsMigratorAsync(
            $$"""
             UPDATE item SET properties = properties || '{"points": "5\u3000"}'::jsonb WHERE id = {{Literal(Work)}};
             UPDATE item SET properties = properties || '{"points": "1e5 "}'::jsonb WHERE id = {{Literal(Sub)}};
             """);

        Assert.Equal(Set(TaskA), await Ids(Rule("points", "greater-than", "3")));

        var folded = await Aggregate(Input([]), "sum", "points");
        Assert.True(folded.IsSuccess, folded.IsFailure ? folded.Error.Message : null);
        Assert.Equal(7.5m, folded.Value.Results.Total);
        Assert.Equal(4, folded.Value.Results.Skipped);
    }

    [Fact]
    public async Task A_value_past_the_per_value_bound_is_skipped_and_the_total_stays_readable()
    {
        // The total's own 1e28 cap needs more rows than a test corpus holds; the shape test pins
        // that it is in the statement. Here: two values at the per-value cap still total exactly,
        // and one past it is left out and counted rather than overflowing the reader.
        await ExecuteAsMigratorAsync(
            $$"""
             UPDATE item SET properties = properties || '{"points": 999999999999999}'::jsonb WHERE id IN ({{Literal(Work)}}, {{Literal(Sub)}});
             UPDATE item SET properties = properties || '{"points": 1e16}'::jsonb WHERE id = {{Literal(TaskB)}};
             """);

        var folded = await Aggregate(Input([]), "sum", "points");

        Assert.True(folded.IsSuccess, folded.IsFailure ? folded.Error.Message : null);
        Assert.Equal(1999999999999998m + 7.5m, folded.Value.Results.Total);

        // 1e16 is past the per-value bound: left out, and counted.
        Assert.Equal(2, folded.Value.Results.Skipped);
    }

    [Fact]
    public async Task A_count_by_type_counts_rows_and_skips_nothing()
    {
        var result = await Aggregate(Input([]) with { GroupBy = "$type" }, "count", null);

        Assert.Equal(
            [
                new QueryAggregateGroup("folder", 1m, 1, 0),
                new QueryAggregateGroup("note", 3m, 3, 0),
                new QueryAggregateGroup("task", 3m, 3, 0),
            ],
            result.Value.Results.Groups);
        Assert.Equal(7m, result.Value.Results.Total);
    }

    [Fact]
    public async Task An_aggregate_over_a_hidden_scope_answers_the_same_404()
    {
        var result = await Aggregate(Input([], parent: ItemId.From(PrivateFolder)), "count", null);

        Assert.Equal("items.not_found", result.Error.Code);
    }

    [Fact]
    public async Task A_structural_sort_orders_by_the_column()
    {
        var result = await Run(Input([]) with { SortProperty = "$created", SortDescending = true });

        Assert.Equal([Loose, TaskB, TaskC, TaskA, Sub, Work, Seed], result.Value.Results.Items.Select(item => item.Id.Value));
    }

    [Fact]
    public async Task A_stored_view_with_a_group_and_a_structural_rule_runs_through_the_same_statement()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<RunItemQuery, Result<ItemQueryResults>>(
                    new RunItemQuery(ItemId.From(Loose), "open-tasks", TodayText),
                    Cancellation);

            Assert.True(result.IsSuccess);
            Assert.Equal(Set(TaskA, TaskC), result.Value.Results.Items.Select(item => item.Id.Value).ToHashSet());
        }
    }

    private static FilterRule Rule(string property, string @operator, string value) => new(property, @operator, value);

    private static HashSet<Guid> Set(params Guid[] ids) => [.. ids];

    private static WorkspaceQueryInput Input(
        ImmutableArray<FilterRule> filters,
        WorkspaceId? workspace = null,
        ItemId? parent = null,
        bool descendants = true) =>
        new(workspace ?? OpenWorkspace, parent, descendants, null, filters, null, false, null, [], TodayText);

    private Task<HashSet<Guid>> Ids(FilterRule rule) => Ids([rule]);

    private async Task<HashSet<Guid>> Ids(ImmutableArray<FilterRule> rules, ItemId? parent = null, bool descendants = true)
    {
        var result = await Run(Input(rules, parent: parent, descendants: descendants));
        Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : null);
        return result.Value.Results.Items.Select(item => item.Id.Value).ToHashSet();
    }

    private async Task<Result<WorkspaceQueryResults>> Run(WorkspaceQueryInput input, int? limit = null)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            return await work.Resolve<NixDispatcher>()
                .QueryAsync<RunWorkspaceQuery, Result<WorkspaceQueryResults>>(new RunWorkspaceQuery(input, limit), Cancellation);
        }
    }

    private async Task<Result<WorkspaceAggregateResults>> Aggregate(WorkspaceQueryInput input, string function, string? property)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            return await work.Resolve<NixDispatcher>()
                .QueryAsync<AggregateWorkspaceQuery, Result<WorkspaceAggregateResults>>(
                    new AggregateWorkspaceQuery(input, function, property),
                    Cancellation);
        }
    }

    private async Task SeedAsync()
    {
        var tenant = Literal(M0SchemaSeed.Alpha.TenantId);
        var beta = Literal(M0SchemaSeed.Beta.TenantId);
        var open = Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var betaWorkspace = Literal(M0SchemaSeed.Beta.WorkspaceId);
        var closed = Literal(PrivateWorkspace);
        var principal = Literal(M0SchemaSeed.Alpha.PrincipalId);
        var betaPrincipal = Literal(M0SchemaSeed.Beta.PrincipalId);

        string Row(Guid id, string tenantId, string workspace, string type, Guid? parent, int seq, string properties, string created, string modified, string lifecycle = "active", string? views = null, string? actor = null) =>
            $"({Literal(id)}, {tenantId}, {workspace}, '{type}', {(parent is { } p ? Literal(p) : "NULL")}, {seq}, "
            + $"'{properties}'::jsonb, {(views is null ? "NULL" : $"'{views}'::jsonb")}, '{lifecycle}', NULL, "
            + $"{actor ?? principal}, {actor ?? principal}, '{created}'::timestamptz, '{modified}'::timestamptz)";

        // A stored query view on Loose: open tasks, as a group and a structural rule.
        const string openTasksView =
            """{"views":[{"id":"open-tasks","name":"Open tasks","kind":"query","filters":[{"property":"$type","operator":"equals","value":"task"},{"property":"$done","operator":"not-equals","value":"true"},{"any":[{"property":"status","operator":"equals","value":"Doing"},{"property":"status","operator":"equals","value":"Blocked"}]}]}],"default":"open-tasks"}""";

        var rows = string.Join(
            ",\n",
            Row(Work, tenant, open, "note", null, 1000, """{"title": "Work"}""", "2026-07-01T00:00:00Z", "2026-07-01T00:00:00Z"),
            Row(TaskA, tenant, open, "task", Work, 2000, """{"title": "Plan launch", "status": "Doing", "points": 5, "tags": ["Urgent", "Home"], "due_date": "2026-08-10", "completion": false}""", "2026-08-01T10:00:00Z", "2026-08-01T10:00:00Z"),
            Row(TaskB, tenant, open, "task", Work, 3000, """{"title": "Write 50%_off copy", "status": "Todo", "points": "7", "due_date": "2026-08-20", "completion": true}""", "2026-08-14T23:30:00Z", "2026-08-14T23:30:00Z"),
            Row(Sub, tenant, open, "note", Work, 4000, """{"title": "Sub"}""", "2026-07-02T00:00:00Z", "2026-07-02T00:00:00Z"),
            Row(TaskC, tenant, open, "task", Sub, 5000, """{"title": "Review plan", "status": "Doing", "points": "lots", "notes": ""}""", "2026-08-12T12:00:00Z", "2026-08-15T09:00:00Z"),
            Row(Loose, tenant, open, "note", null, 6000, """{"title": "Loose ends", "status": null, "points": 2.5}""", "2026-08-15T01:00:00Z", "2026-08-15T01:00:00Z", views: openTasksView),
            Row(Deleted, tenant, open, "task", Work, 7000, """{"title": "Gone plan 50%_off", "status": "Doing", "points": 100, "tags": ["Urgent"], "due_date": "2026-08-12"}""", "2026-08-13T00:00:00Z", "2026-08-15T00:00:00Z", lifecycle: "deleted"),
            Row(PrivateFolder, tenant, closed, "note", null, 8000, """{"title": "Private"}""", "2026-08-13T00:00:00Z", "2026-08-13T00:00:00Z"),
            Row(PrivateTask, tenant, closed, "task", PrivateFolder, 9000, """{"title": "Secret plan 50%_off", "status": "Doing", "points": 1000, "tags": ["Urgent"], "due_date": "2026-08-12"}""", "2026-08-13T00:00:00Z", "2026-08-15T00:00:00Z"),
            Row(BetaTask, beta, betaWorkspace, "task", null, 10000, """{"title": "Beta plan 50%_off", "status": "Doing", "points": 1000, "tags": ["Urgent"], "due_date": "2026-08-12"}""", "2026-08-13T00:00:00Z", "2026-08-15T00:00:00Z", actor: betaPrincipal));

        var all = string.Join(", ", new[] { Work, TaskA, TaskB, Sub, TaskC, Loose, Deleted, PrivateFolder, PrivateTask, BetaTask }.Select(Literal));

        var sql = $$"""
            INSERT INTO principal
                (principal_id, tenant_id, external_subject, kind, display_name, email, status,
                 deprovisioned_at)
            VALUES ({{Literal(Member)}}, {{tenant}}, 'alpha-workspace-query-member', 'user', 'Member',
                    'workspace-query-member@example.test', 'active', NULL);

            INSERT INTO workspace_member
                (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES ({{open}}, 'principal', {{Literal(Member)}}, {{tenant}}, 'viewer',
                    {{principal}}, now());

            INSERT INTO workspace
                (workspace_id, tenant_id, name, version_retention_days, coalesce_window_min,
                 storage_quota_bytes, created_at)
            VALUES ({{closed}}, {{tenant}}, 'Alpha private', 30, 10, 1073741824, now());

            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, views,
                 lifecycle_state, purge_after, created_by, last_modified_by, created_at,
                 last_modified_at)
            VALUES
            {{rows}};

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT id, id, tenant_id, workspace_id, 0 FROM item WHERE id IN ({{all}});

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT id, parent_id, tenant_id, workspace_id, 1 FROM item
             WHERE id IN ({{all}}) AND parent_id IS NOT NULL;

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            VALUES ({{Literal(TaskC)}}, {{Literal(Work)}}, {{tenant}}, {{open}}, 2);

            UPDATE item
               SET created_at = '2026-06-01T00:00:00Z', last_modified_at = '2026-06-01T00:00:00Z'
             WHERE id = {{Literal(Seed)}};
            """;

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    private async Task ExecuteAsMigratorAsync(string sql)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    private static string Literal(Guid value) =>
        $"'{value.ToString("D", CultureInfo.InvariantCulture)}'::uuid";
}
