using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>
/// The stable error code of a turn that failed because it could not start (sharing not reviewed, no provider
/// key), so the app can offer the fix and retry the turn without reading the message text.
/// </summary>
/// <remarks>Hand-written; the table is read and written with raw SQL, so the model snapshot does not change.</remarks>
[DbContext(typeof(NixDbContext))]
[Migration("20261128100000_MessagePetTurnCode")]
public sealed class MessagePetTurnCode : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        ArgumentNullException.ThrowIfNull(migrationBuilder);
        migrationBuilder.Sql("ALTER TABLE message_pet_turn ADD COLUMN reason_code text CHECK (length(reason_code) <= 64);");
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        ArgumentNullException.ThrowIfNull(migrationBuilder);
        migrationBuilder.Sql("ALTER TABLE message_pet_turn DROP COLUMN reason_code;");
    }
}
