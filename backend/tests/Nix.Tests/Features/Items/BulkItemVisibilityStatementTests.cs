using Nix.Abstractions;
using Nix.Domain.Views;
using Nix.Persistence.Sql.Statements;

namespace Nix.Tests.Features.Items;

/// <summary>The copied bulk-read predicates retain the same fail-closed visibility contract.</summary>
/// <remarks>
/// <b>The depth bound is per statement, because the anchor is.</b> Every read here checks that the
/// rows it returns have no non-active proper ancestor; where the statement is anchored on the row
/// itself that is <c>depth &gt; 0</c>, and where it is anchored on the row's <em>parent</em> - the
/// two folds, which aggregate a parent's children - it is <c>depth &gt;= 0</c>, because the
/// parent's own lifecycle is one of the facts its children's visibility depends on. The two spell
/// the same rule at the place each statement can ask it cheaply; a fold anchored on the parent
/// asks fifty times where one anchored on the child would ask fifteen thousand.
/// </remarks>
public sealed class BulkItemVisibilityStatementTests
{
    public static TheoryData<string, string, int, string> Statements => new()
    {
        { nameof(GraphSql.WorkspaceGraph), GraphSql.WorkspaceGraph, 1, OwnAncestors },
        { nameof(SearchSql.MatchingItems), SearchSql.MatchingItems, 1, OwnAncestors },
        { nameof(SearchSql.ReadableItemsById), SearchSql.ReadableItemsById, 1, OwnAncestors },
        { nameof(SearchSql.ItemsLinkingTo), SearchSql.ItemsLinkingTo, 1, OwnAncestors },
        { nameof(BookmarkSql.ListShelf), BookmarkSql.ListShelf, 1, OwnAncestors },
        { nameof(BookmarkSql.Keep), BookmarkSql.Keep, 1, OwnAncestors },
        // Two predicates: one for the containers the dated children hang from, one for the daily
        // notes arm (alias note), which reaches its rows through the daily root rather than a
        // container. Every fragment is counted, so dropping either arm's predicate fails here.
        { nameof(CalendarSql.WorkspaceCalendar), CalendarSql.WorkspaceCalendar, 2, OwnAncestors },

        {
            nameof(RecurrenceSql.WorkspaceRecurrenceCandidates),
            RecurrenceSql.WorkspaceRecurrenceCandidates,
            1,
            OwnAncestors
        },

        // Anchored on the parent: a child's proper ancestors are its parent plus its parent's, so
        // the parent's own path answers it for every child at once.
        {
            nameof(RollupSql.AggregateChildProperties),
            RollupSql.AggregateChildProperties,
            1,
            ParentAndAbove
        },
        {
            nameof(RollupSql.BucketChildrenByProperty),
            RollupSql.BucketChildrenByProperty,
            1,
            ParentAndAbove
        },
        {
            nameof(RollupSql.BucketChildrenByPropertyAndSeries),
            RollupSql.BucketChildrenByPropertyAndSeries,
            1,
            ParentAndAbove
        },
        {
            nameof(RollupSql.BucketChildrenByDay),
            RollupSql.BucketChildrenByDay,
            1,
            ParentAndAbove
        },
    };

    /// <summary>The bound for a statement anchored on the row it returns.</summary>
    private const string OwnAncestors = "visibility_edge.depth > 0";

    /// <summary>The bound for a statement anchored on that row's parent.</summary>
    private const string ParentAndAbove = "visibility_edge.depth >= 0";

    [Theory]
    [MemberData(nameof(Statements))]
    public void Every_bulk_item_read_rejects_a_non_visible_proper_ancestor(
        string name,
        string sql,
        int expectedPredicates,
        string depthBound)
    {
        _ = name;
        ArgumentNullException.ThrowIfNull(sql);
        ArgumentNullException.ThrowIfNull(depthBound);

        Assert.Equal(expectedPredicates, Count(sql, "LEFT JOIN LATERAL"));
        Assert.Equal(expectedPredicates, Count(sql, depthBound));
        Assert.Equal(expectedPredicates, Count(sql, "visibility_ancestor.tenant_id = @tenant_id"));
        Assert.Equal(expectedPredicates, Count(sql, "stored_ancestor.template_id IS NOT NULL"));
        Assert.Equal(
            expectedPredicates,
            Count(sql, "stored_ancestor.lifecycle_state IS DISTINCT FROM 'active'"));
        Assert.Equal(expectedPredicates, Count(sql, "LIMIT 1\n"));
        // Other stages may have their own fences; pin the one protecting each ancestor probe.
        Assert.Equal(
            expectedPredicates,
            System.Text.RegularExpressions.Regex.Count(
                sql,
                @"stored_ancestor.lifecycle_state IS DISTINCT FROM 'active'\)\s*OFFSET 0"));
    }

    [Fact]
    public void The_query_statements_reject_a_non_visible_proper_ancestor_through_a_plain_anti_join()
    {
        // The query's probe is the unfenced correlated anti-join (data review S1), which the
        // planner can hash for a workspace-wide read; the rows and aggregate statements share it.
        var spec = new QuerySpec([], QueryOrder.Recency, new DateOnly(2026, 8, 22))
        {
            Grouping = new QueryGrouping("status", []),
        };

        foreach (var sql in new[]
                 {
                     QuerySql.Compile(spec).Sql,
                     QuerySql.CompileAggregate(spec, new Nix.Domain.Query.QueryAggregate("sum", "points")).Sql,
                 })
        {
            Assert.Equal(1, Count(sql, "FROM item_closure AS visibility_edge"));
            Assert.Equal(1, Count(sql, "JOIN item AS visibility_ancestor"));
            Assert.Equal(1, Count(sql, "visibility_ancestor.tenant_id = @tenant_id"));
            Assert.Equal(1, Count(sql, "visibility_edge.tenant_id = @tenant_id"));
            Assert.Equal(1, Count(sql, "visibility_edge.depth > 0"));
            Assert.Equal(1, Count(sql, "visibility_ancestor.template_id IS NOT NULL"));
            Assert.Equal(1, Count(sql, "visibility_ancestor.lifecycle_state <> 'active'"));
            Assert.Equal(0, Count(sql, "OFFSET 0"));
        }
    }

    [Fact]
    public void Matching_search_results_are_visibility_checked_once_after_both_match_arms()
    {
        Assert.Contains("ranked AS (", SearchSql.MatchingItems, StringComparison.Ordinal);
        Assert.Equal(1, Count(SearchSql.MatchingItems, "LEFT JOIN LATERAL"));
    }

    [Fact]
    public void Matching_search_results_are_ordered_before_the_visibility_probe_so_it_runs_for_the_page_only()
    {
        var sorted = SearchSql.MatchingItems.IndexOf("item_id OFFSET 0) AS ranked", StringComparison.Ordinal);
        var probe = SearchSql.MatchingItems.IndexOf("LEFT JOIN LATERAL", StringComparison.Ordinal);
        Assert.InRange(sorted, 0, probe - 1);
    }

    private static int Count(string text, string value)
    {
        var count = 0;
        var offset = 0;

        while ((offset = text.IndexOf(value, offset, StringComparison.Ordinal)) >= 0)
        {
            count++;
            offset += value.Length;
        }

        return count;
    }
}
