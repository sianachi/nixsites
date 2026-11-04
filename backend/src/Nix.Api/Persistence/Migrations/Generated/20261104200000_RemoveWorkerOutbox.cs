using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Drops the worker outbox table and the functions and triggers that fed it.</summary>
/// <remarks>Hand-written (the Design package is not referenced); the model snapshot was edited by hand.</remarks>
[DbContext(typeof(NixDbContext))]
[Migration("20261104200000_RemoveWorkerOutbox")]
public sealed class RemoveWorkerOutbox : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) =>
        RemoveWorkerOutboxSecuritySql.Apply(sql => migrationBuilder.Sql(sql));

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) =>
        RemoveWorkerOutboxSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
}
