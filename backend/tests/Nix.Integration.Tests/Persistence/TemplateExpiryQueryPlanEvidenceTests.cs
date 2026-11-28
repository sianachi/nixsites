using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Nix.Integration.Tests.Harness;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>Records the workspace-scoped expiry plans against the MVP stress corpus size.</summary>
[Trait("Category", "PlanEvidence")]
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class TemplateExpiryQueryPlanEvidenceTests : IAsyncLifetime
{
    private const int CorpusSize = 3200;
    private readonly NixPostgresFixture _fixture;
    private readonly ITestOutputHelper _output;

    public TemplateExpiryQueryPlanEvidenceTests(NixPostgresFixture fixture, ITestOutputHelper output)
    {
        _fixture = fixture;
        _output = output;
    }

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedCorpusAsync();
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Theory]
    [InlineData(
        "template_operation",
        "operation_id",
        "IX_template_operation_tenant_id_workspace_id_state_expires_at")]
    [InlineData(
        "template_application",
        "application_id",
        "IX_template_application_tenant_id_workspace_id_state_expires_at")]
    public async Task Expiry_scan_uses_the_tenant_workspace_index(
        string table,
        string idColumn,
        string indexName)
    {
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await using var transaction = await connection.BeginTransactionAsync(TestContext.Current.CancellationToken);
            await using (var context = new NpgsqlCommand(
                """
                SELECT set_config('nix.tenant_id', @tenant_id, true),
                       set_config('nix.workspace_id', @workspace_id, true),
                       set_config('nix.principal_id', @principal_id, true);
                """,
                connection,
                transaction))
            {
                context.Parameters.AddWithValue("tenant_id", TestTenants.Alpha.ToString("D"));
                context.Parameters.AddWithValue("workspace_id", TestTenants.AlphaWorkspace.ToString("D"));
                context.Parameters.AddWithValue("principal_id", TestTenants.AlphaPrincipal.ToString("D"));
                await context.ExecuteNonQueryAsync(TestContext.Current.CancellationToken);
            }

#pragma warning disable CA2100 // Justification: table, identifier, and index are closed test theory constants.
            var command = new NpgsqlCommand($$"""
                EXPLAIN (ANALYZE, BUFFERS)
                SELECT {{idColumn}}
                  FROM {{table}}
                 WHERE tenant_id = @tenant_id
                   AND workspace_id = @workspace_id
                   AND (state = 'aborted'
                        OR (state = 'provisioning' AND expires_at <= now()))
                 ORDER BY expires_at, {{idColumn}}
                 LIMIT @limit
                """, connection, transaction);
#pragma warning restore CA2100
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.AddWithValue("tenant_id", TestTenants.Alpha);
                command.Parameters.AddWithValue("workspace_id", TestTenants.AlphaWorkspace);
                command.Parameters.AddWithValue("limit", 25);
                var plan = new StringBuilder();
                var reader = await command.ExecuteReaderAsync(TestContext.Current.CancellationToken);
                await using (reader.ConfigureAwait(false))
                {
                    while (await reader.ReadAsync(TestContext.Current.CancellationToken))
                    {
                        plan.AppendLine(reader.GetString(0));
                    }
                }

                var text = plan.ToString();
                _output.WriteLine(
                    "EXPLAIN (ANALYZE, BUFFERS), {0}, {1} rows:{2}{3}",
                    table,
                    CorpusSize,
                    Environment.NewLine,
                    text);
                Assert.Contains(indexName, text, StringComparison.Ordinal);
                Assert.Contains("actual", text, StringComparison.Ordinal);
                Assert.Contains("Buffers:", text, StringComparison.Ordinal);
                Assert.DoesNotContain("Seq Scan", text, StringComparison.Ordinal);
                Assert.Matches(
                    new Regex(@"actual [^\r\n]* rows=20 loops=1", RegexOptions.CultureInvariant),
                    text);
            }
        }
    }

    private async Task SeedCorpusAsync()
    {
        var tenant = SqlUuid(TestTenants.Alpha);
        var workspace = SqlUuid(TestTenants.AlphaWorkspace);
        var principal = SqlUuid(TestTenants.AlphaPrincipal);
        var target = SqlUuid(M0SchemaSeed.Alpha.ItemId);
        var template = SqlUuid(Guid.NewGuid());
        var sql = $$"""
            INSERT INTO workspace_template
                (template_id, tenant_id, workspace_id, stable_key, profile_key, origin, title,
                 include_body, include_children, state, revision, created_by, last_modified_by,
                 created_at, last_modified_at)
            VALUES
                ({{template}}, {{tenant}}, {{workspace}}, 'query-plan.template',
                 'query-plan.template', 'user', 'Query plan template', false, false, 'active', 1,
                 {{principal}}, {{principal}}, now(), now());

            INSERT INTO template_operation
                (operation_id, tenant_id, workspace_id, template_id, kind, idempotency_key,
                 actor_id, state, created_at, expires_at)
            SELECT gen_random_uuid(), {{tenant}}, {{workspace}}, {{template}}, 'import',
                   'expiry-operation-' || n, {{principal}},
                   CASE WHEN n <= 20 THEN 'aborted' ELSE 'active' END,
                   now(), now() - interval '1 minute'
              FROM generate_series(1, {{CorpusSize}}) AS n;

            INSERT INTO template_application
                (application_id, tenant_id, workspace_id, template_id, target_item_id, mode,
                 idempotency_key, actor_id, state, created_at, expires_at)
            SELECT gen_random_uuid(), {{tenant}}, {{workspace}}, {{template}}, {{target}}, 'merge',
                   'expiry-application-' || n, {{principal}},
                   CASE WHEN n <= 20 THEN 'aborted' ELSE 'active' END,
                   now(), now() - interval '1 minute'
              FROM generate_series(1, {{CorpusSize}}) AS n;

            ANALYZE template_operation;
            ANALYZE template_application;
            """;

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    private static string SqlUuid(Guid value) =>
        $"'{value.ToString("D", CultureInfo.InvariantCulture)}'::uuid";
}
