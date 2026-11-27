using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>
/// Agents addressing pets: the workspace switch (<c>off</c>, <c>ask</c> or <c>on</c>) and one row per
/// message and pet that records whether the pet's turn is waiting, running, answered, failed, declined
/// or expired. The pet's owner reads and changes the rows; a token's daily count is read from them.
/// </summary>
/// <remarks>Hand-written; both are read and written with raw SQL, so the model snapshot does not change.</remarks>
[DbContext(typeof(NixDbContext))]
[Migration("20261127100000_MessagePetTurns")]
public sealed class MessagePetTurns : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        ArgumentNullException.ThrowIfNull(migrationBuilder);
        migrationBuilder.Sql("""
            ALTER TABLE workspace
                ADD COLUMN agents_address_pets text NOT NULL DEFAULT 'off'
                    CONSTRAINT workspace_agents_address_pets_valid CHECK (agents_address_pets IN ('off', 'ask', 'on'));

            CREATE TABLE message_pet_turn (
                tenant_id uuid NOT NULL, message_id uuid NOT NULL, pet_id uuid NOT NULL,
                principal_id uuid NOT NULL,
                status text NOT NULL CHECK (status IN ('pending', 'working', 'answered', 'failed', 'declined', 'expired')),
                reason text CHECK (length(reason) <= 500),
                token_id uuid, token_name text CHECK (length(token_name) <= 100),
                created_at timestamptz NOT NULL DEFAULT now(),
                expires_at timestamptz,
                started_at timestamptz,
                PRIMARY KEY (tenant_id, message_id, pet_id),
                FOREIGN KEY (tenant_id, message_id) REFERENCES item(tenant_id, id) ON DELETE CASCADE,
                FOREIGN KEY (tenant_id, principal_id) REFERENCES principal(tenant_id, principal_id) ON DELETE CASCADE
            );
            CREATE INDEX ix_message_pet_turn_token ON message_pet_turn(tenant_id, token_id, started_at) WHERE token_id IS NOT NULL;
            ALTER TABLE message_pet_turn ENABLE ROW LEVEL SECURITY;
            ALTER TABLE message_pet_turn FORCE ROW LEVEL SECURITY;
            CREATE POLICY message_pet_turn_owner ON message_pet_turn USING (
                tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            ) WITH CHECK (
                tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            );
            REVOKE ALL ON message_pet_turn FROM PUBLIC, nix_app;
            GRANT SELECT, INSERT, UPDATE, DELETE ON message_pet_turn TO nix_app;
            """);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        ArgumentNullException.ThrowIfNull(migrationBuilder);
        migrationBuilder.Sql("""
            DROP TABLE message_pet_turn;
            ALTER TABLE workspace DROP COLUMN agents_address_pets;
            """);
    }
}
