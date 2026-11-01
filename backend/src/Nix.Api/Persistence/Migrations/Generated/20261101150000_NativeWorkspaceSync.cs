using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Adds a transaction-serialized, rebuildable native workspace feed.</summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261101150000_NativeWorkspaceSync")]
public sealed class NativeWorkspaceSync : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) =>
        NativeWorkspaceSyncSecuritySql.Apply(sql => migrationBuilder.Sql(sql));

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) =>
        NativeWorkspaceSyncSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
}
