using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>
/// A fact a pet wants to remember from a message turn while the owner's memory mode is ask: it waits on
/// the turn's row until the owner approves or dismisses it.
/// </summary>
/// <remarks>Hand-written; the table is read and written with raw SQL, so the model snapshot does not change.</remarks>
[DbContext(typeof(NixDbContext))]
[Migration("20261127110000_MessagePetTurnMemory")]
public sealed class MessagePetTurnMemory : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        ArgumentNullException.ThrowIfNull(migrationBuilder);
        migrationBuilder.Sql("ALTER TABLE message_pet_turn ADD COLUMN memory_text text CHECK (length(memory_text) <= 280);");
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        ArgumentNullException.ThrowIfNull(migrationBuilder);
        migrationBuilder.Sql("ALTER TABLE message_pet_turn DROP COLUMN memory_text;");
    }
}
