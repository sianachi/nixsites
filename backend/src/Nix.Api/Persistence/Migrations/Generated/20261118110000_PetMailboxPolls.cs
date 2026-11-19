using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Persists mailbox poll cursors and deduplication keys under their automation rule.</summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261118110000_PetMailboxPolls")]
public sealed class PetMailboxPolls : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        CREATE TABLE pet_mailbox_cursor (
            rule_id uuid NOT NULL REFERENCES automation_rule(id) ON DELETE CASCADE,
            connection_id uuid NOT NULL REFERENCES pet_connector_grant(id) ON DELETE CASCADE,
            connection_revision uuid NOT NULL,
            cursor text NOT NULL CHECK (octet_length(cursor) BETWEEN 1 AND 8192),
            page_token text CHECK (octet_length(page_token) BETWEEN 1 AND 8192),
            baselined boolean NOT NULL,
            PRIMARY KEY (rule_id, connection_id, connection_revision)
        );
        CREATE TABLE pet_mailbox_seen (
            rule_id uuid NOT NULL REFERENCES automation_rule(id) ON DELETE CASCADE,
            connection_id uuid NOT NULL REFERENCES pet_connector_grant(id) ON DELETE CASCADE,
            connection_revision uuid NOT NULL,
            message_hash bytea NOT NULL CHECK (octet_length(message_hash) = 32),
            PRIMARY KEY (rule_id, connection_id, connection_revision, message_hash)
        );
        ALTER TABLE pet_mailbox_cursor ENABLE ROW LEVEL SECURITY;
        ALTER TABLE pet_mailbox_cursor FORCE ROW LEVEL SECURITY;
        ALTER TABLE pet_mailbox_seen ENABLE ROW LEVEL SECURITY;
        ALTER TABLE pet_mailbox_seen FORCE ROW LEVEL SECURITY;
        CREATE POLICY pet_mailbox_cursor_owner ON pet_mailbox_cursor USING (
            EXISTS (
                SELECT 1 FROM automation_rule r
                JOIN pet_connector_grant g ON g.tenant_id = r.tenant_id AND g.workspace_id = r.workspace_id
                  AND g.owner_id = r.owner_principal_id
                WHERE r.id = pet_mailbox_cursor.rule_id AND g.id = pet_mailbox_cursor.connection_id
                  AND g.revision = pet_mailbox_cursor.connection_revision AND g.protected_tokens IS NOT NULL
            )
        );
        CREATE POLICY pet_mailbox_seen_owner ON pet_mailbox_seen USING (
            EXISTS (
                SELECT 1 FROM automation_rule r
                JOIN pet_connector_grant g ON g.tenant_id = r.tenant_id AND g.workspace_id = r.workspace_id
                  AND g.owner_id = r.owner_principal_id
                WHERE r.id = pet_mailbox_seen.rule_id AND g.id = pet_mailbox_seen.connection_id
                  AND g.revision = pet_mailbox_seen.connection_revision AND g.protected_tokens IS NOT NULL
            )
        );
        REVOKE ALL ON pet_mailbox_cursor, pet_mailbox_seen FROM PUBLIC, nix_app;
        GRANT SELECT, INSERT, UPDATE ON pet_mailbox_cursor TO nix_app;
        GRANT SELECT, INSERT ON pet_mailbox_seen TO nix_app;
        """);

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) =>
        migrationBuilder.Sql("DROP TABLE pet_mailbox_seen, pet_mailbox_cursor;");
}
