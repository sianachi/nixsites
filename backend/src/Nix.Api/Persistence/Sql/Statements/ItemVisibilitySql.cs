namespace Nix.Persistence.Sql.Statements;

/// <summary>
/// Point visibility for an ordinary item, including the lifecycle of its whole ancestor path.
/// </summary>
/// <remarks>
/// <para>
/// This is hand-written because the visibility predicate is a closure-table read. The equivalent
/// LINQ anti-join let Postgres start from every non-active candidate in the tenant, making an item
/// open and each collaboration authorization handshake grow with workspace size. The materialized
/// descendant range and lateral point probe keep the work proportional to path depth instead.
/// </para>
/// <para>
/// The proper-ancestor probe is a left lateral join so a missing stored ancestor fails closed.
/// Its logically redundant <c>LIMIT 1</c> is load-bearing: the alternate key already guarantees
/// at most one row, while the limit prevents the RLS-aware planner from flattening the probe and
/// returning to a tenant-wide lifecycle scan.
/// </para>
/// <para>
/// Index dependencies: <c>AK_item_tenant_id_id</c> for the subject and each ancestor, plus
/// <c>IX_item_closure_tenant_id_descendant_id</c> (or the closure primary key) for the path. The
/// production command and its parameters are captured and explained by
/// <c>ItemVisibilityPlanEvidenceTests</c> under the runtime role and RLS.
/// </para>
/// </remarks>
public static class ItemVisibilitySql
{
    /// <summary>Reads one active ordinary item only when every stored ancestor is active.</summary>
    public const string FindVisible = """
        WITH path AS MATERIALIZED (
            SELECT edge.ancestor_id
            FROM item_closure AS edge
            WHERE edge.tenant_id = @tenant_id
              AND edge.descendant_id = @item_id
              AND edge.depth > 0
        )
        SELECT subject.*
        FROM item AS subject
        WHERE subject.tenant_id = @tenant_id
          AND subject.id = @item_id
          AND subject.template_id IS NULL
          AND subject.lifecycle_state = 'active'
          AND NOT EXISTS (
              SELECT 1
              FROM path
              LEFT JOIN LATERAL (
                  SELECT ancestor.template_id, ancestor.lifecycle_state
                  FROM item AS ancestor
                  WHERE ancestor.tenant_id = @tenant_id
                    AND ancestor.id = path.ancestor_id
                  LIMIT 1
              ) AS stored_ancestor ON TRUE
              WHERE stored_ancestor.template_id IS NOT NULL
                 OR stored_ancestor.lifecycle_state IS DISTINCT FROM 'active'
          )
        """;

    /// <summary>
    /// A predicate over <c>item</c>: no proper ancestor is a template or inactive. The bulk reads
    /// (the workspace query) share it; binds <c>@tenant_id</c>.
    /// </summary>
    /// <remarks>
    /// A plain correlated anti-join the planner can turn into one hashed pass over the closure for
    /// a workspace-wide read (measured on 60k items: a grouped sum fell from 883k to 16k buffers)
    /// while a narrow read keeps its per-row index probe. An inner join is safe because an edge
    /// whose ancestor row is missing cannot exist: the closure foreign key cascades the edge away
    /// with its ancestor.
    /// </remarks>
    public const string NoHiddenAncestor = """
        NOT EXISTS (
            SELECT 1
            FROM item_closure AS visibility_edge
            JOIN item AS visibility_ancestor
              ON visibility_ancestor.tenant_id = @tenant_id
             AND visibility_ancestor.id = visibility_edge.ancestor_id
            WHERE visibility_edge.tenant_id = @tenant_id
              AND visibility_edge.descendant_id = item.id
              AND visibility_edge.depth > 0
              AND (visibility_ancestor.template_id IS NOT NULL
                   OR visibility_ancestor.lifecycle_state <> 'active')
        )
        """;
}
