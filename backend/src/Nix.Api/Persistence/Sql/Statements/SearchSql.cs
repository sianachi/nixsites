namespace Nix.Persistence.Sql.Statements;

/// <summary>
/// Finding items by what they are called and by what their documents say.
/// </summary>
/// <remarks>
/// <para>
/// <b>The permission filter is a predicate in the statement, not a pass over the results.</b>
/// Every statement here takes the readable workspaces as a parameter, resolved through
/// <c>IPermissionResolver</c> before the query runs and never sent by the client. Filtering
/// afterwards would be wrong in three separate ways at once: the row count would describe rows the
/// caller may not see, the ranking would be computed against them, and a limit would be spent on
/// them - so a page could come back empty while matches existed. The client never computes
/// permissions and the server never discards rows it should not have read.
/// </para>
/// <para>
/// <b>Two sources, one query.</b> A title lives on <c>item</c>, in <c>properties</c>, and is
/// written by Core. A body's words live in <c>item_search</c> and are written by the collaboration
/// service. They are joined here rather than denormalised into one row, so renaming an item is
/// visible to the next search with no reindex - and a rename is the most common edit an item ever
/// receives.
/// </para>
/// <para>
/// <b>The dictionary is named, not inherited.</b> <c>english</c> is spelled out in every statement
/// because <c>default_text_search_config</c> is a per-database, per-session setting: a vector built
/// under one configuration and queried under another silently stops matching. The migration that
/// built the column names the same one, and a disagreement is then two visible lines of SQL rather
/// than an invisible dependency on server configuration.
/// </para>
/// <para>
/// <b>Every item listing projects the same six columns first, in the same order</b> - <c>id</c>,
/// <c>workspace_id</c>, <c>type</c>, <c>title</c>, <c>parent_id</c>, <c>last_modified_at</c> -
/// because one reader (<c>ItemDigestColumns</c>) maps them all. A statement's own extra columns
/// (an occurrence count, a shared-source count, a matched phrase) come after.
/// </para>
/// <para>
/// The measured runtime-role plan at the phase corpus uses
/// <c>IX_item_tenant_id_workspace_id</c> to bound the title arm and a bounded
/// <c>item_search</c> scan for the body arm. The expression indexes remain available to a future
/// planner, but are not claimed as runtime dependencies. Derived visibility additionally depends
/// on the closure descendant index and the item point key; <c>BulkItemVisibilityPlanEvidenceTests</c>
/// records the exact RLS plan.
/// </para>
/// </remarks>
public static class SearchSql
{
    /// <summary>
    /// Items whose title or document text matches, most relevant first.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>A title match outranks a body match, always.</b> Somebody typing into a palette is
    /// usually trying to reach a document they can already name, and a note that merely mentions
    /// the word must not come above the note called it. That is a sort key rather than a filter,
    /// so a body-only match is still returned - just below.
    /// </para>
    /// <para>
    /// <b>Two arms unioned, rather than one scan with an <c>OR</c>.</b> The obvious shape - join
    /// <c>item_search</c> and write <c>title ILIKE ... OR body_vector @@ ...</c> - cannot use
    /// one combined index. No single index spans two tables, and one joined arm would make the
    /// permission and match predicates inseparable. Split, each source keeps its own permission
    /// predicate and physical plan, and the aggregate merges the two. The runtime-role evidence at
    /// the current corpus uses the workspace index for titles and scans the bounded search table
    /// for bodies; it does not pretend the two expression indexes were selected when they were not.
    /// </para>
    /// <para>
    /// <b>The permission predicate appears in both arms, and must.</b> It is stated twice because
    /// there are two ways in, and an arm without it is a way in without a check. They are in one
    /// statement so both are read together; a reviewer who sees one and not the other is looking at
    /// a bug.
    /// </para>
    /// <para>
    /// <b>A locked item never matches on its body, and neither does anything under it.</b> A lock
    /// covers its subtree, so the probe walks the item's ancestors. Matching is itself a read: a search that
    /// found a locked note for a word would let anybody who can see the note learn, a word at a
    /// time, what its body says. Not relaxed for a credential that has the item unlocked - which
    /// bodies match should not change with which notes happen to be open.
    /// </para>
    /// <para>
    /// <b>A title under a closed lock never matches either</b> (ADR-0056). The title arm takes the
    /// same rule as the children read: an item whose proper ancestor carries a lock this credential
    /// has not opened is left out, so a title search - whose hits carry <c>parent_id</c> - cannot
    /// list a locked folder's children one query at a time. The locked item's own title still
    /// matches, as it is still listed in its parent. Unlike the body rule this one follows the
    /// credential: once the folder is open its children are listed, so they are searchable too.
    /// </para>
    /// <para>
    /// <b>The hidden set is read once and anti-joined, never probed per row.</b>
    /// <see cref="ItemLockSql.ClosedLockDescendants"/> materialises what the closed locks cover, and
    /// the title arm anti-joins it. A per-row probe was costed against every row the title scan
    /// might return - about 1.96 million over a 190,000-item readable corpus - and JIT-compiled
    /// every search for anyone with a closed lock. Measured as the runtime role with RLS on a
    /// throwaway database (190,000 readable items, 30 closed locks covering 60 items), a query
    /// matching nothing (<c>zzqx</c>): 8,375 shared buffers, no JIT, 50 to 62 ms per execution on
    /// a heavily loaded machine (load average about 15), where the same statement with no locks took
    /// 65 to 68 ms and the statement before this work, with no title lock rule at all, 70 to 76 ms.
    /// The time is the title scan, not the lock rule. Re-run without the competing CPU load:
    /// 8,375 buffers, 29 ms warm, no JIT, below the 10,000-buffer and 40-ms gates.
    /// </para>
    /// <para>
    /// The title arm alone reaches items with no document body at all, which is most of a freshly
    /// imported workspace. Its rank is a constant rather than a computed one - a title match is
    /// ordered ahead of every body match by <c>title_matched</c> before rank is consulted at all,
    /// so computing a text rank for it would be arithmetic nothing reads.
    /// </para>
    /// <para>
    /// <c>bool_or</c> and <c>max</c> over the union: an item matching both ways appears in both arms
    /// and must come back once, as a title match, carrying the body rank it earned.
    /// </para>
    /// <para>
    /// <c>websearch_to_tsquery</c> rather than <c>plainto_tsquery</c>: it takes quoted phrases and
    /// <c>or</c> and <c>-</c> from anybody who has used a search engine, and - unlike
    /// <c>to_tsquery</c> - it cannot be made to raise a syntax error by typing a bare bracket,
    /// which is the sort of thing a person types into a search box constantly.
    /// </para>
    /// <para>
    /// The tie-break on <c>item.id</c> is not decoration. Two equally ranked rows in an unstable
    /// order make the same query return a different page each time it runs, which reads as results
    /// flickering as somebody types.
    /// </para>
    /// </remarks>
    public const string MatchingItems = $$"""
        WITH {{ItemLockSql.ClosedLockDescendants}},
        matches AS (
            SELECT item.id AS item_id,
                   true AS title_matched,
                   0::real AS rank
            FROM item
            WHERE item.tenant_id = @tenant_id
              AND item.workspace_id = ANY(@workspace_ids)
              AND item.lifecycle_state = 'active'
              AND item.template_id IS NULL
              AND (item.properties ->> 'title') ILIKE @title_pattern ESCAPE '\'
              AND NOT EXISTS (
                  SELECT 1
                  FROM closed_lock_descendants AS hidden
                  WHERE hidden.descendant_id = item.id
              )

            UNION ALL

            SELECT search.item_id,
                   false AS title_matched,
                   ts_rank(search.body_vector, websearch_to_tsquery('english', @query)) AS rank
            FROM item_search AS search
            JOIN item
              ON item.tenant_id = search.tenant_id
             AND item.id = search.item_id
            WHERE search.tenant_id = @tenant_id
              AND search.body_vector @@ websearch_to_tsquery('english', @query)
              AND item.workspace_id = ANY(@workspace_ids)
              AND item.lifecycle_state = 'active'
              AND item.template_id IS NULL
              AND (cardinality(@lock_ids) = 0
                 OR NOT EXISTS (
                  SELECT 1
                  FROM item_closure AS lock_edge
                  WHERE lock_edge.tenant_id = @tenant_id
                    AND lock_edge.descendant_id = search.item_id
                    AND lock_edge.ancestor_id = ANY(@lock_ids)
                 ))
        ),
        ranked AS (
            SELECT item_id,
                   bool_or(title_matched) AS title_matched,
                   max(rank) AS rank
            FROM matches
            GROUP BY item_id
        )
        SELECT item.id,
               item.workspace_id,
               item.type,
               item.properties ->> 'title' AS title,
               item.parent_id,
               item.last_modified_at
        FROM ranked
        JOIN item
          ON item.tenant_id = @tenant_id
         AND item.id = ranked.item_id
         AND item.template_id IS NULL
         AND item.lifecycle_state = 'active'
         AND NOT EXISTS (
             SELECT 1
             FROM item_closure AS visibility_edge
             LEFT JOIN LATERAL (
                 SELECT visibility_ancestor.template_id,
                        visibility_ancestor.lifecycle_state
                 FROM item AS visibility_ancestor
                 WHERE visibility_ancestor.tenant_id = @tenant_id
                   AND visibility_ancestor.id = visibility_edge.ancestor_id
                 LIMIT 1
             ) AS stored_ancestor ON TRUE
             WHERE visibility_edge.tenant_id = @tenant_id
               AND visibility_edge.descendant_id = item.id
               AND visibility_edge.depth > 0
               AND (stored_ancestor.template_id IS NOT NULL
                    OR stored_ancestor.lifecycle_state IS DISTINCT FROM 'active')
             OFFSET 0
         )
        ORDER BY ranked.title_matched DESC, ranked.rank DESC, item.id
        LIMIT @limit
        """;

