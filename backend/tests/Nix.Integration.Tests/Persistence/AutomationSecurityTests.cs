using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Nix.Abstractions;
using Nix.Domain.Automations;
using Nix.Features.Automations;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// [SEC] Automation rules are private to their owner (Amendment 4): no other principal - in the
/// same tenant or another - reads, changes, runs or even detects them, and the cross-owner SQL is
/// reachable only through the narrow functions, executable by <c>nix_app</c> alone.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class AutomationSecurityTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static readonly string[] Finders =
    [
        "nix_find_planned_automation_rules(integer, uuid)",
        "nix_find_automation_date_candidates(uuid, uuid, date, date, integer, text, uuid)",
        "nix_purge_automation_runs(integer)",
    ];

    private const string PlantedTrigger = """{"type":"property_changed","key":"status"}""";
    private const string PlantedActions = """[{"type":"notify","title":"x","body":""}]""";

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, $"""
                INSERT INTO principal
                    (principal_id, tenant_id, external_subject, kind, display_name, email, status, deprovisioned_at)
                VALUES ('{AutomationIntegrationTests.Colleague}', '{TestTenants.Alpha}', 'alpha-automation-peer', 'user', 'Peer',
                        'automation-peer@example.test', 'active', NULL);
                INSERT INTO workspace_member
                    (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
                VALUES ('{TestTenants.AlphaWorkspace}', 'principal', '{AutomationIntegrationTests.Colleague}', '{TestTenants.Alpha}', 'owner',
                        '{TestTenants.AlphaPrincipal}', now());
                """);
        }
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private static NixSessionContext Peer =>
        TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, AutomationIntegrationTests.Colleague);

    [Fact]
    public async Task Another_principal_in_the_same_tenant_or_another_tenant_sees_and_changes_none_of_an_owners_automations()
    {
        var ruleId = await CreateAsync(TestTenants.AlphaContext);

        // The peer is a workspace owner, and still sees nothing: rules are owner-private, not
        // workspace data.
        foreach (var context in new[] { Peer, TestTenants.BetaContext })
        {
            await AssertInvisibleAsync(context, ruleId);
        }

        Assert.Equal("true", await TextAsync($"SELECT enabled::text FROM automation_rule WHERE id = '{ruleId}'"));
    }

    private async Task AssertInvisibleAsync(NixSessionContext context, Guid ruleId)
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            Assert.Equal(0, await work.DbContext.Set<AutomationRule>().CountAsync(rule => rule.Id == ruleId, Cancellation));
            Assert.Equal(0, await work.DbContext.Set<AutomationRun>().CountAsync(run => run.RuleId == ruleId, Cancellation));
            Assert.Equal(0, await work.DbContext.Set<AutomationItemState>().CountAsync(state => state.RuleId == ruleId, Cancellation));

            var dispatcher = work.Resolve<NixDispatcher>();
            Assert.Equal(AutomationErrors.NotFoundCode, (await dispatcher.SendAsync<GetAutomation, AutomationRuleResponse>(new(ruleId), Cancellation)).Error.Code);
            Assert.Equal(AutomationErrors.NotFoundCode, (await dispatcher.SendAsync<UpdateAutomation, AutomationRuleResponse>(
                new(ruleId, 1, Input()), Cancellation)).Error.Code);
            Assert.Equal(AutomationErrors.NotFoundCode, (await dispatcher.SendAsync<DeleteAutomation, bool>(new(ruleId), Cancellation)).Error.Code);
            Assert.Equal(AutomationErrors.NotFoundCode, (await dispatcher.SendAsync<ListAutomationRuns, AutomationRunsPageResponse>(new(ruleId, null), Cancellation)).Error.Code);

            // A write aimed straight at the table changes nothing either.
            var connection = (NpgsqlConnection)work.DbContext.Database.GetDbConnection();
            var transaction = (NpgsqlTransaction)work.Transaction.GetDbTransaction();
            Assert.Equal(0, await RawSql.ExecuteAsync(connection, transaction, $"UPDATE automation_rule SET enabled = false WHERE id = '{ruleId}'"));
            Assert.Equal(0, await RawSql.ExecuteAsync(connection, transaction, $"DELETE FROM automation_rule WHERE id = '{ruleId}'"));
            await work.CommitAsync(Cancellation);
        }
    }

    [Fact]
    public async Task A_principal_cannot_plant_a_rule_owned_by_someone_else()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(Peer, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var connection = (NpgsqlConnection)work.DbContext.Database.GetDbConnection();
            var transaction = (NpgsqlTransaction)work.Transaction.GetDbTransaction();
            var failure = await Assert.ThrowsAsync<PostgresException>(async () => await RawSql.ExecuteAsync(connection, transaction, $"""
                INSERT INTO automation_rule (id, tenant_id, workspace_id, owner_principal_id, name, enabled, trigger_type, watch_key,
                                             trigger, conditions, actions, schema_version, revision, consecutive_failures, created_at, updated_at)
                VALUES (gen_random_uuid(), '{TestTenants.Alpha}', '{TestTenants.AlphaWorkspace}', '{TestTenants.AlphaPrincipal}', 'planted', true,
                        'property_changed', 'status', '{PlantedTrigger}', '[]',
                        '{PlantedActions}', 1, 1, 0, now(), now())
                """));
            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, failure.SqlState);
        }
    }

    [Fact]
    public async Task The_cross_owner_functions_are_executable_by_the_application_role_only_and_pin_their_search_path()
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            foreach (var function in Finders)
            {
                Assert.Equal(true, await RawSql.BooleanAsync(connection, $"SELECT has_function_privilege('nix_app', '{function}', 'EXECUTE')"));
                Assert.Equal(false, await RawSql.BooleanAsync(connection, $"SELECT has_function_privilege('nix_collab', '{function}', 'EXECUTE')"));
                Assert.Equal(false, await RawSql.BooleanAsync(connection, $"""
                    SELECT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                                    WHERE p.oid = '{function}'::regprocedure AND a.grantee = 0)
                    """));
            }

            // The trigger function is callable by nobody; only the trigger invokes it.
            Assert.Equal(false, await RawSql.BooleanAsync(connection,
                "SELECT has_function_privilege('nix_app', 'nix_enqueue_automation_property_changes()', 'EXECUTE')"));

            // Every SECURITY DEFINER function this lane adds ends its search path with pg_temp.
            var paths = await RawSql.TextListAsync(connection, """
                SELECT p.proname || '=' || array_to_string(p.proconfig, ',')
                  FROM pg_proc p
                 WHERE p.prosecdef
                   AND p.proname IN ('nix_enqueue_automation_property_changes', 'nix_find_planned_automation_rules',
                                     'nix_find_automation_date_candidates', 'nix_purge_automation_runs')
                 ORDER BY p.proname
                """);
            Assert.Equal(4, paths.Count);
            Assert.All(paths, path => Assert.EndsWith("search_path=pg_catalog, public, pg_temp", path, StringComparison.Ordinal));
        }
    }

    [Fact]
    public async Task A_temporary_table_cannot_shadow_what_the_finder_reads()
    {
        var ruleId = await CreateAsync(TestTenants.AlphaContext, trigger: """{"type":"schedule","freq":"daily","interval":1,"time":"09:00"}""");
        // The service roles cannot create temporary tables at all (TEMPORARY is revoked from
        // PUBLIC; DatabaseRoleTests proves that wall). This proves the ones behind it - the
        // finder's schema-qualified relations and pinned search path - on their own, from the
        // migrator's session: it owns the database, so it keeps TEMPORARY, and inside a definer
        // name resolution is the same whoever the caller is.
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, """
                CREATE TEMP TABLE automation_rule (tenant_id uuid, id uuid, workspace_id uuid, owner_principal_id uuid,
                    trigger_type text, trigger jsonb, scope_item_id uuid, enabled boolean);
                INSERT INTO automation_rule VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
                    'schedule', '{}', NULL, true);
                """);
            var found = await RawSql.GuidListAsync(connection, transaction: null, "SELECT rule_id FROM nix_find_planned_automation_rules(500)");
            await RawSql.ExecuteAsync(connection, transaction: null, "DROP TABLE pg_temp.automation_rule");
            Assert.Equal([ruleId], found);
        }
    }

    private static AutomationRuleInput Input(string trigger = """{"type":"property_changed","key":"status"}""") =>
        AutomationIntegrationTests.Input("Private", trigger, """[{"type":"notify","title":"Mine"}]""");

    private async Task<Guid> CreateAsync(NixSessionContext context, string trigger = """{"type":"property_changed","key":"status"}""")
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var created = await work.Resolve<NixDispatcher>().SendAsync<CreateAutomation, AutomationRuleResponse>(
                new(context.WorkspaceId!.Value, Input(trigger)), Cancellation);
            Assert.True(created.IsSuccess, created.IsSuccess ? "" : created.Error.Message);
            await work.CommitAsync(Cancellation);
            return created.Value.Id;
        }
    }

    private async Task<string?> TextAsync(string sql)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            return await RawSql.TextAsync(connection, transaction: null, sql);
        }
    }
}
