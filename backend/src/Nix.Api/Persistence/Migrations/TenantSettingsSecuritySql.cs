namespace Nix.Persistence.Migrations;

/// <summary>
/// The tenant's own switches for remote MCP and public links. Both default on, so behaviour is
/// unchanged until an administrator turns one off.
/// </summary>
/// <remarks>
/// The <c>tenant</c> table keeps its tenant isolation policy and the application's full DML grant
/// (see <c>NixTables.ExpectedApplicationPrivileges</c>); a column adds nothing to either.
/// </remarks>
internal static class TenantSettingsSecuritySql
{
    /// <summary>Adds the columns.</summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    internal static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            ALTER TABLE tenant
                ADD COLUMN mcp_enabled boolean NOT NULL DEFAULT true,
                ADD COLUMN public_links_enabled boolean NOT NULL DEFAULT true;
            """);
    }

    /// <summary>Drops the columns.</summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    internal static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("ALTER TABLE tenant DROP COLUMN public_links_enabled, DROP COLUMN mcp_enabled;");
    }
}
