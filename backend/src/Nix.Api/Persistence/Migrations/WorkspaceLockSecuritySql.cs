namespace Nix.Persistence.Migrations;

/// <summary>
/// Hand-written security DDL for <c>workspace_lock</c> and <c>workspace_unlock</c>: tenant
/// isolation, the grants, and the bound on the verifier.
/// </summary>
/// <remarks>
/// [SEC] Adds two tenant-isolated tables that gate every workspace read for members. An
/// authorization change: requires security review and owner approval before merge. Same shape as
/// <c>ItemLockSecuritySql</c>, which it copies rather than edits.
/// </remarks>
internal static class WorkspaceLockSecuritySql
{
    private const string ApplicationRole = "nix_app";
    private const string CollaborationRole = "nix_collab";

    /// <summary>Emits every statement, in dependency order.</summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    internal static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        Protect(emit, "workspace_lock");
        Protect(emit, "workspace_unlock");

        // Core alone reads and writes both tables. The collaboration service authorizes through
        // Core and gets no grant at all, so a compromise of it yields no verifier to attack.
        emit($"""
            REVOKE ALL ON workspace_lock FROM PUBLIC;
            REVOKE ALL ON workspace_unlock FROM PUBLIC;
            GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_lock TO {ApplicationRole};
            GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_unlock TO {ApplicationRole};
            REVOKE ALL ON workspace_lock FROM {CollaborationRole};
            REVOKE ALL ON workspace_unlock FROM {CollaborationRole};
            """);

        emit("""
            ALTER TABLE workspace_lock ADD CONSTRAINT workspace_lock_password_hash_bounded
                CHECK (char_length(password_hash) BETWEEN 32 AND 256);
            """);
    }

    private static void Protect(Action<string> emit, string table) =>
        emit($"""
            ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;
            ALTER TABLE {table} FORCE ROW LEVEL SECURITY;

            DROP POLICY IF EXISTS {table}_tenant_isolation ON {table};
            CREATE POLICY {table}_tenant_isolation ON {table}
                USING (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid)
                WITH CHECK (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid);
            """);
}
