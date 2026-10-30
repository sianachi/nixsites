using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    // [SEC] Adds content_version, a new tenant-isolated content table (RLS policy, grant split and
    // a bound, applied below via ContentVersionSecuritySql). This
    // migration requires owner approval before merge.
    /// <inheritdoc />
    public partial class ContentVersions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "content_version",
                columns: table => new
                {
                    doc_id = table.Column<Guid>(type: "uuid", nullable: false),
                    seq = table.Column<long>(type: "bigint", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "text", nullable: false),
                    created_by = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_content_version", x => new { x.doc_id, x.seq });
                    table.ForeignKey(
                        name: "FK_content_version_content_doc_tenant_id_doc_id",
                        columns: x => new { x.tenant_id, x.doc_id },
                        principalTable: "content_doc",
                        principalColumns: new[] { "tenant_id", "doc_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_content_version_tenant_id_doc_id",
                table: "content_version",
                columns: new[] { "tenant_id", "doc_id" });

            ContentVersionSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "content_version");
        }
    }
}
