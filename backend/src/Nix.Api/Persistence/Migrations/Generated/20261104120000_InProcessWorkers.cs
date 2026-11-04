using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>In-process worker dispatch: cleanup delay on the lease, the startup sweep, one-shot push hand-out.</summary>
/// <remarks><c>push_attempted_at</c> is read and written by SQL only, so the EF model and its snapshot are untouched.</remarks>
[DbContext(typeof(NixDbContext))]
[Migration("20261104120000_InProcessWorkers")]
public sealed class InProcessWorkers : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) =>
        InProcessWorkersSecuritySql.Apply(sql => migrationBuilder.Sql(sql));

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) =>
        InProcessWorkersSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
}
