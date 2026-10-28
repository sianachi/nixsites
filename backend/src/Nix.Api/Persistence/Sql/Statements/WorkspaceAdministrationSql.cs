namespace Nix.Persistence.Sql.Statements;

/// <summary>Permission-filtered workspace reads and invariant-preserving administration writes.</summary>
public static class WorkspaceAdministrationSql
{
    /// <summary>
    /// Lists reachable workspaces and computes capabilities in the database. The membership
    /// predicate is part of the query, so callers never receive a tenant-wide result to filter.
    /// </summary>
    public const string List = """
        WITH caller AS (
            SELECT p.kind = 'user' AND p.status = 'active' AS active_human,
                   EXISTS (
                       SELECT 1 FROM tenant_role tr
                       WHERE tr.tenant_id = @tenant_id AND tr.role = 'admin'
                         AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                           OR (tr.subject_type = 'group' AND EXISTS (
                               SELECT 1 FROM group_membership gm
                               WHERE gm.tenant_id = tr.tenant_id
                                 AND gm.group_id = tr.subject_id
                                 AND gm.principal_id = @principal_id)))
                   ) AS tenant_admin
            FROM principal p
            WHERE p.tenant_id = @tenant_id AND p.principal_id = @principal_id
        ), candidates AS MATERIALIZED (
            SELECT w.workspace_id, w.name, w.version_retention_days,
                   w.storage_quota_bytes, w.created_at, w.personal_owner_principal_id,
                   w.lifecycle_state, w.archived_at, w.daily_notes, w.membership_locked, w.collaboration
            FROM workspace w
            CROSS JOIN caller c
            WHERE w.tenant_id = @tenant_id
              AND (c.tenant_admin OR EXISTS (
                  SELECT 1 FROM workspace_member wm
                  WHERE wm.tenant_id = w.tenant_id AND wm.workspace_id = w.workspace_id
                    AND (wm.subject_type = 'principal' AND wm.subject_id = @principal_id
                      OR wm.subject_type = 'group' AND EXISTS (
                          SELECT 1 FROM group_membership gm
                          WHERE gm.tenant_id = wm.tenant_id AND gm.group_id = wm.subject_id
                            AND gm.principal_id = @principal_id)))
                OR EXISTS (
                  SELECT 1 FROM workspace_invitation invited
                  WHERE invited.tenant_id = w.tenant_id AND invited.workspace_id = w.workspace_id
                    AND invited.target_principal_id = @principal_id AND invited.status = 'pending'))
              AND (@after_created_at IS NULL
                   OR (w.created_at, w.workspace_id) < (@after_created_at, @after_id))
            ORDER BY w.created_at DESC, w.workspace_id DESC
            LIMIT @limit
        ), reachable AS (
            SELECT candidate.*,
                   COALESCE(held.role_rank, -1) AS role_rank,
                   COALESCE(held.direct_member, false) AS direct_member,
                   COALESCE(held.direct_owner, false) AS direct_owner
            FROM candidates candidate
            LEFT JOIN LATERAL (
                SELECT MAX(CASE wm.role
                         WHEN 'owner' THEN 3 WHEN 'editor' THEN 2
                         WHEN 'commenter' THEN 1 WHEN 'viewer' THEN 0 END) AS role_rank,
                       bool_or(wm.subject_type = 'principal' AND wm.subject_id = @principal_id)
                           AS direct_member,
                       bool_or(wm.subject_type = 'principal' AND wm.subject_id = @principal_id
                           AND wm.role = 'owner') AS direct_owner
                FROM workspace_member wm
                WHERE wm.tenant_id = @tenant_id AND wm.workspace_id = candidate.workspace_id
                  AND (wm.subject_type = 'principal' AND wm.subject_id = @principal_id
                    OR wm.subject_type = 'group' AND EXISTS (
                        SELECT 1 FROM group_membership gm
                        WHERE gm.tenant_id = wm.tenant_id AND gm.group_id = wm.subject_id
                          AND gm.principal_id = @principal_id))
            ) held ON true
        )
        SELECT r.workspace_id, r.name, r.version_retention_days, r.storage_quota_bytes,
               r.created_at, r.personal_owner_principal_id,
               (c.tenant_admin OR r.role_rank = 3) AS can_rename,
               (c.tenant_admin OR r.role_rank = 3) AS can_manage_members,
               (pending.invitation_id IS NULL
                 AND r.direct_member AND r.personal_owner_principal_id IS DISTINCT FROM @principal_id
                 AND NOT (r.direct_owner AND r.personal_owner_principal_id IS NULL AND
                    (SELECT count(*) FROM workspace_member owners
                     JOIN principal owner_principal
                       ON owner_principal.tenant_id = owners.tenant_id
                      AND owner_principal.principal_id = owners.subject_id
                     WHERE owners.tenant_id = @tenant_id
                       AND owners.workspace_id = r.workspace_id
                       AND owners.subject_type = 'principal' AND owners.role = 'owner'
                       AND owner_principal.kind = 'user' AND owner_principal.status = 'active') = 1)
               ) AS can_leave,
               (r.lifecycle_state = 'active'
                 AND (c.tenant_admin OR r.role_rank >= 2)
                 AND (r.personal_owner_principal_id IS NULL OR r.personal_owner_principal_id = @principal_id)
                 AND COALESCE(
                       CASE WHEN jsonb_typeof(r.daily_notes -> 'enabled') = 'boolean'
                            THEN (r.daily_notes ->> 'enabled')::boolean END,
                       r.personal_owner_principal_id IS NOT NULL)
               ) AS can_use_daily_notes,
               pending.invitation_id, r.lifecycle_state, r.archived_at,
               r.membership_locked, r.collaboration
        FROM reachable r CROSS JOIN caller c
        LEFT JOIN LATERAL (
            SELECT invitation.invitation_id
            FROM workspace_invitation invitation
            WHERE invitation.tenant_id = @tenant_id
              AND invitation.workspace_id = r.workspace_id
              AND invitation.target_principal_id = @principal_id
              AND invitation.status = 'pending'
            LIMIT 1
        ) pending ON true
        ORDER BY r.created_at DESC, r.workspace_id DESC
        """;

    /// <summary>Detail is the same permission-filtered relation as list, narrowed by identifier.</summary>
    public const string Detail = """
        WITH caller AS (
            SELECT EXISTS (
                SELECT 1 FROM tenant_role tr
                WHERE tr.tenant_id = @tenant_id AND tr.role = 'admin'
                  AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                    OR (tr.subject_type = 'group' AND EXISTS (
                        SELECT 1 FROM group_membership gm
                        WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                          AND gm.principal_id = @principal_id)))
            ) AS tenant_admin
        ), held AS (
            SELECT COALESCE(MAX(CASE wm.role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2
                    WHEN 'commenter' THEN 1 WHEN 'viewer' THEN 0 END), -1) role_rank,
                   COALESCE(bool_or(wm.subject_type = 'principal' AND wm.subject_id = @principal_id), false) direct_member,
                   COALESCE(bool_or(wm.subject_type = 'principal' AND wm.subject_id = @principal_id
                     AND wm.role = 'owner'), false) direct_owner
            FROM workspace_member wm
            WHERE wm.tenant_id = @tenant_id AND wm.workspace_id = @workspace_id
              AND (wm.subject_type = 'principal' AND wm.subject_id = @principal_id
                OR wm.subject_type = 'group' AND EXISTS (
                    SELECT 1 FROM group_membership gm
                    WHERE gm.tenant_id = wm.tenant_id AND gm.group_id = wm.subject_id
                      AND gm.principal_id = @principal_id))
        )
        SELECT w.workspace_id, w.name, w.version_retention_days, w.storage_quota_bytes,
               w.created_at, w.personal_owner_principal_id,
               (c.tenant_admin OR h.role_rank = 3), (c.tenant_admin OR h.role_rank = 3),
               (pending.invitation_id IS NULL
                 AND h.direct_member AND w.personal_owner_principal_id IS DISTINCT FROM @principal_id
                 AND NOT (h.direct_owner AND w.personal_owner_principal_id IS NULL AND
                    (SELECT count(*) FROM workspace_member owners
                     JOIN principal p ON p.tenant_id = owners.tenant_id
                       AND p.principal_id = owners.subject_id
                     WHERE owners.tenant_id = @tenant_id AND owners.workspace_id = w.workspace_id
                       AND owners.subject_type = 'principal' AND owners.role = 'owner'
                       AND p.kind = 'user' AND p.status = 'active') = 1)),
               (w.lifecycle_state = 'active'
                 AND (c.tenant_admin OR h.role_rank >= 2)
                 AND (w.personal_owner_principal_id IS NULL OR w.personal_owner_principal_id = @principal_id)
                 AND COALESCE(
                       CASE WHEN jsonb_typeof(w.daily_notes -> 'enabled') = 'boolean'
                            THEN (w.daily_notes ->> 'enabled')::boolean END,
                       w.personal_owner_principal_id IS NOT NULL)),
               pending.invitation_id, w.lifecycle_state, w.archived_at,
               w.membership_locked, w.collaboration
        FROM workspace w CROSS JOIN caller c CROSS JOIN held h
        LEFT JOIN LATERAL (
            SELECT invitation.invitation_id
            FROM workspace_invitation invitation
            WHERE invitation.tenant_id = @tenant_id
              AND invitation.workspace_id = w.workspace_id
              AND invitation.target_principal_id = @principal_id
              AND invitation.status = 'pending'
            LIMIT 1
        ) pending ON true
        WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
          AND (c.tenant_admin OR h.role_rank >= 0 OR pending.invitation_id IS NOT NULL)
        """;

