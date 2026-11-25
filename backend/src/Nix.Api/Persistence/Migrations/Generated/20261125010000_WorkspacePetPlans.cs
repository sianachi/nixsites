using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Adds workspace anchors and owner-scoped plan creation idempotency without rewriting existing runs.</summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261125010000_WorkspacePetPlans")]
public sealed class WorkspacePetPlans : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        ALTER TABLE pet_run ALTER COLUMN item_id DROP NOT NULL;
        ALTER TABLE pet_run ADD COLUMN request_id uuid;
        CREATE UNIQUE INDEX ix_pet_run_owner_request
            ON pet_run(tenant_id, actor_id, workspace_id, request_id) WHERE request_id IS NOT NULL;
        DROP POLICY pet_run_actor ON pet_run;
        CREATE POLICY pet_run_actor ON pet_run USING (
            tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
            AND workspace_id = COALESCE(NULLIF(current_setting('nix.workspace_id', true), '')::uuid, workspace_id)
            AND actor_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            AND (
                item_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM item i WHERE i.tenant_id = pet_run.tenant_id
                      AND i.workspace_id = pet_run.workspace_id AND i.id = pet_run.item_id
                      AND i.lifecycle_state = 'active')
                    AND (request_id IS NULL OR EXISTS (
                        SELECT 1 FROM workspace w WHERE w.tenant_id = pet_run.tenant_id
                          AND w.workspace_id = pet_run.workspace_id AND w.lifecycle_state = 'active'
                          AND NOT EXISTS (SELECT 1 FROM workspace_lock l
                              WHERE l.tenant_id = w.tenant_id AND l.workspace_id = w.workspace_id)
                          AND EXISTS (SELECT 1 FROM workspace_member m
                              WHERE m.tenant_id = w.tenant_id AND m.workspace_id = w.workspace_id
                                AND m.role IN ('viewer','commenter','editor','owner')
                                AND (m.subject_type = 'principal' AND m.subject_id = pet_run.actor_id
                                  OR m.subject_type = 'group' AND EXISTS (
                                    SELECT 1 FROM group_membership g WHERE g.tenant_id = m.tenant_id
                                      AND g.group_id = m.subject_id AND g.principal_id = pet_run.actor_id)))))
                OR item_id IS NULL AND EXISTS (
                    SELECT 1 FROM workspace w WHERE w.tenant_id = pet_run.tenant_id
                      AND w.workspace_id = pet_run.workspace_id AND w.lifecycle_state = 'active'
                      AND NOT EXISTS (SELECT 1 FROM workspace_lock l
                          WHERE l.tenant_id = w.tenant_id AND l.workspace_id = w.workspace_id)
                      AND EXISTS (SELECT 1 FROM workspace_member m
                          WHERE m.tenant_id = w.tenant_id AND m.workspace_id = w.workspace_id
                            AND m.role IN ('viewer','commenter','editor','owner')
                            AND (m.subject_type = 'principal' AND m.subject_id = pet_run.actor_id
                              OR m.subject_type = 'group' AND EXISTS (
                                SELECT 1 FROM group_membership g WHERE g.tenant_id = m.tenant_id
                                  AND g.group_id = m.subject_id AND g.principal_id = pet_run.actor_id))))
            )
        );
        """);

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM pet_run WHERE item_id IS NULL) THEN
                RAISE EXCEPTION 'Cannot downgrade while workspace-anchored pet plans exist';
            END IF;
        END $$;
        DROP POLICY pet_run_actor ON pet_run;
        CREATE POLICY pet_run_actor ON pet_run USING (
            tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
            AND workspace_id = COALESCE(NULLIF(current_setting('nix.workspace_id', true), '')::uuid, workspace_id)
            AND actor_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            AND EXISTS (SELECT 1 FROM item i WHERE i.tenant_id = pet_run.tenant_id
                AND i.workspace_id = pet_run.workspace_id AND i.id = pet_run.item_id AND i.lifecycle_state = 'active')
        );
        DROP INDEX ix_pet_run_owner_request;
        ALTER TABLE pet_run DROP COLUMN request_id;
        ALTER TABLE pet_run ALTER COLUMN item_id SET NOT NULL;
        """);
}
