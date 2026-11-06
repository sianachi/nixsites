using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Adds the expiry candidate finder and its index.</summary>
/// <remarks>Hand-written, SQL only: no entity changes, so the model snapshot is untouched.</remarks>
[DbContext(typeof(NixDbContext))]
[Migration("20261106230400_ExpiryFinder")]
public sealed class ExpiryFinder : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) =>
        ExpiryFinderSecuritySql.Apply(sql => migrationBuilder.Sql(sql));

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) =>
        ExpiryFinderSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
}