    /// <summary>Creates a shared workspace only for the active human caller.</summary>
    public const string Create = """
        WITH eligible AS (
            SELECT 1 FROM principal
            WHERE tenant_id = @tenant_id AND principal_id = @principal_id
              AND kind = 'user' AND status = 'active'
        ), created AS (
            INSERT INTO workspace (
                workspace_id, tenant_id, name, version_retention_days,
                coalesce_window_min, storage_quota_bytes, created_at,
                personal_owner_principal_id)
            SELECT @workspace_id, @tenant_id, @name, 90, 10, 10737418240, @now, NULL
            FROM eligible
            RETURNING workspace_id
        ), membership AS (
            INSERT INTO workspace_member (
                workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            SELECT workspace_id, 'principal', @principal_id, @tenant_id, 'owner', @principal_id, @now
            FROM created
        )
        SELECT EXISTS (SELECT 1 FROM created)
        """;

    /// <summary>Renames only when the caller is an owner or tenant administrator.</summary>
    public const string Rename = """
        UPDATE workspace w SET name = @name
        WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
          AND (EXISTS (SELECT 1 FROM workspace_member wm
                       WHERE wm.tenant_id = w.tenant_id AND wm.workspace_id = w.workspace_id
                         AND wm.role = 'owner'
                         AND ((wm.subject_type = 'principal' AND wm.subject_id = @principal_id)
                           OR (wm.subject_type = 'group' AND EXISTS (
                               SELECT 1 FROM group_membership gm
                               WHERE gm.tenant_id = wm.tenant_id AND gm.group_id = wm.subject_id
                                 AND gm.principal_id = @principal_id))))
            OR EXISTS (SELECT 1 FROM tenant_role tr
                       WHERE tr.tenant_id = w.tenant_id AND tr.role = 'admin'
                         AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                           OR (tr.subject_type = 'group' AND EXISTS (
                               SELECT 1 FROM group_membership gm
                               WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                 AND gm.principal_id = @principal_id)))))
        RETURNING workspace_id
        """;

    /// <summary>Sets the sharing switches named, only for an owner or tenant administrator.</summary>
    public const string SetSharing = """
        UPDATE workspace w
        SET membership_locked = COALESCE(@membership_locked, w.membership_locked),
            collaboration = COALESCE(@collaboration, w.collaboration)
        WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
          AND (EXISTS (SELECT 1 FROM workspace_member wm
                       WHERE wm.tenant_id = w.tenant_id AND wm.workspace_id = w.workspace_id
                         AND wm.role = 'owner'
                         AND ((wm.subject_type = 'principal' AND wm.subject_id = @principal_id)
                           OR (wm.subject_type = 'group' AND EXISTS (
                               SELECT 1 FROM group_membership gm
                               WHERE gm.tenant_id = wm.tenant_id AND gm.group_id = wm.subject_id
                                 AND gm.principal_id = @principal_id))))
            OR EXISTS (SELECT 1 FROM tenant_role tr
                       WHERE tr.tenant_id = w.tenant_id AND tr.role = 'admin'
                         AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                           OR (tr.subject_type = 'group' AND EXISTS (
                               SELECT 1 FROM group_membership gm
                               WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                 AND gm.principal_id = @principal_id)))))
        RETURNING workspace_id
        """;

    /// <summary>Archives a workspace only for an owner or tenant administrator.</summary>
    public const string Archive = """
        UPDATE workspace w
        SET lifecycle_state = 'archived', archived_at = @now
        WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
          AND w.lifecycle_state = 'active'
          AND (EXISTS (SELECT 1 FROM workspace_member wm
                      WHERE wm.tenant_id = w.tenant_id AND wm.workspace_id = w.workspace_id
                        AND wm.role = 'owner'
                        AND ((wm.subject_type = 'principal' AND wm.subject_id = @principal_id)
                          OR (wm.subject_type = 'group' AND EXISTS (
                              SELECT 1 FROM group_membership gm
                              WHERE gm.tenant_id = wm.tenant_id AND gm.group_id = wm.subject_id
                                AND gm.principal_id = @principal_id))))
               OR EXISTS (SELECT 1 FROM tenant_role tr
                          WHERE tr.tenant_id = w.tenant_id AND tr.role = 'admin'
                            AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                              OR (tr.subject_type = 'group' AND EXISTS (
                                  SELECT 1 FROM group_membership gm
                                  WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                    AND gm.principal_id = @principal_id)))))
        RETURNING w.workspace_id
        """;

    /// <summary>Restores an archived workspace only for an owner or tenant administrator.</summary>
    public const string Restore = """
        UPDATE workspace w
        SET lifecycle_state = 'active', archived_at = NULL
        WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
          AND w.lifecycle_state = 'archived'
          AND (EXISTS (SELECT 1 FROM workspace_member wm
                      WHERE wm.tenant_id = w.tenant_id AND wm.workspace_id = w.workspace_id
                        AND wm.role = 'owner'
                        AND ((wm.subject_type = 'principal' AND wm.subject_id = @principal_id)
                          OR (wm.subject_type = 'group' AND EXISTS (
                              SELECT 1 FROM group_membership gm
                              WHERE gm.tenant_id = wm.tenant_id AND gm.group_id = wm.subject_id
                                AND gm.principal_id = @principal_id))))
               OR EXISTS (SELECT 1 FROM tenant_role tr
                          WHERE tr.tenant_id = w.tenant_id AND tr.role = 'admin'
                            AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                              OR (tr.subject_type = 'group' AND EXISTS (
                                  SELECT 1 FROM group_membership gm
                                  WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                    AND gm.principal_id = @principal_id)))))
        RETURNING w.workspace_id
        """;

    /// <summary>Irreversibly closes an archived workspace to ordinary use before cleanup starts.</summary>
    public const string BeginPurge = """
        UPDATE workspace w
        SET lifecycle_state = 'purging'
        WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
          AND w.lifecycle_state = 'archived'
          AND (EXISTS (SELECT 1 FROM workspace_member wm
                      WHERE wm.tenant_id = w.tenant_id AND wm.workspace_id = w.workspace_id
                        AND wm.role = 'owner'
                        AND ((wm.subject_type = 'principal' AND wm.subject_id = @principal_id)
                          OR (wm.subject_type = 'group' AND EXISTS (
                              SELECT 1 FROM group_membership gm
                              WHERE gm.tenant_id = wm.tenant_id AND gm.group_id = wm.subject_id
                                AND gm.principal_id = @principal_id))))
               OR EXISTS (SELECT 1 FROM tenant_role tr
                          WHERE tr.tenant_id = w.tenant_id AND tr.role = 'admin'
                            AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                              OR (tr.subject_type = 'group' AND EXISTS (
                                  SELECT 1 FROM group_membership gm
                                  WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                    AND gm.principal_id = @principal_id)))))
        RETURNING w.workspace_id
        """;

