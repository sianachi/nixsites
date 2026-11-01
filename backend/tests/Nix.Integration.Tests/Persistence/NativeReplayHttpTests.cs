using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc.Testing;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Sync;
using Nix.Domain.Tenancy;
using Nix.Features.Tokens;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresCollectionDefinition.Name)]
public sealed class NativeReplayHttpTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static readonly Guid Viewer = new("7c600000-1111-4111-8111-7c6000000001");
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;
    private static string ReplayPath => $"/api/v1/workspaces/{M0SchemaSeed.Alpha.WorkspaceId:D}/sync/replay";

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        await ExecuteAsync("DELETE FROM tenant_role");
        string signingKey;
        using (var key = ECDsa.Create(ECCurve.NamedCurves.nistP256))
        {
            signingKey = key.ExportECPrivateKeyPem();
        }
        _factory = new ConfiguredApplicationFactory(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Nix"] = fixture.ApplicationConnectionString,
            ["Nix:Scheduling:Enabled"] = "false",
            [SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.native-replay.test",
            [SelfIssuedTokenService.AudienceConfigurationKey] = "nix",
            [SelfIssuedTokenService.KeyIdConfigurationKey] = "native-replay-key",
            [SelfIssuedTokenService.SigningKeyConfigurationKey] = signingKey,
        });
        _client = _factory.CreateClient();
    }

    public async ValueTask DisposeAsync()
    {
        _client.Dispose();
        await _factory.DisposeAsync();
    }

    [Fact]
    public async Task Lost_creation_acknowledgement_replays_the_original_receipt_without_another_item()
    {
        var bearer = await AccessTokenAsync();
        var localId = Guid.NewGuid();
        var request = Operation("create", localId, null,
            new { type = "note", title = "Offline capture", parentId = M0SchemaSeed.Alpha.ItemId });
        using var first = await SendAsync(HttpMethod.Post, ReplayPath, bearer, request);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var originalJson = await first.Content.ReadAsStringAsync(Cancellation);
        var original = JsonNode.Parse(originalJson)!.AsObject();
        Assert.Equal("applied", original["status"]!.GetValue<string>());
        Assert.Equal(request["operationId"]!.GetValue<Guid>(), original["operationId"]!.GetValue<Guid>());
        var serverId = original["itemId"]!.GetValue<Guid>();
        Assert.NotEqual(localId, serverId);
        Assert.Equal("Offline capture", original["item"]!["title"]!.GetValue<string>());

        using var renamed = await SendAsync(HttpMethod.Patch, $"/api/v1/items/{serverId:D}", bearer,
            new { title = "Changed after acknowledgement" });
        Assert.Equal(HttpStatusCode.OK, renamed.StatusCode);
        using var retry = await SendAsync(HttpMethod.Post, ReplayPath, bearer, request);
        Assert.Equal(HttpStatusCode.OK, retry.StatusCode);
        // Receipts keep no item data, so the retry carries the item's current state (the rename above bumped it).
        var replayed = await ReadAsync(retry);
        Assert.Equal("applied", replayed["status"]!.GetValue<string>());
        Assert.Equal(serverId, replayed["itemId"]!.GetValue<Guid>());
        Assert.Equal((await SnapshotAsync(serverId)).Revision, replayed["revision"]!.GetValue<string>());
        Assert.Equal("Changed after acknowledgement", replayed["item"]!["title"]!.GetValue<string>());
        Assert.Equal("Changed after acknowledgement", (await ItemAsync(serverId, bearer))["title"]!.GetValue<string>());

        await using var connection = await fixture.OpenMigratorConnectionAsync();
        await using var count = new NpgsqlCommand("SELECT count(*) FROM item WHERE parent_id = @parent", connection);
        count.Parameters.AddWithValue("parent", M0SchemaSeed.Alpha.ItemId);
        Assert.Equal(1L, await count.ExecuteScalarAsync(Cancellation));
    }

    [Fact]
    public async Task Daily_notes_from_distinct_local_ids_share_one_canonical_item_and_replay_the_lost_acknowledgement()
    {
        const string date = "2026-10-13";
        await ExecuteAsync("UPDATE workspace SET daily_notes = '{\"enabled\":true}'::jsonb WHERE workspace_id = @workspace",
            new NpgsqlParameter("workspace", M0SchemaSeed.Alpha.WorkspaceId));
        var bearer = await AccessTokenAsync();
        var firstLocalId = Guid.NewGuid();
        var firstRequest = Operation("daily-note", firstLocalId, null, new { date });
        using var first = await SendAsync(HttpMethod.Post, ReplayPath, bearer, firstRequest);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var originalJson = await first.Content.ReadAsStringAsync(Cancellation);
        var original = JsonNode.Parse(originalJson)!.AsObject();
        Assert.Equal("applied", original["status"]!.GetValue<string>());
        var serverId = original["itemId"]!.GetValue<Guid>();
        Assert.NotEqual(firstLocalId, serverId);
        Assert.Equal(date, original["item"]!["properties"]!["$daily"]!.GetValue<string>());
        Assert.Equal((await SnapshotAsync(serverId)).Revision, original["revision"]!.GetValue<string>());

        var secondLocalId = Guid.NewGuid();
        using var second = await SendAsync(HttpMethod.Post, ReplayPath, bearer,
            Operation("daily-note", secondLocalId, null, new { date }));
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        var reopened = await ReadAsync(second);
        Assert.Equal("applied", reopened["status"]!.GetValue<string>());
        Assert.Equal(serverId, reopened["itemId"]!.GetValue<Guid>());
        Assert.NotEqual(secondLocalId, serverId);

        using var retry = await SendAsync(HttpMethod.Post, ReplayPath, bearer, firstRequest);
        Assert.Equal(HttpStatusCode.OK, retry.StatusCode);
        Assert.Equal(originalJson, await retry.Content.ReadAsStringAsync(Cancellation));
        await using var connection = await fixture.OpenMigratorConnectionAsync();
        await using var count = new NpgsqlCommand(
            "SELECT count(*) FROM item WHERE workspace_id = @workspace AND properties ->> '$daily' = @date", connection);
        count.Parameters.AddWithValue("workspace", M0SchemaSeed.Alpha.WorkspaceId);
        count.Parameters.AddWithValue("date", date);
        Assert.Equal(1L, await count.ExecuteScalarAsync(Cancellation));
    }

    [Fact]
    public async Task Daily_note_replay_obeys_settings_disabled_after_the_operation_was_queued()
    {
        await ExecuteAsync("UPDATE workspace SET daily_notes = '{\"enabled\":true}'::jsonb WHERE workspace_id = @workspace",
            new NpgsqlParameter("workspace", M0SchemaSeed.Alpha.WorkspaceId));
        var bearer = await AccessTokenAsync();
        var request = Operation("daily-note", Guid.NewGuid(), null, new { date = "2026-10-13" });
        await ExecuteAsync("UPDATE workspace SET daily_notes = '{\"enabled\":false}'::jsonb WHERE workspace_id = @workspace",
            new NpgsqlParameter("workspace", M0SchemaSeed.Alpha.WorkspaceId));

        using var replay = await SendAsync(HttpMethod.Post, ReplayPath, bearer, request);

        Assert.Equal(HttpStatusCode.OK, replay.StatusCode);
        AssertRefused(await ReadAsync(replay), "workspaces.daily_notes_disabled");
        await using var connection = await fixture.OpenMigratorConnectionAsync();
        await using var count = new NpgsqlCommand(
            "SELECT count(*) FROM item WHERE workspace_id = @workspace AND properties ? '$daily'", connection);
        count.Parameters.AddWithValue("workspace", M0SchemaSeed.Alpha.WorkspaceId);
        Assert.Equal(0L, await count.ExecuteScalarAsync(Cancellation));
    }

    [Theory]
    [InlineData("")]
    [InlineData("2026-02-30")]
    [InlineData("2026-10-3")]
    [InlineData("not-a-date")]
    public async Task Daily_note_replay_requires_a_canonical_calendar_date(string date)
    {
        var bearer = await AccessTokenAsync();
        using var replay = await SendAsync(HttpMethod.Post, ReplayPath, bearer,
            Operation("daily-note", Guid.NewGuid(), null, new { date }));

        Assert.Equal(HttpStatusCode.BadRequest, replay.StatusCode);
        Assert.Equal("sync.invalid_replay", (await ReadAsync(replay))["code"]!.GetValue<string>());
    }

    [Fact]
    public async Task Reusing_an_operation_id_with_changed_input_returns_409_and_keeps_the_first_write()
    {
        var bearer = await AccessTokenAsync();
        var request = Operation("rename", M0SchemaSeed.Alpha.ItemId,
            (await SnapshotAsync(M0SchemaSeed.Alpha.ItemId)).Revision, new { title = "First write" });
        using var applied = await SendAsync(HttpMethod.Post, ReplayPath, bearer, request);
        Assert.Equal(HttpStatusCode.OK, applied.StatusCode);
        Assert.Equal("applied", (await ReadAsync(applied))["status"]!.GetValue<string>());

        request["payload"] = JsonSerializer.SerializeToNode(new { title = "Changed retry" });
        using var mismatch = await SendAsync(HttpMethod.Post, ReplayPath, bearer, request);

        Assert.Equal(HttpStatusCode.Conflict, mismatch.StatusCode);
        Assert.Equal("sync.idempotency_conflict", (await ReadAsync(mismatch))["code"]!.GetValue<string>());
        Assert.Equal("First write", (await ItemAsync(M0SchemaSeed.Alpha.ItemId, bearer))["title"]!.GetValue<string>());
    }

    [Fact]
    public async Task A_stale_revision_returns_current_authorized_metadata_and_does_not_overwrite_it()
    {
        var bearer = await AccessTokenAsync();
        var stale = (await SnapshotAsync(M0SchemaSeed.Alpha.ItemId)).Revision;
        using var changed = await SendAsync(HttpMethod.Patch, $"/api/v1/items/{M0SchemaSeed.Alpha.ItemId:D}", bearer,
            new { title = "Another device" });
        Assert.Equal(HttpStatusCode.OK, changed.StatusCode);
        var request = Operation("rename", M0SchemaSeed.Alpha.ItemId, stale, new { title = "Stale offline title" });

        using var replay = await SendAsync(HttpMethod.Post, ReplayPath, bearer, request);
        Assert.Equal(HttpStatusCode.OK, replay.StatusCode);
        var conflict = await ReadAsync(replay);
        Assert.Equal("conflict", conflict["status"]!.GetValue<string>());
        Assert.Equal("sync.revision_conflict", conflict["code"]!.GetValue<string>());
        Assert.Equal("Another device", conflict["item"]!["title"]!.GetValue<string>());
        Assert.NotEqual(stale, conflict["revision"]!.GetValue<string>());
        Assert.Equal("Another device", (await ItemAsync(M0SchemaSeed.Alpha.ItemId, bearer))["title"]!.GetValue<string>());

        using var resolved = await SendAsync(HttpMethod.Post, ReplayPath, bearer,
            Operation("rename", M0SchemaSeed.Alpha.ItemId, conflict["revision"]!.GetValue<string>(), new { title = "Resolved title" }));
        Assert.Equal(HttpStatusCode.OK, resolved.StatusCode);
        Assert.Equal("applied", (await ReadAsync(resolved))["status"]!.GetValue<string>());
        Assert.Equal("Resolved title", (await ItemAsync(M0SchemaSeed.Alpha.ItemId, bearer))["title"]!.GetValue<string>());
    }

    [Fact]
    public async Task Properties_move_and_archive_use_the_same_revision_and_retry_contract()
    {
        var bearer = await AccessTokenAsync();
        var itemId = await CreateAsync(bearer, "Queued changes", null);
        var revision = (await SnapshotAsync(itemId)).Revision;
        using var properties = await SendAsync(HttpMethod.Post, ReplayPath, bearer,
            Operation("properties", itemId, revision, new { changes = new { capture = "offline" } }));
        Assert.Equal(HttpStatusCode.OK, properties.StatusCode);
        var patched = await ReadAsync(properties);
        Assert.Equal("applied", patched["status"]!.GetValue<string>());
        Assert.Equal("offline", patched["item"]!["properties"]!["capture"]!.GetValue<string>());
        Assert.Equal("Queued changes", patched["item"]!["title"]!.GetValue<string>());

        using var move = await SendAsync(HttpMethod.Post, ReplayPath, bearer,
            Operation("move", itemId, patched["revision"]!.GetValue<string>(), new { parentId = M0SchemaSeed.Alpha.ItemId }));
        Assert.Equal(HttpStatusCode.OK, move.StatusCode);
        var moved = await ReadAsync(move);
        Assert.Equal("applied", moved["status"]!.GetValue<string>());
        Assert.Equal(M0SchemaSeed.Alpha.ItemId, (await ItemAsync(itemId, bearer))["parentId"]!.GetValue<Guid>());

        var request = Operation("archive", itemId, moved["revision"]!.GetValue<string>(), new { });
        using var archive = await SendAsync(HttpMethod.Post, ReplayPath, bearer, request);
        Assert.Equal(HttpStatusCode.OK, archive.StatusCode);
        var archived = await ReadAsync(archive);
        Assert.Equal("applied", archived["status"]!.GetValue<string>());
        Assert.Null(archived["item"]);
        using var retry = await SendAsync(HttpMethod.Post, ReplayPath, bearer, request);
        Assert.Equal(HttpStatusCode.OK, retry.StatusCode);
        Assert.True(JsonNode.DeepEquals(archived, await ReadAsync(retry)));
        await using var connection = await fixture.OpenMigratorConnectionAsync();
        await using var state = new NpgsqlCommand("SELECT lifecycle_state FROM item WHERE id = @item", connection);
        state.Parameters.AddWithValue("item", itemId);
        Assert.Equal("deleted", await state.ExecuteScalarAsync(Cancellation));
    }

    [Fact]
    public async Task Viewer_writes_are_refused_even_with_a_write_scoped_token()
    {
        await SeedViewerAsync();
        var bearer = await AccessTokenAsync(Viewer, [AccessTokenScopes.Read, AccessTokenScopes.Write]);
        var original = await SnapshotAsync(M0SchemaSeed.Alpha.ItemId);
        using var replay = await SendAsync(HttpMethod.Post, ReplayPath, bearer,
            Operation("rename", M0SchemaSeed.Alpha.ItemId, original.Revision, new { title = "Viewer write" }));

        Assert.Equal(HttpStatusCode.OK, replay.StatusCode);
        AssertRefused(await ReadAsync(replay), "sync.refused");
        Assert.Equal(original.Title, (await SnapshotAsync(M0SchemaSeed.Alpha.ItemId)).Title);
    }

    [Fact]
    public async Task A_write_only_token_cannot_replay_a_move_that_requires_admin_scope()
    {
        var bearer = await AccessTokenAsync(scopes: [AccessTokenScopes.Read, AccessTokenScopes.Write]);
        var itemId = await CreateAsync(bearer, "Scope restricted move", null);
        using var replay = await SendAsync(HttpMethod.Post, ReplayPath, bearer,
            Operation("move", itemId, (await SnapshotAsync(itemId)).Revision, new { parentId = M0SchemaSeed.Alpha.ItemId }));

        Assert.Equal(HttpStatusCode.OK, replay.StatusCode);
        AssertRefused(await ReadAsync(replay), "sync.refused");
        Assert.Null((await ItemAsync(itemId, bearer))["parentId"]);
    }

    [Fact]
    public async Task An_applied_receipt_is_withheld_after_workspace_access_is_revoked()
    {
        var bearer = await AccessTokenAsync();
        var request = Operation("rename", M0SchemaSeed.Alpha.ItemId,
            (await SnapshotAsync(M0SchemaSeed.Alpha.ItemId)).Revision, new { title = "Private receipt" });
        using var applied = await SendAsync(HttpMethod.Post, ReplayPath, bearer, request);
        Assert.Equal(HttpStatusCode.OK, applied.StatusCode);
        Assert.Equal("applied", (await ReadAsync(applied))["status"]!.GetValue<string>());
        await ExecuteAsync("DELETE FROM workspace_member WHERE workspace_id = @workspace AND subject_id = @principal",
            new NpgsqlParameter("workspace", M0SchemaSeed.Alpha.WorkspaceId),
            new NpgsqlParameter("principal", M0SchemaSeed.Alpha.PrincipalId));

        using var retry = await SendAsync(HttpMethod.Post, ReplayPath, bearer, request);

        Assert.Equal(HttpStatusCode.OK, retry.StatusCode);
        AssertRefused(await ReadAsync(retry), "sync.refused");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task An_applied_receipt_does_not_replay_body_metadata_after_the_item_is_locked(bool sameCredential)
    {
        var bearer = await AccessTokenAsync();
        var locker = sameCredential ? bearer : await AccessTokenAsync();
        var request = Operation("rename", M0SchemaSeed.Alpha.ItemId,
            (await SnapshotAsync(M0SchemaSeed.Alpha.ItemId)).Revision, new { title = "Before the lock" });
        using var applied = await SendAsync(HttpMethod.Post, ReplayPath, bearer, request);
        Assert.Equal(HttpStatusCode.OK, applied.StatusCode);
        var original = await ReadAsync(applied);
        Assert.Equal("applied", original["status"]!.GetValue<string>());
        Assert.True(original["item"]!["canPersistBody"]!.GetValue<bool>());
        using var locked = await SendAsync(HttpMethod.Put, $"/api/v1/items/{M0SchemaSeed.Alpha.ItemId:D}/lock", locker,
            new { password = "native-replay-password" });
        Assert.Equal(HttpStatusCode.NoContent, locked.StatusCode);

        using var retry = await SendAsync(HttpMethod.Post, ReplayPath, bearer, request);

        Assert.Equal(HttpStatusCode.OK, retry.StatusCode);
        AssertRefused(await ReadAsync(retry), "sync.refused");
    }

    [Fact]
    public async Task Foreign_tenant_and_missing_items_have_the_same_opaque_refusal()
    {
        var bearer = await AccessTokenAsync();
        foreach (var itemId in new[] { M0SchemaSeed.Beta.ItemId, Guid.NewGuid() })
        {
            using var replay = await SendAsync(HttpMethod.Post, ReplayPath, bearer,
                Operation("rename", itemId, "0", new { title = "Must remain hidden" }));
            Assert.Equal(HttpStatusCode.OK, replay.StatusCode);
            AssertRefused(await ReadAsync(replay), "sync.refused");
        }

        await using var connection = await fixture.OpenMigratorConnectionAsync();
        await using var unchanged = new NpgsqlCommand("SELECT properties IS NULL FROM item WHERE id = @item", connection);
        unchanged.Parameters.AddWithValue("item", M0SchemaSeed.Beta.ItemId);
        Assert.Equal(true, await unchanged.ExecuteScalarAsync(Cancellation));
    }

    [Fact]
    public async Task A_move_into_its_descendant_is_a_conflict_and_preserves_the_tree()
    {
        var bearer = await AccessTokenAsync();
        var child = await CreateAsync(bearer, "Destination child", M0SchemaSeed.Alpha.ItemId);
        using var replay = await SendAsync(HttpMethod.Post, ReplayPath, bearer,
            Operation("move", M0SchemaSeed.Alpha.ItemId, (await SnapshotAsync(M0SchemaSeed.Alpha.ItemId)).Revision,
                new { parentId = child }));

        Assert.Equal(HttpStatusCode.OK, replay.StatusCode);
        var conflict = await ReadAsync(replay);
        Assert.Equal("conflict", conflict["status"]!.GetValue<string>());
        Assert.Equal("items.move_would_create_cycle", conflict["code"]!.GetValue<string>());
        Assert.Null((await ItemAsync(M0SchemaSeed.Alpha.ItemId, bearer))["parentId"]);
        Assert.Equal(M0SchemaSeed.Alpha.ItemId, (await ItemAsync(child, bearer))["parentId"]!.GetValue<Guid>());
    }

    [Fact]
    public async Task Moving_into_a_parent_locked_by_another_credential_is_refused()
    {
        var bearer = await AccessTokenAsync();
        var locker = await AccessTokenAsync();
        var itemId = await CreateAsync(bearer, "Outside lock", null);
        using var locked = await SendAsync(HttpMethod.Put, $"/api/v1/items/{M0SchemaSeed.Alpha.ItemId:D}/lock", locker,
            new { password = "native-replay-password" });
        Assert.Equal(HttpStatusCode.NoContent, locked.StatusCode);
        using var replay = await SendAsync(HttpMethod.Post, ReplayPath, bearer,
            Operation("move", itemId, (await SnapshotAsync(itemId)).Revision, new { parentId = M0SchemaSeed.Alpha.ItemId }));

        Assert.Equal(HttpStatusCode.OK, replay.StatusCode);
        AssertRefused(await ReadAsync(replay), "items.locked");
        Assert.Null((await ItemAsync(itemId, bearer))["parentId"]);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("-1")]
    [InlineData("1.5")]
    [InlineData("not-a-revision")]
    public async Task Existing_item_operations_require_a_decimal_revision(string? revision)
    {
        var bearer = await AccessTokenAsync();
        using var replay = await SendAsync(HttpMethod.Post, ReplayPath, bearer,
            Operation("rename", M0SchemaSeed.Alpha.ItemId, revision, new { title = "Invalid revision" }));

        Assert.Equal(HttpStatusCode.BadRequest, replay.StatusCode);
        Assert.Equal("sync.invalid_replay", (await ReadAsync(replay))["code"]!.GetValue<string>());
    }

    [Fact]
    public async Task Duplicate_property_changes_are_rejected_before_any_write()
    {
        var bearer = await AccessTokenAsync();
        var revision = (await SnapshotAsync(M0SchemaSeed.Alpha.ItemId)).Revision;
        using var request = new HttpRequestMessage(HttpMethod.Post, ReplayPath);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        request.Content = new StringContent($$"""
            {"operationId":"{{Guid.NewGuid():D}}","kind":"properties","itemId":"{{M0SchemaSeed.Alpha.ItemId:D}}",
             "expectedRevision":"{{revision}}","payload":{"changes":{"detail":"first","detail":"last"} } }
            """, Encoding.UTF8, "application/json");

        using var replay = await _client.SendAsync(request, Cancellation);

        Assert.Equal(HttpStatusCode.BadRequest, replay.StatusCode);
        Assert.Equal("sync.invalid_replay", (await ReadAsync(replay))["code"]!.GetValue<string>());
        Assert.Equal(revision, (await SnapshotAsync(M0SchemaSeed.Alpha.ItemId)).Revision);
    }

    [Fact]
    public async Task A_move_requires_an_explicit_parent_field()
    {
        var bearer = await AccessTokenAsync();
        using var replay = await SendAsync(HttpMethod.Post, ReplayPath, bearer,
            Operation("move", M0SchemaSeed.Alpha.ItemId, (await SnapshotAsync(M0SchemaSeed.Alpha.ItemId)).Revision, new { }));

        Assert.Equal(HttpStatusCode.BadRequest, replay.StatusCode);
        Assert.Equal("sync.invalid_replay", (await ReadAsync(replay))["code"]!.GetValue<string>());
        Assert.Null((await ItemAsync(M0SchemaSeed.Alpha.ItemId, bearer))["parentId"]);
    }

    private static JsonObject Operation(string kind, Guid itemId, string? revision, object payload) => new()
    {
        ["operationId"] = Guid.NewGuid(),
        ["kind"] = kind,
        ["itemId"] = itemId,
        ["expectedRevision"] = revision,
        ["payload"] = JsonSerializer.SerializeToNode(payload),
    };

    private static void AssertRefused(JsonObject response, string code)
    {
        Assert.Equal("refused", response["status"]!.GetValue<string>());
        Assert.Equal(code, response["code"]!.GetValue<string>());
        Assert.Null(response["item"]);
        Assert.Null(response["revision"]);
    }

    private async Task<NativeItemSnapshot> SnapshotAsync(Guid itemId)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var result = await work.Resolve<IWorkspaceSync>().ReconcileAsync(
            WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId), [itemId], Cancellation);
        return Assert.Single(result.Items);
    }

    private async Task<Guid> CreateAsync(string bearer, string title, Guid? parentId)
    {
        using var created = await SendAsync(HttpMethod.Post,
            $"/api/v1/workspaces/{M0SchemaSeed.Alpha.WorkspaceId:D}/items", bearer,
            new { type = "note", title, parentId });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        return (await ReadAsync(created))["id"]!.GetValue<Guid>();
    }

    private async Task<JsonObject> ItemAsync(Guid itemId, string bearer)
    {
        using var response = await SendAsync(HttpMethod.Get, $"/api/v1/items/{itemId:D}", bearer);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await ReadAsync(response);
    }

    private async Task<string> AccessTokenAsync(Guid? principal = null, IReadOnlyList<string>? scopes = null)
    {
        var context = TestTenants.ContextFor(M0SchemaSeed.Alpha.TenantId, M0SchemaSeed.Alpha.WorkspaceId,
            principal ?? M0SchemaSeed.Alpha.PrincipalId);
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        var token = await work.Resolve<NixDispatcher>().SendAsync<CreateAccessToken, IssuedAccessToken>(
            new CreateAccessToken("Native replay", scopes ?? [AccessTokenScopes.Read, AccessTokenScopes.Write, AccessTokenScopes.Admin], 1), Cancellation);
        Assert.True(token.IsSuccess, token.IsFailure ? token.Error.Message : string.Empty);
        await work.CommitAsync(Cancellation);
        using var exchange = await _client.PostAsJsonAsync("/public/v1/auth/token", new { token = token.Value.Secret }, Cancellation);
        exchange.EnsureSuccessStatusCode();
        return (await ReadAsync(exchange))["accessToken"]!.GetValue<string>();
    }

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, string bearer, object? body = null)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }
        return await _client.SendAsync(request, Cancellation);
    }

    private static async Task<JsonObject> ReadAsync(HttpResponseMessage response) =>
        (await response.Content.ReadFromJsonAsync<JsonObject>(Cancellation))!;

    private async Task SeedViewerAsync() => await ExecuteAsync(
        """
        INSERT INTO principal (principal_id, tenant_id, external_issuer, external_subject, kind, display_name, status)
        VALUES (@viewer, @tenant, 'https://native-replay.test', 'viewer', 'user', 'Native replay viewer', 'active');
        INSERT INTO workspace_member (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
        VALUES (@workspace, 'principal', @viewer, @tenant, 'viewer', @principal, now());
        """,
        new NpgsqlParameter("viewer", Viewer), new NpgsqlParameter("tenant", M0SchemaSeed.Alpha.TenantId),
        new NpgsqlParameter("workspace", M0SchemaSeed.Alpha.WorkspaceId),
        new NpgsqlParameter("principal", M0SchemaSeed.Alpha.PrincipalId));

    private async Task ExecuteAsync(string sql, params NpgsqlParameter[] parameters)
    {
        await using var connection = await fixture.OpenMigratorConnectionAsync();
#pragma warning disable CA2100 // Only static test SQL reaches this helper; varying values are parameters.
        await using var command = new NpgsqlCommand(sql, connection);
#pragma warning restore CA2100
        command.Parameters.AddRange(parameters);
        await command.ExecuteNonQueryAsync(Cancellation);
    }

    private sealed class ConfiguredApplicationFactory(Dictionary<string, string?> settings)
        : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
        {
            foreach (var (key, value) in settings)
            {
                builder.UseSetting(key, value);
            }
        }
    }
}
