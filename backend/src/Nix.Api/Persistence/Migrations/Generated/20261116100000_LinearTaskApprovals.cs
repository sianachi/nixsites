using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Adds the owner-scoped Linear grant and task request store.</summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261116100000_LinearTaskApprovals")]
public sealed class LinearTaskApprovals : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        CREATE TABLE linear_connection (
            id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL,
            workspace_id uuid NOT NULL,
            owner_id uuid NOT NULL,
            revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
            protected_oauth_state text CHECK (octet_length(protected_oauth_state) BETWEEN 1 AND 65536),
            oauth_attempt_hash text CHECK (oauth_attempt_hash ~ '^[0-9a-f]{64}$'),
            protected_pending_oauth text CHECK (octet_length(protected_pending_oauth) BETWEEN 1 AND 65536),
            oauth_expires_at timestamptz,
            CHECK ((protected_pending_oauth IS NULL) = (oauth_expires_at IS NULL)),
            CHECK (protected_pending_oauth IS NULL OR oauth_attempt_hash IS NOT NULL),
            UNIQUE (tenant_id, workspace_id, owner_id),
            UNIQUE (tenant_id, workspace_id, owner_id, id),
            FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspace(tenant_id, workspace_id) ON DELETE CASCADE,
            FOREIGN KEY (tenant_id, owner_id) REFERENCES principal(tenant_id, principal_id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX ix_linear_connection_oauth_attempt ON linear_connection(oauth_attempt_hash)
            WHERE oauth_attempt_hash IS NOT NULL;

        CREATE TABLE linear_task_request (
            id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL,
            workspace_id uuid NOT NULL,
            item_id uuid NOT NULL,
            connection_id uuid NOT NULL,
            connection_revision bigint NOT NULL CHECK (connection_revision > 0),
            requester_id uuid NOT NULL,
            requester_token_id uuid,
            issue_id text NOT NULL CHECK (length(issue_id) BETWEEN 1 AND 64),
            status text NOT NULL CHECK (status IN ('pending', 'running', 'declined', 'succeeded', 'failed', 'unknown', 'expired')),
            created_at timestamptz NOT NULL,
            expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
            approver_id uuid CHECK (approver_id = requester_id),
            decided_at timestamptz,
            CHECK ((approver_id IS NULL) = (decided_at IS NULL)),
            CHECK (status IN ('pending', 'expired') OR decided_at IS NOT NULL),
            result_json jsonb CHECK (jsonb_typeof(result_json) = 'object' AND octet_length(result_json::text) <= 32768),
            CHECK ((status = 'succeeded') = (result_json IS NOT NULL)),
            FOREIGN KEY (tenant_id, item_id) REFERENCES item(tenant_id, id) ON DELETE CASCADE,
            FOREIGN KEY (tenant_id, workspace_id, requester_id, connection_id)
                REFERENCES linear_connection(tenant_id, workspace_id, owner_id, id) ON DELETE CASCADE
        );
        CREATE INDEX ix_linear_task_request_item ON linear_task_request(tenant_id, item_id, requester_id, created_at DESC, id DESC);
        CREATE INDEX ix_linear_task_request_connection ON linear_task_request(connection_id);

        ALTER TABLE linear_connection ENABLE ROW LEVEL SECURITY;
        ALTER TABLE linear_connection FORCE ROW LEVEL SECURITY;
        CREATE POLICY linear_connection_owner ON linear_connection USING (
            tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
            AND workspace_id = COALESCE(NULLIF(current_setting('nix.workspace_id', true), '')::uuid, workspace_id)
            AND owner_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
        ) WITH CHECK (
            tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
            AND workspace_id = COALESCE(NULLIF(current_setting('nix.workspace_id', true), '')::uuid, workspace_id)
            AND owner_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
        );

        ALTER TABLE linear_task_request ENABLE ROW LEVEL SECURITY;
        ALTER TABLE linear_task_request FORCE ROW LEVEL SECURITY;
        CREATE POLICY linear_task_request_owner ON linear_task_request USING (
            tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
            AND workspace_id = COALESCE(NULLIF(current_setting('nix.workspace_id', true), '')::uuid, workspace_id)
            AND requester_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
        ) WITH CHECK (
            tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
            AND workspace_id = COALESCE(NULLIF(current_setting('nix.workspace_id', true), '')::uuid, workspace_id)
            AND requester_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
        );

        REVOKE ALL ON linear_connection, linear_task_request FROM PUBLIC, nix_app;
        GRANT SELECT, INSERT, UPDATE ON linear_connection, linear_task_request TO nix_app;
        """);

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        DROP TABLE linear_task_request;
        DROP TABLE linear_connection;
        """);
}
