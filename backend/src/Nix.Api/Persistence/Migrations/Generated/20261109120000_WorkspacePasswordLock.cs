using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Adds the workspace password lock and its per-credential grants.</summary>
/// <remarks>
/// [SEC] Two new tenant-isolated tables that gate who may read a workspace (RLS policy, grants and
/// bounds applied via WorkspaceLockSecuritySql). Hand-written (the Design package is not
/// referenced); the model snapshot was edited by hand.
/// </remarks>
[DbContext(typeof(NixDbContext))]
[Migration("20261109120000_WorkspacePasswordLock")]
public sealed class WorkspacePasswordLock : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "workspace_lock",
            columns: table => new
            {
                workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                password_hash = table.Column<string>(type: "text", nullable: false),
                locked_by = table.Column<Guid>(type: "uuid", nullable: false),
                locked_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_workspace_lock", x => x.workspace_id);
                table.UniqueConstraint("AK_workspace_lock_tenant_id_workspace_id", x => new { x.tenant_id, x.workspace_id });
                table.ForeignKey(
                    name: "FK_workspace_lock_workspace_tenant_id_workspace_id",
                    columns: x => new { x.tenant_id, x.workspace_id },
                    principalTable: "workspace",
                    principalColumns: new[] { "tenant_id", "workspace_id" },
                    onDelete: ReferentialAction.Cascade);
            });

        migrationBuilder.CreateTable(
            name: "workspace_unlock",
            columns: table => new
            {
                workspace_id = table.Column<Guid>(type: "uuid", nullable: false),
                credential_id = table.Column<Guid>(type: "uuid", nullable: false),
                tenant_id = table.Column<Guid>(type: "uuid", nullable: false),
                principal_id = table.Column<Guid>(type: "uuid", nullable: false),
                expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_workspace_unlock", x => new { x.workspace_id, x.credential_id });
                table.ForeignKey(
                    name: "FK_workspace_unlock_workspace_lock_tenant_id_workspace_id",
                    columns: x => new { x.tenant_id, x.workspace_id },
                    principalTable: "workspace_lock",
                    principalColumns: new[] { "tenant_id", "workspace_id" },
                    onDelete: ReferentialAction.Cascade);
            });

        // The authorization probe filters on tenant, workspace and credential.
        migrationBuilder.CreateIndex(
            name: "IX_workspace_unlock_tenant_id_workspace_id",
            table: "workspace_unlock",
            columns: new[] { "tenant_id", "workspace_id" });

        WorkspaceLockSecuritySql.Apply(sql => migrationBuilder.Sql(sql));
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(name: "workspace_unlock");
        migrationBuilder.DropTable(name: "workspace_lock");
    }
}
