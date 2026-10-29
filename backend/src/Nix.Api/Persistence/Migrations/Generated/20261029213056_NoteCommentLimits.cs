using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class NoteCommentLimits : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "note_comment_bounded",
                table: "note_comment");

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "deleted_at",
                table: "note_comment",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddCheckConstraint(
                name: "note_comment_bounded",
                table: "note_comment",
                sql: "char_length(body) <= 10000 AND (deleted_at IS NOT NULL OR char_length(body) >= 1) AND cardinality(mention_ids) <= 20 AND (quote IS NULL OR char_length(quote) <= 1000) AND (anchor_start IS NULL OR char_length(anchor_start) <= 512) AND (anchor_end IS NULL OR char_length(anchor_end) <= 512) AND (imported_author IS NULL OR char_length(imported_author) <= 200)");

            Nix.Persistence.Migrations.NoteCommentLimitsSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            Nix.Persistence.Migrations.NoteCommentLimitsSecuritySql.Revert(sql => migrationBuilder.Sql(sql));

            migrationBuilder.DropCheckConstraint(
                name: "note_comment_bounded",
                table: "note_comment");

            migrationBuilder.DropColumn(
                name: "deleted_at",
                table: "note_comment");

            migrationBuilder.AddCheckConstraint(
                name: "note_comment_bounded",
                table: "note_comment",
                sql: "char_length(body) BETWEEN 1 AND 10000 AND cardinality(mention_ids) <= 20 AND (quote IS NULL OR char_length(quote) <= 1000) AND (anchor_start IS NULL OR char_length(anchor_start) <= 512) AND (anchor_end IS NULL OR char_length(anchor_end) <= 512) AND (imported_author IS NULL OR char_length(imported_author) <= 200)");
        }
    }
}
