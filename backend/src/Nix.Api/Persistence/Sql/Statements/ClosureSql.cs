namespace Nix.Persistence.Sql.Statements;

/// <summary>
/// Maintenance of <c>item_closure</c>: the derived table that turns "every ancestor of this item"
/// and "every descendant of this folder" into index range scans instead of recursive walks.
/// </summary>
/// <remarks>
/// <para>
/// Hand-written rather than LINQ, per the data-access rule. These are the statements permission
/// resolution stands on, they are read on every authorization decision, and their plans have to be
/// legible - which they stop being the moment an expression tree is between the author and the
/// query.
/// </para>
/// <para>
/// <b>The invariant every statement here preserves:</b> <c>item_closure</c> contains exactly one
/// row per (ancestor, descendant) pair for which the descendant is reachable from the ancestor by
/// following <c>parent_id</c>, including each item's zero-depth edge to itself. The tree goal's
/// property test asserts precisely that, by recomputing the whole table from <c>parent_id</c>
/// after random sequences of moves and comparing. Nothing here is a source of truth; the parent
/// pointer is.
/// </para>
/// <para>
/// Every statement is tenant-parameterised even though row-level security would filter anyway.
/// That is defence in depth as the security model requires, and it is also what lets the planner
/// hoist the policy predicate into an index condition instead of evaluating it per row - measured
/// at roughly 54ns a row when it lands in filter position.
/// </para>
/// </remarks>
public static class ClosureSql
{
    /// <summary>
    /// Adds a newly created item's edges: its self-edge, and one edge to each of its parent's
    /// ancestors.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A new item is always a leaf, so it has no descendants and this is the whole of its closure.
    /// The self-edge at depth zero is not an implementation detail to be optimised away - it is
    /// what makes "the ancestors of X" and "X plus its ancestors" the same query, which is what
    /// permission resolution actually asks.
    /// </para>
    /// <para>
    /// Index dependency: <c>IX_item_closure_tenant_id_ancestor_id_depth</c> is not used here;
    /// the <c>PK_item_closure</c> prefix on <c>descendant_id</c> serves the ancestor lookup for
    /// the parent. Writes touch the primary key and both secondary indexes.
    /// </para>
    /// </remarks>
    public const string InsertForNewItem = """
        INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
        SELECT @item_id, @item_id, @tenant_id, @workspace_id, 0
        UNION ALL
        SELECT @item_id, parent_closure.ancestor_id, @tenant_id, @workspace_id, parent_closure.depth + 1
        FROM item_closure AS parent_closure
        WHERE parent_closure.descendant_id = @parent_id
          AND parent_closure.tenant_id = @tenant_id
        """;

    /// <summary>
    /// Answers whether making <c>@parent_id</c> the parent of <c>@item_id</c> would create a
    /// cycle.
    /// </summary>
    /// <remarks>
    /// <para>
    /// It would exactly when the proposed parent is already inside the moving item's own subtree -
    /// including the item itself, which the zero-depth self-edge covers without a special case.
    /// Drag a folder onto its own child and this is the query that says no.
    /// </para>
    /// <para>
    /// Asked before any modification and inside the same transaction, so a concurrent move cannot
    /// slip between the check and the write and leave the tree with a detached ring - a state from
    /// which the closure cannot be rebuilt, because a ring has no root to rebuild from.
    /// </para>
    /// <para>
    /// Index dependency: <c>IX_item_closure_tenant_id_ancestor_id_depth</c>, leading columns only.
    /// </para>
    /// </remarks>
    public const string WouldCreateCycle = """
        SELECT EXISTS (
            SELECT 1
            FROM item_closure
            WHERE tenant_id = @tenant_id
              AND ancestor_id = @item_id
              AND descendant_id = @parent_id
        )
        """;

