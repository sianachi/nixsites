using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Nix.Integration.Tests.Harness;
using Nix.Persistence;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresCollectionDefinition.Name)]
public sealed class RemoveNamedConnectorsMigrationTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        await M0SchemaSeed.SeedCurrentSchemaRowsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Upgrade_drops_provider_connections_and_mailbox_rules_and_keeps_registered_tools()
    {
        var options = new DbContextOptionsBuilder<NixDbContext>()
            .UseNpgsql(fixture.MigratorConnectionString).Options;
        await using var context = new NixDbContext(options);
        var migrator = context.GetService<IMigrator>();
        // Walking back also proves Down restores a schema the older code can use.
        await migrator.MigrateAsync("20261122140000_SyncBoundedExpiry", Cancellation);
        try
        {
            var before = await CountAsync(context, "SELECT count(*)::int AS \"Value\" FROM pet_connector_grant WHERE provider = 'mcp'");
            Assert.True(before > 0);
            await context.Database.ExecuteSqlRawAsync("""
                INSERT INTO pet_connector_grant
                    (id, tenant_id, workspace_id, owner_id, revision, provider, resource_kind, resource_id,
                     protected_tokens, state_hash, protected_pending, pending_expires_at)
                SELECT gen_random_uuid(), tenant_id, workspace_id, owner_id, gen_random_uuid(), 'slack', 'channel', 'C1',
                       'protected', repeat('a', 64), 'pending', now() + interval '5 minutes'
                  FROM pet_connector_grant WHERE provider = 'mcp' LIMIT 1;
                UPDATE automation_rule SET actions = '[{{"type": "poll_pet_mailbox", "provider": "gmail"}}]'::jsonb
                 WHERE id = (SELECT id FROM automation_rule ORDER BY id LIMIT 1);
                INSERT INTO pet_mailbox_cursor (rule_id, connection_id, connection_revision, cursor, baselined)
                SELECT (SELECT id FROM automation_rule ORDER BY id LIMIT 1), id, revision, 'cursor', true
                  FROM pet_connector_grant WHERE provider = 'slack';
                """, Cancellation);
            var rules = await CountAsync(context, "SELECT count(*)::int AS \"Value\" FROM automation_rule");

            await migrator.MigrateAsync(targetMigration: null, cancellationToken: Cancellation);

            Assert.Equal(0, await CountAsync(context, "SELECT count(*)::int AS \"Value\" FROM pet_connector_grant WHERE provider <> 'mcp'"));
            Assert.Equal(before, await CountAsync(context, "SELECT count(*)::int AS \"Value\" FROM pet_connector_grant WHERE provider = 'mcp'"));
            Assert.Equal(rules - 1, await CountAsync(context, "SELECT count(*)::int AS \"Value\" FROM automation_rule"));
            Assert.Equal(0, await CountAsync(context, """
                SELECT count(*)::int AS "Value" FROM information_schema.tables
                 WHERE table_name LIKE 'linear\_%' OR table_name LIKE 'pet\_mailbox\_%'
                """));
            Assert.Equal(0, await CountAsync(context, """
                SELECT count(*)::int AS "Value" FROM information_schema.columns
                 WHERE table_name = 'pet_connector_grant' AND column_name IN ('state_hash', 'protected_pending', 'pending_expires_at')
                """));
        }
        finally
        {
            await migrator.MigrateAsync(targetMigration: null, cancellationToken: Cancellation);
        }
    }

    private static async Task<int> CountAsync(NixDbContext context, string sql) =>
        (await context.Database.SqlQueryRaw<int>(sql).ToListAsync(Cancellation)).Single();
}