    /// <summary>Reads the private object keys that belong exclusively to a workspace being purged.</summary>
    public const string PurgeObjectKeys = """
        WITH authorized AS MATERIALIZED (
            SELECT w.workspace_id
            FROM workspace w
            WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
              AND w.lifecycle_state = 'purging'
              AND (EXISTS (SELECT 1 FROM workspace_member wm
                          WHERE wm.tenant_id = w.tenant_id AND wm.workspace_id = w.workspace_id
                            AND wm.role = 'owner'
                            AND ((wm.subject_type = 'principal' AND wm.subject_id = @principal_id)
                              OR (wm.subject_type = 'group' AND EXISTS (
                                  SELECT 1 FROM group_membership gm
                                  WHERE gm.tenant_id = wm.tenant_id AND gm.group_id = wm.subject_id
                                    AND gm.principal_id = @principal_id))))
                   OR EXISTS (SELECT 1 FROM tenant_role tr
                              WHERE tr.tenant_id = w.tenant_id AND tr.role = 'admin'
                                AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                                  OR (tr.subject_type = 'group' AND EXISTS (
                                      SELECT 1 FROM group_membership gm
                                      WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                        AND gm.principal_id = @principal_id)))))
        )
        SELECT version.object_key
        FROM file_version version CROSS JOIN authorized
        WHERE version.tenant_id = @tenant_id AND version.workspace_id = authorized.workspace_id
        UNION
        SELECT upload.object_key
        FROM file_upload upload CROSS JOIN authorized
        WHERE upload.tenant_id = @tenant_id AND upload.workspace_id = authorized.workspace_id
        UNION
        SELECT 'imports/plans/' || @tenant_id::text || '/' || document_import.import_id::text || '.json'
        FROM document_import CROSS JOIN authorized
        WHERE document_import.tenant_id = @tenant_id
          AND document_import.workspace_id = authorized.workspace_id
        ORDER BY 1
        """;

    /// <summary>
    /// Deletes the sites of a purging workspace, from its live cleanup job only, before the
    /// workspace row: a site's keys restrict rather than cascade. The purge was refused while any
    /// of them was live or held objects, so these are drafts and drained sites.
    /// </summary>
    public const string DeletePurgingWorkspaceSites = """
        DELETE FROM site s
        WHERE s.tenant_id = @tenant_id AND s.workspace_id = @workspace_id
          AND EXISTS (SELECT 1 FROM worker_job job
                      WHERE job.tenant_id = @tenant_id AND job.job_id = @job_id
                        AND job.kind = 'object.cleanup' AND job.status = 'running'
                        AND job.workspace_id = @workspace_id)
          AND EXISTS (SELECT 1 FROM workspace w
                      WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
                        AND w.lifecycle_state = 'purging')
        """;

    /// <summary>Deletes a purged workspace only from its live cleanup job.</summary>
    public const string FinalizePurge = """
        WITH purge_job AS MATERIALIZED (
            SELECT job.job_id
            FROM worker_job job
            WHERE job.tenant_id = @tenant_id AND job.job_id = @job_id
              AND job.kind = 'object.cleanup' AND job.status = 'running'
              AND job.workspace_id = @workspace_id
        ), deleted AS (
            DELETE FROM workspace w
            USING purge_job
            WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
              AND w.lifecycle_state = 'purging'
            RETURNING w.workspace_id
        )
        SELECT workspace_id FROM deleted
        """;

    /// <summary>Lists principal and group grants; only direct principal grants are mutable.</summary>
    public const string Members = """
        WITH authorized AS MATERIALIZED (
            SELECT w.personal_owner_principal_id,
                   EXISTS (SELECT 1 FROM workspace_member caller
                           WHERE caller.tenant_id = w.tenant_id AND caller.workspace_id = w.workspace_id
                             AND caller.role = 'owner'
                             AND ((caller.subject_type = 'principal' AND caller.subject_id = @principal_id)
                               OR (caller.subject_type = 'group' AND EXISTS (
                                   SELECT 1 FROM group_membership gm
                                   WHERE gm.tenant_id = caller.tenant_id AND gm.group_id = caller.subject_id
                                     AND gm.principal_id = @principal_id))))
                     OR EXISTS (SELECT 1 FROM tenant_role tr WHERE tr.tenant_id = w.tenant_id
                                  AND tr.role = 'admin'
                                  AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                                    OR (tr.subject_type = 'group' AND EXISTS (
                                        SELECT 1 FROM group_membership gm
                                        WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                          AND gm.principal_id = @principal_id)))) AS can_manage
            FROM workspace w
            WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
              AND (EXISTS (SELECT 1 FROM workspace_member caller
                           WHERE caller.tenant_id = w.tenant_id AND caller.workspace_id = w.workspace_id
                             AND ((caller.subject_type = 'principal' AND caller.subject_id = @principal_id)
                               OR (caller.subject_type = 'group' AND EXISTS (
                                   SELECT 1 FROM group_membership gm
                                   WHERE gm.tenant_id = caller.tenant_id AND gm.group_id = caller.subject_id
                                     AND gm.principal_id = @principal_id))))
                OR EXISTS (SELECT 1 FROM tenant_role tr WHERE tr.tenant_id = w.tenant_id
                             AND tr.role = 'admin'
                             AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                               OR (tr.subject_type = 'group' AND EXISTS (
                                   SELECT 1 FROM group_membership gm
                                   WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                     AND gm.principal_id = @principal_id)))))
        ), owner_state AS MATERIALIZED (
            SELECT count(*) AS active_human_owner_count
            FROM workspace_member owner
            JOIN principal owner_principal ON owner_principal.tenant_id = owner.tenant_id
              AND owner_principal.principal_id = owner.subject_id
            WHERE owner.tenant_id = @tenant_id AND owner.workspace_id = @workspace_id
              AND owner.subject_type = 'principal' AND owner.role = 'owner'
              AND owner_principal.kind = 'user' AND owner_principal.status = 'active'
        )
        SELECT wm.subject_type, wm.subject_id, COALESCE(p.display_name, pg.name), p.email,
               wm.role, wm.granted_at,
               wm.subject_type = 'principal' AND authorized.can_manage
                 AND NOT state.protected_owner AND NOT state.last_owner
                 AND NOT state.provisional AS can_change_role,
               wm.subject_type = 'principal' AND authorized.can_manage
                 AND NOT state.protected_owner AND NOT state.last_owner
                 AND NOT state.provisional AS can_remove,
               CASE
                 WHEN wm.subject_type <> 'principal' OR NOT authorized.can_manage
                   OR state.protected_owner OR state.last_owner OR state.provisional
                   THEN ARRAY[]::text[]
                 WHEN authorized.personal_owner_principal_id IS NOT NULL THEN ARRAY['editor','viewer']::text[]
                 ELSE ARRAY['owner','editor','viewer']::text[]
               END AS assignable_roles
        FROM workspace_member wm
        CROSS JOIN authorized
        CROSS JOIN owner_state
        LEFT JOIN LATERAL (
            SELECT candidate.display_name, candidate.email, candidate.kind, candidate.status
            FROM principal candidate
            WHERE wm.subject_type = 'principal' AND candidate.tenant_id = @tenant_id
              AND candidate.principal_id = wm.subject_id
            LIMIT 1
        ) p ON true
        LEFT JOIN LATERAL (
            SELECT candidate.name
            FROM principal_group candidate
            WHERE wm.subject_type = 'group' AND candidate.tenant_id = @tenant_id
              AND candidate.group_id = wm.subject_id
            LIMIT 1
        ) pg ON true
        CROSS JOIN LATERAL (
            SELECT wm.subject_type = 'principal'
                     AND COALESCE(authorized.personal_owner_principal_id = wm.subject_id, false)
                     AS protected_owner,
                   wm.subject_type = 'principal' AND wm.role = 'owner'
                     AND authorized.personal_owner_principal_id IS NULL
                     AND p.kind = 'user' AND p.status = 'active'
                     AND owner_state.active_human_owner_count = 1 AS last_owner,
                   wm.subject_type = 'principal' AND EXISTS (
                       SELECT 1 FROM workspace_invitation invitation
                       WHERE invitation.tenant_id = wm.tenant_id
                         AND invitation.workspace_id = wm.workspace_id
                         AND invitation.target_principal_id = wm.subject_id
                         AND invitation.status = 'pending') AS provisional
        ) state
        WHERE wm.tenant_id = @tenant_id AND wm.workspace_id = @workspace_id
          AND (@target_principal_id IS NULL
               OR (wm.subject_type = 'principal' AND wm.subject_id = @target_principal_id))
          AND (@after_granted_at IS NULL
               OR wm.granted_at < @after_granted_at
               OR (wm.granted_at = @after_granted_at
                   AND (wm.subject_type, wm.subject_id) > (@after_subject_type, @after_id)))
        ORDER BY wm.granted_at DESC, wm.subject_type, wm.subject_id
        LIMIT @limit
        """;

