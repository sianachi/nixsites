namespace Nix.Persistence.Sql.Statements;

/// <summary>
/// What a site may publish. This is the security-critical read of the feature: the manifest, every
/// rendered view and every chart are built only from the rows it returns (ADR-0063).
/// </summary>
/// <remarks>
/// <para>
/// <b>An item is withheld, with everything under it,</b> when it is not active, is a template, is
/// in <c>site_exclusion</c>, holds a lock of its own, or is a post of a dated collection whose date
/// is empty, unparseable or later than <c>@now</c>. The statement walks the tree down from the root
/// by parent pointer and never steps into a withheld item, so everything under one is withheld by
/// construction: a lock covers its subtree, and so does every other reason. Locks are read whoever
/// has them open: a publisher who unlocked a note in their browser does not publish it.
/// </para>
/// <para>
/// A recursive walk rather than a join over the closure table, for cost: it touches the site's
/// pages and the children it prunes, where the closure formulation measured at a scan of the
/// tenant's items and a per-page rescan of the subtree (about a second for 3,000 pages among
/// 60,000 items). The parent pointer is the authoritative edge; the closure is derived from it.
/// </para>
/// <para>
/// The statement runs under the publisher's session, so row-level security bounds it to the
/// tenant, and the handler asks the permission resolver for workspace read access before running
/// it. Locks above the root are the handler's check (<c>IItemLocks.GetStateAsync</c>); the lifecycle
/// of the ancestors above the root is the item tree's (<see cref="ItemVisibilitySql"/>).
/// </para>
/// <para>
/// Index dependencies: <c>IX_item_tenant_id_parent_id</c> (or <c>IX_item_workspace_id_parent_id_seq</c>,
/// whichever the planner prefers at the corpus size) for each step down,
/// <c>AK_item_tenant_id_id</c> for the final read, and <c>IX_content_doc_tenant_id_item_id</c> for
/// the body join, and the primary keys of <c>content_update</c> and <c>content_snapshot</c>
/// (<c>doc_id, seq</c>) for the time of the body's last update. The final reads are lateral point probes whose redundant <c>LIMIT 1</c> is
/// load-bearing, as in <see cref="ItemVisibilitySql"/>: without it the planner joined the walk to a
/// scan of the tenant's items. The plan is captured by <c>SiteEligibilityPlanEvidenceTests</c>.
/// </para>
/// </remarks>
public static class SiteEligibilitySql
{
    /// <summary>
    /// The eligible items of one site in pre-order (sibling order down the tree, equal keys broken by
    /// id), with the content position a body is read at. The modification time is the later of the
    /// item's own change and its body's head update, since an edit to a body leaves
    /// <c>item.last_modified_at</c> alone; a head update already pruned by retention falls back to the
    /// retained base snapshot at the same seq, and if that is gone too GREATEST ignores the null. A post's date is read without a trailing
    /// <c>[Zone]</c> suffix, as the automation date finder reads it. Binds <c>@tenant_id</c>, <c>@workspace_id</c>, <c>@root_id</c>,
    /// <c>@site_id</c> and <c>@now</c>.
    /// </summary>
    public const string EligiblePages = """
        WITH RECURSIVE barred AS MATERIALIZED (
            SELECT exclusion.item_id
            FROM site_exclusion AS exclusion
            WHERE exclusion.tenant_id = @tenant_id
              AND exclusion.site_id = @site_id
            UNION
            SELECT locked.item_id
            FROM item_lock AS locked
            WHERE locked.tenant_id = @tenant_id
        ),
        dated AS MATERIALIZED (
            SELECT setting.item_id, setting.date_property
            FROM site_dated_collection AS setting
            WHERE setting.tenant_id = @tenant_id
              AND setting.site_id = @site_id
        ),
        walk (id, depth, seq_path) AS (
            SELECT root.id, 0, ARRAY[ROW(root.seq, root.id)]
            FROM item AS root
            WHERE root.tenant_id = @tenant_id
              AND root.id = @root_id
              AND root.workspace_id = @workspace_id
              AND root.lifecycle_state = 'active'
              AND root.template_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM barred WHERE barred.item_id = root.id)
            UNION ALL
            SELECT child.id, walk.depth + 1, walk.seq_path || ROW(child.seq, child.id)
            FROM walk
            JOIN item AS child
              ON child.tenant_id = @tenant_id
             AND child.parent_id = walk.id
            WHERE walk.depth < 128
              AND child.workspace_id = @workspace_id
              AND child.lifecycle_state = 'active'
              AND child.type <> 'message'
              AND child.template_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM barred WHERE barred.item_id = child.id)
              AND NOT EXISTS (
                  SELECT 1
                  FROM dated
                  WHERE dated.item_id = walk.id
                    AND COALESCE(nix_safe_timestamptz(split_part(child.properties ->> dated.date_property, '[', 1)) > @now, true)
              )
        )
        SELECT item.id,
               item.parent_id,
               item.type,
               item.seq,
               item.properties::text,
               item.schema::text,
               item.views::text,
               item.created_at,
               GREATEST(item.last_modified_at, doc.head_at),
               doc.doc_id,
               doc.head_seq
        FROM walk
        CROSS JOIN LATERAL (
            SELECT stored.*
            FROM item AS stored
            WHERE stored.tenant_id = @tenant_id
              AND stored.id = walk.id
            LIMIT 1
        ) AS item
        LEFT JOIN LATERAL (
            SELECT body.doc_id,
                   body.head_seq,
                   -- Retention prunes the head update of a long-idle body but keeps the base
                   -- snapshot at that seq, so its time stands in.
                   COALESCE(
                       (SELECT head.created_at
                        FROM content_update AS head
                        WHERE head.tenant_id = @tenant_id
                          AND head.doc_id = body.doc_id
                          AND head.seq = body.head_seq
                        LIMIT 1),
                       (SELECT base.created_at
                        FROM content_snapshot AS base
                        WHERE base.tenant_id = @tenant_id
                          AND base.doc_id = body.doc_id
                          AND base.seq = body.head_seq
                        LIMIT 1)) AS head_at
            FROM content_doc AS body
            WHERE body.tenant_id = @tenant_id
              AND body.item_id = walk.id
            LIMIT 1
        ) AS doc ON TRUE
        ORDER BY walk.seq_path
        """;

