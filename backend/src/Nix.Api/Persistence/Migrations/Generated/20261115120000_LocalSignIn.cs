using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Adds Core's own sign-in state without changing the EF domain model.</summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261115120000_LocalSignIn")]
public sealed class LocalSignIn : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) =>
        LocalSignInSecuritySql.Apply(sql => migrationBuilder.Sql(sql));

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) =>
        LocalSignInSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
}
