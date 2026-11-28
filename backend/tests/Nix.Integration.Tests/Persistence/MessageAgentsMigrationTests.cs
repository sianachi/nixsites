using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Nix.Integration.Tests.Harness;
using Nix.Persistence;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresCollectionDefinition.Name)]
public sealed class MessageAgentsMigrationTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private const string Before = "20261128100000_MessagePetTurnCode";

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        await M0SchemaSeed.SeedCurrentSchemaRowsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_token_minted_with_pets_send_keeps_working_under_the_agents_scope()
    {
        await using var context = new NixDbContext(new DbContextOptionsBuilder<NixDbContext>().UseNpgsql(fixture.MigratorConnectionString).Options);
        var migrator = context.GetService<IMigrator>();
        // Walking back also proves Down leaves a schema the older code can use.
        await migrator.MigrateAsync(Before, Cancellation);
        try
        {
            var principal = TestTenants.AlphaPrincipal;
            var tenant = TestTenants.Alpha;
            await context.Database.ExecuteSqlAsync($"""
                INSERT INTO personal_access_token (token_id, tenant_id, principal_id, name, lookup, secret_hash, scopes, created_at, expires_at)
                VALUES ('c0c0c000-0000-4000-8000-000000000001', {tenant}, {principal}, 'old agent', 'mtok0000000a', '\x0304'::bytea, ARRAY['read','write','pets:send']::text[], now(), now() + interval '30 days'),
                       ('c0c0c000-0000-4000-8000-000000000002', {tenant}, {principal}, 'plain', 'mtok0000000b', '\x0304'::bytea, ARRAY['read']::text[], now(), now() + interval '30 days')
                """, Cancellation);

            await migrator.MigrateAsync(targetMigration: null, cancellationToken: Cancellation);

            var scopes = await context.Database.SqlQueryRaw<string>("SELECT array_to_string(scopes, ',') AS \"Value\" FROM personal_access_token WHERE name IN ('old agent', 'plain') ORDER BY name").ToListAsync(Cancellation);
            Assert.Equal(["read,write,agents", "read"], scopes);
        }
        finally
        {
            await migrator.MigrateAsync(targetMigration: null, cancellationToken: Cancellation);
        }
    }

    [Fact]
    public async Task A_plan_that_stopped_to_ask_the_removed_sharing_question_is_queued_again_and_other_waiting_plans_are_left_alone()
    {
        await using var context = new NixDbContext(new DbContextOptionsBuilder<NixDbContext>().UseNpgsql(fixture.MigratorConnectionString).Options);
        var migrator = context.GetService<IMigrator>();
        await migrator.MigrateAsync(Before, Cancellation);
        try
        {
            var (tenant, owner, workspace) = (TestTenants.Alpha, TestTenants.AlphaPrincipal, TestTenants.AlphaWorkspace);
            var (stranded, failed, asking) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
            await context.Database.ExecuteSqlAsync($$$"""
                INSERT INTO pet_run (id, tenant_id, workspace_id, item_id, actor_id, brief, source_item_ids, workspace_scope, abilities, status, revision, state, created_at, updated_at, request_id)
                VALUES ({{{stranded}}}, {{{tenant}}}, {{{workspace}}}, NULL, {{{owner}}}, 'Plan A', ARRAY[]::uuid[], false, ARRAY[]::text[], 'waiting_for_input', 3,
                        '{"petId": "c0c0c000-0000-4000-8000-0000000000aa", "sharingQuestion": {"recipient": "x"}, "keep": 1}'::jsonb, now(), now(), gen_random_uuid()),
                       ({{{failed}}}, {{{tenant}}}, {{{workspace}}}, NULL, {{{owner}}}, 'Plan B', ARRAY[]::uuid[], false, ARRAY[]::text[], 'waiting_for_input', 5,
                        '{"petId": "c0c0c000-0000-4000-8000-0000000000aa", "failure": {"stage": "sharing", "code": "pet_plans.sharing_required", "message": "m"}}'::jsonb, now(), now(), gen_random_uuid()),
                       ({{{asking}}}, {{{tenant}}}, {{{workspace}}}, NULL, {{{owner}}}, 'Plan C', ARRAY[]::uuid[], false, ARRAY[]::text[], 'waiting_for_input', 2,
                        '{"petId": "c0c0c000-0000-4000-8000-0000000000aa", "question": {"id": "q"}}'::jsonb, now(), now(), gen_random_uuid())
                """, Cancellation);

            await migrator.MigrateAsync(targetMigration: null, cancellationToken: Cancellation);

            foreach (var (id, revision) in new[] { (stranded, 4L), (failed, 6L) })
            {
                var run = await context.Database.SqlQuery<string>($"""
                    SELECT status || '|' || revision || '|' || (state ? 'sharingQuestion') || '|' || (state ->> 'activeJobId') AS "Value" FROM pet_run WHERE id = {id}
                    """).SingleAsync(Cancellation);
                var parts = run.Split('|');
                Assert.Equal(("queued", revision.ToString(System.Globalization.CultureInfo.InvariantCulture), "false"), (parts[0], parts[1], parts[2]));
                var job = await context.Database.SqlQuery<string>($"""
                    SELECT kind || '|' || status || '|' || (payload ->> 'runId') || '|' || job_id AS "Value" FROM worker_job WHERE idempotency_key = {"pet-run:" + id.ToString("N") + ":" + revision}
                    """).SingleAsync(Cancellation);
                Assert.Equal($"pet.plan.advance|queued|{id}|{parts[3]}", job);
            }

            var untouched = await context.Database.SqlQuery<string>($"SELECT status || '|' || revision AS \"Value\" FROM pet_run WHERE id = {asking}").SingleAsync(Cancellation);
            Assert.Equal("waiting_for_input|2", untouched);
        }
        finally
        {
            await migrator.MigrateAsync(targetMigration: null, cancellationToken: Cancellation);
        }
    }
}