    /// <summary>Lists active humans with server-decided invitation eligibility for authorized owners.</summary>
    public const string Invitees = """
        WITH authorized AS MATERIALIZED (
            SELECT 1
            FROM workspace w
            WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
              AND (EXISTS (SELECT 1 FROM workspace_member caller
                           WHERE caller.tenant_id = w.tenant_id AND caller.workspace_id = w.workspace_id
                             AND caller.role = 'owner'
                             AND ((caller.subject_type = 'principal' AND caller.subject_id = @principal_id)
                               OR (caller.subject_type = 'group' AND EXISTS (
                                   SELECT 1 FROM group_membership gm
                                   WHERE gm.tenant_id = caller.tenant_id AND gm.group_id = caller.subject_id
                                     AND gm.principal_id = @principal_id))))
                OR EXISTS (SELECT 1 FROM tenant_role tr
                           WHERE tr.tenant_id = w.tenant_id AND tr.role = 'admin'
                             AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                               OR (tr.subject_type = 'group' AND EXISTS (
                                   SELECT 1 FROM group_membership gm
                                   WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                     AND gm.principal_id = @principal_id)))))
        )
        SELECT candidate.principal_id, candidate.display_name, candidate.email,
               eligibility.reason IS NULL AS can_invite, eligibility.reason
        FROM principal candidate
        CROSS JOIN authorized
        CROSS JOIN LATERAL (
            SELECT CASE
                WHEN candidate.principal_id = @principal_id THEN 'self'
                WHEN EXISTS (
                    SELECT 1 FROM workspace_invitation invitation
                    WHERE invitation.tenant_id = @tenant_id AND invitation.workspace_id = @workspace_id
                      AND invitation.target_principal_id = candidate.principal_id
                      AND invitation.status = 'pending') THEN 'invitation_pending'
                WHEN EXISTS (
                    SELECT 1 FROM workspace_member member
                    WHERE member.tenant_id = @tenant_id AND member.workspace_id = @workspace_id
                      AND ((member.subject_type = 'principal' AND member.subject_id = candidate.principal_id)
                        OR (member.subject_type = 'group' AND EXISTS (
                            SELECT 1 FROM group_membership membership
                            WHERE membership.tenant_id = member.tenant_id
                              AND membership.group_id = member.subject_id
                              AND membership.principal_id = candidate.principal_id)))) THEN 'already_has_access'
                WHEN candidate.email IS NULL THEN 'email_missing'
                WHEN NOT candidate.email_verified OR candidate.email_normalized IS NULL THEN 'email_unverified'
                ELSE NULL
            END AS reason
        ) eligibility
        WHERE candidate.tenant_id = @tenant_id
          AND candidate.kind = 'user' AND candidate.status = 'active'
          AND (@query IS NULL
               OR position(lower(@query) in lower(candidate.display_name)) > 0
               OR position(lower(@query) in lower(candidate.email)) > 0)
          AND (@after_id IS NULL OR candidate.principal_id > @after_id)
        ORDER BY candidate.principal_id
        LIMIT @limit
        """;

    /// <summary>Lists invitation history for workspace owners and tenant administrators.</summary>
    public const string Invitations = """
        SELECT i.invitation_id, i.email_normalized, i.target_principal_id,
               i.role, i.status, i.invited_by_principal_id,
               i.invited_at, i.accepted_at, i.accepted_by_principal_id, i.revoked_at
        FROM workspace_invitation i
        WHERE i.tenant_id = @tenant_id AND i.workspace_id = @workspace_id
          AND (EXISTS (SELECT 1 FROM workspace_member caller
                       WHERE caller.tenant_id = i.tenant_id AND caller.workspace_id = i.workspace_id
                         AND caller.role = 'owner'
                         AND ((caller.subject_type = 'principal' AND caller.subject_id = @principal_id)
                           OR (caller.subject_type = 'group' AND EXISTS (
                               SELECT 1 FROM group_membership gm
                               WHERE gm.tenant_id = caller.tenant_id AND gm.group_id = caller.subject_id
                                 AND gm.principal_id = @principal_id))))
            OR EXISTS (SELECT 1 FROM tenant_role tr WHERE tr.tenant_id = i.tenant_id
                         AND tr.role = 'admin'
                         AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                           OR (tr.subject_type = 'group' AND EXISTS (
                               SELECT 1 FROM group_membership gm
                               WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                 AND gm.principal_id = @principal_id)))))
          AND (@after_invited_at IS NULL OR (i.invited_at, i.invitation_id) < (@after_invited_at, @after_id))
        ORDER BY i.invited_at DESC, i.invitation_id DESC
        LIMIT @limit
        """;

    /// <summary>Reads one invitation through the same owner-or-administrator authorization.</summary>
    public const string InvitationById = """
        SELECT i.invitation_id, i.email_normalized, i.target_principal_id,
               i.role, i.status, i.invited_by_principal_id,
               i.invited_at, i.accepted_at, i.accepted_by_principal_id, i.revoked_at
        FROM workspace_invitation i
        WHERE i.tenant_id = @tenant_id AND i.workspace_id = @workspace_id
          AND i.invitation_id = @invitation_id
          AND (EXISTS (SELECT 1 FROM workspace_member caller
                       WHERE caller.tenant_id = i.tenant_id AND caller.workspace_id = i.workspace_id
                         AND caller.role = 'owner'
                         AND ((caller.subject_type = 'principal' AND caller.subject_id = @principal_id)
                           OR (caller.subject_type = 'group' AND EXISTS (
                               SELECT 1 FROM group_membership gm
                               WHERE gm.tenant_id = caller.tenant_id AND gm.group_id = caller.subject_id
                                 AND gm.principal_id = @principal_id))))
            OR EXISTS (SELECT 1 FROM tenant_role tr WHERE tr.tenant_id = i.tenant_id
                         AND tr.role = 'admin'
                         AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                           OR (tr.subject_type = 'group' AND EXISTS (
                               SELECT 1 FROM group_membership gm
                               WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                 AND gm.principal_id = @principal_id)))))
        """;

    /// <summary>
    /// Creates a pending invitation. It grants nothing: access starts only when the target accepts,
    /// and a workspace whose owners closed it to new members refuses the invitation outright.
    /// </summary>
    public const string CreateInvitation = """
        WITH locked_workspace AS MATERIALIZED (
            SELECT w.personal_owner_principal_id, w.membership_locked
            FROM workspace w
            WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
              AND (EXISTS (SELECT 1 FROM workspace_member caller
                           WHERE caller.tenant_id = w.tenant_id AND caller.workspace_id = w.workspace_id
                             AND caller.role = 'owner'
                             AND ((caller.subject_type = 'principal' AND caller.subject_id = @principal_id)
                               OR (caller.subject_type = 'group' AND EXISTS (
                                   SELECT 1 FROM group_membership gm
                                   WHERE gm.tenant_id = caller.tenant_id AND gm.group_id = caller.subject_id
                                     AND gm.principal_id = @principal_id))))
                OR EXISTS (SELECT 1 FROM tenant_role tr WHERE tr.tenant_id = w.tenant_id
                             AND tr.role = 'admin'
                             AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                               OR (tr.subject_type = 'group' AND EXISTS (
                                   SELECT 1 FROM group_membership gm
                                   WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                     AND gm.principal_id = @principal_id)))))
            FOR UPDATE
        ), target AS MATERIALIZED (
            SELECT person.principal_id, person.email_normalized
            FROM principal person
            CROSS JOIN locked_workspace workspace
            WHERE person.tenant_id = @tenant_id
              AND person.principal_id = @target_principal_id
              AND person.principal_id <> @principal_id
              AND person.kind = 'user' AND person.status = 'active'
              AND person.email_verified AND person.email_normalized IS NOT NULL
              AND person.principal_id IS DISTINCT FROM workspace.personal_owner_principal_id
              AND (workspace.personal_owner_principal_id IS NULL OR @role <> 'owner')
              AND NOT workspace.membership_locked
              AND NOT EXISTS (
                  SELECT 1 FROM workspace_member member
                  WHERE member.tenant_id = @tenant_id AND member.workspace_id = @workspace_id
                    AND ((member.subject_type = 'principal' AND member.subject_id = person.principal_id)
                      OR (member.subject_type = 'group' AND EXISTS (
                          SELECT 1 FROM group_membership membership
                          WHERE membership.tenant_id = member.tenant_id
                            AND membership.group_id = member.subject_id
                            AND membership.principal_id = person.principal_id))))
        ), inserted AS (
            INSERT INTO workspace_invitation (
                invitation_id, tenant_id, workspace_id, email_normalized, target_principal_id, role,
                invited_by_principal_id, status, invited_at, accepted_at,
                accepted_by_principal_id, revoked_at)
            SELECT @invitation_id, @tenant_id, @workspace_id, target.email_normalized,
                   target.principal_id, @role, @principal_id, 'pending', @now, NULL, NULL, NULL
            FROM target
            ON CONFLICT (tenant_id, workspace_id, email_normalized) WHERE status = 'pending'
            DO UPDATE SET target_principal_id = EXCLUDED.target_principal_id
            WHERE workspace_invitation.role = EXCLUDED.role
              AND workspace_invitation.target_principal_id = EXCLUDED.target_principal_id
            RETURNING invitation_id, email_normalized, target_principal_id, role, status,
                      invited_by_principal_id, invited_at, accepted_at,
                      accepted_by_principal_id, revoked_at
        )
        SELECT 'ok', invitation_id, email_normalized, target_principal_id,
               role, status, invited_by_principal_id,
               invited_at, accepted_at, accepted_by_principal_id, revoked_at
        FROM inserted
        UNION ALL
        SELECT CASE WHEN EXISTS (SELECT 1 FROM locked_workspace WHERE membership_locked) THEN 'locked'
                    WHEN EXISTS (SELECT 1 FROM locked_workspace) THEN 'conflict' ELSE 'not_found' END,
               NULL::uuid, NULL::text, NULL::uuid, NULL::text, NULL::text, NULL::uuid,
               NULL::timestamptz, NULL::timestamptz, NULL::uuid, NULL::timestamptz
        WHERE NOT EXISTS (SELECT 1 FROM inserted)
        """;

