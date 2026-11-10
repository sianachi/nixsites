namespace Nix.Persistence.Sql.Statements;

/// <summary>Setting, checking and removing workspace passwords, and the grants past them.</summary>
public static class WorkspaceLockSql
{
    /// <summary>
    /// The clause both authorization statements append: the workspace has no password, or the
    /// credential holds an unexpired grant. Binds <c>@tenant_id</c>, <c>@credential_id</c> (null
    /// matches nothing, so a request with no credential is closed out) and <c>@now</c>. Expects the
    /// workspace row aliased <c>workspace</c>.
    /// </summary>
    public const string WorkspaceIsOpen = """
        (NOT EXISTS (
            SELECT 1 FROM workspace_lock closed
            WHERE closed.tenant_id = workspace.tenant_id
              AND closed.workspace_id = workspace.workspace_id)
         OR EXISTS (
            SELECT 1 FROM workspace_unlock opened
            WHERE opened.tenant_id = workspace.tenant_id
              AND opened.workspace_id = workspace.workspace_id
              AND opened.credential_id = @credential_id
              AND opened.expires_at > @now))
        """;

    /// <summary>
    /// A principal that is a public form's own submission identity: a service principal Core made
    /// for one published form link, reachable only through that link. It cannot sign in or hold a
    /// credential, so a workspace password cannot apply to it; the form's owner published the form
    /// into the workspace on purpose. Binds <c>@tenant_id</c> and <c>@principal_id</c>.
    /// </summary>
    public const string IsPublicFormPrincipal = """
        EXISTS (
            SELECT 1 FROM principal form_principal
            WHERE form_principal.tenant_id = @tenant_id
              AND form_principal.principal_id = @principal_id
              AND form_principal.kind = 'service'
              AND form_principal.external_subject LIKE 'nix:public-form:%')
        """;

    /// <summary>Lock state for a set of workspaces: only those with a password come back.</summary>
    public const string States = """
        SELECT lock_row.workspace_id,
               (SELECT max(opened.expires_at) FROM workspace_unlock opened
                WHERE opened.tenant_id = lock_row.tenant_id
                  AND opened.workspace_id = lock_row.workspace_id
                  AND opened.credential_id = @credential_id
                  AND opened.expires_at > @now)
        FROM workspace_lock lock_row
        WHERE lock_row.tenant_id = @tenant_id AND lock_row.workspace_id = ANY(@workspace_ids)
        """;

    /// <summary>The stored verifier, or no row.</summary>
    public const string Verifier = """
        SELECT password_hash FROM workspace_lock
        WHERE tenant_id = @tenant_id AND workspace_id = @workspace_id
        """;

    /// <summary>
    /// The verifier, only for a workspace a non-member could join: active, open to new members and
    /// with a password. One row or none, so nothing distinguishes the reasons.
    /// </summary>
    public const string JoinVerifier = """
        SELECT lock_row.password_hash
        FROM workspace_lock lock_row
        JOIN workspace
          ON workspace.tenant_id = lock_row.tenant_id AND workspace.workspace_id = lock_row.workspace_id
        WHERE lock_row.tenant_id = @tenant_id AND lock_row.workspace_id = @workspace_id
          AND workspace.lifecycle_state = 'active' AND NOT workspace.membership_locked
        """;

    /// <summary>Sets a password; nothing when one exists.</summary>
    public const string Lock = """
        INSERT INTO workspace_lock (workspace_id, tenant_id, password_hash, locked_by, locked_at)
        VALUES (@workspace_id, @tenant_id, @password_hash, @principal_id, @now)
        ON CONFLICT (workspace_id) DO NOTHING
        """;

    /// <summary>Replaces the verifier only if it still is the expected one.</summary>
    public const string ChangeVerifier = """
        UPDATE workspace_lock
        SET password_hash = @password_hash, locked_by = @principal_id, locked_at = @now
        WHERE tenant_id = @tenant_id AND workspace_id = @workspace_id AND password_hash = @expected_hash
        """;

    /// <summary>Drops every grant; run with <see cref="ChangeVerifier"/> in the same transaction.</summary>
    public const string RevokeAll = """
        DELETE FROM workspace_unlock WHERE tenant_id = @tenant_id AND workspace_id = @workspace_id
        """;

