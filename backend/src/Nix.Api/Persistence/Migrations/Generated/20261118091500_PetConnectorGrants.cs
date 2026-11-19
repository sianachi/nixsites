using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Stores owner-private, scoped connector credentials and one-use browser OAuth state.</summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261118091500_PetConnectorGrants")]
public sealed class PetConnectorGrants : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        CREATE TABLE pet_connector_grant (
            id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL,
            workspace_id uuid NOT NULL,
            owner_id uuid NOT NULL,
            revision uuid NOT NULL,
            provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 40),
            resource_kind text NOT NULL CHECK (length(resource_kind) BETWEEN 1 AND 48),
            resource_id text NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 512),
            actions text[] NOT NULL DEFAULT ARRAY[]::text[] CHECK (cardinality(actions) <= 32),
            protected_tokens text CHECK (octet_length(protected_tokens) BETWEEN 1 AND 65536),
            state_hash text CHECK (state_hash ~ '^[0-9a-f]{64}$'),
            protected_pending text CHECK (octet_length(protected_pending) BETWEEN 1 AND 65536),
            pending_expires_at timestamptz,
            UNIQUE (tenant_id, workspace_id, owner_id, provider, resource_kind, resource_id),
            CHECK ((protected_pending IS NULL) = (pending_expires_at IS NULL)),
            CHECK (protected_pending IS NULL OR state_hash IS NOT NULL),
            FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspace(tenant_id, workspace_id) ON DELETE CASCADE,
            FOREIGN KEY (tenant_id, owner_id) REFERENCES principal(tenant_id, principal_id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX ix_pet_connector_grant_pending ON pet_connector_grant(state_hash)
            WHERE state_hash IS NOT NULL;
        ALTER TABLE pet_connector_grant ENABLE ROW LEVEL SECURITY;
        ALTER TABLE pet_connector_grant FORCE ROW LEVEL SECURITY;
        CREATE POLICY pet_connector_grant_owner ON pet_connector_grant USING (
            tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
            AND owner_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            AND workspace_id = COALESCE(NULLIF(current_setting('nix.workspace_id', true), '')::uuid, workspace_id)
        ) WITH CHECK (
            tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
            AND owner_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            AND workspace_id = COALESCE(NULLIF(current_setting('nix.workspace_id', true), '')::uuid, workspace_id)
        );
        REVOKE ALL ON pet_connector_grant FROM PUBLIC, nix_app;
        GRANT SELECT, INSERT, UPDATE ON pet_connector_grant TO nix_app;
        """);

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("DROP TABLE pet_connector_grant;");
}