    /// <summary>
    /// The direct entries of an otherwise eligible dated collection that its date rule withholds.
    /// It deliberately excludes entries that are locked or explicitly excluded, so a build report
    /// cannot disclose those items. Binds the same parameters as <see cref="EligiblePages"/>, plus
    /// <c>@limit</c> so the build report never materializes an unbounded draft collection.
    /// </summary>
    public const string WithheldDatedPosts = """
        WITH RECURSIVE barred AS MATERIALIZED (
            SELECT exclusion.item_id
            FROM site_exclusion AS exclusion
            WHERE exclusion.tenant_id = @tenant_id
              AND exclusion.site_id = @site_id
            UNION
            SELECT locked.item_id
            FROM item_lock AS locked
            WHERE locked.tenant_id = @tenant_id
        ),
        dated AS MATERIALIZED (
            SELECT setting.item_id, setting.date_property
            FROM site_dated_collection AS setting
            WHERE setting.tenant_id = @tenant_id
              AND setting.site_id = @site_id
        ),
        walk (id, depth, seq_path) AS (
            SELECT root.id, 0, ARRAY[ROW(root.seq, root.id)]
            FROM item AS root
            WHERE root.tenant_id = @tenant_id
              AND root.id = @root_id
              AND root.workspace_id = @workspace_id
              AND root.lifecycle_state = 'active'
              AND root.template_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM barred WHERE barred.item_id = root.id)
            UNION ALL
            SELECT child.id, walk.depth + 1, walk.seq_path || ROW(child.seq, child.id)
            FROM walk
            JOIN item AS child
              ON child.tenant_id = @tenant_id
             AND child.parent_id = walk.id
            WHERE walk.depth < 128
              AND child.workspace_id = @workspace_id
              AND child.lifecycle_state = 'active'
              AND child.type <> 'message'
              AND child.template_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM barred WHERE barred.item_id = child.id)
              AND NOT EXISTS (
                  SELECT 1
                  FROM dated
                  WHERE dated.item_id = walk.id
                    AND COALESCE(nix_safe_timestamptz(split_part(child.properties ->> dated.date_property, '[', 1)) > @now, true)
              )
        )
        SELECT child.properties ->> 'title',
               child.properties ->> dated.date_property AS date_value,
               nix_safe_timestamptz(split_part(child.properties ->> dated.date_property, '[', 1)) AS published_at
        FROM walk
        JOIN dated ON dated.item_id = walk.id
        JOIN item AS child
          ON child.tenant_id = @tenant_id
         AND child.parent_id = walk.id
        WHERE child.workspace_id = @workspace_id
          AND child.lifecycle_state = 'active'
          AND child.type <> 'message'
          AND child.template_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM barred WHERE barred.item_id = child.id)
          AND COALESCE(nix_safe_timestamptz(split_part(child.properties ->> dated.date_property, '[', 1)) > @now, true)
        ORDER BY walk.seq_path, child.seq, child.id
        LIMIT @limit
        """;

    /// <summary>
    /// The containers, among <c>@container_ids</c>, that have an active child outside
    /// <c>@eligible_ids</c>. A chart over such a container would count the hidden child, so none is
    /// published for it (rule 1.7). Binds <c>@tenant_id</c>, <c>@container_ids</c> and
    /// <c>@eligible_ids</c>.
    /// </summary>
    public const string ContainersWithHiddenChildren = """
        SELECT DISTINCT child.parent_id
        FROM item AS child
        WHERE child.tenant_id = @tenant_id
          AND child.parent_id = ANY(@container_ids)
          AND child.lifecycle_state = 'active'
          AND child.template_id IS NULL
          AND NOT (child.id = ANY(@eligible_ids))
        """;