    /// <summary>
    /// The passages that best match a query, in a note's subtree or, when <c>@root_id</c> is null,
    /// in every readable workspace given, by reciprocal-rank fusion of full-text rank and, when
    /// <c>@query_embedding</c> is not null, cosine distance.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The subtree is <c>item_closure</c> from the root, root included. The filters are
    /// <see cref="MatchingItems"/>' body arm and its visibility check: readable workspace, active,
    /// not a template, nothing at or under any lock, and no trashed or template ancestor.
    /// </para>
    /// <para>
    /// Each arm keeps its fifty best before fusing, and 60 is the usual fusion constant. The cosine
    /// arm scans the candidate chunks exactly, under the ad-hoc query timeout. shortcut: no ANN
    /// index; add HNSW once a workspace holds more than about 100,000 chunks.
    /// </para>
    /// </remarks>
    public const string Passages = """
        WITH scoped AS MATERIALIZED (
            SELECT chunk.item_id,
                   chunk.ord,
                   chunk.heading,
                   chunk.body,
                   chunk.body_vector,
                   chunk.embedding,
                   item.properties ->> 'title' AS title
            FROM item_chunk AS chunk
            JOIN item
              ON item.tenant_id = @tenant_id
             AND item.id = chunk.item_id
            WHERE chunk.tenant_id = @tenant_id
              AND (CAST(@root_id AS uuid) IS NULL
                   OR EXISTS (
                       SELECT 1
                       FROM item_closure AS edge
                       WHERE edge.tenant_id = @tenant_id
                         AND edge.ancestor_id = @root_id
                         AND edge.descendant_id = item.id
                   ))
              AND item.workspace_id = ANY(@workspace_ids)
              AND item.lifecycle_state = 'active'
              AND item.template_id IS NULL
              AND (cardinality(@lock_ids) = 0
                 OR NOT EXISTS (
                  SELECT 1
                  FROM item_closure AS lock_edge
                  WHERE lock_edge.tenant_id = @tenant_id
                    AND lock_edge.descendant_id = item.id
                    AND lock_edge.ancestor_id = ANY(@lock_ids)
                 ))
              AND NOT EXISTS (
                  SELECT 1
                  FROM item_closure AS visibility_edge
                  JOIN item AS ancestor
                    ON ancestor.tenant_id = @tenant_id
                   AND ancestor.id = visibility_edge.ancestor_id
                  WHERE visibility_edge.tenant_id = @tenant_id
                    AND visibility_edge.descendant_id = item.id
                    AND visibility_edge.depth > 0
                    AND (ancestor.template_id IS NOT NULL
                         OR ancestor.lifecycle_state <> 'active')
              )
        ),
        search_terms AS (
            -- Any of the words, not all: a pet asks a whole question, and ts_rank already favours
            -- passages that hold more of it.
            SELECT CAST(replace(CAST(plainto_tsquery('english', @query) AS text), ' & ', ' | ') AS tsquery) AS terms
        ),
        by_text AS (
            SELECT item_id, ord,
                   row_number() OVER (
                       ORDER BY ts_rank(body_vector, search_terms.terms) DESC, item_id, ord
                   ) AS position
            FROM scoped, search_terms
            WHERE body_vector @@ search_terms.terms
            ORDER BY position
            LIMIT 50
        ),
        by_meaning AS (
            SELECT item_id, ord,
                   row_number() OVER (
                       ORDER BY embedding <=> CAST(@query_embedding AS vector), item_id, ord
                   ) AS position
            FROM scoped
            WHERE @query_embedding IS NOT NULL
              AND embedding IS NOT NULL
            ORDER BY position
            LIMIT 50
        ),
        fused AS (
            SELECT item_id, ord, sum(1.0 / (60 + position)) AS score
            FROM (SELECT * FROM by_text UNION ALL SELECT * FROM by_meaning) AS ranked
            GROUP BY item_id, ord
        )
        SELECT scoped.item_id, coalesce(scoped.title, ''), scoped.heading, scoped.ord, scoped.body
        FROM fused
        JOIN scoped USING (item_id, ord)
        ORDER BY fused.score DESC, scoped.item_id, scoped.ord
        LIMIT @limit
        """;