    /// <summary>
    /// Removes every edge joining the moving subtree to its old ancestors, leaving the subtree's
    /// internal edges intact.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The first half of a move. "Internal" is the whole subtlety: an edge is cut when its
    /// descendant is inside the subtree and its ancestor is not. Cutting by depth, or cutting
    /// everything touching the subtree, would destroy the relationships between the moving items
    /// themselves - which do not change when the subtree moves, and which would then have to be
    /// rebuilt.
    /// </para>
    /// <para>
    /// Index dependency: <c>IX_item_closure_tenant_id_ancestor_id_depth</c> for both subqueries;
    /// the delete itself walks <c>PK_item_closure</c>.
    /// </para>
    /// </remarks>
    public const string DetachSubtree = """
        DELETE FROM item_closure
        WHERE tenant_id = @tenant_id
          AND descendant_id IN (
              SELECT descendant_id
              FROM item_closure
              WHERE tenant_id = @tenant_id AND ancestor_id = @item_id
          )
          AND ancestor_id NOT IN (
              SELECT descendant_id
              FROM item_closure
              WHERE tenant_id = @tenant_id AND ancestor_id = @item_id
          )
        """;

    /// <summary>
    /// Joins every member of the moving subtree to every ancestor of its new parent.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The second half of a move, and the reason a closure table is worth maintaining: the new
    /// depths are arithmetic rather than a walk. An item at depth <c>d</c> below the subtree root
    /// sits at <c>a + d + 1</c> below an ancestor that is <c>a</c> above the new parent, and the
    /// cross join computes every such pair in one statement.
    /// </para>
    /// <para>
    /// Run after <see cref="DetachSubtree"/> and never before: the two together are one atomic
    /// edit of the tree, and between them the subtree is a root, which is a state no reader may
    /// observe. Both run inside the caller's transaction.
    /// </para>
    /// <para>
    /// Index dependency: <c>IX_item_closure_tenant_id_ancestor_id_depth</c> for the subtree side,
    /// <c>PK_item_closure</c> for the ancestor side.
    /// </para>
    /// </remarks>
    public const string AttachSubtree = """
        INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
        SELECT subtree.descendant_id,
               destination.ancestor_id,
               @tenant_id,
               @workspace_id,
               destination.depth + subtree.depth + 1
        FROM item_closure AS destination
        CROSS JOIN item_closure AS subtree
        WHERE destination.descendant_id = @parent_id
          AND destination.tenant_id = @tenant_id
          AND subtree.ancestor_id = @item_id
          AND subtree.tenant_id = @tenant_id
        """;

    /// <summary>
    /// Reads every edge in a workspace, for the property test that rebuilds the table from
    /// <c>parent_id</c> and compares.
    /// </summary>
    /// <remarks>
    /// Exists for the assertion rather than for the application: the claim that this table is
    /// derived data is only worth making if something checks it, and the only honest check is a
    /// full comparison against a from-scratch recomputation.
    /// </remarks>
    public const string SelectAllEdgesInWorkspace = """
        SELECT descendant_id, ancestor_id, depth
        FROM item_closure
        WHERE tenant_id = @tenant_id AND workspace_id = @workspace_id
        ORDER BY descendant_id, ancestor_id
        """;

    /// <summary>
    /// Allocates the next sibling position under a parent.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Sparse by design: positions advance by a gap rather than by one, so an item can later be
    /// inserted between two siblings by choosing a number in between instead of renumbering the
    /// whole set. The gap is large enough that ordinary use never exhausts it, and a renumber is
    /// the documented fallback for when it does.
    /// </para>
    /// <para>
    /// <c>coalesce</c> covers the first child, where the aggregate returns NULL rather than no
    /// row. Index dependency: <c>IX_item_workspace_id_parent_id_seq</c>, whose trailing <c>seq</c>
    /// makes this a backwards index scan of one row rather than an aggregate over the siblings.
    /// </para>
    /// </remarks>
    public const string NextSiblingSequence = """
        SELECT coalesce(max(seq), 0) + 1000
        FROM item
        WHERE tenant_id = @tenant_id
          AND workspace_id = @workspace_id
          AND parent_id IS NOT DISTINCT FROM @parent_id
          AND template_id IS NULL
          AND lifecycle_state = 'active'
        """;

