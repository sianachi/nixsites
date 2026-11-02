using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Adds one-time native sign-in handoff storage without changing the EF domain model.</summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261102120000_NativeLoginHandoff")]
public sealed class NativeLoginHandoff : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) =>
        NativeHandoffSecuritySql.Apply(sql => migrationBuilder.Sql(sql));

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) =>
        NativeHandoffSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
}
