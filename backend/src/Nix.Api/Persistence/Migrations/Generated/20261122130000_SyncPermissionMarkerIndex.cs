using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>
/// Lets the native sync boundary find a permission marker (no item) past a cursor without reading
/// every change marker of the workspace.
/// </summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261122130000_SyncPermissionMarkerIndex")]
public sealed class SyncPermissionMarkerIndex : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) =>
        // Partial: permission markers are rare next to item markers. Built concurrently, as its own
        // statement outside a transaction. RLS and the grants of the table apply to it unchanged.
        migrationBuilder.Sql(
            """
            CREATE INDEX CONCURRENTLY IF NOT EXISTS workspace_sync_change_permission
                ON workspace_sync_change (tenant_id, workspace_id, seq)
                WHERE item_id IS NULL;
            """,
            suppressTransaction: true);

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) =>
        migrationBuilder.Sql("DROP INDEX IF EXISTS workspace_sync_change_permission;");
}