    /// <summary>
    /// Finds the midpoint between a named sibling and whichever sibling follows it, for a move
    /// that asked to be placed immediately after a particular item.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Returns NULL when there is no room - when the two neighbours are adjacent integers - which
    /// is the signal to renumber and retry rather than to silently place the item somewhere the
    /// user did not ask for. A drag that lands in the wrong position is worse than one that costs
    /// an extra statement.
    /// </para>
    /// <para>
    /// When the named sibling is last, the midpoint is simply a gap past it. The moving item is
    /// excluded from the neighbour search: it may already be among these siblings, and it must not
    /// be treated as its own successor.
    /// </para>
    /// <para>
    /// Index dependency: <c>IX_item_workspace_id_parent_id_seq</c>, used for both the anchor
    /// lookup and the successor scan.
    /// </para>
    /// </remarks>
    public const string SequenceSlotAfter = """
        WITH anchor AS (
            SELECT seq
            FROM item
            WHERE tenant_id = @tenant_id
              AND id = @after_id
              AND template_id IS NULL
              AND lifecycle_state = 'active'
        ),
        successor AS (
            SELECT min(sibling.seq) AS seq
            FROM item AS sibling, anchor
            WHERE sibling.tenant_id = @tenant_id
              AND sibling.workspace_id = @workspace_id
              AND sibling.parent_id IS NOT DISTINCT FROM @parent_id
              AND sibling.id <> @item_id
              AND sibling.seq > anchor.seq
              AND sibling.template_id IS NULL
              AND sibling.lifecycle_state = 'active'
        )
        SELECT CASE
                   WHEN successor.seq IS NULL THEN anchor.seq + 1000
                   WHEN successor.seq - anchor.seq > 1 THEN anchor.seq + (successor.seq - anchor.seq) / 2
                   ELSE NULL
               END
        FROM anchor, successor
        """;

    /// <summary>
    /// Finds a position ahead of every current sibling, for a move that asked to be placed first.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The mirror of <see cref="SequenceSlotAfter"/> for the one placement it cannot express:
    /// "before everything" has no anchor to be after. Halving the current minimum keeps positions
    /// positive, which is what lets the renumber fallback and the append path share a numbering
    /// scheme.
    /// </para>
    /// <para>
    /// Returns NULL when the first sibling already sits at 1 and there is no room below it -
    /// the same signal to renumber and retry - and the first gap when there are no siblings at all.
    /// The moving item is excluded: it may already be among these siblings, and asking to be placed
    /// before itself must not resolve to its own position.
    /// </para>
    /// <para>
    /// Index dependency: <c>IX_item_workspace_id_parent_id_seq</c>, which supplies the minimum
    /// without a scan.
    /// </para>
    /// </remarks>
    public const string SequenceSlotFirst = """
        SELECT CASE
                   WHEN min(sibling.seq) IS NULL THEN 1000
                   WHEN min(sibling.seq) > 1 THEN min(sibling.seq) / 2
                   ELSE NULL
               END
        FROM item AS sibling
        WHERE sibling.tenant_id = @tenant_id
          AND sibling.workspace_id = @workspace_id
          AND sibling.parent_id IS NOT DISTINCT FROM @parent_id
          AND sibling.id <> @item_id
          AND sibling.template_id IS NULL
          AND sibling.lifecycle_state = 'active'
        """;

    /// <summary>
    /// Rewrites every sibling's position with even gaps, preserving their current order.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The fallback for when sparse positions run out of room between two neighbours. Rare by
    /// construction - the gap is a thousand and ordinary use never closes it - but it has to exist,
    /// because the alternative is an insertion the schema cannot express.
    /// </para>
    /// <para>
    /// Order is preserved by ranking on the existing <c>seq</c>, so a renumber is invisible to
    /// anyone reading the list. It touches only one parent's children.
    /// </para>
    /// <para>
    /// Index dependency: <c>IX_item_workspace_id_parent_id_seq</c> supplies the rows already
    /// ordered, so the window function needs no sort.
    /// </para>
    /// </remarks>
    public const string RenumberSiblings = """
        UPDATE item
        SET seq = renumbered.position * 1000
        FROM (
            SELECT id, row_number() OVER (ORDER BY seq, id) AS position
            FROM item
            WHERE tenant_id = @tenant_id
              AND workspace_id = @workspace_id
              AND parent_id IS NOT DISTINCT FROM @parent_id
              AND template_id IS NULL
              AND lifecycle_state = 'active'
        ) AS renumbered
        WHERE item.id = renumbered.id
          AND item.tenant_id = @tenant_id
          AND item.template_id IS NULL
          AND item.lifecycle_state = 'active'
        """;

