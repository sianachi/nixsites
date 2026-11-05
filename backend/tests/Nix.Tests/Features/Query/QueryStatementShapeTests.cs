using System.Collections.Immutable;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Query;
using Nix.Domain.Views;
using Nix.Persistence.Sql.Statements;

namespace Nix.Tests.Features.Query;

/// <summary>
/// The shape of what the queries plan (1.2 to 1.7) added to the statement: the six newly compiled
/// operators, the structural fields, one level of OR, the scope, grouping and the aggregate. What
/// each one matches on real Postgres is <c>WorkspaceQueryIntegrationTests</c>'s business; this
/// pins the text the meaning depends on - escaping, guards, parenthesisation - without Docker.
/// </summary>
public sealed class QueryStatementShapeTests
{
    private static readonly DateOnly Today = new(2026, 8, 13);

    private static readonly string[] GroupOrder = ["Todo", "Doing"];

    private static CompiledQuery Compile(params FilterRule[] rules) =>
        QuerySql.Compile(new QuerySpec([.. rules], QueryOrder.Recency, Today));

    private static object? Parameter(CompiledQuery compiled, string name) =>
        Assert.Single(compiled.Parameters, parameter => parameter.ParameterName == name).Value;

    [Fact]
    public void Contains_is_an_escaped_case_insensitive_match_on_text_and_exact_membership_on_a_list()
    {
        var compiled = Compile(new FilterRule("title", "contains", "50%_off\\"));

        Assert.Contains("ILIKE @p0_pattern ESCAPE '\\'", compiled.Sql, StringComparison.Ordinal);
        Assert.Contains("@> jsonb_build_array(@p0_option::text)", compiled.Sql, StringComparison.Ordinal);
        Assert.Equal("%50\\%\\_off\\\\%", Parameter(compiled, "p0_pattern"));
        Assert.Equal("50%_off\\", Parameter(compiled, "p0_option"));
    }

    [Theory]
    [InlineData("plain", "plain")]
    [InlineData("100%", "100\\%")]
    [InlineData("a_b", "a\\_b")]
    [InlineData("c:\\temp", "c:\\\\temp")]
    [InlineData("\\%", "\\\\\\%")]
    public void Like_escaping_makes_every_wildcard_mean_itself(string typed, string escaped) =>
        Assert.Equal(escaped, QuerySql.EscapeLike(typed));

