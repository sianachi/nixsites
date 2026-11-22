using Nix.Domain.Items;

namespace Nix.Persistence.Sql.Statements;

/// <summary>
/// Reading a workspace as a graph: what may be drawn, and what may be joined to what.
/// </summary>
/// <remarks>
/// <para>
/// <b>The permission filter is a predicate in the statement, not a pass over the results.</b> The
/// readable workspaces are resolved through <c>IPermissionResolver</c> before the query runs and
/// are never sent by the client. This is the same rule <see cref="SearchSql"/> states, and it is
/// stricter here for a reason worth writing down: a graph read is bulk disclosure. Every other item
/// read in the product starts from an identifier the caller already holds and returns one row; this
/// one returns the title and the parent of everything at once. Filtering after the fact would mean
/// the ceiling had already been spent on rows the caller may not see, so a workspace they share a
/// corner of could come back empty while the rest of it filled the limit - and the mistake would
/// surface as a drawing, which nobody diffs.
/// </para>
/// <para>
/// <b>Two predicates, not one.</b> Every statement here carries both
/// <c>workspace_id = @workspace_id</c> (which workspace was asked for) and
/// <c>workspace_id = ANY(@workspace_ids)</c> (which ones may be answered). While visibility is per
/// workspace the second is implied by a membership test the handler has already made, and the
/// duplication looks redundant; it is not, because the handler's test is a fact about the request
/// and the predicate is a fact about the rows. When access control entries make visibility per
/// item, the predicate is the line that grows and the handler does not move.
/// </para>
/// <para>
/// Index dependencies: <c>IX_item_tenant_id_workspace_id</c> for the node set,
/// <c>PK_item_link</c> and <c>ix_item_link_target_occurrences</c> for the edges.
/// </para>
/// </remarks>
public static class GraphSql
{
    /// <summary>
    /// The readable nodes of one workspace and the reference edges between them, in one statement.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>One statement returning two row kinds, rather than two statements.</b> Nodes and links
    /// must describe the same instant. Read separately - even inside one transaction, which runs at
    /// read committed - the second statement could see an item the first did not, and the payload
    /// would carry an edge pointing at a node that is not in it. A client can only render that as a
    /// line into nothing. Discriminating on <c>row_kind</c> costs one integer column and removes
    /// the failure entirely.
    /// </para>
    /// <para>
    /// <b><c>visible</c> is referenced three times, which is what makes it correct.</b> Postgres
    /// inlines a CTE referenced once and materialises one referenced more than once, so the node
    /// set is computed exactly once and both the node arm and the edge arm are joined against that
    /// same set. Two copies of the same <c>SELECT ... LIMIT</c> would be two evaluations, and two
    /// evaluations of a limited, ordered set are only equal by luck.
    /// </para>
    /// <para>
    /// <b>The parent is self-joined rather than projected.</b> <c>item.parent_id</c> may name an
    /// item that is real, readable, and absent from this reading because the node ceiling was
    /// reached - and a parent identifier the payload cannot resolve is the same dangling reference
    /// the single-statement shape exists to prevent. The left join returns the parent only when it
    /// is itself a node, so a truncated graph is a smaller graph rather than a broken one.
    /// </para>
    /// <para>
    /// <b>An edge needs both ends.</b> <c>item_link</c> joins the target to <c>visible</c> and checks
    /// source membership, so a
    /// reference to an item outside this workspace, outside the caller's entitlement, or outside
    /// the ceiling produces no row at all. It is not returned with the far end blanked: that would
    /// disclose that something is there, which for a graph is most of what there is to disclose.
    /// </para>
    /// <para>
    /// <b>A locked item, and anything under one, draws no outgoing edges.</b> Its edges were
    /// extracted from its body, and drawing them would say what the locked body refers to. Edges
    /// <i>into</i> it come from other bodies and stay. Not relaxed for a credential that holds the
    /// lock open, like every body-derived answer.
    /// </para>
    /// <para>
    /// <b>Nothing under a lock this credential has not opened is drawn at all</b> (ADR-0056). A
    /// node carries its title and its parent, so drawing the contents of a closed folder would list
    /// them - the listing the children read refuses. The hidden set
    /// (<see cref="ItemLockSql.ClosedLockDescendants"/>) is read once and anti-joined before the
    /// node ceiling, so hidden nodes never spend it, and an edge into a hidden node goes with it
    /// because an edge needs both ends. The locked item itself is still drawn.
    /// </para>
    /// <para>
    /// <b>A node under a lock reports no modification time.</b> <c>last_modified_at</c> is a
    /// record of activity on the item, so for a locked item it says that somebody is working
    /// behind the lock and when. It is nulled for the same set that draws no outgoing edges
    /// (<c>body_locked_nodes</c>), and for the same reason. The creation time stays: that the item
    /// exists is already what drawing it says.
    /// </para>
    /// <para>
    /// <b>The ancestor probe runs lazily, in node order.</b> The candidates are sorted by
    /// <c>seq</c> behind an <c>OFFSET 0</c> fence, and the per-row deleted-or-template-ancestor
    /// probe runs on them in that order until the node ceiling is met, rather than on every item in
    /// the workspace before the sort. A fenced lateral eligibility check preserves the lazy probe
    /// and avoids estimating half the candidates as rejected. Source membership avoids duplicate
    /// join estimates for the unique node identifiers in the materialised set. Body lock descendants
    /// are materialised once, including closed ids from the second
    /// preload so a lock added between preloads still withholds its own outgoing edges.
    /// Measured as the runtime role with RLS on a throwaway database (150,000 items, 30 closed
    /// locks, ceilings 2,001 and 4,001): 35,117 shared buffers, 76 ms warm, no JIT. The candidate sort still scans the workspace and spills about 10 MB;
    /// the ceiling bounds ancestor probes and output, not that initial sort.
    /// </para>
    /// <para>
    /// Imported calendar events are omitted before the node ceiling. Their reserved source key
    /// records import origin; calendar-managed containers and Nix-authored events pushed to a
    /// provider stay visible. Edges touching an omitted event leave with it.
    /// </para>
    /// <para>
    /// The ordering is stable so the same workspace draws the same way twice, and so the ceiling
    /// cuts the same items each time rather than a different subset per request. Nodes enter by
    /// <c>seq</c>, the workspace's own sibling order, so what survives a truncated read is the top
    /// of the tree rather than an arbitrary sample of it.
    /// </para>
    /// </remarks>
    public static readonly string WorkspaceGraph = $$"""
        WITH {{ItemLockSql.ClosedLockDescendants}},
        body_locked_nodes AS MATERIALIZED (
            SELECT lock_edge.descendant_id
            FROM item_closure AS lock_edge
            WHERE lock_edge.tenant_id = @tenant_id
              AND lock_edge.ancestor_id = ANY(@lock_ids || @closed_lock_ids)
        ),
        visible AS (
            SELECT item.id AS id,
                   item.parent_id AS parent_id,
                   item.type AS type,
                   item.title AS title,
                   item.created_at AS created_at,
                   item.last_modified_at AS last_modified_at
            FROM (
                SELECT item.id,
                       item.parent_id,
                       item.type,
                       item.properties ->> 'title' AS title,
                       item.created_at,
                       item.last_modified_at,
                       item.seq
                FROM item
                WHERE item.tenant_id = @tenant_id
                  AND item.workspace_id = @workspace_id
                  AND item.workspace_id = ANY(@workspace_ids)
                  AND item.lifecycle_state = 'active'
                  AND item.template_id IS NULL
                  AND item.properties ->> '{{ItemProperties.CalendarSourceKey}}' IS NULL
                  AND NOT EXISTS (
                      SELECT 1
                      FROM closed_lock_descendants AS hidden
                      WHERE hidden.descendant_id = item.id
                  )
                ORDER BY item.seq, item.id
                OFFSET 0
            ) AS item
            CROSS JOIN LATERAL (
                SELECT 1
                WHERE {{ItemVisibilitySql.NoHiddenStoredAncestor("item.id")}}
                OFFSET 0
            ) AS allowed
            ORDER BY item.seq, item.id
            LIMIT @node_limit
        ),
        edge AS (
            SELECT link.source_item_id AS source_id,
                   link.target_item_id AS target_id,
                   link.occurrences AS occurrences
            FROM item_link AS link
            JOIN visible AS target ON target.id = link.target_item_id
            WHERE link.tenant_id = @tenant_id
              AND link.source_item_id IN (SELECT source.id FROM visible AS source)
              AND NOT EXISTS (
                  SELECT 1
                  FROM body_locked_nodes AS locked
                  WHERE locked.descendant_id = link.source_item_id
              )
            ORDER BY link.source_item_id, link.target_item_id
            LIMIT @link_limit
        )
        SELECT 0 AS row_kind,
               node.id AS left_id,
               parent.id AS right_id,
               node.type AS type,
               node.title AS title,
               node.created_at AS created_at,
               CASE
                   WHEN EXISTS (
                       SELECT 1
                       FROM body_locked_nodes AS locked
                       WHERE locked.descendant_id = node.id
                   ) THEN NULL
                   ELSE node.last_modified_at
               END AS last_modified_at,
               NULL::integer AS occurrences
        FROM visible AS node
        LEFT JOIN visible AS parent
          ON parent.id = node.parent_id
        UNION ALL
        SELECT 1 AS row_kind,
               edge.source_id AS left_id,
               edge.target_id AS right_id,
               NULL::text AS type,
               NULL::text AS title,
               NULL::timestamptz AS created_at,
               NULL::timestamptz AS last_modified_at,
               edge.occurrences AS occurrences
        FROM edge
        ORDER BY row_kind, left_id, right_id
        """;
}