    /// <summary>
    /// <see cref="DetachSubtree"/> for every child of <c>@item_id</c> at once.
    /// </summary>
    /// <remarks>
    /// The edges to cut are those from a moved subtree to the parent's own ancestors (the parent
    /// included), which is every ancestor outside the subtrees; naming them through the parent's
    /// closure rows keeps the match to a handful of ancestors instead of the moved set.
    /// </remarks>
    public const string DetachChildren = """
        DELETE FROM item_closure
        WHERE tenant_id = @tenant_id
          AND descendant_id IN (
              SELECT descendant_id
              FROM item_closure
              WHERE tenant_id = @tenant_id
                AND ancestor_id IN (
                    SELECT id FROM item
                    WHERE tenant_id = @tenant_id AND workspace_id = @workspace_id AND parent_id = @item_id)
          )
          AND ancestor_id IN (
              SELECT ancestor_id
              FROM item_closure
              WHERE tenant_id = @tenant_id AND descendant_id = @item_id
          )
        """;

    /// <summary>
    /// <see cref="AttachSubtree"/> for every child of <c>@item_id</c> at once, under
    /// <c>@parent_id</c>. Runs while the children still name <c>@item_id</c> as their parent.
    /// </summary>
    public const string AttachChildren = """
        INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
        SELECT subtree.descendant_id,
               destination.ancestor_id,
               @tenant_id,
               @workspace_id,
               destination.depth + subtree.depth + 1
        FROM item_closure AS destination
        CROSS JOIN item_closure AS subtree
        WHERE destination.descendant_id = @parent_id
          AND destination.tenant_id = @tenant_id
          AND subtree.tenant_id = @tenant_id
          AND subtree.ancestor_id IN (
              SELECT id FROM item
              WHERE tenant_id = @tenant_id AND workspace_id = @workspace_id AND parent_id = @item_id)
        """;

    /// <summary>
    /// Moves every child of <c>@item_id</c> to <c>@parent_id</c> (NULL for the root) in order of
    /// position, giving each the next sibling position the way one
    /// <see cref="NextSiblingSequence"/> call per child would.
    /// </summary>
    /// <remarks>
    /// Only active, non-template children count towards the running maximum, as in
    /// <see cref="NextSiblingSequence"/>; a trashed child therefore takes the position the next
    /// active one then shares, exactly as the one-at-a-time allocation did.
    /// </remarks>
    public const string ReparentChildren = """
        UPDATE item
        SET parent_id = @parent_id,
            seq = moved.seq,
            last_modified_by = @actor,
            last_modified_at = @at
        FROM (
            SELECT child.id,
                   (SELECT coalesce(max(sibling.seq), 0)
                    FROM item AS sibling
                    WHERE sibling.tenant_id = @tenant_id
                      AND sibling.workspace_id = @workspace_id
                      AND sibling.parent_id IS NOT DISTINCT FROM @parent_id
                      AND sibling.template_id IS NULL
                      AND sibling.lifecycle_state = 'active')
                   + 1000 * (1 + count(*) FILTER (WHERE child.template_id IS NULL AND child.lifecycle_state = 'active')
                                 OVER (ORDER BY child.seq, child.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)) AS seq
            FROM item AS child
            WHERE child.tenant_id = @tenant_id
              AND child.workspace_id = @workspace_id
              AND child.parent_id = @item_id
        ) AS moved
        WHERE item.id = moved.id
          AND item.tenant_id = @tenant_id
        """;
}
