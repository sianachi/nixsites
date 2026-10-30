using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>[SEC] Pins <c>pg_temp</c> last again on every SECURITY DEFINER function.</summary>
/// <remarks>
/// <c>NoteCommentLimits</c> recreated <c>nix_authorize_worker_execution</c> with the search path it
/// had before <c>HardenSecurityDefinerSearchPath</c>, so the caller's temporary schema was searched
/// first again. This reruns the same idempotent sweep, which leaves already-safe functions alone.
/// No schema change, so the model snapshot is untouched.
/// </remarks>
[DbContext(typeof(NixDbContext))]
[Migration("20261030120000_RehardenSecurityDefinerSearchPath")]
public sealed class RehardenSecurityDefinerSearchPath : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) =>
        SecurityDefinerSearchPathSecuritySql.Apply(sql => migrationBuilder.Sql(sql));

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) =>
        // Intentionally empty: restoring the unsafe search path is never wanted.
        SecurityDefinerSearchPathSecuritySql.Revert(sql => migrationBuilder.Sql(sql));
}
