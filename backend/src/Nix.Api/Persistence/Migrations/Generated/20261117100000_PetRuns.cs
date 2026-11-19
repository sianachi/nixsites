using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Adds actor-owned task checkpoints for the leased pet runner.</summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261117100000_PetRuns")]
public sealed class CreatePetRunTable : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        CREATE TABLE pet_run (
            id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL,
            workspace_id uuid NOT NULL,
            item_id uuid NOT NULL,
            actor_id uuid NOT NULL,
            brief text NOT NULL CHECK (char_length(brief) BETWEEN 1 AND 8000),
            source_item_ids uuid[] NOT NULL CHECK (cardinality(source_item_ids) <= 100),
            workspace_scope boolean NOT NULL,
            abilities text[] NOT NULL CHECK (cardinality(abilities) <= 100),
            status text NOT NULL CHECK (status IN (
                'queued', 'running', 'waiting_for_input', 'waiting_for_approval', 'waiting_for_handoff',
                'completed', 'failed', 'cancelled', 'review_required')),
            revision bigint NOT NULL CHECK (revision > 0),
            state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object' AND octet_length(state::text) <= 1048576),
            created_at timestamptz NOT NULL,
            updated_at timestamptz NOT NULL CHECK (updated_at >= created_at),
            FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspace(tenant_id, workspace_id) ON DELETE CASCADE,
            FOREIGN KEY (tenant_id, item_id) REFERENCES item(tenant_id, id) ON DELETE CASCADE,
            FOREIGN KEY (tenant_id, actor_id) REFERENCES principal(tenant_id, principal_id) ON DELETE CASCADE
        );

        CREATE INDEX ix_pet_run_workspace_activity
            ON pet_run(tenant_id, actor_id, workspace_id, updated_at DESC, id DESC);
        CREATE INDEX ix_pet_run_item_activity
            ON pet_run(tenant_id, item_id, actor_id, workspace_id, updated_at DESC, id DESC);

        ALTER TABLE pet_run ENABLE ROW LEVEL SECURITY;
        ALTER TABLE pet_run FORCE ROW LEVEL SECURITY;
        CREATE POLICY pet_run_actor ON pet_run USING (
            tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
            AND workspace_id = COALESCE(NULLIF(current_setting('nix.workspace_id', true), '')::uuid, workspace_id)
            AND actor_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            AND EXISTS (
                SELECT 1 FROM item i
                 WHERE i.tenant_id = pet_run.tenant_id AND i.workspace_id = pet_run.workspace_id
                   AND i.id = pet_run.item_id AND i.lifecycle_state = 'active'
            )
        ) WITH CHECK (
            tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
            AND workspace_id = COALESCE(NULLIF(current_setting('nix.workspace_id', true), '')::uuid, workspace_id)
            AND actor_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            AND EXISTS (
                SELECT 1 FROM item i
                 WHERE i.tenant_id = pet_run.tenant_id AND i.workspace_id = pet_run.workspace_id
                   AND i.id = pet_run.item_id AND i.lifecycle_state = 'active'
            )
        );

        REVOKE ALL ON pet_run FROM PUBLIC, nix_app;
        GRANT SELECT, INSERT, UPDATE ON pet_run TO nix_app;
        """);

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("DROP TABLE pet_run");
}
