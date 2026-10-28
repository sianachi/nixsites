using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class WorkspaceSharing : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "notification_bounded",
                table: "notification");

            migrationBuilder.AddColumn<bool>(
                name: "collaboration",
                table: "workspace",
                type: "boolean",
                nullable: false,
                defaultValue: true);

            migrationBuilder.AddColumn<bool>(
                name: "membership_locked",
                table: "workspace",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "collaboration",
                table: "item",
                type: "boolean",
                nullable: false,
                defaultValue: true);

            migrationBuilder.AddCheckConstraint(
                name: "notification_bounded",
                table: "notification",
                sql: "char_length(title) <= 200 AND char_length(body) <= 1000 AND kind IN ('reminder', 'automation', 'calendar', 'system', 'invitation')");
            Nix.Persistence.Migrations.WorkspaceSharingSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            Nix.Persistence.Migrations.WorkspaceSharingSecuritySql.Revert(sql => migrationBuilder.Sql(sql));

            migrationBuilder.DropCheckConstraint(
                name: "notification_bounded",
                table: "notification");

            migrationBuilder.DropColumn(
                name: "collaboration",
                table: "workspace");

            migrationBuilder.DropColumn(
                name: "membership_locked",
                table: "workspace");

            migrationBuilder.DropColumn(
                name: "collaboration",
                table: "item");

            migrationBuilder.AddCheckConstraint(
                name: "notification_bounded",
                table: "notification",
                sql: "char_length(title) <= 200 AND char_length(body) <= 1000 AND kind IN ('reminder', 'automation', 'calendar', 'system')");
        }
    }
}