    /// <summary>
    /// The items among a given set that the caller may read, with their titles.
    /// </summary>
    /// <remarks>
    /// <para>
    /// What a document's references resolve against. An identifier absent from the result is one of
    /// three things - it never existed, it was deleted, or it belongs to a workspace this caller
    /// cannot reach - and the caller is told none of them, because telling them apart is how an
    /// outsider enumerates a tenant one identifier at a time. The reader gets a stub either way.
    /// </para>
    /// <para>
    /// <b>This is the statement that stops a title leaking.</b> A reference node carries a cached
    /// <c>label</c> - the target's title as of when the link was made - and that cache is a title
    /// the reader may have no entitlement to. Resolution has to be the thing that decides whether
    /// they see one, so this returns a title only for a row that passed the workspace predicate,
    /// and returns no row at all otherwise.
    /// </para>
    /// <para>
    /// Index dependencies: <c>PK_item</c> for the identifier lookup, then the workspace and
    /// lifecycle columns as filters on the fetched rows.
    /// </para>
    /// </remarks>
    public const string ReadableItemsById = """
        SELECT item.id,
               item.workspace_id,
               item.type,
               item.properties ->> 'title' AS title,
               item.parent_id,
               item.last_modified_at
        FROM item
        WHERE item.tenant_id = @tenant_id
          AND item.id = ANY(@item_ids)
          AND item.workspace_id = ANY(@workspace_ids)
          AND item.lifecycle_state = 'active'
          AND item.template_id IS NULL
          AND NOT EXISTS (
              SELECT 1
              FROM item_closure AS visibility_edge
              LEFT JOIN LATERAL (
                  SELECT visibility_ancestor.template_id,
                         visibility_ancestor.lifecycle_state
                  FROM item AS visibility_ancestor
                  WHERE visibility_ancestor.tenant_id = @tenant_id
                    AND visibility_ancestor.id = visibility_edge.ancestor_id
                  LIMIT 1
              ) AS stored_ancestor ON TRUE
              WHERE visibility_edge.tenant_id = @tenant_id
                AND visibility_edge.descendant_id = item.id
                AND visibility_edge.depth > 0
                AND (stored_ancestor.template_id IS NOT NULL
                     OR stored_ancestor.lifecycle_state IS DISTINCT FROM 'active')
              OFFSET 0
          )
        """;