    /// <summary>Revokes a pending invitation.</summary>
    public const string RevokeInvitation = """
        WITH target AS MATERIALIZED (
            SELECT invitation.target_principal_id
            FROM workspace_invitation invitation
            WHERE invitation.tenant_id = @tenant_id AND invitation.workspace_id = @workspace_id
              AND invitation.invitation_id = @invitation_id AND invitation.status = 'pending'
              AND invitation.target_principal_id IS NOT NULL
              AND (EXISTS (SELECT 1 FROM workspace_member caller
                       WHERE caller.tenant_id = invitation.tenant_id AND caller.workspace_id = invitation.workspace_id
                         AND caller.role = 'owner'
                         AND ((caller.subject_type = 'principal' AND caller.subject_id = @principal_id)
                           OR (caller.subject_type = 'group' AND EXISTS (
                               SELECT 1 FROM group_membership gm
                               WHERE gm.tenant_id = caller.tenant_id AND gm.group_id = caller.subject_id
                                 AND gm.principal_id = @principal_id))))
            OR EXISTS (SELECT 1 FROM tenant_role tr WHERE tr.tenant_id = invitation.tenant_id
                         AND tr.role = 'admin'
                         AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                           OR (tr.subject_type = 'group' AND EXISTS (
                               SELECT 1 FROM group_membership gm
                               WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                 AND gm.principal_id = @principal_id)))))
            FOR UPDATE
        )
        UPDATE workspace_invitation invitation
        SET status = 'revoked', revoked_at = @now
        FROM target
        WHERE invitation.tenant_id = @tenant_id AND invitation.workspace_id = @workspace_id
          AND invitation.invitation_id = @invitation_id AND invitation.status = 'pending'
        """;

    /// <summary>
    /// Accepts the caller's pending invitation and grants its offered role, never lowering a role
    /// already held. Refused, leaving the invitation pending, while the workspace is closed to new
    /// members; the share lock makes a concurrent close wait for this accept or win before it.
    /// </summary>
    public const string AcceptInvitation = """
        WITH open_workspace AS MATERIALIZED (
            SELECT w.workspace_id
            FROM workspace w
            WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
              AND NOT w.membership_locked
            FOR SHARE
        ), accepted AS (
            UPDATE workspace_invitation invitation
            SET status = 'accepted', accepted_at = @now, accepted_by_principal_id = @principal_id
            FROM open_workspace
            WHERE invitation.tenant_id = @tenant_id AND invitation.workspace_id = @workspace_id
              AND invitation.invitation_id = @invitation_id AND invitation.status = 'pending'
              AND invitation.target_principal_id = @principal_id
            RETURNING invitation.invitation_id, invitation.role
        ), membership AS (
            INSERT INTO workspace_member (
                workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            SELECT @workspace_id, 'principal', @principal_id, @tenant_id,
                   accepted.role, @principal_id, @now
            FROM accepted
            ON CONFLICT (workspace_id, subject_type, subject_id)
            DO UPDATE SET role = CASE
                WHEN array_position(ARRAY['viewer', 'commenter', 'editor', 'owner'], EXCLUDED.role)
                   > array_position(ARRAY['viewer', 'commenter', 'editor', 'owner'], workspace_member.role)
                THEN EXCLUDED.role ELSE workspace_member.role END
            RETURNING workspace_id
        )
        SELECT invitation_id FROM accepted CROSS JOIN membership
        """;

    /// <summary>Declines the caller's pending invitation.</summary>
    public const string DeclineInvitation = """
        WITH declined AS (
            UPDATE workspace_invitation invitation
            SET status = 'revoked', revoked_at = @now
            WHERE invitation.tenant_id = @tenant_id AND invitation.workspace_id = @workspace_id
              AND invitation.invitation_id = @invitation_id AND invitation.status = 'pending'
              AND invitation.target_principal_id = @principal_id
            RETURNING invitation.invitation_id
        )
        SELECT invitation_id FROM declined
        """;

    /// <summary>
    /// Changes one direct member under a workspace row lock. The predicate protects the personal
    /// owner and requires another recoverable owner before a shared owner is demoted.
    /// </summary>
    public const string ChangeMemberRole = """
        WITH locked_workspace AS MATERIALIZED (
            SELECT w.personal_owner_principal_id
            FROM workspace w
            WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
              AND (EXISTS (SELECT 1 FROM workspace_member caller
                           WHERE caller.tenant_id = w.tenant_id AND caller.workspace_id = w.workspace_id
                             AND caller.role = 'owner'
                             AND ((caller.subject_type = 'principal' AND caller.subject_id = @principal_id)
                               OR (caller.subject_type = 'group' AND EXISTS (
                                   SELECT 1 FROM group_membership gm
                                   WHERE gm.tenant_id = caller.tenant_id AND gm.group_id = caller.subject_id
                                     AND gm.principal_id = @principal_id))))
                OR EXISTS (SELECT 1 FROM tenant_role tr WHERE tr.tenant_id = w.tenant_id
                             AND tr.role = 'admin'
                             AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                               OR (tr.subject_type = 'group' AND EXISTS (
                                   SELECT 1 FROM group_membership gm
                                   WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                     AND gm.principal_id = @principal_id)))))
            FOR UPDATE
        )
        UPDATE workspace_member target SET role = @role, granted_by = @principal_id, granted_at = @now
        FROM locked_workspace w
        WHERE target.tenant_id = @tenant_id AND target.workspace_id = @workspace_id
          AND target.subject_type = 'principal' AND target.subject_id = @target_principal_id
          AND NOT EXISTS (
              SELECT 1 FROM workspace_invitation invitation
              WHERE invitation.tenant_id = target.tenant_id
                AND invitation.workspace_id = target.workspace_id
                AND invitation.target_principal_id = target.subject_id
                AND invitation.status = 'pending')
          AND w.personal_owner_principal_id IS DISTINCT FROM target.subject_id
          AND (w.personal_owner_principal_id IS NULL OR @role <> 'owner')
          AND (@role <> 'owner' OR EXISTS (
              SELECT 1 FROM principal p WHERE p.tenant_id = target.tenant_id
                AND p.principal_id = target.subject_id AND p.kind = 'user' AND p.status = 'active'))
          AND (target.role <> 'owner' OR @role = 'owner' OR EXISTS (
              SELECT 1 FROM workspace_member other
              JOIN principal p ON p.tenant_id = other.tenant_id AND p.principal_id = other.subject_id
              WHERE other.tenant_id = target.tenant_id AND other.workspace_id = target.workspace_id
                AND other.subject_type = 'principal' AND other.role = 'owner'
                AND other.subject_id <> target.subject_id AND p.kind = 'user' AND p.status = 'active'))
        RETURNING target.subject_id
        """;

