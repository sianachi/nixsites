using Nix.Persistence.Sql.Statements;

namespace Nix.Tests.Persistence;

/// <summary>
/// What the related-items and mention statements must say, asserted against their text.
/// </summary>
/// <remarks>
/// For the reason <c>GraphStatementTests</c> gives: the permission predicates are properties of the
/// text, and a statement missing one still compiles, runs and returns rows. Two tenants against real
/// Postgres prove the behaviour in <c>Nix.Integration.Tests</c>; this proves the shape without a
/// Docker daemon. Each assertion names the way the statement could be wrong.
/// </remarks>
public sealed class SuggestionStatementTests
{
    [Fact]
    public void Co_citation_filters_sources_and_results_by_the_readable_workspaces()
    {
        // Two disclosures: a source contributes to a count, a result is returned. Each needs its
        // own predicate; one standing in for the other is a leak in one direction or the other.
        Assert.Contains("source.workspace_id = ANY(@workspace_ids)", SearchSql.CoCitedItems, StringComparison.Ordinal);
        Assert.Contains("candidate.workspace_id = ANY(@workspace_ids)", SearchSql.CoCitedItems, StringComparison.Ordinal);
    }

    [Fact]
    public void Co_citation_checks_derived_visibility_for_sources_and_results()
    {
        Assert.Contains("visibility_edge.descendant_id = source.id", SearchSql.CoCitedItems, StringComparison.Ordinal);
        Assert.Contains("visibility_edge.descendant_id = item.id", SearchSql.CoCitedItems, StringComparison.Ordinal);
    }

    [Fact]
    public void Co_citation_leaves_out_a_source_under_a_lock()
    {
        // Every edge was extracted from a source's body.
        Assert.Contains("lock_edge.descendant_id = link.source_item_id", SearchSql.CoCitedItems, StringComparison.Ordinal);
        Assert.Contains("lock_edge.ancestor_id = ANY(@lock_ids)", SearchSql.CoCitedItems, StringComparison.Ordinal);
    }

    [Fact]
    public void Co_citation_is_bounded_by_a_source_limit_and_never_counts_or_returns_the_target()
    {
        Assert.Contains("LIMIT @source_limit", SearchSql.CoCitedItems, StringComparison.Ordinal);
        Assert.Contains("link.source_item_id <> @target_item_id", SearchSql.CoCitedItems, StringComparison.Ordinal);
        Assert.Contains("link.target_item_id <> @target_item_id", SearchSql.CoCitedItems, StringComparison.Ordinal);
    }

    [Fact]
    public void Co_citation_scopes_every_table_to_one_tenant()
    {
        Assert.Contains("link.tenant_id = @tenant_id", SearchSql.CoCitedItems, StringComparison.Ordinal);
        Assert.Contains("outgoing.tenant_id = @tenant_id", SearchSql.CoCitedItems, StringComparison.Ordinal);
        Assert.Contains("candidate.tenant_id = @tenant_id", SearchSql.CoCitedItems, StringComparison.Ordinal);
        Assert.Contains("item.tenant_id = @tenant_id", SearchSql.CoCitedItems, StringComparison.Ordinal);
    }

    [Fact]
    public void Mention_matching_filters_by_tenant_readable_workspaces_lifecycle_and_visibility()
    {
        Assert.Contains("candidate.tenant_id = @tenant_id", SearchSql.ItemsTitledAs, StringComparison.Ordinal);
        Assert.Contains("candidate.workspace_id = ANY(@workspace_ids)", SearchSql.ItemsTitledAs, StringComparison.Ordinal);
        Assert.Contains("candidate.lifecycle_state = 'active'", SearchSql.ItemsTitledAs, StringComparison.Ordinal);
        Assert.Contains("candidate.template_id IS NULL", SearchSql.ItemsTitledAs, StringComparison.Ordinal);
        Assert.Contains("visibility_edge.descendant_id = item.id", SearchSql.ItemsTitledAs, StringComparison.Ordinal);
    }

