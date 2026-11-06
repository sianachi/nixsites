using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class AgentRecords : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "agents_may_approve",
                table: "workspace",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "agents_may_create_public_links",
                table: "workspace",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<Guid>(
                name: "source_item_id",
                table: "file_version",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "source_seq",
                table: "file_version",
                type: "bigint",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "state",
                table: "file_version",
                type: "text",
                nullable: false,
                defaultValue: "draft");

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "state_changed_at",
                table: "file_version",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "state_changed_by",
                table: "file_version",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "published_version_id",
                table: "file_upload",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "source_item_id",
                table: "file_upload",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "source_seq",
                table: "file_upload",
                type: "bigint",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "item_reference",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                    holder_item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    target_item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    target_file_version_id = table.Column<Guid>(type: "uuid", nullable: true),
                    role = table.Column<string>(type: "text", nullable: true),
                    created_by = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_item_reference", x => x.id);
                    table.CheckConstraint("item_reference_role_bounded", "role IS NULL OR char_length(role) BETWEEN 1 AND 80");
                    table.ForeignKey(
                        name: "FK_item_reference_file_version_tenant_id_target_item_id_target~",
                        columns: x => new { x.tenant_id, x.target_item_id, x.target_file_version_id },
                        principalTable: "file_version",
                        principalColumns: new[] { "tenant_id", "item_id", "file_version_id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_item_reference_item_tenant_id_holder_item_id",
                        columns: x => new { x.tenant_id, x.holder_item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_item_reference_item_tenant_id_target_item_id",
                        columns: x => new { x.tenant_id, x.target_item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_item_reference_workspace_tenant_id_workspace_id",
                        columns: x => new { x.tenant_id, x.workspace_id },
                        principalTable: "workspace",
                        principalColumns: new[] { "tenant_id", "workspace_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "public_link",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                    item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    nonce = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    file_version_id = table.Column<Guid>(type: "uuid", nullable: true),
                    service_principal_id = table.Column<Guid>(type: "uuid", nullable: false),
                    created_by = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    revoked_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_public_link", x => x.id);
                    table.ForeignKey(
                        name: "FK_public_link_file_version_tenant_id_item_id_file_version_id",
                        columns: x => new { x.tenant_id, x.item_id, x.file_version_id },
                        principalTable: "file_version",
                        principalColumns: new[] { "tenant_id", "item_id", "file_version_id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_public_link_item_tenant_id_item_id",
                        columns: x => new { x.tenant_id, x.item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_public_link_principal_tenant_id_created_by",
                        columns: x => new { x.tenant_id, x.created_by },
                        principalTable: "principal",
                        principalColumns: new[] { "tenant_id", "principal_id" },
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_public_link_principal_tenant_id_service_principal_id",
                        columns: x => new { x.tenant_id, x.service_principal_id },
                        principalTable: "principal",
                        principalColumns: new[] { "tenant_id", "principal_id" },
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_public_link_tenant_tenant_id",
                        column: x => x.tenant_id,
                        principalTable: "tenant",
                        principalColumn: "tenant_id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_public_link_workspace_tenant_id_workspace_id",
                        columns: x => new { x.tenant_id, x.workspace_id },
                        principalTable: "workspace",
                        principalColumns: new[] { "tenant_id", "workspace_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "record_key",
                columns: table => new
                {
                    tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                    scope_item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    field = table.Column<string>(type: "text", nullable: false),
                    value = table.Column<string>(type: "text", nullable: false),
                    item_id = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("ux_record_key_value", x => new { x.tenant_id, x.scope_item_id, x.field, x.value });
                    table.CheckConstraint("record_key_bounded", "char_length(value) BETWEEN 1 AND 2048 AND octet_length(value) <= 2400 AND char_length(field) BETWEEN 1 AND 128");
                    table.ForeignKey(
                        name: "FK_record_key_item_tenant_id_item_id",
                        columns: x => new { x.tenant_id, x.item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_record_key_item_tenant_id_scope_item_id",
                        columns: x => new { x.tenant_id, x.scope_item_id },
                        principalTable: "item",
                        principalColumns: new[] { "tenant_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.AddCheckConstraint(
                name: "file_version_state_valid",
                table: "file_version",
                sql: "state IN ('draft', 'in_review', 'approved', 'revoked')");

            migrationBuilder.CreateIndex(
                name: "ix_item_reference_pin",
                table: "item_reference",
                columns: new[] { "tenant_id", "target_file_version_id" },
                filter: "target_file_version_id IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_item_reference_tenant_id_target_item_id_target_file_version~",
                table: "item_reference",
                columns: new[] { "tenant_id", "target_item_id", "target_file_version_id" });

            migrationBuilder.CreateIndex(
                name: "IX_item_reference_tenant_id_workspace_id",
                table: "item_reference",
                columns: new[] { "tenant_id", "workspace_id" });

            migrationBuilder.CreateIndex(
                name: "ux_item_reference_edge",
                table: "item_reference",
                columns: new[] { "tenant_id", "holder_item_id", "target_item_id", "target_file_version_id", "role" },
                unique: true)
                .Annotation("Npgsql:NullsDistinct", false);

            migrationBuilder.CreateIndex(
                name: "ix_public_link_nonce",
                table: "public_link",
                column: "nonce");

            migrationBuilder.CreateIndex(
                name: "IX_public_link_tenant_id_created_by",
                table: "public_link",
                columns: new[] { "tenant_id", "created_by" });

            migrationBuilder.CreateIndex(
                name: "IX_public_link_tenant_id_item_id_file_version_id",
                table: "public_link",
                columns: new[] { "tenant_id", "item_id", "file_version_id" });

            migrationBuilder.CreateIndex(
                name: "IX_public_link_tenant_id_service_principal_id",
                table: "public_link",
                columns: new[] { "tenant_id", "service_principal_id" });

            migrationBuilder.CreateIndex(
                name: "IX_public_link_tenant_id_workspace_id",
                table: "public_link",
                columns: new[] { "tenant_id", "workspace_id" });

            migrationBuilder.CreateIndex(
                name: "ux_public_link_active_item",
                table: "public_link",
                columns: new[] { "tenant_id", "item_id" },
                unique: true,
                filter: "revoked_at IS NULL");

            migrationBuilder.CreateIndex(
                name: "ix_record_key_item",
                table: "record_key",
                columns: new[] { "tenant_id", "item_id" });

            // Isolation and grants; kept outside this folder so a re-scaffold cannot delete them.
            Nix.Persistence.Migrations.AgentRecordsSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            Nix.Persistence.Migrations.AgentRecordsSecuritySql.Revert(sql => migrationBuilder.Sql(sql));

            migrationBuilder.DropTable(
                name: "item_reference");

            migrationBuilder.DropTable(
                name: "public_link");

            migrationBuilder.DropTable(
                name: "record_key");

            migrationBuilder.DropCheckConstraint(
                name: "file_version_state_valid",
                table: "file_version");

            migrationBuilder.DropColumn(
                name: "agents_may_approve",
                table: "workspace");

            migrationBuilder.DropColumn(
                name: "agents_may_create_public_links",
                table: "workspace");

            migrationBuilder.DropColumn(
                name: "source_item_id",
                table: "file_version");

            migrationBuilder.DropColumn(
                name: "source_seq",
                table: "file_version");

            migrationBuilder.DropColumn(
                name: "state",
                table: "file_version");

            migrationBuilder.DropColumn(
                name: "state_changed_at",
                table: "file_version");

            migrationBuilder.DropColumn(
                name: "state_changed_by",
                table: "file_version");

            migrationBuilder.DropColumn(
                name: "published_version_id",
                table: "file_upload");

            migrationBuilder.DropColumn(
                name: "source_item_id",
                table: "file_upload");

            migrationBuilder.DropColumn(
                name: "source_seq",
                table: "file_upload");
        }
    }
}