    /// <summary>Removes a direct member with the same protected-owner and last-owner rules.</summary>
    public const string RemoveMember = """
        WITH locked_workspace AS MATERIALIZED (
            SELECT w.personal_owner_principal_id
            FROM workspace w
            WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
              AND (@self OR EXISTS (SELECT 1 FROM workspace_member caller
                           WHERE caller.tenant_id = w.tenant_id AND caller.workspace_id = w.workspace_id
                             AND caller.role = 'owner'
                             AND ((caller.subject_type = 'principal' AND caller.subject_id = @principal_id)
                               OR (caller.subject_type = 'group' AND EXISTS (
                                   SELECT 1 FROM group_membership gm
                                   WHERE gm.tenant_id = caller.tenant_id AND gm.group_id = caller.subject_id
                                     AND gm.principal_id = @principal_id))))
                OR EXISTS (SELECT 1 FROM tenant_role tr WHERE tr.tenant_id = w.tenant_id
                             AND tr.role = 'admin'
                             AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                               OR (tr.subject_type = 'group' AND EXISTS (
                                   SELECT 1 FROM group_membership gm
                                   WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                     AND gm.principal_id = @principal_id)))))
            FOR UPDATE
        )
        DELETE FROM workspace_member target USING locked_workspace w
        WHERE target.tenant_id = @tenant_id AND target.workspace_id = @workspace_id
          AND target.subject_type = 'principal' AND target.subject_id = @target_principal_id
          AND NOT EXISTS (
              SELECT 1 FROM workspace_invitation invitation
              WHERE invitation.tenant_id = target.tenant_id
                AND invitation.workspace_id = target.workspace_id
                AND invitation.target_principal_id = target.subject_id
                AND invitation.status = 'pending')
          AND (NOT @self OR target.subject_id = @principal_id)
          AND w.personal_owner_principal_id IS DISTINCT FROM target.subject_id
          AND (target.role <> 'owner' OR EXISTS (
              SELECT 1 FROM workspace_member other
              JOIN principal p ON p.tenant_id = other.tenant_id AND p.principal_id = other.subject_id
              WHERE other.tenant_id = target.tenant_id AND other.workspace_id = target.workspace_id
                AND other.subject_type = 'principal' AND other.role = 'owner'
                AND other.subject_id <> target.subject_id AND p.kind = 'user' AND p.status = 'active'))
        RETURNING target.subject_id
        """;

    /// <summary>Tenant-admin recovery converts a personal workspace to shared and installs an active human owner.</summary>
    public const string Recover = """
        WITH administrator AS MATERIALIZED (
            SELECT 1 FROM tenant_role tr
            WHERE tr.tenant_id = @tenant_id AND tr.role = 'admin'
              AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                OR (tr.subject_type = 'group' AND EXISTS (
                    SELECT 1 FROM group_membership gm
                    WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                      AND gm.principal_id = @principal_id)))
        ), locked_workspace AS MATERIALIZED (
            SELECT w.workspace_id
            FROM workspace w
            JOIN principal protected_owner
              ON protected_owner.tenant_id = w.tenant_id
             AND protected_owner.principal_id = w.personal_owner_principal_id
            CROSS JOIN administrator
            WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
              AND protected_owner.kind = 'user' AND protected_owner.status <> 'active'
            FOR UPDATE OF w
        ), replacement AS MATERIALIZED (
            SELECT p.principal_id FROM principal p, locked_workspace
            WHERE p.tenant_id = @tenant_id AND p.principal_id = @target_principal_id
              AND p.kind = 'user' AND p.status = 'active'
        ), converted AS (
            UPDATE workspace w SET personal_owner_principal_id = NULL
            FROM replacement, locked_workspace
            WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
              AND w.workspace_id = locked_workspace.workspace_id
            RETURNING w.workspace_id
        ), membership AS (
            INSERT INTO workspace_member (
                workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            SELECT c.workspace_id, 'principal', r.principal_id, @tenant_id, 'owner', @principal_id, @now
            FROM converted c CROSS JOIN replacement r
            ON CONFLICT (workspace_id, subject_type, subject_id)
            DO UPDATE SET role = 'owner', granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at
        )
        SELECT workspace_id FROM converted
        """;

    /// <summary>
    /// Reads a workspace's stored daily-note settings for a caller who can see the workspace: a
    /// tenant administrator or any direct or group member. No row means not found, so a workspace
    /// the caller cannot read is indistinguishable from one that does not exist.
    /// </summary>
    public const string ReadDailyNoteSettings = """
        SELECT w.daily_notes::text, w.personal_owner_principal_id IS NOT NULL
        FROM workspace w
        WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
          AND (EXISTS (SELECT 1 FROM tenant_role tr
                       WHERE tr.tenant_id = w.tenant_id AND tr.role = 'admin'
                         AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                           OR (tr.subject_type = 'group' AND EXISTS (
                               SELECT 1 FROM group_membership gm
                               WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                 AND gm.principal_id = @principal_id))))
            OR EXISTS (SELECT 1 FROM workspace_member wm
                       WHERE wm.tenant_id = w.tenant_id AND wm.workspace_id = w.workspace_id
                         AND ((wm.subject_type = 'principal' AND wm.subject_id = @principal_id)
                           OR (wm.subject_type = 'group' AND EXISTS (
                               SELECT 1 FROM group_membership gm
                               WHERE gm.tenant_id = wm.tenant_id AND gm.group_id = wm.subject_id
                                 AND gm.principal_id = @principal_id)))))
        """;

    /// <summary>
    /// Replaces a workspace's daily-note settings. It uses the rename rule - a workspace owner or a
    /// tenant administrator - and also always admits the personal owner, so the check is made in the
    /// statement and no client claim enters it.
    /// </summary>
    public const string SaveDailyNoteSettings = """
        UPDATE workspace w SET daily_notes = @settings::jsonb
        WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
          AND (w.personal_owner_principal_id = @principal_id
            OR EXISTS (SELECT 1 FROM workspace_member wm
                       WHERE wm.tenant_id = w.tenant_id AND wm.workspace_id = w.workspace_id
                         AND wm.role = 'owner'
                         AND ((wm.subject_type = 'principal' AND wm.subject_id = @principal_id)
                           OR (wm.subject_type = 'group' AND EXISTS (
                               SELECT 1 FROM group_membership gm
                               WHERE gm.tenant_id = wm.tenant_id AND gm.group_id = wm.subject_id
                                 AND gm.principal_id = @principal_id))))
            OR EXISTS (SELECT 1 FROM tenant_role tr
                       WHERE tr.tenant_id = w.tenant_id AND tr.role = 'admin'
                         AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                           OR (tr.subject_type = 'group' AND EXISTS (
                               SELECT 1 FROM group_membership gm
                               WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                 AND gm.principal_id = @principal_id)))))
        RETURNING workspace_id
        """;

    /// <summary>
    /// The condition, over a <c>workspace w</c> row, that the caller may create daily notes in it.
    /// It mirrors the permission resolver's write rule - an active workspace in which the caller is
    /// a tenant administrator or holds the owner or editor role, directly or through a group - and
    /// then keeps a personal workspace private to its owner, as daily notes always were.
    /// </summary>
    private const string DailyNoteWriter = """
        w.lifecycle_state = 'active'
          AND (EXISTS (SELECT 1 FROM tenant_role tr
                       WHERE tr.tenant_id = w.tenant_id AND tr.role = 'admin'
                         AND ((tr.subject_type = 'principal' AND tr.subject_id = @principal_id)
                           OR (tr.subject_type = 'group' AND EXISTS (
                               SELECT 1 FROM group_membership gm
                               WHERE gm.tenant_id = tr.tenant_id AND gm.group_id = tr.subject_id
                                 AND gm.principal_id = @principal_id))))
            OR EXISTS (SELECT 1 FROM workspace_member wm
                       WHERE wm.tenant_id = w.tenant_id AND wm.workspace_id = w.workspace_id
                         AND wm.role IN ('owner', 'editor')
                         AND ((wm.subject_type = 'principal' AND wm.subject_id = @principal_id)
                           OR (wm.subject_type = 'group' AND EXISTS (
                               SELECT 1 FROM group_membership gm
                               WHERE gm.tenant_id = wm.tenant_id AND gm.group_id = wm.subject_id
                                 AND gm.principal_id = @principal_id)))))
          AND (w.personal_owner_principal_id IS NULL OR w.personal_owner_principal_id = @principal_id)
        """;

