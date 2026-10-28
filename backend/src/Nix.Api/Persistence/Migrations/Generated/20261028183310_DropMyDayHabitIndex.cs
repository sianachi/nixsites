using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class DropMyDayHabitIndex : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_item_habit_marker",
                table: "item");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "ix_item_habit_marker",
                table: "item",
                columns: new[] { "tenant_id", "id" },
                filter: "lifecycle_state = 'active' AND template_id IS NULL AND (properties ->> '$habit_frequency') IS NOT NULL");
        }
    }
}