    [Fact]
    public void Not_contains_negates_an_expression_that_is_never_null()
    {
        // The contains expression ends in ELSE FALSE, so NOT of it is TRUE for an absent property:
        // an item without a title does not contain "plan".
        var compiled = Compile(new FilterRule("title", "not-contains", "plan"));

        Assert.Contains("AND NOT (CASE jsonb_typeof(item.properties -> @p0_key)", compiled.Sql, StringComparison.Ordinal);
        Assert.Contains("ELSE FALSE", compiled.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void Numeric_comparisons_read_json_numbers_only()
    {
        var compiled = Compile(new FilterRule("points", "greater-than", " 2.5 "));

        Assert.Contains(NumberSql.Number("item.properties", "@p0_key"), compiled.Sql, StringComparison.Ordinal);
        Assert.Contains("> CAST(@p0_number AS numeric), FALSE)", compiled.Sql, StringComparison.Ordinal);
        Assert.Equal("2.5", Parameter(compiled, "p0_number"));

        // No pattern over text: a string never reaches the cast.
        Assert.DoesNotContain(" ~ '", compiled.Sql, StringComparison.Ordinal);
        Assert.DoesNotContain("WHEN 'string'", compiled.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void The_guard_nests_the_cast_inside_the_type_test()
    {
        // CASE fixes the evaluation order; AND would not.
        Assert.Equal(
            "(CASE WHEN jsonb_typeof(b -> k) = 'number' THEN (b ->> k)::numeric END)",
            NumberSql.Number("b", "k"));
        Assert.StartsWith(
            "(CASE WHEN jsonb_typeof(b -> k) = 'number' THEN CASE WHEN abs((b ->> k)::numeric) <= 1e15",
            NumberSql.Bounded("b", "k"),
            StringComparison.Ordinal);
    }

    [Fact]
    public void Emptiness_is_absence_null_empty_text_or_an_empty_list()
    {
        var empty = Compile(new FilterRule("owner", "is-empty", string.Empty));
        var full = Compile(new FilterRule("owner", "is-not-empty", string.Empty));

        const string bucket = "COALESCE((item.properties -> @p0_key) IN ('null'::jsonb, '\"\"'::jsonb, '[]'::jsonb), TRUE)";
        Assert.Contains("AND " + bucket, empty.Sql, StringComparison.Ordinal);
        Assert.Contains("AND NOT " + bucket, full.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void Within_last_is_the_window_back_from_today_inclusive()
    {
        var compiled = Compile(new FilterRule("due", "within-last", "7"));

        Assert.Contains("BETWEEN @p0_from AND @p0_to", compiled.Sql, StringComparison.Ordinal);
        Assert.Equal("2026-08-06", Parameter(compiled, "p0_from"));
        Assert.Equal("2026-08-13", Parameter(compiled, "p0_to"));
    }

    [Theory]
    [InlineData("start-of-week", "2026-08-10")]
    [InlineData("start-of-month", "2026-08-01")]
    [InlineData("same-day-last-week", "2026-08-06")]
    [InlineData("same-day-last-month", "2026-07-13")]
    public void Day_tokens_bind_the_resolved_day(string token, string day) =>
        Assert.Equal(day, Parameter(Compile(new FilterRule("due", "on-or-after", token)), "p0_day"));

    [Fact]
    public void Type_compares_the_column_and_never_the_bag()
    {
        var compiled = Compile(new FilterRule("$type", "not-equals", "task"));

        Assert.Contains("item.type <> @p0_value", compiled.Sql, StringComparison.Ordinal);
        Assert.DoesNotContain("$type", compiled.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void Inside_reads_the_closure_strictly_beneath_with_a_typed_ancestor_id()
    {
        var ancestor = new Guid("7b7b7000-1111-4111-8111-7b7b70000001");
        var compiled = Compile(new FilterRule("$inside", "equals", ancestor.ToString()));

        Assert.Contains("FROM item_closure AS p0_inside", compiled.Sql, StringComparison.Ordinal);
        Assert.Contains("p0_inside.tenant_id = @tenant_id", compiled.Sql, StringComparison.Ordinal);
        Assert.Contains("p0_inside.depth > 0", compiled.Sql, StringComparison.Ordinal);
        Assert.Equal(ancestor, Parameter(compiled, "p0_ancestor"));

        Assert.Contains("NOT EXISTS (\n      SELECT 1\n      FROM item_closure AS p0_inside", Compile(new FilterRule("$inside", "not-equals", ancestor.ToString())).Sql, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("equals", "true", "= 'true'")]
    [InlineData("not-equals", "false", "= 'true'")]
    [InlineData("equals", "false", "IS DISTINCT FROM 'true'")]
    [InlineData("not-equals", "true", "IS DISTINCT FROM 'true'")]
    public void Done_is_the_completion_key_being_true_and_absence_is_not_done(string @operator, string value, string predicate)
    {
        var compiled = Compile(new FilterRule("$done", @operator, value));

        Assert.Contains("item.properties ->> 'completion' " + predicate, compiled.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void Created_and_modified_compare_instants_from_the_callers_zone_as_half_open_ranges()
    {
        var zone = NodaTime.DateTimeZoneProviders.Tzdb["America/New_York"];
        CompiledQuery Zoned(params FilterRule[] rules) =>
            QuerySql.Compile(new QuerySpec([.. rules], QueryOrder.Recency, Today) { Zone = zone });

        var on = Zoned(new FilterRule("$created", "on", "2026-08-13"));
        Assert.Contains("(item.created_at >= @p0_from AND item.created_at < @p0_to)", on.Sql, StringComparison.Ordinal);
        Assert.Equal(new DateTimeOffset(2026, 8, 13, 4, 0, 0, TimeSpan.Zero), Parameter(on, "p0_from"));
        Assert.Equal(new DateTimeOffset(2026, 8, 14, 4, 0, 0, TimeSpan.Zero), Parameter(on, "p0_to"));

        var before = Zoned(new FilterRule("$modified", "before", "today"));
        Assert.Contains("(item.last_modified_at < @p0_to)", before.Sql, StringComparison.Ordinal);
        Assert.Equal(new DateTimeOffset(2026, 8, 13, 4, 0, 0, TimeSpan.Zero), Parameter(before, "p0_to"));

        var last = Zoned(new FilterRule("$modified", "within-last", "3"));
        Assert.Equal(new DateTimeOffset(2026, 8, 10, 4, 0, 0, TimeSpan.Zero), Parameter(last, "p0_from"));
        Assert.Equal(new DateTimeOffset(2026, 8, 14, 4, 0, 0, TimeSpan.Zero), Parameter(last, "p0_to"));

        Assert.DoesNotContain("to_char", last.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void An_any_of_group_is_one_parenthesised_or_beside_the_anded_rules()
    {
        var compiled = Compile(
            new FilterRule("due_date", "before", "today"),
            FilterRule.Group(
            [
                new FilterRule("status", "equals", "Doing"),
                new FilterRule("status", "equals", "Blocked"),
            ]));

        Assert.Contains(
            "\n  AND (("
            + "item.properties ->> @p1_0_key = @p1_0_value)\n       OR ("
            + "item.properties ->> @p1_1_key = @p1_1_value))",
            compiled.Sql,
            StringComparison.Ordinal);
        Assert.Contains("\n  AND item.due_day < @p0_day", compiled.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void The_smart_list_exclusion_appears_only_when_a_smart_list_is_running()
    {
        Assert.DoesNotContain("@query_item_id", Compile().Sql, StringComparison.Ordinal);

        var saved = QuerySql.Compile(new QuerySpec([], QueryOrder.Recency, Today)
        {
            ExcludedItemId = ItemId.From(Guid.NewGuid()),
        });
        Assert.Contains("item.id <> @query_item_id", saved.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void A_subtree_scope_reads_the_closure_and_a_children_scope_reads_the_parent_column()
    {
        var parent = ItemId.From(Guid.NewGuid());
        var subtree = QuerySql.Compile(new QuerySpec([], QueryOrder.Recency, Today) { Scope = new QueryScope(parent, true) });
        var children = QuerySql.Compile(new QuerySpec([], QueryOrder.Recency, Today) { Scope = new QueryScope(parent, false) });

        Assert.Contains("scope_edge.ancestor_id = @scope_parent_id", subtree.Sql, StringComparison.Ordinal);
        Assert.Contains("scope_edge.tenant_id = @tenant_id", subtree.Sql, StringComparison.Ordinal);
        Assert.Contains("scope_edge.depth > 0", subtree.Sql, StringComparison.Ordinal);
        Assert.Contains("AND item.parent_id = @scope_parent_id", children.Sql, StringComparison.Ordinal);
        Assert.DoesNotContain("scope_edge", children.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void Grouped_rows_order_by_group_before_the_sort_and_before_the_limit()
    {
        var compiled = QuerySql.Compile(new QuerySpec([], new QueryOrder("title", false, false), Today)
        {
            Grouping = new QueryGrouping("status", ["Todo", "Doing"]),
        });

        Assert.Contains(
            "ORDER BY array_position(@group_order, grouping.group_key) ASC NULLS LAST, grouping.group_key ASC NULLS LAST, item.properties ->> @order_key ASC NULLS LAST, item.id\nLIMIT @limit",
            compiled.Sql,
            StringComparison.Ordinal);
        Assert.Contains("count(*) OVER (PARTITION BY grouping.group_key)", compiled.Sql, StringComparison.Ordinal);
        Assert.Equal(GroupOrder, Parameter(compiled, "group_order"));
    }

    [Fact]
    public void Grouping_by_type_reads_the_column()
    {
        var compiled = QuerySql.Compile(new QuerySpec([], QueryOrder.Recency, Today)
        {
            Grouping = new QueryGrouping("$type", []),
        });

        Assert.Contains("CROSS JOIN LATERAL (SELECT item.type AS group_key) AS grouping", compiled.Sql, StringComparison.Ordinal);
        Assert.DoesNotContain("@group_order", compiled.Sql, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("$created", "item.created_at DESC, item.id")]
    [InlineData("$modified", "item.last_modified_at DESC, item.id")]
    [InlineData("$type", "item.type DESC, item.id")]
    [InlineData("due_date", "item.due_day DESC NULLS LAST, item.id")]
    public void Structural_and_due_date_sorts_read_columns_in_either_direction(string key, string order)
    {
        var compiled = QuerySql.Compile(new QuerySpec([], new QueryOrder(key, key == "due_date", true), Today));

        Assert.Contains("ORDER BY " + order, compiled.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void The_aggregate_folds_the_same_match_the_rows_read()
    {
        var spec = new QuerySpec([new FilterRule("status", "equals", "Done")], QueryOrder.Recency, Today)
        {
            Grouping = new QueryGrouping("status", []),
        };

        var rows = QuerySql.Compile(spec).Sql;
        var aggregate = QuerySql.CompileAggregate(spec, new QueryAggregate("sum", "points")).Sql;

        // The permission, lifecycle, lock and rule text is one builder's output in both.
        var match = rows[rows.IndexOf("WHERE item.tenant_id = @tenant_id", StringComparison.Ordinal)..rows.IndexOf("ORDER BY", StringComparison.Ordinal)];
        Assert.Contains(match.TrimEnd(), aggregate, StringComparison.Ordinal);
        Assert.Contains($"round({NumberSql.CappedSum("measure")}, 6)", aggregate, StringComparison.Ordinal);
        Assert.Contains("<= 1e28", aggregate, StringComparison.Ordinal);
        Assert.Contains("LIMIT @group_limit", aggregate, StringComparison.Ordinal);
        Assert.Contains("count(*) FILTER (WHERE present AND measure IS NULL) AS skipped", aggregate, StringComparison.Ordinal);
        Assert.Contains("<= 1e15", aggregate, StringComparison.Ordinal);
    }

    [Fact]
    public void A_count_reads_no_property_and_an_ungrouped_aggregate_returns_only_totals()
    {
        var aggregate = QuerySql.CompileAggregate(
            new QuerySpec([], QueryOrder.Recency, Today),
            new QueryAggregate("count", null));

        Assert.Contains("count(*)::numeric AS value", aggregate.Sql, StringComparison.Ordinal);
        Assert.DoesNotContain("measure_key", aggregate.Sql, StringComparison.Ordinal);
        Assert.DoesNotContain("group_limit", aggregate.Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void A_numeric_fold_without_a_property_or_an_unknown_fold_is_a_bug_not_an_input()
    {
        var spec = new QuerySpec([], QueryOrder.Recency, Today);

        Assert.Throws<InvalidOperationException>(() => QuerySql.CompileAggregate(spec, new QueryAggregate("sum", null)));
        Assert.Throws<InvalidOperationException>(() => QuerySql.CompileAggregate(spec, new QueryAggregate("median", "points")));
    }

    [Fact]
    public void A_reserved_field_without_an_arm_is_a_bug_not_an_input()
    {
        Assert.Throws<InvalidOperationException>(() => Compile(new FilterRule("$tag", "equals", "x")));
    }

    [Fact]
    public void Hostile_values_in_groups_and_aggregates_never_enter_the_statement_text()
    {
        const string hostile = "'; DROP TABLE item; --";
        var spec = new QuerySpec(
            [FilterRule.Group([new FilterRule(hostile, "contains", hostile), new FilterRule("k", "greater-than", "1e3")])],
            new QueryOrder(hostile, false, false),
            Today)
        {
            Grouping = new QueryGrouping(hostile, [hostile]),
        };

        Assert.DoesNotContain("DROP TABLE", QuerySql.Compile(spec).Sql, StringComparison.Ordinal);
        Assert.DoesNotContain("DROP TABLE", QuerySql.CompileAggregate(spec, new QueryAggregate("max", hostile)).Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void The_rule_ceiling_counts_rules_inside_groups()
    {
        var group = FilterRule.Group([.. Enumerable.Range(0, 5).Select(index => new FilterRule($"k{index}", "is-empty", string.Empty))]);
        ImmutableArray<FilterRule> rules = [group, new("a", "is-empty", ""), new("b", "is-empty", ""), new("c", "is-empty", "")];

        Assert.Equal(8, QueryRules.Count(rules));
        Assert.Null(QueryRules.Refuse(rules, query: true));
        Assert.NotNull(QueryRules.Refuse(rules.Add(new FilterRule("d", "is-empty", "")), query: true));
    }
}