    [Fact]
    public void Mention_matching_compares_whole_titles_for_equality_and_reads_no_body()
    {
        // Equality, not a pattern: a mention is the whole title. And no body-derived table: only
        // the closed-lock rule for titles applies, not the body rule every lock carries.
        Assert.Contains("lower(candidate.properties ->> 'title') = ANY(@phrases)", SearchSql.ItemsTitledAs, StringComparison.Ordinal);
        Assert.DoesNotContain("LIKE", SearchSql.ItemsTitledAs, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("item_search", SearchSql.ItemsTitledAs, StringComparison.Ordinal);
        Assert.DoesNotContain("item_link", SearchSql.ItemsTitledAs, StringComparison.Ordinal);
    }

    [Fact]
    public void Mention_matching_leaves_out_the_excluded_items_before_any_cap()
    {
        // In the first stage, so the note itself and what it already links to never spend a
        // per-phrase or candidate slot.
        var matches = Stage(SearchSql.ItemsTitledAs, "matches AS MATERIALIZED", "ranked AS");
        Assert.Contains("candidate.id <> ALL(@exclude_ids)", matches, StringComparison.Ordinal);
    }

    [Fact]
    public void Mention_matching_caps_each_phrase_before_the_candidate_limit()
    {
        // A common title ("Meeting notes") must not fill the candidate set on its own.
        Assert.Contains("row_number() OVER (PARTITION BY matched_phrase", SearchSql.ItemsTitledAs, StringComparison.Ordinal);
        var candidates = Stage(SearchSql.ItemsTitledAs, "candidates AS MATERIALIZED", "SELECT item.id");
        Assert.Contains("phrase_rank <= @per_phrase_limit", candidates, StringComparison.Ordinal);
        Assert.Contains("LIMIT @candidate_limit", candidates, StringComparison.Ordinal);
    }

    [Fact]
    public void Both_suggestion_reads_probe_their_candidates_lazily_in_result_order()
    {
        // The outer query reads the capped candidates through a subquery already in the result
        // order, so the LIMIT stops the probes once enough rows have passed; sorting after the
        // probes would run them for every candidate (measured: 12,979 against 7,348 buffers for
        // mentions, 16,622 against 10,971 for a 3,000-source related read).
        Assert.Contains(") AS ordered", SearchSql.ItemsTitledAs, StringComparison.Ordinal);
        Assert.Contains(
            "ORDER BY ordered.phrase_length DESC, ordered.matched_phrase, ordered.phrase_rank",
            SearchSql.ItemsTitledAs,
            StringComparison.Ordinal);
        Assert.Contains(") AS ranked", SearchSql.CoCitedItems, StringComparison.Ordinal);
        Assert.Contains(
            "ORDER BY ranked.shared_sources DESC, ranked.title, ranked.item_id",
            SearchSql.CoCitedItems,
            StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(nameof(SearchSql.MatchingItems), "title AS MATERIALIZED (", "-- Matched and ranked", "item.id")]
    [InlineData(nameof(SearchSql.ItemsTitledAs), "matches AS MATERIALIZED (", "ranked AS", "candidate.id")]
    [InlineData(nameof(SearchSql.CoCitedItems), "co_cited AS MATERIALIZED (", "GROUP BY", "candidate.id")]
    public void Every_title_scan_drops_what_sits_under_a_closed_lock_before_any_cap(
        string statement,
        string stageStart,
        string stageEnd,
        string row)
    {
        // ADR-0056: a lock hides the titles under it from every title search. Read once as a
        // materialised set and anti-joined in the scanning stage - before a per-phrase, candidate
        // or result cap, so a hidden item can neither spend a slot nor be detected by the gap it
        // leaves - rather than probed per row, which the planner costs against the whole scan.
        ArgumentNullException.ThrowIfNull(stageStart);
        ArgumentNullException.ThrowIfNull(stageEnd);
        var text = Statement(statement);
        Assert.Contains(ItemLockSql.ClosedLockDescendants, text, StringComparison.Ordinal);

        var stage = Stage(text, stageStart, stageEnd);
        Assert.Contains(
            $"WHERE hidden.descendant_id = {row}",
            stage,
            StringComparison.Ordinal);
        Assert.DoesNotContain(ItemLockSql.ItemIsNotUnderClosedLock, text, StringComparison.Ordinal);
    }

    [Fact]
    public void The_graph_drops_nodes_under_a_closed_lock_before_its_node_ceiling()
    {
        var visible = Stage(GraphSql.WorkspaceGraph, "visible AS (", "LIMIT @node_limit");

        Assert.Contains(ItemLockSql.ClosedLockDescendants, GraphSql.WorkspaceGraph, StringComparison.Ordinal);
        Assert.Contains("WHERE hidden.descendant_id = item.id", visible, StringComparison.Ordinal);
    }

    [Fact]
    public void The_hidden_set_is_proper_descendants_of_the_closed_locks_only()
    {
        // The locked item itself keeps its title: depth > 0.
        Assert.Contains("lock_edge.ancestor_id = ANY(@closed_lock_ids)", ItemLockSql.ClosedLockDescendants, StringComparison.Ordinal);
        Assert.Contains("lock_edge.depth > 0", ItemLockSql.ClosedLockDescendants, StringComparison.Ordinal);
        Assert.Contains("MATERIALIZED", ItemLockSql.ClosedLockDescendants, StringComparison.Ordinal);
    }

    [Fact]
    public void Reference_resolution_is_a_read_by_identifier_and_carries_no_lock_rule()
    {
        // Resolving the references a readable document already holds is a read of named items,
        // like the item read, not a search; ADR-0056 records why it stays unfiltered.
        Assert.DoesNotContain("closed_lock_ids", SearchSql.ReadableItemsById, StringComparison.Ordinal);
    }

    [Fact]
    public void The_title_arm_of_search_takes_the_closed_lock_rule_and_the_body_arm_every_lock()
    {
        var titleArm = Stage(SearchSql.MatchingItems, "title AS MATERIALIZED (", "-- Matched and ranked");
        var bodyArm = Stage(SearchSql.MatchingItems, "hits AS MATERIALIZED (", "ranked AS");

        Assert.Contains("closed_lock_descendants AS hidden", titleArm, StringComparison.Ordinal);
        Assert.DoesNotContain("closed_lock_descendants", bodyArm, StringComparison.Ordinal);
        Assert.DoesNotContain("@lock_ids", titleArm, StringComparison.Ordinal);
        Assert.Contains("lock_edge.ancestor_id = ANY(@lock_ids)", bodyArm, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(nameof(SearchSql.MatchingItems))]
    [InlineData(nameof(SearchSql.ReadableItemsById))]
    [InlineData(nameof(SearchSql.ItemsLinkingTo))]
    [InlineData(nameof(SearchSql.CoCitedItems))]
    [InlineData(nameof(SearchSql.ItemsTitledAs))]
    public void Every_item_listing_projects_the_parent_and_modification_time(string statement)
    {
        var text = Statement(statement);

        Assert.Contains(".parent_id,", text, StringComparison.Ordinal);
        Assert.Contains(".last_modified_at", text, StringComparison.Ordinal);
    }

    private static string Statement(string name) =>
        (string)typeof(SearchSql).GetField(name)!.GetValue(null)!;

    /// <summary>The text between two markers, so an assertion is about one stage of a statement.</summary>
    private static string Stage(string statement, string from, string to)
    {
        var start = statement.IndexOf(from, StringComparison.Ordinal);
        Assert.True(start >= 0, $"'{from}' is not in the statement.");
        var end = statement.IndexOf(to, start + from.Length, StringComparison.Ordinal);
        Assert.True(end > start, $"'{to}' does not follow '{from}'.");
        return statement[start..end];
    }
}
