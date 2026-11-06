namespace Nix.Persistence.Migrations;

/// <summary>
/// [SEC] Tenant isolation and grants for the agent-records tables: <c>item_reference</c>,
/// <c>public_link</c> and <c>record_key</c>.
/// </summary>
/// <remarks>
/// Frozen to the migration that applies it. The runtime role gets full DML and no other role gets
/// anything: the collaboration service reaches public notes through Core, not through these tables.
/// </remarks>
internal static class AgentRecordsSecuritySql
{
    private static readonly string[] Tables = ["item_reference", "public_link", "record_key"];

    /// <summary>Emits the policies and grants.</summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    internal static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        foreach (var table in Tables)
        {
            emit($"""
                ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;
                ALTER TABLE {table} FORCE ROW LEVEL SECURITY;

                DROP POLICY IF EXISTS {table}_tenant_isolation ON {table};
                CREATE POLICY {table}_tenant_isolation ON {table}
                    USING (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid)
                    WITH CHECK (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid);

                REVOKE ALL ON {table} FROM PUBLIC;
                GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO nix_app;
                """);
        }
    }

    /// <summary>The tables go with the generated Down; nothing else to undo.</summary>
    /// <param name="emit">Unused.</param>
    internal static void Revert(Action<string> emit) => ArgumentNullException.ThrowIfNull(emit);
}
