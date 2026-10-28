namespace Nix.Persistence.Sql.Statements;

/// <summary>Conflict-safe writes for one first-login personal workspace.</summary>
public static class ProvisioningSql
{
    /// <summary>Creates the deterministic principal and reports whether this request won.</summary>
    public const string InsertPrincipal = """
        INSERT INTO principal
            (principal_id, tenant_id, external_subject, external_issuer, kind, display_name,
             email, email_normalized, email_verified, status, can_manage_templates)
        VALUES
            (@principal_id, @tenant_id, @subject, @issuer, 'user', @display_name,
             @email, @email_normalized, @email_verified, 'active', false)
        -- Both the issuer-qualified identity and its deterministic UUID are uniqueness guards.
        -- Catch either conflict: PostgreSQL may report the primary-key arbiter first when two
        -- first-login transactions race. ReadPrincipal below still requires the exact external
        -- identity, so an impossible UUID collision fails the invariant rather than admitting it.
        ON CONFLICT DO NOTHING
        RETURNING true
        """;

    /// <summary>Refreshes only the active human bound to the validated external identity.</summary>
    public const string RefreshEmail = """
        UPDATE principal
           SET email = @email, email_normalized = @email_normalized,
               email_verified = @email_verified
         WHERE tenant_id = @tenant_id AND principal_id = @principal_id
           AND external_issuer = @issuer AND external_subject = @subject
           AND kind = 'user' AND status = 'active'
        """;

    /// <summary>Finds the exact identity after a concurrent winner commits.</summary>
    public const string ReadPrincipal = """
        SELECT principal_id, tenant_id, status, kind, display_name
          FROM principal
         WHERE tenant_id = @tenant_id
           AND external_issuer = @issuer
           AND external_subject = @subject
         LIMIT 1
        """;

    /// <summary>Creates and returns the one personal workspace.</summary>
    public const string InsertWorkspace = """
        INSERT INTO workspace
            (workspace_id, tenant_id, name, personal_owner_principal_id,
             version_retention_days, coalesce_window_min, storage_quota_bytes, created_at)
        VALUES
            (@workspace_id, @tenant_id, @workspace_name, @principal_id,
             90, 10, 10737418240, @now)
        ON CONFLICT DO NOTHING;

        SELECT workspace_id
          FROM workspace
         WHERE tenant_id = @tenant_id
           AND personal_owner_principal_id = @principal_id
         LIMIT 1
        """;

    /// <summary>Creates the protected owner membership and Daily Notes root.</summary>
    public const string SeedWorkspace = """
        INSERT INTO workspace_member
            (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
        VALUES
            (@workspace_id, 'principal', @principal_id, @tenant_id, 'owner', @principal_id, @now)
        ON CONFLICT (workspace_id, subject_type, subject_id) DO UPDATE
           SET role = 'owner', granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at;

        INSERT INTO item
            (id, tenant_id, workspace_id, type, parent_id, seq, properties, schema, views,
             lifecycle_state, created_by, last_modified_by, created_at, last_modified_at)
        VALUES
            (@daily_root_id, @tenant_id, @workspace_id, 'note', NULL, 0,
             '{"title":"Daily notes"}'::jsonb, NULL, NULL, 'active',
             @principal_id, @principal_id, @now, @now)
        ON CONFLICT (id) DO NOTHING;

        INSERT INTO item_closure
            (tenant_id, workspace_id, ancestor_id, descendant_id, depth)
        VALUES
            (@tenant_id, @workspace_id, @daily_root_id, @daily_root_id, 0)
        ON CONFLICT (ancestor_id, descendant_id) DO NOTHING
        """;

