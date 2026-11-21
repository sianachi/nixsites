namespace Nix.Persistence.Sql.Statements;

/// <summary>
/// Reading and writing one principal's shelf.
/// </summary>
/// <remarks>
/// <para>
/// <b>The acting principal is a parameter taken from the session, never from a client.</b> Every
/// statement here is scoped to one principal and one tenant, and both come from the session context
/// the unit of work was opened with. A principal identifier that arrived in a request body would be
/// an authorization decision made by whoever sent it.
/// </para>
/// <para>
/// <b>The permission filter on the list is a predicate, not a pass over the results.</b> A bookmark
/// outlives access to what it points at - being removed from a workspace does not delete rows -
/// so the list is filtered by what the caller may read today, while it is being read. Filtering
/// afterwards would mean the titles had already been fetched, and on a shelf the title is the
/// disclosure.
/// </para>
/// <para>
/// Index dependencies: <c>IX_bookmark_tenant_id_principal_id_seq</c> for the list, <c>PK_bookmark</c>
/// for both writes.
/// </para>
/// </remarks>
public static class BookmarkSql
{
    /// <summary>
    /// What one principal has kept, most recently kept first, filtered to what they may still read.
    /// </summary>
    /// <remarks>
    /// <para>
    /// An inner join to <c>item</c>, which does three jobs at once and is worth naming. It supplies
    /// the title and body kind, so nothing is stored twice and a rename shows on the shelf
    /// immediately. It drops a bookmark whose item is soft-deleted, so a trashed note is not a dead
    /// row on somebody's shelf. And it is where the workspace predicate lands, because the workspace
    /// is a fact about the item rather than about the bookmark.
    /// </para>
    /// <para>
    /// Ordered by <c>seq</c> descending: the sequence is assigned by the database on insert, so
    /// highest-first is most-recently-kept-first today and stays correct if a reorder ever writes
    /// the column directly.
    /// </para>
    /// </remarks>
    public static readonly string ListShelf = $"""
        SELECT item.id AS item_id,
               item.properties ->> 'title' AS title,
               item.type AS type,
               item.workspace_id AS workspace_id,
               bookmark.created_at AS created_at
        FROM bookmark
        JOIN item ON item.id = bookmark.item_id
                 AND item.tenant_id = bookmark.tenant_id
        WHERE bookmark.tenant_id = @tenant_id
          AND bookmark.principal_id = @principal_id
          AND item.lifecycle_state = 'active'
          AND item.template_id IS NULL
          AND item.workspace_id = ANY(@workspace_ids)
          AND {ItemVisibilitySql.NoHiddenStoredAncestor("item.id")}
        ORDER BY bookmark.seq DESC
        """;

    /// <summary>
    /// How many rows are on the shelf at all, before anything is filtered out of the list.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Subtracting the list's length from this is what lets the response say the shelf is larger
    /// than what came back. It counts rows rather than resolving why each is missing, deliberately:
    /// the two reasons - the item was trashed, or the caller can no longer read it - are both
    /// "on your shelf and not shown", and telling them apart per row would disclose which documents
    /// somebody has been removed from.
    /// </para>
    /// <para>
    /// No join, so it stays an index-only count on
    /// <c>IX_bookmark_tenant_id_principal_id_seq</c>.
    /// </para>
    /// </remarks>
    public const string CountShelf = """
        SELECT count(*)
        FROM bookmark
        WHERE tenant_id = @tenant_id
          AND principal_id = @principal_id
        """;

    /// <summary>
    /// Puts an item on the shelf, doing nothing if it is already there.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>ON CONFLICT DO NOTHING</c> rather than a read-then-write. Two tabs keeping the same item
    /// at the same moment is an ordinary race, and the honest resolution is one row and no error -
    /// a check followed by an insert would be the same race with a wider window and a duplicate-key
    /// exception at the end of it.
    /// </para>
    /// <para>
    /// <b>The item is joined rather than trusted.</b> The insert selects from <c>item</c> with the
    /// caller's readable workspaces as a predicate, so keeping something is possible only for
    /// something they can see. Passing the identifier straight into a <c>VALUES</c> clause would let
    /// anybody put any identifier on their own shelf and then learn its title from the list read -
    /// which turns a shelf into an oracle for whether an item exists.
    /// </para>
    /// <para>
    /// <c>seq</c> is left to its identity default, so the database assigns the position.
    /// </para>
    /// </remarks>
    public static readonly string Keep = $"""
        INSERT INTO bookmark (principal_id, tenant_id, item_id, created_at)
        SELECT @principal_id, @tenant_id, item.id, now()
        FROM item
        WHERE item.id = @item_id
          AND item.tenant_id = @tenant_id
          AND item.lifecycle_state = 'active'
          AND item.template_id IS NULL
          AND item.workspace_id = ANY(@workspace_ids)
          AND {ItemVisibilitySql.NoHiddenStoredAncestor("item.id")}
        ON CONFLICT (principal_id, item_id) DO NOTHING
        """;

    /// <summary>
    /// Takes an item off the shelf.
    /// </summary>
    /// <remarks>
    /// No workspace predicate, deliberately, and it is the one statement here without one. Somebody
    /// who has lost access to an item must still be able to clear it off their own shelf - a row
    /// they can neither see nor remove would be permanent clutter, and refusing the delete would
    /// disclose that the row is there anyway.
    /// </remarks>
    public const string Release = """
        DELETE FROM bookmark
        WHERE tenant_id = @tenant_id
          AND principal_id = @principal_id
          AND item_id = @item_id
        """;
}
