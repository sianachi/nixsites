using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Adds durable native replay receipts without an EF domain entity.</summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261101150100_NativeReplayReceipts")]
public sealed class NativeReplayReceipts : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) => NativeReplaySecuritySql.Apply(sql => migrationBuilder.Sql(sql));

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) => NativeReplaySecuritySql.Revert(sql => migrationBuilder.Sql(sql));
}