    /// <summary>
    /// The items whose documents refer to a given item, most-referring first.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The backlinks read. It starts from <c>item_link</c> on the target and joins back to
    /// <c>item</c> for the source's name, so the workspace predicate applies to the <i>source</i> -
    /// which is the one being disclosed. A reader entitled to the item they are looking at is not
    /// thereby entitled to know that a document in a workspace they cannot reach mentions it, and
    /// the count in the panel must not include it either.
    /// </para>
    /// <para>
    /// A locked source is left out: an edge is extracted from the source's body, so "this locked
    /// note links here, three times" is a sentence about what the locked body says.
    /// </para>
    /// <para>
    /// Ordered by <c>occurrences</c> so a document that discusses the target at length comes above
    /// one that mentions it once in passing, then by title so the order is stable, then by
    /// identifier because two items may share a title.
    /// </para>
    /// <para>
    /// Index dependencies: <c>ix_item_link_target_occurrences</c> for the driving lookup, then
    /// <c>item_pkey</c> for each source.
    /// </para>
    /// </remarks>
    public const string ItemsLinkingTo = """
        SELECT source.id,
               source.workspace_id,
               source.type,
               source.properties ->> 'title' AS title,
               source.parent_id,
               source.last_modified_at,
               link.occurrences
        FROM item_link AS link
        JOIN item AS source
          ON source.tenant_id = link.tenant_id
         AND source.id = link.source_item_id
        WHERE link.tenant_id = @tenant_id
          AND link.target_item_id = @target_item_id
          AND source.workspace_id = ANY(@workspace_ids)
          AND source.lifecycle_state = 'active'
          AND source.template_id IS NULL
          AND (cardinality(@lock_ids) = 0
             OR NOT EXISTS (
              SELECT 1
              FROM item_closure AS lock_edge
              WHERE lock_edge.tenant_id = @tenant_id
                AND lock_edge.descendant_id = link.source_item_id
                AND lock_edge.ancestor_id = ANY(@lock_ids)
             ))
          AND NOT EXISTS (
              SELECT 1
              FROM item_closure AS visibility_edge
              LEFT JOIN LATERAL (
                  SELECT visibility_ancestor.template_id,
                         visibility_ancestor.lifecycle_state
                  FROM item AS visibility_ancestor
                  WHERE visibility_ancestor.tenant_id = @tenant_id
                    AND visibility_ancestor.id = visibility_edge.ancestor_id
                  LIMIT 1
              ) AS stored_ancestor ON TRUE
              WHERE visibility_edge.tenant_id = @tenant_id
                AND visibility_edge.descendant_id = source.id
                AND visibility_edge.depth > 0
                AND (stored_ancestor.template_id IS NOT NULL
                     OR stored_ancestor.lifecycle_state IS DISTINCT FROM 'active')
              OFFSET 0
          )
        ORDER BY link.occurrences DESC, title, source.id
        LIMIT @limit
        """;

