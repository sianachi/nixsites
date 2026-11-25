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
    public async Task Bounded_owner_lookup_decision_context_CAS_and_cleanup_have_real_Postgres_plans()
    {
        var tenant = TestTenants.Alpha;
        var owner = TestTenants.AlphaPrincipal;
        var workspace = TestTenants.AlphaWorkspace;
        var targetPet = Guid.NewGuid();
        var runId = Guid.NewGuid();
        var planId = Guid.NewGuid();
        var credential = Guid.NewGuid();
        var decisionNonce = Guid.NewGuid();
        await using (var seed = await fixture.OpenMigratorConnectionAsync())
        {
            await RawSql.ExecuteAsync(seed, null, $"""
                INSERT INTO principal(principal_id,tenant_id,external_subject,kind,display_name,email,status)
                SELECT md5('consent-owner-' || n)::uuid, '{tenant:D}', 'consent-owner-' || n, 'user',
                    'Fixture owner ' || n, 'consent-owner-' || n || '@fixture.test', 'active'
                FROM generate_series(1,25) n;
                INSERT INTO pet_plan_consent(id,tenant_id,owner_id,workspace_id,pet_id,scope_digest,recipient_revision,
                    request_id,authority_id,granted_at,expires_at)
                SELECT gen_random_uuid(), '{tenant:D}', md5('consent-owner-' || owner_number)::uuid,
                    '{workspace:D}', gen_random_uuid(), repeat('a',64), repeat('b',64), gen_random_uuid(),
                    gen_random_uuid(), now(), now()+interval '1 day'
                FROM generate_series(1,25) owner_number CROSS JOIN generate_series(1,100) grant_number;
                INSERT INTO pet_plan_consent(id,tenant_id,owner_id,workspace_id,pet_id,scope_digest,recipient_revision,
                    request_id,authority_id,granted_at,expires_at)
                SELECT gen_random_uuid(), '{tenant:D}', '{owner:D}', '{workspace:D}',
                    CASE WHEN n=1 THEN '{targetPet:D}'::uuid ELSE gen_random_uuid() END,
                    repeat('a',64), repeat('b',64), gen_random_uuid(), gen_random_uuid(), now(), now()+interval '1 day'
                FROM generate_series(1,100) n;
                UPDATE pet_plan_consent SET decision_nonce='{decisionNonce:D}',
                    question_expires_at=now()+interval '30 minutes',updated_at=now()
                WHERE tenant_id='{tenant:D}' AND owner_id='{owner:D}' AND pet_id='{targetPet:D}';
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
                ANALYZE pet_plan_consent;
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
        var lookup = await Explain(connection, transaction, $"""
            SELECT id FROM pet_plan_consent WHERE tenant_id='{tenant:D}' AND owner_id='{owner:D}'
                AND workspace_id='{workspace:D}' AND pet_id='{targetPet:D}'
                AND scope_digest=repeat('a',64) AND recipient_revision=repeat('b',64)
            """);
        var consume = await Explain(connection, transaction, $"""
            UPDATE pet_plan_decision_context SET consumed_request_id='{Guid.NewGuid():D}', consumed_at=now()
            WHERE tenant_id='{tenant:D}' AND owner_id='{owner:D}' AND workspace_id='{workspace:D}'
                AND secret_hash=repeat('c',64) AND run_id='{runId:D}' AND plan_id='{planId:D}' AND plan_version=1
                AND review_digest='review' AND approve=true AND grantee_credential_id='{credential:D}'
                AND expires_at>now() AND revoked_at IS NULL AND authority_id IS NOT NULL AND consumed_request_id IS NULL
            RETURNING id
            """);
        var decision = await Explain(connection, transaction, $"""
            UPDATE pet_plan_consent SET request_id='{Guid.NewGuid():D}',authority_id='{Guid.NewGuid():D}',
                granted_at=now(),expires_at=now()+interval '30 days',revoked_at=NULL,
                last_decision_nonce=decision_nonce,decision_nonce=NULL,question_expires_at=NULL,updated_at=now()
            WHERE tenant_id='{tenant:D}' AND owner_id='{owner:D}' AND workspace_id='{workspace:D}'
                AND pet_id='{targetPet:D}' AND scope_digest=repeat('a',64) AND recipient_revision=repeat('b',64)
                AND decision_nonce='{decisionNonce:D}' AND question_expires_at>now()
                AND request_id<>'{Guid.NewGuid():D}'
            """);
        var cleanup = await Explain(connection, transaction, $"""
            DELETE FROM pet_plan_consent WHERE id IN(SELECT id FROM pet_plan_consent
                WHERE tenant_id='{tenant:D}' AND owner_id='{owner:D}'
                ORDER BY updated_at DESC,id OFFSET 100 LIMIT 100)
            """);
        Assert.Contains("Index", lookup, StringComparison.Ordinal);
        Assert.Contains("Index", consume, StringComparison.Ordinal);
        Assert.Contains("Index", decision, StringComparison.Ordinal);
        Assert.Contains("Index", cleanup, StringComparison.Ordinal);
        if (Environment.GetEnvironmentVariable("NIX_PLAN_SQL_EVIDENCE") is { Length: > 0 } directory)
        {
            Directory.CreateDirectory(directory);
            await File.WriteAllTextAsync(Path.Combine(directory, "consent-store-explain.json"),
                JsonSerializer.Serialize(new
                {
                    fixture = "isolated Postgres16",
                    consentRows = 2600,
                    ownerRows = 100,
                    contextRows = 100,
                    lookup = JsonSerializer.Deserialize<JsonElement>(lookup),
                    consume = JsonSerializer.Deserialize<JsonElement>(consume),
                    decision = JsonSerializer.Deserialize<JsonElement>(decision),
                    cleanup = JsonSerializer.Deserialize<JsonElement>(cleanup)
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
