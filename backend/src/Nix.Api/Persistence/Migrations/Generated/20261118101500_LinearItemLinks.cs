using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Stores exact Linear links and status baselines, private to their owner.</summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261118101500_LinearItemLinks")]
public sealed class LinearItemLinks : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        CREATE TABLE linear_item_link (
            tenant_id uuid NOT NULL,
            workspace_id uuid NOT NULL,
            item_id uuid NOT NULL,
            owner_id uuid NOT NULL,
            connection_id uuid NOT NULL REFERENCES pet_connector_grant(id) ON DELETE CASCADE,
            connection_revision uuid NOT NULL,
            revision uuid NOT NULL,
            issue_id uuid NOT NULL,
            identifier text NOT NULL CHECK (length(identifier) BETWEEN 1 AND 64),
            url text NOT NULL CHECK (length(url) BETWEEN 1 AND 2048),
            status_id uuid NOT NULL,
            status text NOT NULL CHECK (length(status) BETWEEN 1 AND 120),
            remote_updated_at timestamptz NOT NULL,
            checked_at timestamptz NOT NULL,
            baseline_status_id uuid NOT NULL,
            baseline_local_status text CHECK (length(baseline_local_status) <= 1024),
            PRIMARY KEY (tenant_id, workspace_id, item_id, owner_id),
            FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspace(tenant_id, workspace_id) ON DELETE CASCADE,
            FOREIGN KEY (tenant_id, item_id) REFERENCES item(tenant_id, id) ON DELETE CASCADE,
            FOREIGN KEY (tenant_id, owner_id) REFERENCES principal(tenant_id, principal_id) ON DELETE CASCADE
        );
        CREATE INDEX ix_linear_item_link_connection ON linear_item_link(connection_id);
        ALTER TABLE linear_item_link ENABLE ROW LEVEL SECURITY;
        ALTER TABLE linear_item_link FORCE ROW LEVEL SECURITY;
        CREATE POLICY linear_item_link_owner ON linear_item_link USING (
            tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
            AND owner_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            AND workspace_id = COALESCE(NULLIF(current_setting('nix.workspace_id', true), '')::uuid, workspace_id)
        ) WITH CHECK (
            tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
            AND owner_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            AND workspace_id = COALESCE(NULLIF(current_setting('nix.workspace_id', true), '')::uuid, workspace_id)
        );
        REVOKE ALL ON linear_item_link FROM PUBLIC, nix_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON linear_item_link TO nix_app;
        """);

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("DROP TABLE linear_item_link;");
}
