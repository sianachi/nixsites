using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Adds bounded owner-private destination consent and exact browser-authorized decision delegation.</summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261125010100_PetPlanConsents")]
public sealed class PetPlanConsents : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        CREATE TABLE pet_plan_consent (
            id uuid PRIMARY KEY, tenant_id uuid NOT NULL, owner_id uuid NOT NULL, workspace_id uuid NOT NULL,
            pet_id uuid NOT NULL, scope_digest text NOT NULL CHECK (scope_digest ~ '^[0-9a-f]{64}$'),
            recipient_revision text NOT NULL CHECK (recipient_revision ~ '^[0-9a-f]{64}$'),
            request_id uuid NOT NULL, authority_id uuid NOT NULL, granted_at timestamptz NOT NULL,
            expires_at timestamptz NOT NULL, revoked_at timestamptz,
            decision_nonce uuid, question_expires_at timestamptz, last_decision_nonce uuid,
            updated_at timestamptz NOT NULL DEFAULT now(),
            CHECK (expires_at > granted_at AND expires_at <= granted_at + interval '30 days'),
            CHECK ((decision_nonce IS NULL) = (question_expires_at IS NULL)),
            CHECK (question_expires_at IS NULL OR
                (question_expires_at > updated_at AND question_expires_at <= updated_at + interval '30 minutes')),
            CHECK (decision_nonce IS NULL OR decision_nonce IS DISTINCT FROM last_decision_nonce),
            CHECK (request_id <> '00000000-0000-0000-0000-000000000000'::uuid OR
                (revoked_at IS NOT NULL AND authority_id = '00000000-0000-0000-0000-000000000000'::uuid)),
            UNIQUE (tenant_id, owner_id, workspace_id, pet_id, scope_digest, recipient_revision),
            FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspace(tenant_id, workspace_id) ON DELETE CASCADE,
            FOREIGN KEY (tenant_id, owner_id) REFERENCES principal(tenant_id, principal_id) ON DELETE CASCADE
        );
        CREATE INDEX ix_pet_plan_consent_owner ON pet_plan_consent(tenant_id, owner_id, updated_at DESC);
        CREATE TABLE pet_plan_decision_context (
            id uuid PRIMARY KEY, tenant_id uuid NOT NULL, owner_id uuid NOT NULL, workspace_id uuid NOT NULL,
            run_id uuid NOT NULL REFERENCES pet_run(id) ON DELETE CASCADE, plan_id uuid NOT NULL,
            plan_version integer NOT NULL CHECK (plan_version > 0), review_digest text NOT NULL CHECK (length(review_digest) BETWEEN 1 AND 128),
            grantee_credential_id uuid NOT NULL, client_name text NOT NULL CHECK (length(client_name) BETWEEN 1 AND 80),
            approve boolean NOT NULL, secret_hash text NOT NULL UNIQUE CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
            expires_at timestamptz NOT NULL, authority_id uuid, authorized_at timestamptz, revoked_at timestamptz,
            consumed_request_id uuid, consumed_at timestamptz,
            CHECK ((authority_id IS NULL) = (authorized_at IS NULL)),
            CHECK ((consumed_request_id IS NULL) = (consumed_at IS NULL)),
            CHECK (consumed_at IS NULL OR authority_id IS NOT NULL),
            FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspace(tenant_id, workspace_id) ON DELETE CASCADE,
            FOREIGN KEY (tenant_id, owner_id) REFERENCES principal(tenant_id, principal_id) ON DELETE CASCADE
        );
        CREATE INDEX ix_pet_plan_context_owner ON pet_plan_decision_context(tenant_id, owner_id, expires_at DESC);
        ALTER TABLE pet_plan_consent ENABLE ROW LEVEL SECURITY;
        ALTER TABLE pet_plan_consent FORCE ROW LEVEL SECURITY;
        ALTER TABLE pet_plan_decision_context ENABLE ROW LEVEL SECURITY;
        ALTER TABLE pet_plan_decision_context FORCE ROW LEVEL SECURITY;
        CREATE POLICY pet_plan_consent_owner ON pet_plan_consent USING (
            tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
            AND owner_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            AND workspace_id = COALESCE(NULLIF(current_setting('nix.workspace_id', true), '')::uuid, workspace_id)
        ) WITH CHECK (
            tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
            AND owner_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            AND workspace_id = COALESCE(NULLIF(current_setting('nix.workspace_id', true), '')::uuid, workspace_id)
        );
        CREATE POLICY pet_plan_context_owner ON pet_plan_decision_context USING (
            tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
            AND owner_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            AND workspace_id = COALESCE(NULLIF(current_setting('nix.workspace_id', true), '')::uuid, workspace_id)
        ) WITH CHECK (
            tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
            AND owner_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            AND workspace_id = COALESCE(NULLIF(current_setting('nix.workspace_id', true), '')::uuid, workspace_id)
        );
        REVOKE ALL ON pet_plan_consent, pet_plan_decision_context FROM PUBLIC, nix_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON pet_plan_consent, pet_plan_decision_context TO nix_app;
        """);

    protected override void Down(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        DROP TABLE pet_plan_decision_context;
        DROP TABLE pet_plan_consent;
        """);
}
