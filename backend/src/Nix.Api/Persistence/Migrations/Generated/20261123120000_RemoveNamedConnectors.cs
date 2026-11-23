using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>
/// Removes the integrations built for one named external product: the Linear tables, the mailbox
/// watch tables with the automation rules that used them, every connection that is not a
/// registered remote MCP tool or a browser site, and the browser OAuth state those connections
/// needed.
/// </summary>
/// <remarks>
/// Hand-written (the Design package is not referenced); these tables were created by raw SQL and
/// are not in the model, so the snapshot is unchanged. Runs as the migrator, which holds
/// <c>BYPASSRLS</c>. Down restores the schema only: the deleted rows held credentials for
/// providers Core can no longer call.
/// </remarks>
[DbContext(typeof(NixDbContext))]
[Migration("20261123120000_RemoveNamedConnectors")]
public sealed class RemoveNamedConnectors : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        ArgumentNullException.ThrowIfNull(migrationBuilder);
        migrationBuilder.Sql("""
            DROP TABLE IF EXISTS linear_item_link, linear_task_request, linear_connection,
                pet_mailbox_seen, pet_mailbox_cursor;

            UPDATE scheduled_trigger t
               SET status = 'cancelled', updated_at = now()
              FROM automation_rule r
             WHERE t.kind = 'automation' AND t.rule_id = r.id AND t.status = 'pending'
               AND r.actions @> '[{"type": "poll_pet_mailbox"}]';
            DELETE FROM automation_rule WHERE actions @> '[{"type": "poll_pet_mailbox"}]';

            DELETE FROM pet_connector_grant WHERE provider NOT IN ('mcp', 'browser-site');
            -- Dropping the columns also drops the pending-state index and the two checks on them.
            ALTER TABLE pet_connector_grant
                DROP COLUMN state_hash,
                DROP COLUMN protected_pending,
                DROP COLUMN pending_expires_at;
            """);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        ArgumentNullException.ThrowIfNull(migrationBuilder);
        migrationBuilder.Sql("""
            ALTER TABLE pet_connector_grant
                ADD COLUMN state_hash text CHECK (state_hash ~ '^[0-9a-f]{64}$'),
                ADD COLUMN protected_pending text CHECK (octet_length(protected_pending) BETWEEN 1 AND 65536),
                ADD COLUMN pending_expires_at timestamptz,
                ADD CHECK ((protected_pending IS NULL) = (pending_expires_at IS NULL)),
                ADD CHECK (protected_pending IS NULL OR state_hash IS NOT NULL);
            CREATE UNIQUE INDEX ix_pet_connector_grant_pending ON pet_connector_grant(state_hash)
                WHERE state_hash IS NOT NULL;
            """);
        Migration[] removed = [new LinearTaskApprovals(), new LinearPetReceipts(), new LinearItemLinks(), new PetMailboxPolls()];
        foreach (var operation in removed.SelectMany(migration => migration.UpOperations))
        {
            migrationBuilder.Operations.Add(operation);
        }
    }
}