    /// <summary>Creates the three shipped preset catalog entries and hidden roots.</summary>
    public const string SeedPresets = """
        WITH preset(template_id, root_id, source_id, stable_key, title, description,
                    schema_json, views_json) AS (
            VALUES
            (@kanban_template_id::uuid, @kanban_root_id::uuid, @kanban_source_id::uuid,
             'seed.kanban', 'Kanban', 'A To do, Doing, and Done workflow.',
             '{"inherit":true,"properties":[{"key":"status","label":"Status","type":"select","options":["To do","Doing","Done"],"required":false}]}'::jsonb,
             '{"views":[{"id":"board","name":"Board","kind":"board","columns":["title","status"],"groupBy":"status","groupOrder":["To do","Doing","Done"],"sortDescending":false}],"default":"board"}'::jsonb),
            (@calendar_template_id::uuid, @calendar_root_id::uuid, @calendar_source_id::uuid,
             'seed.calendar', 'Calendar', 'A week calendar backed by a Starts timestamp.',
             '{"inherit":true,"properties":[{"key":"starts","label":"Starts","type":"timestamp","required":false}]}'::jsonb,
             '{"views":[{"id":"calendar","name":"Calendar","kind":"calendar","columns":["title","starts"],"dateProperty":"starts","mode":"week","sortDescending":false}],"default":"calendar"}'::jsonb),
            (@list_template_id::uuid, @list_root_id::uuid, @list_source_id::uuid,
             'seed.list', 'List', 'A list with Done and Owner fields.',
             '{"inherit":true,"properties":[{"key":"done","label":"Done","type":"checkbox","required":false},{"key":"owner","label":"Owner","type":"text","required":false}]}'::jsonb,
             '{"views":[{"id":"list","name":"All","kind":"list","columns":["title","done","owner"],"sortDescending":false}],"default":"list"}'::jsonb)
        ), inserted_catalog AS (
            INSERT INTO workspace_template
                (template_id, tenant_id, workspace_id, stable_key, profile_key, origin,
                 title, description, include_body, include_children, state, revision,
                 created_by, last_modified_by, created_at, last_modified_at)
            SELECT template_id, @tenant_id, @workspace_id, stable_key, stable_key, 'seed',
                   title, description, false, false, 'active', 1,
                   @principal_id, @principal_id, @now, @now
              FROM preset
            ON CONFLICT (tenant_id, workspace_id, stable_key) DO NOTHING
            RETURNING template_id
        ), inserted_item AS (
            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, schema, views,
                 template_id, template_source_id, lifecycle_state, created_by, last_modified_by,
                 created_at, last_modified_at)
            SELECT root_id, @tenant_id, @workspace_id, 'note', NULL, 0,
                   jsonb_build_object('title', title), schema_json, views_json,
                   template_id, source_id, 'active', @principal_id, @principal_id, @now, @now
              FROM preset
            ON CONFLICT (id) DO NOTHING
            RETURNING id, template_id
        ), inserted_closure AS (
            INSERT INTO item_closure
                (tenant_id, workspace_id, ancestor_id, descendant_id, depth)
            SELECT @tenant_id, @workspace_id, id, id, 0
              FROM inserted_item
            ON CONFLICT (ancestor_id, descendant_id) DO NOTHING
        )
        UPDATE workspace_template catalog
           SET root_item_id = preset.root_id
          FROM preset
         WHERE catalog.tenant_id = @tenant_id
           AND catalog.workspace_id = @workspace_id
           AND catalog.template_id = preset.template_id
           AND catalog.root_item_id IS NULL
        """;

    /// <summary>Audits the three durable facts created by first-login provisioning.</summary>
    public const string InsertFoundationAudit = """
        INSERT INTO audit_event
            (event_id, tenant_id, workspace_id, actor_id, action, subject_id,
             subject_type, after, occurred_at)
        VALUES
            (@principal_event_id, @tenant_id, NULL, @principal_id, 'principal.provisioned',
             @principal_id, 'principal', jsonb_build_object('kind', 'user'), @now),
            (@workspace_event_id, @tenant_id, @workspace_id, @principal_id, 'workspace.created',
             @workspace_id, 'workspace', jsonb_build_object('kind', 'personal'), @now),
            (@ownership_event_id, @tenant_id, @workspace_id, @principal_id,
             'workspace.ownership_granted', @principal_id, 'principal',
             jsonb_build_object('role', 'owner'), @now)
        """;
}