    /// <summary>
    /// The condition, over a <c>workspace w</c> row, that daily notes are switched on: the stored
    /// flag when it is a boolean, otherwise the default, which is on only for a personal workspace.
    /// The calendar's daily-note arm shares it, so a switched-off workspace shows no daily chips.
    /// </summary>
    internal const string DailyNoteEnabled = """
        COALESCE(
            CASE WHEN jsonb_typeof(w.daily_notes -> 'enabled') = 'boolean'
                 THEN (w.daily_notes ->> 'enabled')::boolean END,
            w.personal_owner_principal_id IS NOT NULL)
        """;

    /// <summary>
    /// Serializes every daily-note creation in one workspace by taking an advisory lock on the
    /// workspace's deterministic root identifier, so two concurrent opens cannot race to create the
    /// root, a folder or the same note.
    /// </summary>
    public const string LockDailyNote = "SELECT pg_advisory_xact_lock(hashtextextended(@item_id::text, 0))";

    /// <summary>
    /// Authorises the caller to use daily notes in the workspace, locks the workspace row, and
    /// reports what creation needs to know: the stored settings, whether the workspace is personal,
    /// and the day's note slot with whether a note already occupies it. No row means the caller
    /// cannot write the workspace, or it does not exist.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>@candidate_ids</c> are the day's deterministic identifiers in generation order. A
    /// candidate is <em>ours</em> when it is held by a note of this workspace in any state but
    /// purged; a purged note is terminal and a note moved to another workspace is no longer this
    /// day's, so each retires its identifier. The slot is the highest-generation candidate that is
    /// ours - the day's newest note, so a lower identifier that becomes ours again (its note moved
    /// back) or free again (its workspace purged) never displaces the note that has been in use
    /// since. With none ours, the slot is the first free candidate above every taken one, so a hole
    /// that reopens below a retired identifier is never reused. A trashed or locked note is ours, so
    /// the open reports it rather than filing a duplicate. A null slot means every candidate is
    /// taken: 64 purges or moves of one day's note, which only a writer of this workspace can do,
    /// and which is reported as unavailable rather than recovered silently.
    /// </para>
    /// <para>
    /// The probe reads <c>item</c> rows of every workspace in the tenant - row-level security is
    /// tenant-wide - because a candidate held elsewhere must retire. Nothing about such a row leaves
    /// the statement: the only output is which of this workspace's own derived identifiers is the
    /// slot, so it discloses neither where the row is nor whether it still exists.
    /// </para>
    /// </remarks>
    public const string DailyNoteContext = $$"""
        SELECT w.daily_notes::text, w.personal_owner_principal_id IS NOT NULL, slot.id, slot.present
        FROM workspace w
        LEFT JOIN LATERAL (
            WITH candidates AS (
                SELECT candidate.id, candidate.generation, note.id IS NOT NULL AS taken,
                       COALESCE(note.workspace_id = w.workspace_id
                                AND note.lifecycle_state <> 'purged', false) AS ours
                FROM unnest(@candidate_ids::uuid[]) WITH ORDINALITY AS candidate(id, generation)
                LEFT JOIN item note ON note.tenant_id = w.tenant_id AND note.id = candidate.id
            )
            SELECT id, taken AS present
            FROM candidates
            WHERE ours
               OR (NOT taken
                   AND generation > COALESCE((SELECT max(generation) FROM candidates WHERE taken), 0))
            ORDER BY ours DESC, CASE WHEN ours THEN -generation ELSE generation END
            LIMIT 1
        ) slot ON true
        WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
          AND {{DailyNoteWriter}}
        FOR UPDATE OF w
        """;

    /// <summary>
    /// Explains why an existing dated note could not be opened: <c>trash</c> when the note or an
    /// ancestor is soft-deleted, <c>locked</c> when an ancestor carries a lock the caller's
    /// credential has not opened, and <c>unavailable</c> for anything else. Trash is reported before
    /// a lock because restoring is the step that has to come first. The writer condition is
    /// repeated so the statement describes nothing outside a workspace the caller may write.
    /// </summary>
    public const string DailyNoteBlocker = $$"""
        SELECT CASE
                 WHEN n.lifecycle_state = 'deleted' OR EXISTS (
                     SELECT 1 FROM item_closure edge
                     JOIN item ancestor ON ancestor.tenant_id = edge.tenant_id AND ancestor.id = edge.ancestor_id
                     WHERE edge.tenant_id = @tenant_id AND edge.descendant_id = n.id AND edge.depth > 0
                       AND ancestor.lifecycle_state = 'deleted') THEN 'trash'
                 WHEN EXISTS (
                     SELECT 1 FROM item_closure edge
                     JOIN item_lock locked ON locked.tenant_id = edge.tenant_id AND locked.item_id = edge.ancestor_id
                     WHERE edge.tenant_id = @tenant_id AND edge.descendant_id = n.id AND edge.depth > 0
                       AND NOT EXISTS (
                           SELECT 1 FROM item_unlock grant_row
                           WHERE grant_row.tenant_id = @tenant_id AND grant_row.item_id = locked.item_id
                             AND grant_row.credential_id = @credential_id AND grant_row.expires_at > @now))
                   THEN 'locked'
                 ELSE 'unavailable'
               END
        FROM item n
        JOIN workspace w ON w.tenant_id = n.tenant_id AND w.workspace_id = n.workspace_id
        WHERE n.tenant_id = @tenant_id AND n.workspace_id = @workspace_id AND n.id = @item_id
          AND {{DailyNoteWriter}}
        """;

    /// <summary>
    /// Picks which generation of a daily-notes container - the root, a year folder or a month
    /// folder - the open uses, by the same rule as <see cref="DailyNoteContext"/> uses for the note:
    /// the newest candidate that is ours, else the first free one above every taken one. No row
    /// means every candidate is taken.
    /// </summary>
    /// <remarks>
    /// A container is ours when it is in this workspace, not purged, and still sits under the
    /// parent the tree needs (<c>@parent_id</c>; null for the root). Purging a container is terminal
    /// and moves its children up a level, so a purged root leaves its year folders at the top of the
    /// workspace: they are no longer where the tree needs them, retire, and the tree starts anew
    /// under the next generation. A trashed or locked container is still ours, so the open reports
    /// it rather than building a second tree beside it. Like the note probe, this reads candidate
    /// rows across the tenant and returns only one of this workspace's own derived identifiers.
    /// </remarks>
    public const string DailyNoteContainerSlot = $$"""
        WITH candidates AS (
            SELECT candidate.id, candidate.generation, held.id IS NOT NULL AS taken,
                   COALESCE(held.workspace_id = @workspace_id
                            AND held.lifecycle_state <> 'purged'
                            AND held.parent_id IS NOT DISTINCT FROM @parent_id, false) AS ours
            FROM unnest(@candidate_ids::uuid[]) WITH ORDINALITY AS candidate(id, generation)
            LEFT JOIN item held ON held.tenant_id = @tenant_id AND held.id = candidate.id
        )
        SELECT c.id
        FROM candidates c
        JOIN workspace w ON w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
        WHERE {{DailyNoteWriter}}
          AND (c.ours
               OR (NOT c.taken
                   AND c.generation > COALESCE((SELECT max(generation) FROM candidates WHERE taken), 0)))
        ORDER BY c.ours DESC, CASE WHEN c.ours THEN -c.generation ELSE c.generation END
        LIMIT 1
        """;

