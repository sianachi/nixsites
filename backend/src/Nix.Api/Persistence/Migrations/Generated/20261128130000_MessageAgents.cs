using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>
/// Agents contacting each other: one inbox row per message and agent token it addressed (read when the token says so),
/// and one row per message a token posted, which the 500-a-day cap counts (kept when the message is deleted, so deleting cannot dodge the cap). The owner's units of work read and write both.
/// </summary>
/// <remarks>Hand-written; both tables are read and written with raw SQL, so the model snapshot does not change.</remarks>
[DbContext(typeof(NixDbContext))]
[Migration("20261128130000_MessageAgents")]
public sealed class MessageAgents : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        ArgumentNullException.ThrowIfNull(migrationBuilder);
        migrationBuilder.Sql("""
            CREATE TABLE message_agent_inbox (
                tenant_id uuid NOT NULL, message_id uuid NOT NULL, token_id uuid NOT NULL, principal_id uuid NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now(),
                read_at timestamptz,
                PRIMARY KEY (tenant_id, message_id, token_id),
                FOREIGN KEY (tenant_id, message_id) REFERENCES item(tenant_id, id) ON DELETE CASCADE,
                FOREIGN KEY (tenant_id, principal_id) REFERENCES principal(tenant_id, principal_id) ON DELETE CASCADE
            );
            CREATE INDEX ix_message_agent_inbox_unread ON message_agent_inbox(tenant_id, token_id, message_id DESC) WHERE read_at IS NULL;

            CREATE TABLE message_token_post (
                tenant_id uuid NOT NULL, message_id uuid NOT NULL, token_id uuid NOT NULL, principal_id uuid NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (tenant_id, message_id),
                FOREIGN KEY (tenant_id, principal_id) REFERENCES principal(tenant_id, principal_id) ON DELETE CASCADE
            );
            CREATE INDEX ix_message_token_post_token ON message_token_post(tenant_id, token_id, created_at);

            ALTER TABLE message_agent_inbox ENABLE ROW LEVEL SECURITY;
            ALTER TABLE message_agent_inbox FORCE ROW LEVEL SECURITY;
            CREATE POLICY message_agent_inbox_owner ON message_agent_inbox USING (
                tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            ) WITH CHECK (
                tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            );
            ALTER TABLE message_token_post ENABLE ROW LEVEL SECURITY;
            ALTER TABLE message_token_post FORCE ROW LEVEL SECURITY;
            CREATE POLICY message_token_post_owner ON message_token_post USING (
                tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            ) WITH CHECK (
                tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            );
            REVOKE ALL ON message_agent_inbox, message_token_post FROM PUBLIC, nix_app;
            GRANT SELECT, INSERT, UPDATE, DELETE ON message_agent_inbox, message_token_post TO nix_app;
            """);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        ArgumentNullException.ThrowIfNull(migrationBuilder);
        migrationBuilder.Sql("DROP TABLE message_agent_inbox; DROP TABLE message_token_post;");
    }
}
