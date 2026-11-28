using System.Text.Json;
using Nix.Integration.Tests.Harness;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresCollectionDefinition.Name)]
public sealed class PetPlanConsentStoreExplainTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;
    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }
    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Bounded_decision_context_CAS_has_a_real_Postgres_plan()
    {
        var tenant = TestTenants.Alpha;
        var owner = TestTenants.AlphaPrincipal;
        var workspace = TestTenants.AlphaWorkspace;
        var runId = Guid.NewGuid();
        var planId = Guid.NewGuid();
        var credential = Guid.NewGuid();
        await using (var seed = await fixture.OpenMigratorConnectionAsync())
        {
            await RawSql.ExecuteAsync(seed, null, $"""
                INSERT INTO pet_run(id,tenant_id,actor_id,workspace_id,item_id,brief,source_item_ids,workspace_scope,
                    abilities,status,revision,state,created_at,updated_at)
                VALUES('{runId:D}','{tenant:D}','{owner:D}','{workspace:D}','{M0SchemaSeed.Alpha.ItemId:D}',
                    'Fixture plan',ARRAY[]::uuid[],false,ARRAY[]::text[],'queued',1,jsonb_build_object(),now(),now());
                INSERT INTO pet_plan_decision_context(id,tenant_id,owner_id,workspace_id,run_id,plan_id,plan_version,
                    review_digest,grantee_credential_id,client_name,approve,secret_hash,expires_at,authority_id,authorized_at)
                SELECT gen_random_uuid(),'{tenant:D}','{owner:D}','{workspace:D}','{runId:D}','{planId:D}',1,
                    'review','{credential:D}','Fixture CLI',true,
                    CASE WHEN n=1 THEN repeat('c',64) ELSE md5('context-' || n) || md5('context-tail-' || n) END,
                    now()+interval '4 minutes',gen_random_uuid(),now()
                FROM generate_series(1,100) n;
                ANALYZE pet_plan_decision_context;
                """);
        }

        await using var connection = new NpgsqlConnection(fixture.ApplicationConnectionString);
        await connection.OpenAsync(Cancellation);
        await using var transaction = await connection.BeginTransactionAsync(Cancellation);
        await RawSql.ExecuteAsync(connection, transaction, $"""
            SELECT set_config('nix.tenant_id','{tenant:D}',true),
                set_config('nix.principal_id','{owner:D}',true),set_config('nix.workspace_id','{workspace:D}',true);
            """);
        var consume = await Explain(connection, transaction, $"""
            UPDATE pet_plan_decision_context SET consumed_request_id='{Guid.NewGuid():D}', consumed_at=now()
            WHERE tenant_id='{tenant:D}' AND owner_id='{owner:D}' AND workspace_id='{workspace:D}'
                AND secret_hash=repeat('c',64) AND run_id='{runId:D}' AND plan_id='{planId:D}' AND plan_version=1
                AND review_digest='review' AND approve=true AND grantee_credential_id='{credential:D}'
                AND expires_at>now() AND revoked_at IS NULL AND authority_id IS NOT NULL AND consumed_request_id IS NULL
            RETURNING id
            """);
        Assert.Contains("Index", consume, StringComparison.Ordinal);
        if (Environment.GetEnvironmentVariable("NIX_PLAN_SQL_EVIDENCE") is { Length: > 0 } directory)
        {
            Directory.CreateDirectory(directory);
            await File.WriteAllTextAsync(Path.Combine(directory, "consent-store-explain.json"),
                JsonSerializer.Serialize(new
                {
                    fixture = "isolated Postgres16",
                    contextRows = 100,
                    consume = JsonSerializer.Deserialize<JsonElement>(consume)
                }), Cancellation);
        }
        await transaction.RollbackAsync(Cancellation);
    }

#pragma warning disable CA2100 // Test SQL uses only fixture GUIDs and fixed query text.
    private static async Task<string> Explain(NpgsqlConnection connection, NpgsqlTransaction transaction, string sql)
    {
        await using var command = new NpgsqlCommand("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + sql, connection, transaction);
        return Assert.IsType<string>(await command.ExecuteScalarAsync(Cancellation));
    }
#pragma warning restore CA2100
}