    /// <summary>
    /// Idempotently creates one container of the daily-notes tree - the root, a year folder or a
    /// month folder - and returns its lifecycle state. A null parent makes the root, as the personal
    /// provisioner does; otherwise the parent must be active in the same workspace. The writer and
    /// enabled conditions are repeated here so the statement creates nothing for anyone else even if
    /// a caller skipped <see cref="DailyNoteContext"/>. An existing container is left untouched, and
    /// a trashed one is reported as it is rather than resurrected.
    /// </summary>
    public const string EnsureDailyNoteContainer = $$"""
        WITH authorized AS MATERIALIZED (
            SELECT w.workspace_id
            FROM workspace w
            WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
              AND {{DailyNoteWriter}}
              AND {{DailyNoteEnabled}}
        ), parent AS MATERIALIZED (
            SELECT p.id
            FROM item p
            WHERE p.tenant_id = @tenant_id AND p.workspace_id = @workspace_id
              AND p.id = @parent_id AND p.lifecycle_state = 'active'
              AND p.template_id IS NULL
              AND NOT EXISTS (
                  SELECT 1 FROM item_closure edge
                  JOIN item ancestor ON ancestor.tenant_id = edge.tenant_id AND ancestor.id = edge.ancestor_id
                  WHERE edge.tenant_id = @tenant_id AND edge.descendant_id = p.id
                    AND (ancestor.lifecycle_state <> 'active' OR ancestor.template_id IS NOT NULL
                         OR EXISTS (
                             SELECT 1 FROM item_lock locked
                             WHERE locked.tenant_id = @tenant_id AND locked.item_id = ancestor.id
                               AND NOT EXISTS (
                                   SELECT 1 FROM item_unlock grant_row
                                   WHERE grant_row.tenant_id = @tenant_id AND grant_row.item_id = locked.item_id
                                     AND grant_row.credential_id = @credential_id AND grant_row.expires_at > @now)))
              )
        ), inserted AS (
            INSERT INTO item (
                id, tenant_id, workspace_id, type, parent_id, seq, properties,
                lifecycle_state, created_by, last_modified_by, created_at, last_modified_at)
            SELECT @item_id, @tenant_id, @workspace_id, 'note', @parent_id,
                   CASE WHEN @parent_id IS NULL THEN 0
                        ELSE COALESCE((SELECT max(seq) + 1000 FROM item sibling
                                       WHERE sibling.tenant_id = @tenant_id
                                         AND sibling.workspace_id = @workspace_id
                                         AND sibling.parent_id = @parent_id), 1000) END,
                   jsonb_build_object('title', @title), 'active',
                   @principal_id, @principal_id, @now, @now
            FROM authorized a
            WHERE @parent_id IS NULL OR EXISTS (SELECT 1 FROM parent)
            ON CONFLICT (id) DO NOTHING
            RETURNING id
        ), closure AS (
            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT i.id, i.id, @tenant_id, @workspace_id, 0 FROM inserted i
            UNION ALL
            SELECT i.id, up.ancestor_id, @tenant_id, @workspace_id, up.depth + 1
            FROM inserted i
            JOIN item_closure up ON up.descendant_id = @parent_id AND up.tenant_id = @tenant_id
            ON CONFLICT (descendant_id, ancestor_id) DO NOTHING
        )
        SELECT 'active' FROM inserted
        UNION ALL
        SELECT existing.lifecycle_state
        FROM item existing
        WHERE existing.tenant_id = @tenant_id AND existing.workspace_id = @workspace_id
          AND existing.id = @item_id AND EXISTS (SELECT 1 FROM authorized)
              AND existing.template_id IS NULL
              AND NOT EXISTS (
                  SELECT 1 FROM item_closure edge
                  JOIN item ancestor ON ancestor.tenant_id = edge.tenant_id AND ancestor.id = edge.ancestor_id
                  WHERE edge.tenant_id = @tenant_id AND edge.descendant_id = existing.id
                    AND (ancestor.lifecycle_state <> 'active' OR ancestor.template_id IS NOT NULL
                         OR EXISTS (
                             SELECT 1 FROM item_lock locked
                             WHERE locked.tenant_id = @tenant_id AND locked.item_id = ancestor.id
                               AND NOT EXISTS (
                                   SELECT 1 FROM item_unlock grant_row
                                   WHERE grant_row.tenant_id = @tenant_id AND grant_row.item_id = locked.item_id
                                     AND grant_row.credential_id = @credential_id AND grant_row.expires_at > @now)))
              )
        LIMIT 1
        """;

    /// <summary>
    /// Idempotently opens the dated note under the given parent and returns its identifier and
    /// whether this statement created it. An existing note is returned where it is, untouched except
    /// that a missing <c>$daily</c> marker is added; the parent, title and folders of a new note
    /// follow the settings at creation, and no later settings change moves it. The writer and
    /// enabled conditions are part of the statement.
    /// </summary>
    public const string OpenDailyNote = $$"""
        WITH authorized AS MATERIALIZED (
            SELECT w.workspace_id
            FROM workspace w
            WHERE w.tenant_id = @tenant_id AND w.workspace_id = @workspace_id
              AND {{DailyNoteWriter}}
              AND {{DailyNoteEnabled}}
        ), existing AS MATERIALIZED (
            SELECT n.id
            FROM item n
            WHERE n.tenant_id = @tenant_id AND n.workspace_id = @workspace_id AND n.id = @item_id
              AND n.lifecycle_state = 'active'
              AND EXISTS (SELECT 1 FROM authorized)
              AND n.template_id IS NULL
              AND NOT EXISTS (
                  SELECT 1 FROM item_closure edge
                  JOIN item ancestor ON ancestor.tenant_id = edge.tenant_id AND ancestor.id = edge.ancestor_id
                  WHERE edge.tenant_id = @tenant_id AND edge.descendant_id = n.id AND edge.depth > 0
                    AND (ancestor.lifecycle_state <> 'active' OR ancestor.template_id IS NOT NULL
                         OR EXISTS (
                             SELECT 1 FROM item_lock locked
                             WHERE locked.tenant_id = @tenant_id AND locked.item_id = ancestor.id
                               AND NOT EXISTS (
                                   SELECT 1 FROM item_unlock grant_row
                                   WHERE grant_row.tenant_id = @tenant_id AND grant_row.item_id = locked.item_id
                                     AND grant_row.credential_id = @credential_id AND grant_row.expires_at > @now)))
              )
        ), parent AS MATERIALIZED (
            SELECT p.id
            FROM item p
            WHERE p.tenant_id = @tenant_id AND p.workspace_id = @workspace_id
              AND p.id = @parent_id AND p.lifecycle_state = 'active'
              AND p.template_id IS NULL
              AND NOT EXISTS (
                  SELECT 1 FROM item_closure edge
                  JOIN item ancestor ON ancestor.tenant_id = edge.tenant_id AND ancestor.id = edge.ancestor_id
                  WHERE edge.tenant_id = @tenant_id AND edge.descendant_id = p.id
                    AND (ancestor.lifecycle_state <> 'active' OR ancestor.template_id IS NOT NULL
                         OR EXISTS (
                             SELECT 1 FROM item_lock locked
                             WHERE locked.tenant_id = @tenant_id AND locked.item_id = ancestor.id
                               AND NOT EXISTS (
                                   SELECT 1 FROM item_unlock grant_row
                                   WHERE grant_row.tenant_id = @tenant_id AND grant_row.item_id = locked.item_id
                                     AND grant_row.credential_id = @credential_id AND grant_row.expires_at > @now)))
              )
        ), inserted AS (
            INSERT INTO item (
                id, tenant_id, workspace_id, type, parent_id, seq, properties,
                lifecycle_state, created_by, last_modified_by, created_at, last_modified_at)
            SELECT @item_id, @tenant_id, @workspace_id, 'note', p.id,
                   COALESCE((SELECT max(seq) + 1000 FROM item sibling
                             WHERE sibling.tenant_id = @tenant_id AND sibling.workspace_id = @workspace_id
                               AND sibling.parent_id = p.id), 1000),
                   jsonb_build_object('title', @title, '$daily', @date), 'active',
                   @principal_id, @principal_id, @now, @now
            FROM authorized a CROSS JOIN parent p
            WHERE NOT EXISTS (SELECT 1 FROM existing)
            ON CONFLICT (id) DO NOTHING
            RETURNING id
        ), closure AS (
            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT i.id, i.id, @tenant_id, @workspace_id, 0 FROM inserted i
            UNION ALL
            SELECT i.id, up.ancestor_id, @tenant_id, @workspace_id, up.depth + 1
            FROM inserted i
            JOIN item_closure up ON up.descendant_id = @parent_id AND up.tenant_id = @tenant_id
            ON CONFLICT (descendant_id, ancestor_id) DO NOTHING
        ), marked AS (
            UPDATE item n SET properties = n.properties || jsonb_build_object('$daily', @date)
            FROM existing e
            WHERE n.id = e.id AND n.tenant_id = @tenant_id AND n.workspace_id = @workspace_id
              AND NOT jsonb_exists(n.properties, '$daily')
            RETURNING n.id
        )
        SELECT id, true FROM inserted
        UNION ALL
        SELECT id, false FROM existing
        LIMIT 1
        """;
}