    /// <summary>Removes the password; grants go by cascade.</summary>
    public const string Remove = """
        DELETE FROM workspace_lock
        WHERE tenant_id = @tenant_id AND workspace_id = @workspace_id AND password_hash = @expected_hash
        """;

    /// <summary>Issues or extends one credential's grant while the verifier is unchanged; sweeps expired grants.</summary>
    public const string Grant = """
        DELETE FROM workspace_unlock
        WHERE (workspace_id, credential_id) IN (
            SELECT workspace_id, credential_id FROM workspace_unlock
            WHERE tenant_id = @tenant_id AND expires_at <= @now
            FOR UPDATE SKIP LOCKED);

        INSERT INTO workspace_unlock (workspace_id, credential_id, tenant_id, principal_id, expires_at)
        SELECT lock_row.workspace_id, @credential_id, lock_row.tenant_id, @principal_id, @expires_at
        FROM workspace_lock lock_row
        WHERE lock_row.tenant_id = @tenant_id
          AND lock_row.workspace_id = @workspace_id
          AND lock_row.password_hash = @password_hash
        FOR SHARE
        ON CONFLICT (workspace_id, credential_id)
        DO UPDATE SET expires_at = EXCLUDED.expires_at, principal_id = EXCLUDED.principal_id
        """;

    /// <summary>Whether the credential holds an unexpired grant.</summary>
    public const string HoldsGrant = """
        SELECT EXISTS (
            SELECT 1 FROM workspace_unlock
            WHERE tenant_id = @tenant_id AND workspace_id = @workspace_id
              AND credential_id = @credential_id AND expires_at > @now)
        """;

    /// <summary>Ends one credential's grant.</summary>
    public const string Revoke = """
        DELETE FROM workspace_unlock
        WHERE tenant_id = @tenant_id AND workspace_id = @workspace_id AND credential_id = @credential_id
        """;

    /// <summary>
    /// Adds an active human as a viewer while the lock still carries the checked verifier and the
    /// workspace is active and open to new members. The row lock on the workspace makes a
    /// concurrent close of membership wait for this join or win before it. An existing grant is
    /// left alone. Audited only when a row was added.
    /// </summary>
    public const string Join = """
        WITH open_workspace AS MATERIALIZED (
            SELECT workspace.workspace_id
            FROM workspace
            JOIN workspace_lock lock_row
              ON lock_row.tenant_id = workspace.tenant_id AND lock_row.workspace_id = workspace.workspace_id
            WHERE workspace.tenant_id = @tenant_id AND workspace.workspace_id = @workspace_id
              AND workspace.lifecycle_state = 'active' AND NOT workspace.membership_locked
              AND lock_row.password_hash = @password_hash
              AND EXISTS (SELECT 1 FROM principal p
                          WHERE p.tenant_id = @tenant_id AND p.principal_id = @principal_id
                            AND p.kind = 'user' AND p.status = 'active')
            FOR SHARE OF workspace
        ), membership AS (
            INSERT INTO workspace_member (
                workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            SELECT workspace_id, 'principal', @principal_id, @tenant_id, 'viewer', @principal_id, @now
            FROM open_workspace
            ON CONFLICT (workspace_id, subject_type, subject_id) DO NOTHING
            RETURNING workspace_id
        ), audited AS (
            INSERT INTO audit_event
                (event_id, tenant_id, workspace_id, actor_id, action, subject_id, subject_type, after, occurred_at)
            SELECT gen_random_uuid(), @tenant_id, workspace_id, @principal_id, 'workspace.member_joined',
                   @principal_id, 'principal', jsonb_build_object('role', 'viewer', 'via', 'password'), @now
            FROM membership
        )
        SELECT EXISTS (SELECT 1 FROM open_workspace)
        """;

    /// <summary>Records a password change in the audit log.</summary>
    public const string Audit = """
        INSERT INTO audit_event
            (event_id, tenant_id, workspace_id, actor_id, action, subject_id, subject_type, after, occurred_at)
        VALUES (gen_random_uuid(), @tenant_id, @workspace_id, @principal_id, 'workspace.password_' || @audit_action,
                @workspace_id, 'workspace', '{}'::jsonb, @now)
        """;
}
