using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Features.Items;
using Nix.Features.Tokens;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class ItemCreationIdempotencyTests(NixPostgresFixture fixture, ITestOutputHelper output) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        await using var connection = await fixture.OpenMigratorConnectionAsync();
        await RawSql.ExecuteAsync(connection, null, "DELETE FROM tenant_role");
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Http_creation_replays_the_key_and_current_children_and_returns_409_for_changed_input()
    {
        using var signingKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        await using var factory = new ConfiguredApplicationFactory(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Nix"] = fixture.ApplicationConnectionString,
            ["Nix:Scheduling:Enabled"] = "false",
            [SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.item-create.test",
            [SelfIssuedTokenService.AudienceConfigurationKey] = "nix",
            [SelfIssuedTokenService.KeyIdConfigurationKey] = "item-create-key",
            [SelfIssuedTokenService.SigningKeyConfigurationKey] = signingKey.ExportECPrivateKeyPem(),
        });
        using var client = factory.CreateClient();
        string secret;
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var token = await work.Resolve<NixDispatcher>().SendAsync<CreateAccessToken, IssuedAccessToken>(
                new CreateAccessToken("Offline creation contract", [AccessTokenScopes.Read, AccessTokenScopes.Write], 1), Cancellation);
            Assert.True(token.IsSuccess);
            secret = token.Value.Secret;
            await work.CommitAsync(Cancellation);
        }
        using var exchange = await client.PostAsJsonAsync("/public/v1/auth/token", new { token = secret }, Cancellation);
        exchange.EnsureSuccessStatusCode();
        var credential = await exchange.Content.ReadFromJsonAsync<JsonObject>(Cancellation);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", credential!["accessToken"]!.GetValue<string>());
        var path = $"/api/v1/workspaces/{TestTenants.AlphaWorkspace:D}/items";
        var request = new JsonObject
        {
            ["type"] = "note",
            ["title"] = "Offline HTTP capture",
            ["idempotencyKey"] = Guid.NewGuid(),
        };
        using var created = await client.PostAsJsonAsync(path, request, Cancellation);
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var original = await created.Content.ReadFromJsonAsync<JsonObject>(Cancellation);
        var itemId = original!["id"]!.GetValue<Guid>();
        Assert.False(original["hasChildren"]!.GetValue<bool>());
        using var child = await client.PostAsJsonAsync(path, new { type = "note", title = "New child", parentId = itemId }, Cancellation);
        Assert.Equal(HttpStatusCode.Created, child.StatusCode);

        using var retry = await client.PostAsJsonAsync(path, request, Cancellation);
        Assert.Equal(HttpStatusCode.Created, retry.StatusCode);
        var replayed = await retry.Content.ReadFromJsonAsync<JsonObject>(Cancellation);
        Assert.Equal(itemId, replayed!["id"]!.GetValue<Guid>());
        Assert.True(replayed["hasChildren"]!.GetValue<bool>());
        request["title"] = "Different capture";
        using var conflicting = await client.PostAsJsonAsync(path, request, Cancellation);
        Assert.Equal(HttpStatusCode.Conflict, conflicting.StatusCode);
        var problem = await conflicting.Content.ReadFromJsonAsync<JsonObject>(Cancellation);
        Assert.Equal("items.idempotency_conflict", problem!["code"]!.GetValue<string>());
        await AssertNoteCountAsync(TestTenants.AlphaContext, 2);
    }

    [Fact]
    public async Task A_retry_after_a_lost_response_returns_the_committed_note_even_after_a_rename()
    {
        var command = Command(TestTenants.AlphaContext);
        var created = await CommitCreationAsync(TestTenants.AlphaContext, command);
        await using (var editing = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var renamed = await editing.Resolve<NixDispatcher>().SendAsync<RenameItem, Item>(
                new RenameItem(created.Id, "Renamed after creation"), Cancellation);
            Assert.True(renamed.IsSuccess);
            await editing.CommitAsync(Cancellation);
        }

        var retried = await CommitCreationAsync(TestTenants.AlphaContext, command);

        Assert.Equal(created.Id, retried.Id);
        Assert.Equal("Renamed after creation", JsonNode.Parse(retried.Properties!)!["title"]!.GetValue<string>());
        await AssertNoteCountAsync(TestTenants.AlphaContext, 1);
    }

    [Fact]
    public async Task Canonical_property_order_matches_but_changed_input_returns_a_conflict()
    {
        var command = Command(TestTenants.AlphaContext) with
        {
            Properties = new JsonObject { ["status"] = "open", ["colour"] = "blue" },
        };
        var created = await CommitCreationAsync(TestTenants.AlphaContext, command);
        var retried = await CommitCreationAsync(TestTenants.AlphaContext, command with
        {
            Properties = new JsonObject { ["colour"] = "blue", ["status"] = "open" },
        });
        Assert.Equal(created.Id, retried.Id);

        await using var conflict = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var result = await conflict.Resolve<NixDispatcher>().SendAsync<CreateItem, Item>(command with
        {
            Properties = new JsonObject { ["status"] = "done", ["colour"] = "blue" },
        }, Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("items.idempotency_conflict", result.Error.Code);
        Assert.Equal(1, await conflict.DbContext.Items.CountAsync(item => item.Type == "note", Cancellation));
    }

    [Fact]
    public async Task Concurrent_requests_with_one_key_commit_one_note()
    {
        var command = Command(TestTenants.AlphaContext);
        await using var first = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var created = await first.Resolve<NixDispatcher>().SendAsync<CreateItem, Item>(command, Cancellation);
        Assert.True(created.IsSuccess);
        await using var second = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var secondProcessId = ((NpgsqlConnection)second.DbContext.Database.GetDbConnection()).ProcessID;
        var pending = second.Resolve<NixDispatcher>().SendAsync<CreateItem, Item>(command, Cancellation).AsTask();
        await WaitForDatabaseLockAsync(secondProcessId);

        await first.CommitAsync(Cancellation);
        var retried = await pending.WaitAsync(TimeSpan.FromSeconds(10), Cancellation);
        Assert.True(retried.IsSuccess);
        Assert.Equal(created.Value.Id, retried.Value.Id);
        await second.CommitAsync(Cancellation);

        await AssertNoteCountAsync(TestTenants.AlphaContext, 1);
    }

    [Fact]
    public async Task A_rolled_back_creation_leaves_no_receipt_or_item()
    {
        var command = Command(TestTenants.AlphaContext);
        ItemId rolledBack;
        await using (var aborted = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var result = await aborted.Resolve<NixDispatcher>().SendAsync<CreateItem, Item>(command, Cancellation);
            Assert.True(result.IsSuccess);
            rolledBack = result.Value.Id;
        }

        var created = await CommitCreationAsync(TestTenants.AlphaContext, command);

        Assert.NotEqual(rolledBack, created.Id);
        await AssertNoteCountAsync(TestTenants.AlphaContext, 1);
        await using var checking = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        Assert.Equal(1, await ReceiptCountAsync(checking));
    }

    [Theory]
    [InlineData(ItemLifecycleState.Deleted)]
    [InlineData(ItemLifecycleState.Purged)]
    public async Task Retry_cannot_recreate_a_deleted_or_purged_note(ItemLifecycleState state)
    {
        var context = TestTenants.AlphaContext;
        var command = Command(context);
        var created = await CommitCreationAsync(context, command);
        await using (var deleting = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation))
        {
            await deleting.Resolve<IItemTree>().SetLifecycleAsync(created.Id, state, context.PrincipalId,
                DateTimeOffset.UtcNow, Cancellation);
            await deleting.CommitAsync(Cancellation);
        }

        await using var retry = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        var result = await retry.Resolve<NixDispatcher>().SendAsync<CreateItem, Item>(command, Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("items.not_found", result.Error.Code);
        Assert.Equal(1, await retry.DbContext.Items.CountAsync(item => item.Type == "note", Cancellation));
        Assert.Equal(1, await ReceiptCountAsync(retry));
    }

    [Fact]
    public async Task A_receipt_survives_physical_item_removal_and_refuses_a_duplicate()
    {
        var context = TestTenants.AlphaContext;
        var command = Command(context);
        var created = await CommitCreationAsync(context, command);
        await using (var connection = await fixture.OpenMigratorConnectionAsync())
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                DELETE FROM item_closure WHERE descendant_id = '{created.Id.Value:D}'::uuid;
                DELETE FROM item WHERE id = '{created.Id.Value:D}'::uuid;
                """);
        }

        await using var retry = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        var result = await retry.Resolve<NixDispatcher>().SendAsync<CreateItem, Item>(command, Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("items.not_found", result.Error.Code);
        Assert.Equal(0, await retry.DbContext.Items.CountAsync(item => item.Type == "note", Cancellation));
        Assert.Equal(1, await ReceiptCountAsync(retry));
    }

    [Fact]
    public async Task Revoked_write_access_refuses_the_retry_without_using_the_receipt_as_a_grant()
    {
        var context = TestTenants.AlphaContext;
        var command = Command(context);
        await CommitCreationAsync(context, command);
        await using (var connection = await fixture.OpenMigratorConnectionAsync())
        {
            await RawSql.ExecuteAsync(connection, null,
                $"DELETE FROM workspace_member WHERE workspace_id = '{context.WorkspaceId!.Value.Value:D}'::uuid");
        }

        await using var retry = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        var result = await retry.Resolve<NixDispatcher>().SendAsync<CreateItem, Item>(command, Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("workspaces.not_found", result.Error.Code);
        await using var checking = await fixture.OpenMigratorConnectionAsync();
        Assert.Equal(1, await RawSql.CountAsync(checking, null,
            $"SELECT count(*) FROM item WHERE tenant_id = '{context.TenantId.Value:D}'::uuid AND type = 'note'"));
    }

    [Fact]
    public async Task Receipts_and_request_keys_are_isolated_by_tenant_and_principal()
    {
        var key = Guid.NewGuid();
        var alphaCommand = Command(TestTenants.AlphaContext) with { IdempotencyKey = key };
        var alpha = await CommitCreationAsync(TestTenants.AlphaContext, alphaCommand);
        var beta = await CommitCreationAsync(TestTenants.BetaContext,
            Command(TestTenants.BetaContext) with { IdempotencyKey = key });
        var otherPrincipal = Guid.NewGuid();
        await using (var connection = await fixture.OpenMigratorConnectionAsync())
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                INSERT INTO principal (principal_id, tenant_id, external_issuer, external_subject,
                    kind, display_name, status)
                VALUES ('{otherPrincipal:D}'::uuid, '{TestTenants.Alpha:D}'::uuid,
                    'https://issuer.alpha.test', 'other-{otherPrincipal:D}', 'user', 'Other editor', 'active');
                INSERT INTO workspace_member (workspace_id, tenant_id, subject_type, subject_id,
                    role, granted_by, granted_at)
                VALUES ('{TestTenants.AlphaWorkspace:D}'::uuid, '{TestTenants.Alpha:D}'::uuid,
                    'principal', '{otherPrincipal:D}'::uuid, 'editor', '{TestTenants.AlphaPrincipal:D}'::uuid, now());
                """);
        }
        var otherContext = TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, otherPrincipal);
        var other = await CommitCreationAsync(otherContext, alphaCommand);

        Assert.NotEqual(alpha.Id, beta.Id);
        Assert.NotEqual(alpha.Id, other.Id);
        await using var checkingAlpha = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using var checkingBeta = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation);
        await using var checkingOther = await fixture.Application.BeginUnitOfWorkAsync(otherContext, Cancellation);
        Assert.Equal(1, await ReceiptCountAsync(checkingAlpha));
        Assert.Equal(1, await ReceiptCountAsync(checkingBeta));
        Assert.Equal(1, await ReceiptCountAsync(checkingOther));
    }

    [Theory]
    [InlineData("UPDATE item_creation_receipt SET request_hash = request_hash")]
    [InlineData("DELETE FROM item_creation_receipt")]
    public async Task Runtime_role_cannot_change_or_remove_creation_receipts(string sql)
    {
        await CommitCreationAsync(TestTenants.AlphaContext, Command(TestTenants.AlphaContext));
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);

        var error = await Assert.ThrowsAsync<PostgresException>(() => RawSql.ExecuteAsync(
            (NpgsqlConnection)work.DbContext.Database.GetDbConnection(),
            (NpgsqlTransaction)work.Transaction.GetDbTransaction(), sql));

        Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, error.SqlState);
    }

    [Fact]
    public async Task Receipt_lookup_uses_the_primary_key_under_rls_with_ten_thousand_receipts_per_tenant()
    {
        var creation = Command(TestTenants.AlphaContext);
        await CommitCreationAsync(TestTenants.AlphaContext, creation);
        await using (var connection = await fixture.OpenMigratorConnectionAsync())
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                INSERT INTO item_creation_receipt (tenant_id, principal_id, request_key, request_hash, item_id)
                SELECT t.tenant_id, t.principal_id, md5(n::text)::uuid,
                    sha256(convert_to(jsonb_build_object()::text, 'UTF8')), t.item_id
                FROM (VALUES
                    ('{TestTenants.Alpha:D}'::uuid, '{TestTenants.AlphaPrincipal:D}'::uuid, '{M0SchemaSeed.Alpha.ItemId:D}'::uuid),
                    ('{TestTenants.Beta:D}'::uuid, '{TestTenants.BetaPrincipal:D}'::uuid, '{M0SchemaSeed.Beta.ItemId:D}'::uuid)
                ) t(tenant_id, principal_id, item_id)
                CROSS JOIN generate_series(1, 10000) n;
                ANALYZE item_creation_receipt;
                """);
        }
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        const string explain = "EXPLAIN (ANALYZE, BUFFERS) " + ItemCreationSql.Find;
        await using var command = new NpgsqlCommand(explain,
            (NpgsqlConnection)work.DbContext.Database.GetDbConnection(),
            (NpgsqlTransaction)work.Transaction.GetDbTransaction());
        command.Parameters.AddWithValue("tenant_id", NpgsqlDbType.Uuid, TestTenants.Alpha);
        command.Parameters.AddWithValue("principal_id", NpgsqlDbType.Uuid, TestTenants.AlphaPrincipal);
        command.Parameters.AddWithValue("key", NpgsqlDbType.Uuid, creation.IdempotencyKey!.Value);
        command.Parameters.AddWithValue("request", NpgsqlDbType.Text, "{}");
        var lines = new StringBuilder();
        await using (var reader = await command.ExecuteReaderAsync(Cancellation))
        {
            while (await reader.ReadAsync(Cancellation))
            {
                lines.AppendLine(reader.GetString(0));
            }
        }
        var plan = lines.ToString();
        output.WriteLine("Receipt lookup as nix_app, 10,000 receipts per tenant:");
        output.WriteLine(plan);
        Assert.Contains("Index Scan using item_creation_receipt_pkey", plan, StringComparison.Ordinal);
        Assert.Contains("rows=1 loops=1", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan", plan, StringComparison.Ordinal);
    }

    private static CreateItem Command(NixSessionContext context) =>
        new(context.WorkspaceId!.Value, "note", "Offline capture", null, null) { IdempotencyKey = Guid.NewGuid() };

    private async Task<Item> CommitCreationAsync(NixSessionContext context, CreateItem command)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        var result = await work.Resolve<NixDispatcher>().SendAsync<CreateItem, Item>(command, Cancellation);
        Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : null);
        await work.CommitAsync(Cancellation);
        return result.Value;
    }

    private async Task AssertNoteCountAsync(NixSessionContext context, int expected)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        Assert.Equal(expected, await work.DbContext.Items.CountAsync(item => item.Type == "note", Cancellation));
    }

    private static Task<long> ReceiptCountAsync(NixUnitOfWork work) => RawSql.CountAsync(
        (NpgsqlConnection)work.DbContext.Database.GetDbConnection(),
        (NpgsqlTransaction)work.Transaction.GetDbTransaction(), "SELECT count(*) FROM item_creation_receipt");

    private async Task WaitForDatabaseLockAsync(int processId)
    {
        await using var connection = await fixture.OpenMigratorConnectionAsync();
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (DateTime.UtcNow < deadline)
        {
            if (await RawSql.CountAsync(connection, null,
                    $"SELECT count(*) FROM pg_locks WHERE pid = {processId} AND NOT granted") > 0)
            {
                return;
            }
            await Task.Delay(10, Cancellation);
        }
        Assert.Fail("The concurrent creation did not wait for its transaction lock.");
    }
}
