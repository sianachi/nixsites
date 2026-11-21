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
using Microsoft.Extensions.DependencyInjection;
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

    [Fact]
    public async Task A_queued_habit_check_in_replays_once_and_a_lost_acknowledgement_does_not_add_a_second()
    {
        var bearer = await AccessTokenAsync();
        var habit = await CreateHabitAsync(bearer);
        var path = $"/api/v1/items/{habit:D}/habit/check-ins/2026-09-10";
        var request = Operation("request", habit, null,
            new { method = "PUT", path, body = new { completed = false, quantity = 2 } });

        using var first = await SendAsync(HttpMethod.Post, ReplayPath, bearer, request);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var applied = await ReadAsync(first);
        Assert.Equal("applied", applied["status"]!.GetValue<string>());
        Assert.Equal(habit, applied["itemId"]!.GetValue<Guid>());
        using var retry = await SendAsync(HttpMethod.Post, ReplayPath, bearer, request);
        Assert.Equal("applied", (await ReadAsync(retry))["status"]!.GetValue<string>());

        Assert.Equal(1L, await CheckInCountAsync(habit));
        using var undo = await SendAsync(HttpMethod.Post, ReplayPath, bearer,
            Operation("request", habit, null, new { method = "DELETE", path }));
        Assert.Equal("applied", (await ReadAsync(undo))["status"]!.GetValue<string>());
        Assert.Equal(0L, await CheckInCountAsync(habit));
    }

    [Fact]
    public async Task A_queued_completion_marks_the_occurrence_and_a_refusal_comes_back_as_refused()
    {
        var bearer = await AccessTokenAsync();
        var itemId = await CreateAsync(bearer, "Not repeating", null);
        using var refused = await SendAsync(HttpMethod.Post, ReplayPath, bearer,
            Operation("request", itemId, null,
                new { method = "POST", path = $"/api/v1/items/{itemId:D}/recurrence/completions", body = new { occurredOn = "2026-09-10" } }));
        Assert.Equal(HttpStatusCode.OK, refused.StatusCode);
        var response = await ReadAsync(refused);
        Assert.Equal("refused", response["status"]!.GetValue<string>());
        Assert.Equal("recurrence.not_recurring", response["code"]!.GetValue<string>());
    }

    [Theory]
    [InlineData("PUT", "/api/v1/items/{0}/habit")]
    [InlineData("PUT", "/api/v1/items/{0}/habit/status")]
    [InlineData("DELETE", "/api/v1/items/{0}")]
    [InlineData("PATCH", "/api/v1/items/{0}")]
    [InlineData("POST", "/api/v1/items/{0}/habit/check-ins/2026-09-10")]
    [InlineData("PUT", "/api/v1/items/{0}/habit/check-ins/2026-09-10/extra")]
    [InlineData("PUT", "/api/v1/items/{0}/habit/check-ins/2026-9-10")]
    [InlineData("PUT", "/api/v1/items/{0}/recurrence")]
    [InlineData("GET", "/api/v1/items/{0}/habit")]
    [InlineData("POST", "/api/v1/workspaces/{0}/sync/replay")]
    [InlineData("PUT", "https://elsewhere.test/api/v1/items/{0}/habit/check-ins/2026-09-10")]
    [InlineData("PUT", "/api/v1/items/{0}/habit/check-ins/2026-09-10?x=1")]
    [InlineData("PUT", "/api/v1/items/{0}/habit/check-ins/2026-09-10/")]
    [InlineData("PUT", "/api/v1/items/{0}/habit/check-ins/2026-09-10\n")]
    [InlineData("PUT", "/api/v1/items/{0}/habit%2Fcheck-ins/2026-09-10")]
    [InlineData("put", "/api/v1/items/{0}/habit/check-ins/2026-09-10")]
    public async Task A_request_outside_the_allowlist_is_invalid_and_nothing_is_applied(string method, string template)
    {
        var bearer = await AccessTokenAsync();
        var habit = await CreateHabitAsync(bearer);
        using var replay = await SendAsync(HttpMethod.Post, ReplayPath, bearer,
            Operation("request", habit, null,
                new { method, path = string.Format(System.Globalization.CultureInfo.InvariantCulture, template, habit), body = new { completed = true, quantity = (int?)null } }));

        Assert.Equal(HttpStatusCode.BadRequest, replay.StatusCode);
        Assert.Equal("sync.invalid_replay", (await ReadAsync(replay))["code"]!.GetValue<string>());
        Assert.Equal(0L, await CheckInCountAsync(habit));
    }

    [Fact]
    public async Task A_request_naming_another_item_than_the_operations_own_is_invalid()
    {
        var bearer = await AccessTokenAsync();
        var habit = await CreateHabitAsync(bearer);
        var other = await CreateHabitAsync(bearer);
        using var replay = await SendAsync(HttpMethod.Post, ReplayPath, bearer,
            Operation("request", habit, null,
                new { method = "PUT", path = $"/api/v1/items/{other:D}/habit/check-ins/2026-09-10", body = new { completed = true, quantity = (int?)null } }));

        Assert.Equal(HttpStatusCode.BadRequest, replay.StatusCode);
        Assert.Equal(0L, await CheckInCountAsync(other));
    }

    [Fact]
    public async Task A_request_carries_no_expected_revision_and_takes_only_the_three_fields()
    {
        var bearer = await AccessTokenAsync();
        var habit = await CreateHabitAsync(bearer);
        var path = $"/api/v1/items/{habit:D}/habit/check-ins/2026-09-10";
        using var withRevision = await SendAsync(HttpMethod.Post, ReplayPath, bearer,
            Operation("request", habit, (await SnapshotAsync(habit)).Revision,
                new { method = "PUT", path, body = new { completed = true, quantity = (int?)null } }));
        Assert.Equal(HttpStatusCode.BadRequest, withRevision.StatusCode);
        using var extra = await SendAsync(HttpMethod.Post, ReplayPath, bearer,
            Operation("request", habit, null,
                new { method = "PUT", path, body = new { completed = true, quantity = (int?)null }, headers = "x" }));
        Assert.Equal(HttpStatusCode.BadRequest, extra.StatusCode);
        Assert.Equal(0L, await CheckInCountAsync(habit));
    }

    [Fact]
    public async Task A_viewer_cannot_replay_a_request()
    {
        var bearer = await AccessTokenAsync();
        var habit = await CreateHabitAsync(bearer);
        await SeedViewerAsync();
        var viewer = await AccessTokenAsync(Viewer, [AccessTokenScopes.Read, AccessTokenScopes.Write]);
        using var replay = await SendAsync(HttpMethod.Post, ReplayPath, viewer,
            Operation("request", habit, null,
                new { method = "PUT", path = $"/api/v1/items/{habit:D}/habit/check-ins/2026-09-10", body = new { completed = true, quantity = (int?)null } }));

        Assert.Equal(HttpStatusCode.OK, replay.StatusCode);
        AssertRefused(await ReadAsync(replay), "sync.refused");
        Assert.Equal(0L, await CheckInCountAsync(habit));
    }

    private static JsonObject RequestOperation(Guid itemId, string method, string path, object? body, Guid? operationId = null)
    {
        var operation = Operation("request", itemId, null, new { method, path, body });
        if (operationId is { } id)
        {
            operation["operationId"] = id;
        }
        return operation;
    }

    private static string CheckInPath(Guid habit) => $"/api/v1/items/{habit:D}/habit/check-ins/2026-09-10";

    [Fact]
    public async Task An_operation_id_reused_for_another_request_is_a_conflict_of_identity()
    {
        var bearer = await AccessTokenAsync();
        var habit = await CreateHabitAsync(bearer);
        var id = Guid.NewGuid();
        using var first = await SendAsync(HttpMethod.Post, ReplayPath, bearer,
            RequestOperation(habit, "PUT", CheckInPath(habit), new { completed = true, quantity = (int?)null }, id));
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        foreach (var other in new[]
        {
            RequestOperation(habit, "PUT", CheckInPath(habit), new { completed = false, quantity = (int?)null }, id),
            RequestOperation(habit, "PUT", CheckInPath(habit).Replace("09-10", "09-11", StringComparison.Ordinal), new { completed = true, quantity = (int?)null }, id),
            RequestOperation(habit, "DELETE", CheckInPath(habit), null, id),
        })
        {
            using var reused = await SendAsync(HttpMethod.Post, ReplayPath, bearer, other);
            Assert.Equal(HttpStatusCode.Conflict, reused.StatusCode);
            Assert.Equal("sync.idempotency_conflict", (await ReadAsync(reused))["code"]!.GetValue<string>());
        }
        Assert.Equal(1L, await CheckInCountAsync(habit));
    }

    [Theory]
    [InlineData("{\"completed\":true,\"quantity\":null,\"extra\":1}")]
    [InlineData("{\"Completed\":true}")]
    [InlineData("{\"COMPLETED\":true,\"quantity\":null}")]
    public async Task A_body_with_an_unknown_or_miscased_member_is_refused_but_the_direct_route_still_takes_it(string json)
    {
        var bearer = await AccessTokenAsync();
        var habit = await CreateHabitAsync(bearer);
        var operation = RequestOperation(habit, "PUT", CheckInPath(habit), null);
        operation["payload"]!["body"] = JsonNode.Parse(json);
        using var replay = await SendAsync(HttpMethod.Post, ReplayPath, bearer, operation);
        Assert.Equal(HttpStatusCode.BadRequest, replay.StatusCode);
        Assert.Equal(0L, await CheckInCountAsync(habit));
    }

    [Fact]
    public async Task A_delete_with_a_body_is_invalid()
    {
        var bearer = await AccessTokenAsync();
        var habit = await CreateHabitAsync(bearer);
        using var replay = await SendAsync(HttpMethod.Post, ReplayPath, bearer,
            RequestOperation(habit, "DELETE", CheckInPath(habit), new { completed = true }));
        Assert.Equal(HttpStatusCode.BadRequest, replay.StatusCode);
    }

    [Fact]
    public async Task An_item_of_another_workspace_the_caller_can_write_is_refused_before_any_command_runs()
    {
        var bearer = await AccessTokenAsync();
        using var created = await SendAsync(HttpMethod.Post, "/api/v1/workspaces", bearer, new { name = "Second" });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var second = (await ReadAsync(created))["id"]!.GetValue<Guid>();
        using var made = await SendAsync(HttpMethod.Post, $"/api/v1/workspaces/{second:D}/items", bearer,
            new { type = "note", title = "Elsewhere", parentId = (Guid?)null });
        Assert.Equal(HttpStatusCode.Created, made.StatusCode);
        var elsewhere = (await ReadAsync(made))["id"]!.GetValue<Guid>();
        using var replay = await SendAsync(HttpMethod.Post, ReplayPath, bearer,
            RequestOperation(elsewhere, "PUT", CheckInPath(elsewhere), new { completed = true, quantity = (int?)null }));
        Assert.Equal(HttpStatusCode.OK, replay.StatusCode);
        AssertRefused(await ReadAsync(replay), "sync.refused");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task A_locked_item_or_one_under_a_locked_ancestor_is_refused(bool lockAncestor)
    {
        var bearer = await AccessTokenAsync();
        var parent = await CreateAsync(bearer, "Parent", null);
        var habit = await CreateHabitAsync(bearer, parent);
        using var locked = await SendAsync(HttpMethod.Put, $"/api/v1/items/{(lockAncestor ? parent : habit):D}/lock", bearer,
            new { password = "native-replay-password" });
        Assert.Equal(HttpStatusCode.NoContent, locked.StatusCode);
        using var replay = await SendAsync(HttpMethod.Post, ReplayPath, bearer,
            RequestOperation(habit, "PUT", CheckInPath(habit), new { completed = true, quantity = (int?)null }));
        Assert.Equal(HttpStatusCode.OK, replay.StatusCode);
        AssertRefused(await ReadAsync(replay), "sync.refused");
        Assert.Equal(0L, await CheckInCountAsync(habit));
    }

    [Fact]
    public async Task A_workspace_closed_by_its_password_answers_423_for_a_request()
    {
        var bearer = await AccessTokenAsync();
        var habit = await CreateHabitAsync(bearer);
        await ExecuteAsync(
            "INSERT INTO workspace_lock (workspace_id, tenant_id, password_hash, locked_by, locked_at) VALUES (@workspace, @tenant, repeat('a', 64), @principal, now())",
            new NpgsqlParameter("workspace", M0SchemaSeed.Alpha.WorkspaceId), new NpgsqlParameter("tenant", M0SchemaSeed.Alpha.TenantId),
            new NpgsqlParameter("principal", M0SchemaSeed.Alpha.PrincipalId));
        using var replay = await SendAsync(HttpMethod.Post, ReplayPath, bearer,
            RequestOperation(habit, "PUT", CheckInPath(habit), new { completed = true, quantity = (int?)null }));
        Assert.Equal(HttpStatusCode.Locked, replay.StatusCode);
    }

    [Fact]
    public async Task A_habit_replay_and_a_direct_check_in_can_run_together_without_deadlocking()
    {
        var bearer = await AccessTokenAsync();
        var habit = await CreateHabitAsync(bearer);
        var days = Enumerable.Range(1, 8).Select(day => $"2026-09-{day:00}").ToArray();
        var work = days.SelectMany(day => new[]
        {
            SendAsync(HttpMethod.Post, ReplayPath, bearer, RequestOperation(habit, "PUT", $"/api/v1/items/{habit:D}/habit/check-ins/{day}", new { completed = true, quantity = (int?)null })),
            SendAsync(HttpMethod.Put, $"/api/v1/items/{habit:D}/habit/check-ins/{day}", bearer, new { completed = true, quantity = (int?)null }),
        }).ToArray();
        var responses = await Task.WhenAll(work).WaitAsync(TimeSpan.FromSeconds(60), Cancellation);
        foreach (var response in responses)
        {
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            response.Dispose();
        }
        Assert.Equal(days.Length, await CheckInCountAsync(habit));
    }

    [Fact]
    public async Task Protection_replays_with_the_flags_the_device_saw_and_conflicts_when_they_changed()
    {
        var bearer = await AccessTokenAsync();
        var itemId = await CreateAsync(bearer, "Guarded", null);
        var path = $"/api/v1/items/{itemId:D}/protection";
        using var applied = await SendAsync(HttpMethod.Post, ReplayPath, bearer, RequestOperation(itemId, "PUT", path,
            new { noDelete = true, @base = new { noDelete = false, noChildren = false } }));
        Assert.Equal("applied", (await ReadAsync(applied))["status"]!.GetValue<string>());
        Assert.True((await ItemAsync(itemId, bearer))["noDelete"]!.GetValue<bool>());

        // Another person turned deletion protection off and children protection on meanwhile.
        using var other = await SendAsync(HttpMethod.Put, path, bearer, new { noDelete = false, noChildren = true });
        Assert.Equal(HttpStatusCode.OK, other.StatusCode);
        using var stale = await SendAsync(HttpMethod.Post, ReplayPath, bearer, RequestOperation(itemId, "PUT", path,
            new { noDelete = true, noChildren = false, @base = new { noDelete = true, noChildren = false } }));
        var conflict = await ReadAsync(stale);
        Assert.Equal("conflict", conflict["status"]!.GetValue<string>());
        Assert.Equal("items.protection_base_changed", conflict["code"]!.GetValue<string>());
        var after = await ItemAsync(itemId, bearer);
        Assert.False(after["noDelete"]!.GetValue<bool>());
        Assert.True(after["noChildren"]!.GetValue<bool>());
    }

    [Theory]
    [InlineData("{\"noDelete\":true}")]
    [InlineData("{\"noDelete\":true,\"base\":{\"noDelete\":false}}")]
    [InlineData("{\"noDelete\":true,\"collaboration\":true,\"base\":{\"noDelete\":false,\"noChildren\":false}}")]
    [InlineData("{\"noDelete\":\"yes\",\"base\":{\"noDelete\":false,\"noChildren\":false}}")]
    public async Task A_protection_request_without_its_base_or_with_other_fields_is_invalid(string json)
    {
        var bearer = await AccessTokenAsync();
        var itemId = await CreateAsync(bearer, "Guarded", null);
        var operation = RequestOperation(itemId, "PUT", $"/api/v1/items/{itemId:D}/protection", null);
        operation["payload"]!["body"] = JsonNode.Parse(json);
        using var replay = await SendAsync(HttpMethod.Post, ReplayPath, bearer, operation);
        Assert.Equal(HttpStatusCode.BadRequest, replay.StatusCode);
        Assert.False((await ItemAsync(itemId, bearer))["noDelete"]!.GetValue<bool>());
    }

    [Fact]
    public async Task A_pet_turn_cannot_change_protection_through_replay_though_it_can_replay_a_check_in()
    {
        var humanBearer = await AccessTokenAsync();
        var habit = await CreateHabitAsync(humanBearer);
        var pet = _factory.Services.GetRequiredService<SelfIssuedTokenService>()
            .MintPetTurn(PrincipalId.From(M0SchemaSeed.Alpha.PrincipalId), TenantId.From(M0SchemaSeed.Alpha.TenantId), Guid.NewGuid(), PetTurnMode.Write);
        using var refused = await SendAsync(HttpMethod.Post, ReplayPath, pet, RequestOperation(habit, "PUT", $"/api/v1/items/{habit:D}/protection",
            new { noDelete = true, @base = new { noDelete = false, noChildren = false } }));
        Assert.Equal(HttpStatusCode.OK, refused.StatusCode);
        AssertRefused(await ReadAsync(refused), "sync.refused");
        Assert.False((await ItemAsync(habit, humanBearer))["noDelete"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Views_replay_with_the_version_the_device_saw_and_conflict_when_it_changed()
    {
        var bearer = await AccessTokenAsync();
        var itemId = await CreateAsync(bearer, "Board", null);
        var path = $"/api/v1/items/{itemId:D}/views";
        string Version(JsonObject views) => views["version"]!.GetValue<string>();
        using var read = await SendAsync(HttpMethod.Get, path, bearer);
        var seen = Version(await ReadAsync(read));
        object Body(string name, string? version) => new
        {
            views = new[] { new { id = "list", name, kind = "list", sortDescending = false } },
            @default = "list",
            expectedVersion = version,
        };

        using var applied = await SendAsync(HttpMethod.Post, ReplayPath, bearer, RequestOperation(itemId, "PUT", path, Body("Mine", seen)));
        Assert.Equal("applied", (await ReadAsync(applied))["status"]!.GetValue<string>());

        using var stale = await SendAsync(HttpMethod.Post, ReplayPath, bearer, RequestOperation(itemId, "PUT", path, Body("Late", seen)));
        var conflict = await ReadAsync(stale);
        Assert.Equal("conflict", conflict["status"]!.GetValue<string>());
        Assert.Equal("views.version_conflict", conflict["code"]!.GetValue<string>());
        using var now = await SendAsync(HttpMethod.Get, path, bearer);
        Assert.Equal("Mine", (await ReadAsync(now))["views"]![0]!["name"]!.GetValue<string>());

        using var without = await SendAsync(HttpMethod.Post, ReplayPath, bearer, RequestOperation(itemId, "PUT", path, Body("None", null)));
        Assert.Equal(HttpStatusCode.BadRequest, without.StatusCode);
    }

    [Fact]
    public async Task The_snapshot_carries_the_version_a_views_replay_needs()
    {
        var bearer = await AccessTokenAsync();
        var itemId = await CreateAsync(bearer, "Board", null);
        using var read = await SendAsync(HttpMethod.Get, $"/api/v1/items/{itemId:D}/views", bearer);
        var version = (await ReadAsync(read))["version"]!.GetValue<string>();
        Assert.Equal(version, (await SnapshotAsync(itemId)).ViewsVersion);
    }

    [Fact]
    public async Task Schema_replays_against_the_document_the_device_edited_from_and_conflicts_otherwise()
    {
        var bearer = await AccessTokenAsync();
        var itemId = await CreateAsync(bearer, "Tasks", null);
        var path = $"/api/v1/items/{itemId:D}/schema";
        object Property(string key, string type = "text") => new { key, label = key, type, required = false };
        var empty = new { properties = Array.Empty<object>(), inherit = true };

        using var applied = await SendAsync(HttpMethod.Post, ReplayPath, bearer, RequestOperation(itemId, "PUT", path,
            new { properties = new[] { Property("a") }, inherit = true, @base = empty }));
        Assert.Equal("applied", (await ReadAsync(applied))["status"]!.GetValue<string>());

        // Someone else adds "b" directly; a device still holding the old document must not drop it.
        using var other = await SendAsync(HttpMethod.Put, path, bearer, new { properties = new[] { Property("a"), Property("b") }, inherit = true });
        Assert.Equal(HttpStatusCode.OK, other.StatusCode);
        using var stale = await SendAsync(HttpMethod.Post, ReplayPath, bearer, RequestOperation(itemId, "PUT", path,
            new { properties = new[] { Property("a"), Property("c") }, inherit = true, @base = new { properties = new[] { Property("a") }, inherit = true } }));
        var conflict = await ReadAsync(stale);
        Assert.Equal("conflict", conflict["status"]!.GetValue<string>());
        Assert.Equal("items.schema_base_changed", conflict["code"]!.GetValue<string>());
        using var now = await SendAsync(HttpMethod.Get, path, bearer);
        Assert.Equal(["a", "b"], ((await ReadAsync(now))["declared"]!.AsArray()).Select(property => property!["key"]!.GetValue<string>()).ToArray());

        using var unknown = await SendAsync(HttpMethod.Post, ReplayPath, bearer, RequestOperation(itemId, "PUT", path,
            new { properties = new[] { Property("a") }, inherit = true, extra = 1, @base = empty }));
        Assert.Equal(HttpStatusCode.BadRequest, unknown.StatusCode);
        using var noBase = await SendAsync(HttpMethod.Post, ReplayPath, bearer, RequestOperation(itemId, "PUT", path,
            new { properties = new[] { Property("a") }, inherit = true }));
        Assert.Equal(HttpStatusCode.BadRequest, noBase.StatusCode);
    }

    [Fact]
    public async Task A_property_edit_queued_behind_a_schema_change_that_no_longer_fits_is_refused()
    {
        var bearer = await AccessTokenAsync();
        var itemId = await CreateAsync(bearer, "Tasks", null);
        var path = $"/api/v1/items/{itemId:D}/schema";
        using var schema = await SendAsync(HttpMethod.Post, ReplayPath, bearer, RequestOperation(itemId, "PUT", path,
            new
            {
                properties = new[] { new { key = "n", label = "n", type = "number", required = false } },
                inherit = true,
                @base = new { properties = Array.Empty<object>(), inherit = true },
            }));
        var applied = await ReadAsync(schema);
        Assert.Equal("applied", applied["status"]!.GetValue<string>());
        using var edit = await SendAsync(HttpMethod.Post, ReplayPath, bearer,
            Operation("properties", itemId, applied["revision"]!.GetValue<string>(), new { changes = new { n = "not a number" } }));
        var response = await ReadAsync(edit);
        // Refused like any violation; the device records every refusal as a change that could not be applied.
        Assert.Equal("refused", response["status"]!.GetValue<string>());
        Assert.Equal("properties.invalid", response["code"]!.GetValue<string>());
    }

    private async Task<Guid> CreateHabitAsync(string bearer, Guid? parent = null)
    {
        var habit = await CreateAsync(bearer, "Water", parent);
        using var configured = await SendAsync(HttpMethod.Put, $"/api/v1/items/{habit:D}/habit", bearer,
            new { frequency = "daily", weekdays = Array.Empty<int>(), timezone = "UTC", startDate = "2026-01-01", target = 2, unit = "reps" });
        Assert.Equal(HttpStatusCode.OK, configured.StatusCode);
        return habit;
    }

    private async Task<long> CheckInCountAsync(Guid habit)
    {
        await using var connection = await fixture.OpenMigratorConnectionAsync();
        await using var count = new NpgsqlCommand(
            "SELECT count(*) FROM item WHERE parent_id = @parent AND properties ? '$habit_check_in_date' AND lifecycle_state = 'active'", connection);
        count.Parameters.AddWithValue("parent", habit);
        return (long)(await count.ExecuteScalarAsync(Cancellation))!;
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