    /// <summary>
    /// The items most often linked from the same documents that link to a given item - its
    /// co-citations - most shared sources first.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Two disclosures, two permission checks.</b> The <i>sources</i> are never returned, but
    /// each one contributes a count, and "three documents that mention this also mention that" is a
    /// statement about those three documents. So a source counts only when the caller may read it:
    /// readable workspace, active, not a template, no deleted or template ancestor. The <i>results</i>
    /// are returned, so each passes the same predicates again in the outer query. Neither check can
    /// stand in for the other - a readable result co-cited only by unreadable documents must not
    /// appear at all, and a readable source may point at an item the caller cannot reach.
    /// </para>
    /// <para>
    /// <b>A locked source is left out, and so is anything under a lock.</b> Every edge here was
    /// extracted from a source's body; letting a locked body contribute would let anybody who can
    /// see the note learn, one related item at a time, what it links to. The same reasoning and the
    /// same predicate as <see cref="ItemsLinkingTo"/>, and like it not relaxed for a credential
    /// that holds the lock open.
    /// </para>
    /// <para>
    /// <b>A result under a closed lock is left out too</b> (ADR-0056): a related item is a title
    /// disclosed by a search, and a lock hides the titles under it until this credential opens it.
    /// The locked item itself may still be returned - its own title is outside its lock. The hidden
    /// set (<see cref="ItemLockSql.ClosedLockDescendants"/>) is anti-joined in <c>co_cited</c>,
    /// before the count is ranked and capped, so a hidden item never takes a candidate slot.
    /// </para>
    /// <para>
    /// <b>Bounded in stages, so a hub cannot turn this into a corpus scan.</b> The sources are
    /// the target's <c>@source_limit</c> most-referring readable sources, chosen exactly as the
    /// backlinks read chooses them (driven by <c>ix_item_link_target_occurrences</c>), so the first stage costs
    /// what the backlinks panel beside it already costs. The fan-out then reads only those sources'
    /// outgoing edges, one <c>PK_item_link</c> prefix probe <c>(tenant_id, source_item_id)</c> per
    /// source - the <c>OFFSET 0</c> keeps the lateral from being flattened into a hash join that
    /// would scan every edge in the tenant - so the second stage is bounded by <c>@source_limit</c>
    /// times the out-degree of a document, never by the size of the tenant. The permission filter
    /// on sources sits inside the first stage, before its limit, so the limit is never spent on a
    /// source that would then be discarded.
    /// </para>
    /// <para>
    /// <b>The cheap result predicates run before ranking; the ancestor probe runs last, lazily.</b>
    /// Workspace, lifecycle, template and the closed-lock set are checks on the candidate's own row,
    /// so they filter before the count is ranked and a hidden or unreadable item can never take a
    /// candidate slot. The derived-visibility probe is a subplan the planner costs per row it
    /// assumes, and charged against every co-cited item it pushed the estimate past
    /// <c>jit_above_cost</c>; ranking first and keeping only the top <c>@candidate_limit</c> bounds
    /// that. The outer query then reads the candidates through a subquery already in the result
    /// order, so the nested loop keeps that order and the <c>LIMIT</c> stops it as soon as
    /// <c>@limit</c> rows have passed: a ten-row panel probes about a dozen candidates, not two
    /// hundred. Only an active item below a deleted or template ancestor can spend a candidate slot
    /// and then be skipped; such an item is in the trash or a template, not behind a lock.
    /// </para>
    /// <para>
    /// Measured as the runtime role with RLS on a throwaway database built from the migrations
    /// (350,000 items, 250,000 in the tenant; 1.43 million edges; 30 closed locks), for a target
    /// with 3,001 readable sources: an index-only scan of <c>ix_item_link_target_occurrences</c>
    /// in occurrence order, 238 sources probed to keep 200; 200 <c>PK_item_link</c> index-only
    /// probes returning 1,003 outgoing edges; 580 co-cited candidates ranked to 200; 12 lazy
    /// lock and ancestor probes for the 10 rows returned; 10,971 shared buffers, 6.3 ms warm, no
    /// JIT. A target with 249,769 sources costs 9,088 buffers and 4.7 ms, because the first stage
    /// reads the index in order and stops at its limit. Probing all 200 candidates, as the
    /// previous shape did, cost 16,622 buffers for the 3,001-source target. With the closed-lock
    /// set anti-joined before ranking (a second throwaway build of the same corpus, a 3,000-source
    /// target), 9,401 buffers and 11 ms under load, no JIT.
    /// </para>
    /// <para>
    /// The target never counts as its own source (a self-reference says what the target's own body
    /// links to, which is its outgoing links rather than its co-citations) and is never returned.
    /// </para>
    /// <para>
    /// Ordered by shared-source count, then title so equal counts read alphabetically, then
    /// identifier because two items may share a title and an unstable order flickers.
    /// </para>
    /// </remarks>
    public const string CoCitedItems = $$"""
        WITH {{ItemLockSql.ClosedLockDescendants}},
        sources AS (
            SELECT link.source_item_id AS source_id
            FROM item_link AS link
            JOIN item AS source
              ON source.tenant_id = link.tenant_id
             AND source.id = link.source_item_id
            WHERE link.tenant_id = @tenant_id
              AND link.target_item_id = @target_item_id
              AND link.source_item_id <> @target_item_id
              AND source.workspace_id = ANY(@workspace_ids)
              AND source.lifecycle_state = 'active'
              AND source.template_id IS NULL
              AND (cardinality(@lock_ids) = 0
                 OR NOT EXISTS (
                  SELECT 1
                  FROM item_closure AS lock_edge
                  WHERE lock_edge.tenant_id = @tenant_id
                    AND lock_edge.descendant_id = link.source_item_id
                    AND lock_edge.ancestor_id = ANY(@lock_ids)
                 ))
              AND NOT EXISTS (
                  SELECT 1
                  FROM item_closure AS visibility_edge
                  LEFT JOIN LATERAL (
                      SELECT visibility_ancestor.template_id,
                             visibility_ancestor.lifecycle_state
                      FROM item AS visibility_ancestor
                      WHERE visibility_ancestor.tenant_id = @tenant_id
                        AND visibility_ancestor.id = visibility_edge.ancestor_id
                      LIMIT 1
                  ) AS stored_ancestor ON TRUE
                  WHERE visibility_edge.tenant_id = @tenant_id
                    AND visibility_edge.descendant_id = source.id
                    AND visibility_edge.depth > 0
                    AND (stored_ancestor.template_id IS NOT NULL
                         OR stored_ancestor.lifecycle_state IS DISTINCT FROM 'active')
                  OFFSET 0
              )
            ORDER BY link.occurrences DESC, link.source_item_id
            LIMIT @source_limit
        ),
        co_cited AS MATERIALIZED (
            SELECT candidate.id AS item_id,
                   count(*)::integer AS shared_sources,
                   min(candidate.properties ->> 'title') AS title
            FROM sources
            CROSS JOIN LATERAL (
                SELECT outgoing.target_item_id
                FROM item_link AS outgoing
                WHERE outgoing.tenant_id = @tenant_id
                  AND outgoing.source_item_id = sources.source_id
                OFFSET 0
            ) AS link
            JOIN item AS candidate
              ON candidate.tenant_id = @tenant_id
             AND candidate.id = link.target_item_id
            WHERE link.target_item_id <> @target_item_id
              AND candidate.workspace_id = ANY(@workspace_ids)
              AND candidate.lifecycle_state = 'active'
              AND candidate.template_id IS NULL
              AND NOT EXISTS (
                  SELECT 1
                  FROM closed_lock_descendants AS hidden
                  WHERE hidden.descendant_id = candidate.id
              )
            GROUP BY candidate.id
            ORDER BY count(*) DESC, min(candidate.properties ->> 'title'), candidate.id
            LIMIT @candidate_limit
        )
        SELECT item.id,
               item.workspace_id,
               item.type,
               item.properties ->> 'title' AS title,
               item.parent_id,
               item.last_modified_at,
               ranked.shared_sources
        FROM (
            SELECT co_cited.item_id,
                   co_cited.shared_sources,
                   co_cited.title
            FROM co_cited
            ORDER BY co_cited.shared_sources DESC, co_cited.title, co_cited.item_id
        ) AS ranked
        JOIN item
          ON item.tenant_id = @tenant_id
         AND item.id = ranked.item_id
        WHERE NOT EXISTS (
              SELECT 1
              FROM item_closure AS visibility_edge
              LEFT JOIN LATERAL (
                  SELECT visibility_ancestor.template_id,
                         visibility_ancestor.lifecycle_state
                  FROM item AS visibility_ancestor
                  WHERE visibility_ancestor.tenant_id = @tenant_id
                    AND visibility_ancestor.id = visibility_edge.ancestor_id
                  LIMIT 1
              ) AS stored_ancestor ON TRUE
              WHERE visibility_edge.tenant_id = @tenant_id
                AND visibility_edge.descendant_id = item.id
                AND visibility_edge.depth > 0
                AND (stored_ancestor.template_id IS NOT NULL
                     OR stored_ancestor.lifecycle_state IS DISTINCT FROM 'active')
              OFFSET 0
          )
        ORDER BY ranked.shared_sources DESC, ranked.title, ranked.item_id
        LIMIT @limit
        """;