    /// <summary>
    /// The current version of an image the publisher may copy: inside the site's subtree, active
    /// along its whole ancestor path, not under any lock, not under an excluded item, not under a
    /// post a dated collection withholds, a supported raster type of at most 10 MiB or any SVG of
    /// at most 2 MiB (meant for captured Mermaid diagrams, but not limited to them; the worker
    /// re-sanitises every SVG before publishing), or a download (PDF, plain text or CSV) of at
    /// most 20 MiB, <c>SiteRules.MaximumDownloadBytes</c>, or a video (MP4 or WebM) of at most 50 MiB, <c>SiteRules.MaximumVideoBytes</c>, with its bytes in the store. The same withholding rules as <see cref="EligiblePages"/>, applied to the
    /// file's ancestors through the closure. Binds <c>@tenant_id</c>, <c>@workspace_id</c>,
    /// <c>@root_id</c>, <c>@site_id</c>, <c>@now</c> and <c>@file_item_id</c>.
    /// </summary>
    public const string EligibleFile = """
        SELECT file.id,
               version.file_version_id,
               version.sha256,
               version.media_type,
               version.byte_length,
               version.object_key,
               version.file_name
        FROM item AS file
        JOIN file_body AS body
          ON body.tenant_id = file.tenant_id
         AND body.item_id = file.id
        JOIN file_version AS version
          ON version.tenant_id = body.tenant_id
         AND version.item_id = body.item_id
         AND version.file_version_id = body.current_version_id
        WHERE file.tenant_id = @tenant_id
          AND file.id = @file_item_id
          AND file.workspace_id = @workspace_id
          AND file.lifecycle_state = 'active'
          AND file.template_id IS NULL
          AND version.object_ready
          AND (
              (version.media_type IN ('image/png', 'image/jpeg', 'image/webp')
                  AND version.byte_length BETWEEN 1 AND 10485760)
              OR (version.media_type = 'image/svg+xml' AND version.byte_length BETWEEN 1 AND 2097152)
              OR (version.media_type IN ('application/pdf', 'text/plain', 'text/csv')
                  AND version.byte_length BETWEEN 1 AND 20971520)
              OR (version.media_type IN ('video/mp4', 'video/webm')
                  AND version.byte_length BETWEEN 1 AND 52428800)
          )
          AND EXISTS (
              SELECT 1
              FROM item_closure AS inside
              WHERE inside.tenant_id = @tenant_id
                AND inside.ancestor_id = @root_id
                AND inside.descendant_id = file.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM item_closure AS edge
              JOIN item AS ancestor
                ON ancestor.tenant_id = edge.tenant_id
               AND ancestor.id = edge.ancestor_id
              WHERE edge.tenant_id = @tenant_id
                AND edge.descendant_id = file.id
                AND edge.depth > 0
                AND (ancestor.lifecycle_state <> 'active' OR ancestor.template_id IS NOT NULL)
          )
          AND NOT EXISTS (
              SELECT 1
              FROM item_closure AS edge
              JOIN item_lock AS locked
                ON locked.tenant_id = edge.tenant_id
               AND locked.item_id = edge.ancestor_id
              WHERE edge.tenant_id = @tenant_id
                AND edge.descendant_id = file.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM item_closure AS edge
              JOIN site_exclusion AS exclusion
                ON exclusion.tenant_id = edge.tenant_id
               AND exclusion.site_id = @site_id
               AND exclusion.item_id = edge.ancestor_id
              WHERE edge.tenant_id = @tenant_id
                AND edge.descendant_id = file.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM item_closure AS edge
              JOIN item AS post
                ON post.tenant_id = edge.tenant_id
               AND post.id = edge.ancestor_id
              JOIN site_dated_collection AS dated
                ON dated.tenant_id = post.tenant_id
               AND dated.site_id = @site_id
               AND dated.item_id = post.parent_id
              WHERE edge.tenant_id = @tenant_id
                AND edge.descendant_id = file.id
                AND COALESCE(nix_safe_timestamptz(split_part(post.properties ->> dated.date_property, '[', 1)) > @now, true)
          )
        """;

    /// <summary>
    /// How many of <c>@item_ids</c> are the root or lie under it. Binds <c>@tenant_id</c>,
    /// <c>@root_id</c> and <c>@item_ids</c>.
    /// </summary>
    public const string CountInSubtree = """
        SELECT count(DISTINCT edge.descendant_id)
        FROM item_closure AS edge
        WHERE edge.tenant_id = @tenant_id
          AND edge.ancestor_id = @root_id
          AND edge.descendant_id = ANY(@item_ids)
        """;

    /// <summary>The titles of <c>@item_ids</c>, for a path listing. Binds <c>@tenant_id</c> and <c>@item_ids</c>.</summary>
    public const string Titles = """
        SELECT item.id, item.properties ->> 'title'
        FROM item
        WHERE item.tenant_id = @tenant_id
          AND item.id = ANY(@item_ids)
        """;
}
