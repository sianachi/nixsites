namespace Nix.Persistence.Sql.Statements;

/// <summary>Current authorization and locks are evaluated in each bounded page, before its limit.</summary>
public static class WorkspaceSyncSql
{
    /// <summary>Publishes a completed native replay mutation before reading its canonical revision.</summary>
    public const string FlushPending = "SET CONSTRAINTS native_sync_flush IMMEDIATE; SET CONSTRAINTS native_sync_flush DEFERRED;";

    // A tenant administrator reads a workspace only as a member, like everyone else. Role interpretation stays in WorkspaceRoles; the parameters contain only this build's known readable/writable roles.
    private const string Admission = $$"""
        grants AS MATERIALIZED ({{AuthorizationSql.WorkspacesReadableByPrincipal}}),
        allowed_workspace AS MATERIALIZED (
            SELECT workspace.workspace_id,
                   @may_write AND EXISTS (SELECT 1 FROM grants WHERE grants.workspace_id = workspace.workspace_id
                                AND grants.role = ANY(@write_roles)) AS can_write
            FROM workspace
            WHERE workspace.tenant_id = @tenant_id
              AND workspace.workspace_id = @workspace_id
              AND workspace.lifecycle_state = 'active'
              AND EXISTS (SELECT 1 FROM grants WHERE grants.workspace_id = workspace.workspace_id
                          AND grants.role = ANY(@read_roles))
        )
        """;

    /// <summary>Reads the committed boundary only for a currently authorized workspace.</summary>
    public const string Boundary = $$"""
        WITH {{Admission}}
        SELECT COALESCE(revision.seq, 0),
               greatest(COALESCE(revision.retained_floor, 0), COALESCE((
                   SELECT max(change.seq) FROM workspace_sync_change AS change
                   WHERE change.tenant_id = @tenant_id AND change.workspace_id = @workspace_id
                     AND change.created_at < @now - interval '30 days'), 0)),
               EXISTS (SELECT 1 FROM workspace_sync_change AS change
                   WHERE change.tenant_id = @tenant_id AND change.workspace_id = @workspace_id
                     AND change.seq > @after AND change.seq <= COALESCE(revision.seq, 0)
                     AND change.item_id IS NULL)
        FROM allowed_workspace
        LEFT JOIN workspace_sync_revision AS revision
            ON revision.tenant_id = @tenant_id AND revision.workspace_id = allowed_workspace.workspace_id
        """;

    // UUID paging can use the tenant/item key or dedicated workspace index; closure probes use the descendant-leading primary key.
    private const string Eligible = """
        JOIN allowed_workspace ON allowed_workspace.workspace_id = item.workspace_id
        LEFT JOIN workspace_sync_item_revision AS item_revision
          ON item_revision.tenant_id = item.tenant_id AND item_revision.workspace_id = item.workspace_id
         AND item_revision.item_id = item.id
        CROSS JOIN LATERAL (
            SELECT count(*) > 0 AS locked,
                   COALESCE(bool_or(edge.depth > 0 AND unlocked.expires_at IS NULL), false) AS hidden,
                   min(unlocked.expires_at) FILTER (WHERE edge.depth > 0) AS metadata_expires_at
            FROM item_closure AS edge
            JOIN item_lock AS locked
              ON locked.tenant_id = edge.tenant_id AND locked.item_id = edge.ancestor_id
            LEFT JOIN item_unlock AS unlocked
              ON unlocked.tenant_id = locked.tenant_id AND unlocked.item_id = locked.item_id
             AND unlocked.credential_id = @credential_id AND unlocked.expires_at > @now
            WHERE edge.tenant_id = @tenant_id AND edge.descendant_id = item.id
        ) AS lock_state
        LEFT JOIN content_doc AS body
          ON body.tenant_id = item.tenant_id AND body.item_id = item.id AND NOT lock_state.locked
        LEFT JOIN file_body AS file_body
          ON file_body.tenant_id = item.tenant_id AND file_body.item_id = item.id AND NOT lock_state.locked
        LEFT JOIN file_version AS file
          ON file.tenant_id = file_body.tenant_id AND file.item_id = file_body.item_id
         AND file.file_version_id = file_body.current_version_id AND file.object_ready
        """;

    private const string Visible = """
        item.tenant_id = @tenant_id AND item.workspace_id = @workspace_id
        AND item.template_id IS NULL AND item.lifecycle_state = 'active' AND NOT lock_state.hidden
        AND NOT EXISTS (
            SELECT 1 FROM item_closure AS edge
            LEFT JOIN LATERAL (
                SELECT ancestor.template_id, ancestor.lifecycle_state
                FROM item AS ancestor
                WHERE ancestor.tenant_id = @tenant_id AND ancestor.id = edge.ancestor_id LIMIT 1
            ) AS ancestor ON TRUE
            WHERE edge.tenant_id = @tenant_id AND edge.descendant_id = item.id AND edge.depth > 0
              AND (ancestor.template_id IS NOT NULL OR ancestor.lifecycle_state IS DISTINCT FROM 'active')
            OFFSET 0
        )
        """;

    private const string Projection = """
        item.id, item.workspace_id, COALESCE(item_revision.seq, 0), item.parent_id, item.type,
        COALESCE(item.properties ->> 'title', ''), item.seq, item.lifecycle_state,
        COALESCE(item.properties::text, '{}'),
        CASE WHEN lock_state.locked THEN NULL ELSE item.schema::text END,
        CASE WHEN lock_state.locked THEN NULL ELSE item.views::text END,
        CASE WHEN lock_state.locked THEN NULL ELSE item.recurrence::text END,
        item.no_delete, item.no_children, item.managed_by, item.created_at,
        CASE WHEN lock_state.locked THEN NULL ELSE item.last_modified_at END,
        allowed_workspace.can_write, lock_state.locked, lock_state.metadata_expires_at,
        body.doc_id, body.head_seq,
        file.file_version_id, file.file_name, file.media_type, file.byte_length, file.sha256
        """;

    /// <summary>Lists every currently visible durable item, independently of marker history.</summary>
    public const string Snapshot = $$"""
        WITH {{Admission}}
        SELECT 0::bigint, {{Projection}}
        FROM item
        {{Eligible}}
        WHERE {{Visible}} AND (@cursor IS NULL OR item.id > @cursor)
        ORDER BY item.id LIMIT @limit
        """;

    /// <summary>Filters inaccessible markers before limits, returning only current metadata.</summary>
    public const string Changes = $$"""
        WITH {{Admission}}
        SELECT change.seq, {{Projection}}
        FROM workspace_sync_change AS change
        JOIN item ON item.tenant_id = change.tenant_id AND item.id = change.item_id
        {{Eligible}}
        WHERE change.tenant_id = @tenant_id AND change.workspace_id = @workspace_id
          AND change.seq > @after AND change.seq <= @boundary AND {{Visible}}
          AND (change.metadata_revision OR NOT lock_state.locked)
        ORDER BY change.seq LIMIT @limit
        """;

    /// <summary>Returns only supplied IDs still visible in the requested workspace.</summary>
    public const string Reconcile = $$"""
        WITH {{Admission}}
        SELECT 0::bigint, {{Projection}}
        FROM item
        {{Eligible}}
        WHERE {{Visible}} AND item.id = ANY(@item_ids)
        ORDER BY item.id
        """;
}
