using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Owner-scoped registrations and reviewed delegation work for pet MCP.</summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261117110000_PetPeers")]
public sealed class CreatePetPeerTables : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        CREATE TABLE pet_peer (
            id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL,
            owner_id uuid NOT NULL,
            workspace_id uuid NOT NULL,
            item_id uuid NOT NULL,
            pet_id uuid NOT NULL,
            name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
            kind text NOT NULL CHECK (kind IN ('client', 'claude', 'codex')),
            expires_at timestamptz NOT NULL,
            revoked_at timestamptz,
            FOREIGN KEY (tenant_id, owner_id) REFERENCES principal(tenant_id, principal_id) ON DELETE CASCADE,
            FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspace(tenant_id, workspace_id) ON DELETE CASCADE,
            FOREIGN KEY (tenant_id, item_id) REFERENCES item(tenant_id, id) ON DELETE CASCADE,
            UNIQUE (id, tenant_id, workspace_id, owner_id)
        );
        CREATE INDEX pet_peer_item ON pet_peer (tenant_id, workspace_id, owner_id, item_id, expires_at DESC);

        CREATE TABLE pet_peer_work (
            id uuid NOT NULL,
            peer_id uuid NOT NULL,
            tenant_id uuid NOT NULL,
            workspace_id uuid NOT NULL,
            owner_id uuid NOT NULL,
            run_id uuid NOT NULL REFERENCES pet_run(id) ON DELETE CASCADE,
            direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
            status text NOT NULL CHECK (status IN ('submitted', 'queued', 'running', 'completed', 'failed')),
            brief text NOT NULL CHECK (char_length(brief) BETWEEN 1 AND 4000),
            result text CHECK (char_length(result) BETWEEN 1 AND 16000),
            lease_id uuid,
            lease_expires_at timestamptz,
            created_at timestamptz NOT NULL,
            PRIMARY KEY (peer_id, id),
            FOREIGN KEY (peer_id, tenant_id, workspace_id, owner_id)
                REFERENCES pet_peer(id, tenant_id, workspace_id, owner_id) ON DELETE CASCADE,
            CHECK ((status = 'running') = (lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)),
            CHECK ((direction = 'inbound') = (status = 'submitted'))
        );
        CREATE INDEX pet_peer_claimable ON pet_peer_work (peer_id, created_at, id) WHERE status = 'queued';
        CREATE UNIQUE INDEX pet_peer_submission ON pet_peer_work (peer_id, run_id) WHERE direction = 'inbound';

        ALTER TABLE pet_peer ENABLE ROW LEVEL SECURITY;
        ALTER TABLE pet_peer FORCE ROW LEVEL SECURITY;
        ALTER TABLE pet_peer_work ENABLE ROW LEVEL SECURITY;
        ALTER TABLE pet_peer_work FORCE ROW LEVEL SECURITY;
        CREATE POLICY pet_peer_owner ON pet_peer USING (
            tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
            AND owner_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            AND workspace_id = COALESCE(NULLIF(current_setting('nix.workspace_id', true), '')::uuid, workspace_id)
        );
        CREATE POLICY pet_peer_work_owner ON pet_peer_work USING (
            tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
            AND owner_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            AND workspace_id = COALESCE(NULLIF(current_setting('nix.workspace_id', true), '')::uuid, workspace_id)
        );
        REVOKE ALL ON pet_peer, pet_peer_work FROM PUBLIC, nix_app;
        GRANT SELECT, INSERT, UPDATE ON pet_peer, pet_peer_work TO nix_app;
        """);

    protected override void Down(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        DROP TABLE pet_peer_work;
        DROP TABLE pet_peer;
        """);
}
