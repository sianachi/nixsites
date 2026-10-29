using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class NoteComments : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "notification_bounded",
                table: "notification");

            migrationBuilder.CreateTable(
                name: "note_comment",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    thread_id = table.Column<Guid>(type: "uuid", nullable: false),
                    author_principal_id = table.Column<Guid>(type: "uuid", nullable: false),
                    imported_author = table.Column<string>(type: "text", nullable: true),
                    body = table.Column<string>(type: "text", nullable: false),
                    mention_ids = table.Column<Guid[]>(type: "uuid[]", nullable: false),
                    anchor_start = table.Column<string>(type: "text", nullable: true),
                    anchor_end = table.Column<string>(type: "text", nullable: true),
                    quote = table.Column<string>(type: "text", nullable: true),
                    resolved_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    resolved_by = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    edited_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_note_comment", x => x.id);
                    table.CheckConstraint("note_comment_bounded", "char_length(body) BETWEEN 1 AND 10000 AND cardinality(mention_ids) <= 20 AND (quote IS NULL OR char_length(quote) <= 1000) AND (anchor_start IS NULL OR char_length(anchor_start) <= 512) AND (anchor_end IS NULL OR char_length(anchor_end) <= 512) AND (imported_author IS NULL OR char_length(imported_author) <= 200)");
                    table.ForeignKey(
                        name: "FK_note_comment_item_tenant_id_item_id",
                        columns: x => new { x.tenant_id, x.item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_note_comment_note_comment_thread_id",
                        column: x => x.thread_id,
                        principalTable: "note_comment",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "note_comment_revision",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    revision = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_note_comment_revision", x => new { x.tenant_id, x.item_id });
                    table.ForeignKey(
                        name: "FK_note_comment_revision_item_tenant_id_item_id",
                        columns: x => new { x.tenant_id, x.item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.AddCheckConstraint(
                name: "notification_bounded",
                table: "notification",
                sql: "char_length(title) <= 200 AND char_length(body) <= 1000 AND kind IN ('reminder', 'automation', 'calendar', 'system', 'invitation', 'comment')");

            migrationBuilder.CreateIndex(
                name: "IX_note_comment_tenant_id_item_id_created_at",
                table: "note_comment",
                columns: new[] { "tenant_id", "item_id", "created_at" });

            migrationBuilder.CreateIndex(
                name: "IX_note_comment_tenant_id_thread_id",
                table: "note_comment",
                columns: new[] { "tenant_id", "thread_id" });

            migrationBuilder.CreateIndex(
                name: "IX_note_comment_thread_id",
                table: "note_comment",
                column: "thread_id");

            // Isolation, grants and triggers; kept outside this folder so a re-scaffold cannot delete them.
            Nix.Persistence.Migrations.NoteCommentsSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            Nix.Persistence.Migrations.NoteCommentsSecuritySql.Revert(sql => migrationBuilder.Sql(sql));

            migrationBuilder.DropTable(
                name: "note_comment");

            migrationBuilder.DropTable(
                name: "note_comment_revision");

            migrationBuilder.DropCheckConstraint(
                name: "notification_bounded",
                table: "notification");

            migrationBuilder.AddCheckConstraint(
                name: "notification_bounded",
                table: "notification",
                sql: "char_length(title) <= 200 AND char_length(body) <= 1000 AND kind IN ('reminder', 'automation', 'calendar', 'system', 'invitation')");
        }
    }
}
