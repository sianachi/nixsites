using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Adds pending OAuth authorization code storage for remote MCP sign-in without changing the EF domain model.</summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261115130000_OAuthCodes")]
public sealed class OAuthCodes : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) =>
        OAuthCodeSecuritySql.Apply(sql => migrationBuilder.Sql(sql));

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) =>
        OAuthCodeSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
}
