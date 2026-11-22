using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>
/// Lets the attachments page find the few files with a version in a non-draft state without
/// resolving the shown version of every file in the workspace.
/// </summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261122120000_FileVersionStateIndex")]
public sealed class FileVersionStateIndex : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) =>
        // Partial: draft is nearly every version and is not a selective filter, so it stays out of
        // the index. Built concurrently, as its own statement outside a transaction.
        migrationBuilder.Sql(
            """
            CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_file_version_state
                ON file_version (tenant_id, state, item_id)
                WHERE state <> 'draft';
            """,
            suppressTransaction: true);

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) =>
        migrationBuilder.Sql("DROP INDEX IF EXISTS ix_file_version_state;");
}