    /// <summary>
    /// The readable items in the named workspaces whose title, lower-cased, is one of a given set of
    /// phrases - the "unlinked mentions" read - longest title first, at most
    /// <c>@per_phrase_limit</c> per phrase.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The phrases are word n-grams the server cut from a passage of text the caller sent
    /// (<c>MentionPhrases</c>); the caller never sends a phrase list, a pattern, or SQL. Equality
    /// against an array rather than <c>ILIKE</c>: a mention is the whole title as a whole-word
    /// phrase, never a fragment of one, and equality has no metacharacters to neutralise.
    /// </para>
    /// <para>
    /// <b>The same permission predicates as every other item listing</b> - readable workspace,
    /// active, not a template, no deleted or template ancestor - because the result is a list of
    /// titles, and a title is exactly what must not leak. <c>@workspace_ids</c> is the one
    /// workspace the passage is being written in, already intersected with the readable set by the
    /// handler, so a 150,000-item neighbour workspace costs nothing.
    /// </para>
    /// <para>
    /// <b>A title under a closed lock is not a mention</b> (ADR-0056), by the rule the children read
    /// and <see cref="MatchingItems"/>' title arm use: a proper ancestor carrying a lock this
    /// credential has not opened. The locked item's own title still is. Nothing derived from a body
    /// is read here, so the body rule (every lock, opened or not) does not apply.
    /// </para>
    /// <para>
    /// <b>Hidden items are dropped in <c>matches</c>, before the per-phrase cap.</b> The cap keeps
    /// the newest three per phrase; were the lock checked after it, three hidden items with a title
    /// would take all three slots and the readable one would vanish - and its absence would tell
    /// the caller that at least three hidden items with that title were edited more recently. So
    /// the closed-lock set (<see cref="ItemLockSql.ClosedLockDescendants"/>) is anti-joined in the
    /// scan itself.
    /// </para>
    /// <para>
    /// <b>Four stages, each bounding the next.</b> <c>matches</c> is every equal title in the
    /// workspace minus <c>@exclude_ids</c> (the note being written and what it already links to,
    /// at most 256), materialised so the scan runs once. <c>ranked</c> numbers each phrase's
    /// matches newest first, and <c>candidates</c> keeps at most <c>@per_phrase_limit</c> of each
    /// before the <c>@candidate_limit</c> cap, so one common title ("Meeting notes", a date) cannot
    /// fill the candidate set and starve every other phrase. Only then does the outer query run
    /// the per-row deleted-or-template-ancestor probe, reading the candidates through a subquery
    /// already in the result order so the nested loop keeps it and the <c>LIMIT</c> stops after
    /// <c>@limit</c> rows have passed: a twenty-row answer probes about twenty candidates.
    /// </para>
    /// <para>
    /// <b>Why the candidates are a capped, materialised set before the probes.</b> With no
    /// statistics on the lower-cased expression the planner guesses that a large share of the
    /// workspace matches, and it charges the per-row visibility subplan to every guessed row.
    /// Written as one flat <c>WHERE</c>, that pushed the estimate past <c>jit_above_cost</c> and
    /// JIT compilation cost about 100 ms on a statement whose scan took 6 ms. The cap bounds what
    /// the planner may assume. The ancestor probe stays after the caps because it is the costly
    /// one; so a per-phrase or candidate slot can still be spent on an active item below a
    /// deleted or template ancestor, and a phrase whose newest matches all sit in the trash can
    /// come back short. What that gap can reveal is that trashed or template items with the title
    /// exist in a workspace the caller may read - recorded in ADR-0056 - never anything behind a
    /// lock, which cannot spend a slot.
    /// </para>
    /// <para>
    /// <b>Bound.</b> No index serves <c>lower(title) = ANY(...)</c>: <c>ix_item_title</c> leads
    /// with <c>parent_id</c> and is case-sensitive, and <c>ix_item_title_trgm</c> is not an equality
    /// index on the lower-cased expression. The work is one pass over the named workspace's items
    /// through <c>IX_item_tenant_id_workspace_id</c>, each probed against a hashed array of at most
    /// <c>MentionPhrases.MaximumPhrases</c> phrases, so the cost grows with the workspace and
    /// barely with the phrase count. An expression index on <c>lower(properties ->> 'title')</c>
    /// is <i>not</i> the next step: <c>lower()</c> is not leakproof, so under row-level security
    /// the planner may not evaluate it inside an index condition ahead of the policy, and such an
    /// index goes unused for the runtime role. The workable path, if a workspace outgrows this, is
    /// a stored generated <c>title_lower</c> column with a plain B-tree on
    /// <c>(tenant_id, workspace_id, title_lower)</c>, compared with <c>=</c>, which is leakproof.
    /// It is documented here, not built.
    /// </para>
    /// <para>
    /// Measured as the runtime role with RLS on a throwaway database built from the migrations
    /// (350,000 items; 150,000 in the named workspace; 4,000 phrases; 256 exclusions; 30 closed
    /// locks): a bitmap heap scan through <c>IX_item_tenant_id_workspace_id</c> (6,602 buffers)
    /// finding 19,127 equal titles, 1,735 left after the per-phrase cap, 200 candidates, and 23
    /// lazy lock and ancestor probes for the 20 rows returned; 7,348 shared buffers, about 62 ms
    /// per warm execution, no JIT. With the closed-lock set anti-joined in the scan (a second
    /// build of the same corpus, under load average about 15): 7,326 buffers, 77 to 103 ms under
    /// <c>EXPLAIN ANALYZE</c>, no JIT. Re-run without the competing CPU load: 7,364 buffers,
    /// 66 ms warm, no JIT, below the 10,000-buffer and 100-ms gates. Nearly all of the time is evaluating <c>lower()</c> and the
    /// hashed phrase array over the workspace's rows. Probing all 200 candidates, as the previous
    /// shape did, cost 12,979 buffers. The figures are for a custom plan, which is what Core gets:
    /// it does not prepare statements, so every execution is planned with its parameters. A
    /// generic plan of this statement measured 1.3 s, so enabling Npgsql auto-prepare would need
    /// this statement re-measured first.
    /// </para>
    /// <para>
    /// Returns the matched phrase as its own column so the handler can pair a row with the phrase
    /// it cut, by exact equality, rather than lower-casing the title again in .NET and hoping the
    /// two implementations of <c>lower</c> agree.
    /// </para>
    /// </remarks>
    public const string ItemsTitledAs = $$"""
        WITH {{ItemLockSql.ClosedLockDescendants}},
        matches AS MATERIALIZED (
            SELECT candidate.id,
                   lower(candidate.properties ->> 'title') AS matched_phrase,
                   candidate.last_modified_at
            FROM item AS candidate
            WHERE candidate.tenant_id = @tenant_id
              AND candidate.workspace_id = ANY(@workspace_ids)
              AND candidate.lifecycle_state = 'active'
              AND candidate.template_id IS NULL
              AND candidate.id <> ALL(@exclude_ids)
              AND lower(candidate.properties ->> 'title') = ANY(@phrases)
              AND NOT EXISTS (
                  SELECT 1
                  FROM closed_lock_descendants AS hidden
                  WHERE hidden.descendant_id = candidate.id
              )
        ),
        ranked AS (
            SELECT matches.id,
                   matches.matched_phrase,
                   row_number() OVER (PARTITION BY matched_phrase
                                      ORDER BY matches.last_modified_at DESC, matches.id) AS phrase_rank
            FROM matches
        ),
        candidates AS MATERIALIZED (
            SELECT ranked.id,
                   ranked.matched_phrase,
                   ranked.phrase_rank
            FROM ranked
            WHERE phrase_rank <= @per_phrase_limit
            ORDER BY char_length(ranked.matched_phrase) DESC, ranked.matched_phrase, ranked.phrase_rank
            LIMIT @candidate_limit
        )
        SELECT item.id,
               item.workspace_id,
               item.type,
               item.properties ->> 'title' AS title,
               item.parent_id,
               item.last_modified_at,
               ordered.matched_phrase
        FROM (
            SELECT candidates.id,
                   candidates.matched_phrase,
                   candidates.phrase_rank,
                   char_length(candidates.matched_phrase) AS phrase_length
            FROM candidates
            ORDER BY char_length(candidates.matched_phrase) DESC, candidates.matched_phrase, candidates.phrase_rank
        ) AS ordered
        JOIN item
          ON item.tenant_id = @tenant_id
         AND item.id = ordered.id
        WHERE NOT EXISTS (
              SELECT 1
              FROM item_closure AS visibility_edge
              LEFT JOIN LATERAL (
                  SELECT visibility_ancestor.template_id,
                         visibility_ancestor.lifecycle_state
                  FROM item AS visibility_ancestor
                  WHERE visibility_ancestor.tenant_id = @tenant_id
                    AND visibility_ancestor.id = visibility_edge.ancestor_id
                  LIMIT 1
              ) AS stored_ancestor ON TRUE
              WHERE visibility_edge.tenant_id = @tenant_id
                AND visibility_edge.descendant_id = item.id
                AND visibility_edge.depth > 0
                AND (stored_ancestor.template_id IS NOT NULL
                     OR stored_ancestor.lifecycle_state IS DISTINCT FROM 'active')
              OFFSET 0
          )
        ORDER BY ordered.phrase_length DESC, ordered.matched_phrase, ordered.phrase_rank
        LIMIT @limit
        """;
}
