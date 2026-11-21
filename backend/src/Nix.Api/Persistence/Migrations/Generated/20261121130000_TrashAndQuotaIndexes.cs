using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>
/// Serves the Trash page and the workspace list's storage total from an index instead of a scan of
/// every item or file version the tenant holds.
/// </summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261121130000_TrashAndQuotaIndexes")]
public sealed class TrashAndQuotaIndexes : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        // Built concurrently, so a large tenant's writes are not blocked while it runs. Each
        // statement is its own call, because CONCURRENTLY cannot share a transaction.
        migrationBuilder.Sql(
            """
            CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_item_trash
                ON item (tenant_id, workspace_id, last_modified_at DESC, id DESC)
                WHERE lifecycle_state = 'deleted';
            """,
            suppressTransaction: true);
        migrationBuilder.Sql(
            """
            CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_file_version_workspace_bytes
                ON file_version (tenant_id, workspace_id) INCLUDE (byte_length);
            """,
            suppressTransaction: true);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("DROP INDEX IF EXISTS ix_file_version_workspace_bytes;");
        migrationBuilder.Sql("DROP INDEX IF EXISTS ix_item_trash;");
    }
}
