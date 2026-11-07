using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Adds the tenant switches for remote MCP and public links.</summary>
/// <remarks>Hand-written (the Design package is not referenced); the model snapshot was edited by hand.</remarks>
[DbContext(typeof(NixDbContext))]
[Migration("20261107120000_TenantSettings")]
public sealed class TenantSettings : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) =>
        TenantSettingsSecuritySql.Apply(sql => migrationBuilder.Sql(sql));

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) =>
        TenantSettingsSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
}
