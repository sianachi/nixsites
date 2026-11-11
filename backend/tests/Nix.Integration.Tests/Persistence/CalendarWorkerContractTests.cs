using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Features.CalendarSync;
using Nix.Features.Items;
using Nix.Features.Properties;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Contracts C1-C6 at the wire (ADR-0052, Amendment 1): the shared fixtures in
/// <c>fixtures/calendar-contract/</c> (shared with the in-process worker) posted exactly and answered with
/// exactly their key sets, and the pull, push, cursor and log semantics behind them.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class CalendarWorkerContractTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private CalendarSyncHost _host = null!;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static NixSessionContext Alpha => TestTenants.AlphaContext;

    private static string CurrentUtcDay => DateTimeOffset.UtcNow.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        _host = await CalendarSyncHost.StartAsync(fixture);
    }

    public async ValueTask DisposeAsync() => await _host.DisposeAsync();

    [Fact]
    public async Task The_shared_fixtures_are_accepted_and_answered_with_exactly_their_key_sets()
    {
        var connection = await _host.ConnectAsync(Alpha);
        var link = await _host.LinkAsync(Alpha, connection);
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);
        var basePath = $"/internal/worker-executions/calendar/links/{link.Id:D}";

        using (var session = await _host.WorkerAsync(HttpMethod.Post, $"{basePath}/session", job, execution))
        {
            Assert.Equal(HttpStatusCode.OK, session.StatusCode);
            using var body = JsonDocument.Parse(await session.Content.ReadAsStringAsync(Cancellation));
            AssertSameKeys(Fixture("c1_session_response.json"), body.RootElement);
            Assert.Equal("google", body.RootElement.GetProperty("provider").GetString());
            Assert.Equal("primary", body.RootElement.GetProperty("externalCalendarId").GetString());
            Assert.Equal(JsonValueKind.Null, body.RootElement.GetProperty("cursor").ValueKind);
            Assert.Equal("access-refreshed", body.RootElement.GetProperty("accessToken").GetString());
            var today = DateTimeOffset.UtcNow.UtcDateTime.Date;
            Assert.Equal(new DateTimeOffset(today.AddDays(-30), TimeSpan.Zero), body.RootElement.GetProperty("windowStart").GetDateTimeOffset());
            Assert.Equal(new DateTimeOffset(today.AddDays(366), TimeSpan.Zero), body.RootElement.GetProperty("windowEnd").GetDateTimeOffset());
            Assert.True(body.RootElement.GetProperty("accessTokenExpiresAt").GetDateTimeOffset() > DateTimeOffset.UtcNow.AddMinutes(30));
        }

        using (var pull = await _host.WorkerAsync(HttpMethod.Post, $"{basePath}/pull", job, execution, FixtureText("c2_pull_request.json")))
        {
            Assert.Equal(HttpStatusCode.OK, pull.StatusCode);
            using var body = JsonDocument.Parse(await pull.Content.ReadAsStringAsync(Cancellation));
            Assert.Equal(["applied", "conflicts"], body.RootElement.EnumerateObject().Select(member => member.Name).Order(StringComparer.Ordinal));
            Assert.Equal(2, body.RootElement.GetProperty("applied").GetInt32());
        }

        // The pull wrote two items through the ordinary handlers and never marked the link dirty.
        Assert.Equal(2, await CountAsync($"SELECT count(*) FROM item WHERE parent_id = '{link.ContainerItemId.Value}' AND lifecycle_state = 'active'"));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM item WHERE parent_id = '{link.ContainerItemId.Value}' AND properties ->> '$cal_readonly' = 'true'"));
        Assert.Equal(2, await CountAsync($"SELECT count(*) FROM item WHERE parent_id = '{link.ContainerItemId.Value}' AND properties ->> '$cal_link' = '{link.Id:D}' AND properties ->> '$cal_source' = 'google'"));
        Assert.Equal(0, await CountAsync("SELECT count(*) FROM scheduled_trigger WHERE source = 'calendar.dirty'"));

        await CreateChildAsync(link.ContainerItemId, "Dentist", """{"start":"2026-10-02T15:00:00+01:00[Europe/London]","end":"2026-10-02T16:00:00+01:00[Europe/London]","location":"High Street"}""");
        using (var changes = await _host.WorkerAsync(HttpMethod.Get, $"{basePath}/changes?limit=100", job, execution))
        {
            Assert.Equal(HttpStatusCode.OK, changes.StatusCode);
            using var body = JsonDocument.Parse(await changes.Content.ReadAsStringAsync(Cancellation));
            var fixtureChanges = Fixture("c3_changes_response.json");
            AssertSameKeys(fixtureChanges, body.RootElement);
            var change = Assert.Single(body.RootElement.GetProperty("changes").EnumerateArray());
            AssertSameKeys(fixtureChanges.GetProperty("changes")[0], change);
            Assert.Equal("create", change.GetProperty("op").GetString());
            Assert.Equal("Dentist", change.GetProperty("title").GetString());
            Assert.Equal(JsonValueKind.Null, change.GetProperty("externalId").ValueKind);
            Assert.Equal(string.Empty, change.GetProperty("details").GetString());
        }

        foreach (var name in new[] { "c4_pushed_request.json", "c6_log_request.json" })
        {
            var path = name.StartsWith("c4", StringComparison.Ordinal) ? "pushed" : "log";
            using var response = await _host.WorkerAsync(HttpMethod.Post, $"{basePath}/{path}", job, execution, FixtureText(name));
            Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        }

        using (var cursor = await _host.WorkerAsync(HttpMethod.Post, $"{basePath}/cursor", job, execution, FixtureText("c5_cursor_request.json")))
        {
            Assert.Equal(HttpStatusCode.NoContent, cursor.StatusCode);
        }

        Assert.Equal("CPDAlvWDx70CEPDAlvWDx70CGAU=", await TextAsync($"SELECT sync_cursor FROM calendar_link WHERE id = '{link.Id}'"));
        Assert.Equal(2, await CountAsync($"SELECT count(*) FROM calendar_sync_log WHERE link_id = '{link.Id}' AND detail IN ('google calendar API returned 500', 'item start is not a date or timestamp')"));
    }

    [Fact]
    public async Task Unknown_or_missing_members_and_oversized_batches_are_refused_as_malformed()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);
        var basePath = $"/internal/worker-executions/calendar/links/{link.Id:D}";

        var extra = JsonNode.Parse(FixtureText("c2_pull_request.json"))!.AsObject();
        extra["surprise"] = 1;
        var missing = JsonNode.Parse(FixtureText("c2_pull_request.json"))!.AsObject();
        missing["events"]![0]!.AsObject().Remove("version");
        var nulled = JsonNode.Parse(FixtureText("c5_cursor_request.json"))!.AsObject();
        nulled["cursor"] = null;
        var tooMany = new JsonObject
        {
            ["full"] = false,
            ["events"] = new JsonArray([.. Enumerable.Range(0, 101).Select(index => (JsonNode?)JsonNode.Parse(
            $$"""{"externalId":"e{{index}}","version":"v","status":"confirmed","title":"t","start":"2026-10-01","location":"","details":"","readOnly":false,"updatedAt":"2026-09-30T12:00:00Z"}"""))])
        };

        foreach (var (path, body) in new[]
        {
            ("pull", extra.ToJsonString()),
            ("pull", missing.ToJsonString()),
            ("pull", tooMany.ToJsonString()),
            ("cursor", nulled.ToJsonString()),
            ("log", """{"entries":[{"direction":"pull","action":"created","detail":"x"}]}"""),
            ("pushed", """{"results":[]}"""),
        })
        {
            using var response = await _host.WorkerAsync(HttpMethod.Post, $"{basePath}/{path}", job, execution, body);
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Equal("calendar.request_invalid", await ProblemCodeAsync(response));
        }

        using var badLimit = await _host.WorkerAsync(HttpMethod.Get, $"{basePath}/changes?limit=101", job, execution);
        Assert.Equal(HttpStatusCode.BadRequest, badLimit.StatusCode);
    }

    [Fact]
    public async Task A_job_for_another_link_a_stopped_link_or_another_workspace_is_refused_as_unavailable()
    {
        var connection = await _host.ConnectAsync(Alpha);
        var link = await _host.LinkAsync(Alpha, connection);
        var other = await _host.LinkAsync(Alpha, connection, externalCalendarId: "holidays");
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);

        using (var wrongLink = await _host.WorkerAsync(HttpMethod.Post, $"/internal/worker-executions/calendar/links/{other.Id:D}/session", job, execution))
        {
            Assert.Equal(HttpStatusCode.Conflict, wrongLink.StatusCode);
            Assert.Equal("calendar.link_unavailable", await ProblemCodeAsync(wrongLink));
        }

        // Paused still lets the in-flight round finish; stopped does not.
        await ExecuteAsync($"UPDATE calendar_link SET status = 'paused' WHERE id = '{link.Id}'");
        using (var paused = await _host.WorkerAsync(HttpMethod.Get, $"/internal/worker-executions/calendar/links/{link.Id:D}/changes?limit=10", job, execution))
        {
            Assert.Equal(HttpStatusCode.OK, paused.StatusCode);
        }

        await ExecuteAsync($"UPDATE calendar_link SET status = 'stopped' WHERE id = '{link.Id}'");
        using var stopped = await _host.WorkerAsync(HttpMethod.Get, $"/internal/worker-executions/calendar/links/{link.Id:D}/changes?limit=10", job, execution);
        Assert.Equal(HttpStatusCode.Conflict, stopped.StatusCode);
        Assert.Equal("calendar.link_unavailable", await ProblemCodeAsync(stopped));
    }

    [Fact]
    public async Task A_dead_grant_commits_needs_reauth_and_exactly_one_notification_despite_the_409_rollback()
    {
        var connection = await _host.ConnectAsync(Alpha);
        var link = await _host.LinkAsync(Alpha, connection);
        await ExecuteAsync("DELETE FROM notification");
        _host.Provider.RefreshOutcome = "invalid_grant";

        for (var attempt = 0; attempt < 2; attempt++)
        {
            var (job, execution) = await _host.ClaimJobAsync(Alpha, link);
            using var session = await _host.WorkerAsync(HttpMethod.Post, $"/internal/worker-executions/calendar/links/{link.Id:D}/session", job, execution);
            Assert.Equal(HttpStatusCode.Conflict, session.StatusCode);
            Assert.Equal("calendar.needs_reauth", await ProblemCodeAsync(session));
        }

        Assert.Equal("needs_reauth", await TextAsync($"SELECT status FROM calendar_connection WHERE id = '{connection}'"));
        Assert.Equal(1, await CountAsync("SELECT count(*) FROM notification WHERE kind = 'calendar' AND title = 'Reconnect your calendar'"));
        Assert.Single(_host.Provider.CallsTo("/token"));
    }

    [Fact]
    public async Task A_provider_outage_is_503_and_a_rotated_refresh_token_is_kept_for_the_next_refresh()
    {
        var connection = await _host.ConnectAsync(Alpha);
        var link = await _host.LinkAsync(Alpha, connection);
        var path = $"/internal/worker-executions/calendar/links/{link.Id:D}/session";

        _host.Provider.RefreshOutcome = "server_error";
        var (first, firstExecution) = await _host.ClaimJobAsync(Alpha, link);
        using (var outage = await _host.WorkerAsync(HttpMethod.Post, path, first, firstExecution))
        {
            Assert.Equal(HttpStatusCode.ServiceUnavailable, outage.StatusCode);
            Assert.Equal("calendar.provider_unavailable", await ProblemCodeAsync(outage));
        }

        _host.Provider.RefreshOutcome = "rotate";
        var (second, secondExecution) = await _host.ClaimJobAsync(Alpha, link);
        using (var rotated = await _host.WorkerAsync(HttpMethod.Post, path, second, secondExecution))
        {
            Assert.Equal(HttpStatusCode.OK, rotated.StatusCode);
        }

        // Expire the cache so the next session refreshes again, with the rotated token.
        await ExecuteAsync($"UPDATE calendar_connection SET access_token_expires_at = now() WHERE id = '{connection}'");
        _host.Provider.RefreshOutcome = "ok";
        var (third, thirdExecution) = await _host.ClaimJobAsync(Alpha, link);
        using (var again = await _host.WorkerAsync(HttpMethod.Post, path, third, thirdExecution))
        {
            Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        }

        var refreshes = _host.Provider.CallsTo("/token").Select(call => call.Form["refresh_token"]).ToList();
        Assert.Equal(["refresh-initial", "refresh-initial", "refresh-rotated"], refreshes);

        // A cached token with more than ten minutes left is reused without calling the provider.
        var (fourth, fourthExecution) = await _host.ClaimJobAsync(Alpha, link);
        using (var cached = await _host.WorkerAsync(HttpMethod.Post, path, fourth, fourthExecution))
        {
            Assert.Equal(HttpStatusCode.OK, cached.StatusCode);
        }

        Assert.Equal(3, _host.Provider.CallsTo("/token").Count);
    }

    [Fact]
    public async Task A_full_job_or_a_stale_cursor_gets_no_cursor_and_a_fresh_one_is_returned_as_stored()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var today = new DateTimeOffset(DateTimeOffset.UtcNow.UtcDateTime.Date, TimeSpan.Zero);
        await ExecuteAsync($"""
            UPDATE calendar_link SET sync_cursor = 'stored-cursor', cursor_window_start = '{today.AddDays(-30):O}',
                   cursor_window_end = '{today.AddDays(366):O}' WHERE id = '{link.Id}'
            """);

        Assert.Equal("stored-cursor", await SessionCursorAsync(link, full: false));
        Assert.Null(await SessionCursorAsync(link, full: true));

        await ExecuteAsync($"""
            UPDATE calendar_link SET cursor_window_start = '{today.AddDays(-62):O}', cursor_window_end = '{today.AddDays(334):O}'
             WHERE id = '{link.Id}'
            """);
        Assert.Null(await SessionCursorAsync(link, full: false));
    }

    [Fact]
    public async Task Pulled_changes_resolve_by_version_then_by_the_later_modification_and_cancellations_trash()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);

        Assert.Equal((1, 0), await PullAsync(link, job, execution, Event("evt-1", "v1", "Standup", "2026-10-01T09:00:00-04:00[America/New_York]", DateTimeOffset.UtcNow.AddMinutes(-10))));
        var itemId = await GuidAsync($"SELECT item_id FROM calendar_event_map WHERE link_id = '{link.Id}' AND external_event_id = 'evt-1'");

        // The same version again changes nothing.
        Assert.Equal((0, 0), await PullAsync(link, job, execution, Event("evt-1", "v1", "Standup", "2026-10-01T09:00:00-04:00[America/New_York]", DateTimeOffset.UtcNow.AddMinutes(-10))));

        // Nix edits after the provider did: the edit is kept, only the version moves, one conflict.
        await SetPropertiesAsync(itemId, """{"location":"Room 9"}""");
        Assert.Equal((0, 1), await PullAsync(link, job, execution, Event("evt-1", "v2", "Standup moved", "2026-10-01T10:00:00-04:00[America/New_York]", DateTimeOffset.UtcNow.AddMinutes(-5))));
        Assert.Equal("Room 9", await TextAsync($"SELECT properties ->> 'location' FROM item WHERE id = '{itemId}'"));
        Assert.Equal("Standup", await TextAsync($"SELECT properties ->> 'title' FROM item WHERE id = '{itemId}'"));
        Assert.Equal("v2", await TextAsync($"SELECT external_version FROM calendar_event_map WHERE item_id = '{itemId}'"));

        // The provider edits later still: it wins, overwriting the Nix edit, recorded as a conflict.
        Assert.Equal((1, 1), await PullAsync(link, job, execution, Event("evt-1", "v3", "Standup moved", "2026-10-01T10:00:00-04:00[America/New_York]", DateTimeOffset.UtcNow.AddMinutes(5))));
        Assert.Equal("Standup moved", await TextAsync($"SELECT properties ->> 'title' FROM item WHERE id = '{itemId}'"));
        Assert.Null(await TextAsync($"SELECT properties ->> 'location' FROM item WHERE id = '{itemId}'"));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM calendar_sync_log WHERE link_id = '{link.Id}' AND action = 'conflict' AND detail = 'provider newer'"));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM calendar_sync_log WHERE link_id = '{link.Id}' AND action = 'conflict' AND detail = 'nix newer'"));

        // Invalid bounds are skipped, not applied.
        Assert.Equal((0, 0), await PullAsync(link, job, execution, Event("evt-bad", "v1", "Broken", "next tuesday", DateTimeOffset.UtcNow)));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM calendar_sync_log WHERE link_id = '{link.Id}' AND action = 'skipped' AND detail = 'invalid start/end'"));

        // A cancellation trashes the item and tombstones the pair - without the trash echoing
        // back as a dirty round (the Nix edit above legitimately made one).
        Assert.Equal(1, await CountAsync("SELECT count(*) FROM scheduled_trigger WHERE source = 'calendar.dirty'"));
        await ExecuteAsync("DELETE FROM scheduled_trigger WHERE source = 'calendar.dirty'");
        Assert.Equal((1, 0), await PullAsync(link, job, execution, """{"externalId":"evt-1","version":"","status":"cancelled","title":"","start":"","location":"","details":"","readOnly":false,"updatedAt":"2026-09-30T12:05:00Z"}"""));
        Assert.Equal("deleted", await TextAsync($"SELECT lifecycle_state FROM item WHERE id = '{itemId}'"));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM calendar_event_map WHERE item_id = '{itemId}' AND deleted_at IS NOT NULL"));
        Assert.Equal(0, await CountAsync("SELECT count(*) FROM scheduled_trigger WHERE source = 'calendar.dirty'"));
    }

    [Fact]
    public async Task A_read_only_event_always_takes_the_provider_version_and_is_never_pushed()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);
        await PullAsync(link, job, execution, Event("evt-ro", "v1", "Board", "2026-10-05", DateTimeOffset.UtcNow.AddHours(-1), readOnly: true));
        var itemId = await GuidAsync($"SELECT item_id FROM calendar_event_map WHERE external_event_id = 'evt-ro'");

        // The mirrored fields of an event its calendar refuses edits to are refused here too.
        await using (var work = await _host.BeginAsync(Alpha))
        {
            var refused = await work.Resolve<NixDispatcher>().SendAsync<SetItemProperties, Item>(
                new SetItemProperties(ItemId.From(itemId), """{"location":"Mine"}"""), Cancellation);
            Assert.True(refused.IsFailure);
            Assert.Equal("items.read_only", refused.Error.Code);
        }

        Assert.Empty(await ChangesAsync(link, job, execution));

        // With the local edit refused there is nothing for the provider's version to conflict with.
        Assert.Equal((1, 0), await PullAsync(link, job, execution, Event("evt-ro", "v2", "Board", "2026-10-05", DateTimeOffset.UtcNow.AddHours(-2), readOnly: true)));
        Assert.Null(await TextAsync($"SELECT properties ->> 'location' FROM item WHERE id = '{itemId}'"));
    }

    [Fact]
    public async Task Pushes_create_update_and_delete_and_their_outcomes_update_the_map()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);
        var itemId = await CreateChildAsync(link.ContainerItemId, "Lunch", """{"start":"2026-10-03","details":"<b>bring</b>"}""");

        var created = Assert.Single(await ChangesAsync(link, job, execution));
        Assert.Equal("create", created.GetProperty("op").GetString());
        Assert.Equal("<b>bring</b>", created.GetProperty("details").GetString());
        await PushedAsync(link, job, execution, $$"""{"results":[{"itemId":"{{itemId:D}}","externalId":"evt-new","version":"v1","status":"ok"}]}""");
        Assert.Equal("evt-new", await TextAsync($"SELECT external_event_id FROM calendar_event_map WHERE item_id = '{itemId}'"));
        Assert.Empty(await ChangesAsync(link, job, execution));

        // A touch that changes no synced field is caught up silently.
        await SetPropertiesAsync(itemId, """{"unsynced":"x"}""");
        Assert.Empty(await ChangesAsync(link, job, execution));

        await SetPropertiesAsync(itemId, """{"location":"Cafe"}""");
        var updated = Assert.Single(await ChangesAsync(link, job, execution));
        Assert.Equal("update", updated.GetProperty("op").GetString());
        Assert.Equal("evt-new", updated.GetProperty("externalId").GetString());
        Assert.Equal("v1", updated.GetProperty("version").GetString());
        await PushedAsync(link, job, execution, $$"""{"results":[{"itemId":"{{itemId:D}}","externalId":"evt-new","version":"v2","status":"ok"}]}""");
        Assert.Equal("v2", await TextAsync($"SELECT external_version FROM calendar_event_map WHERE item_id = '{itemId}'"));

        // Deleted upstream while Nix changed it: recreated on the next page.
        await SetPropertiesAsync(itemId, """{"location":"Home"}""");
        Assert.Single(await ChangesAsync(link, job, execution));
        await PushedAsync(link, job, execution, $$"""{"results":[{"itemId":"{{itemId:D}}","externalId":"evt-new","version":"v2","status":"gone","detail":"gone"}]}""");
        Assert.Equal("create", Assert.Single(await ChangesAsync(link, job, execution)).GetProperty("op").GetString());
        await PushedAsync(link, job, execution, $$"""{"results":[{"itemId":"{{itemId:D}}","externalId":"evt-again","version":"v1","status":"ok"}]}""");

        await DeleteItemAsync(itemId);
        var deleted = Assert.Single(await ChangesAsync(link, job, execution));
        Assert.Equal("delete", deleted.GetProperty("op").GetString());
        Assert.Equal("evt-again", deleted.GetProperty("externalId").GetString());
        Assert.Equal(JsonValueKind.Null, deleted.GetProperty("end").ValueKind);
        await PushedAsync(link, job, execution, $$"""{"results":[{"itemId":"{{itemId:D}}","externalId":"evt-again","version":"v1","status":"ok"}]}""");
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM calendar_event_map WHERE item_id = '{itemId}' AND deleted_at IS NOT NULL"));
        Assert.Empty(await ChangesAsync(link, job, execution));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM calendar_sync_log WHERE link_id = '{link.Id}' AND action = 'conflict' AND detail = 'deleted upstream; recreating'"));
    }

    [Fact]
    public async Task Failed_pushes_stop_after_five_and_a_page_that_leaves_changes_behind_schedules_a_dirty_round()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);
        var failing = await CreateChildAsync(link.ContainerItemId, "Fails", """{"start":"2026-10-03"}""");
        for (var attempt = 0; attempt < 5; attempt++)
        {
            var change = Assert.Single(await ChangesAsync(link, job, execution));
            Assert.Equal(failing, change.GetProperty("itemId").GetGuid());
            await PushedAsync(link, job, execution, $$"""{"results":[{"itemId":"{{failing:D}}","externalId":"","version":"","status":"failed","detail":"google calendar API returned 403: Forbidden"}]}""");
        }

        Assert.Empty(await ChangesAsync(link, job, execution));
        Assert.Equal(5, await CountAsync($"SELECT count(*) FROM calendar_sync_log WHERE link_id = '{link.Id}' AND action = 'error'"));

        await ExecuteAsync("DELETE FROM scheduled_trigger WHERE source = 'calendar.dirty'");
        var first = await CreateChildAsync(link.ContainerItemId, "One", """{"start":"2026-10-04"}""");
        await CreateChildAsync(link.ContainerItemId, "Two", """{"start":"2026-10-05"}""");
        await ExecuteAsync("DELETE FROM scheduled_trigger WHERE source = 'calendar.dirty'");
        var page = Assert.Single(await ChangesAsync(link, job, execution, limit: 1));
        Assert.Equal(first, page.GetProperty("itemId").GetGuid());
        await PushedAsync(link, job, execution, $$"""{"results":[{"itemId":"{{first:D}}","externalId":"evt-one","version":"v1","status":"ok"}]}""");
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM scheduled_trigger WHERE source = 'calendar.dirty' AND rule_id = '{link.Id}' AND status = 'pending'"));
    }

    [Fact]
    public async Task An_import_only_link_pushes_nothing()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha), direction: "import_only");
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);
        await CreateChildAsync(link.ContainerItemId, "Local", """{"start":"2026-10-03"}""");
        Assert.Empty(await ChangesAsync(link, job, execution));
    }

    [Fact]
    public async Task A_changes_page_stops_short_of_four_mebibytes_encoded()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);

        // '<' escapes to six bytes, so 8000 of them are 48,000 encoded bytes per change. The
        // property bag's own 32 KiB bound (counted escaped) keeps the write path from storing one,
        // so the rows are written directly: the cap is the backstop for whatever else did.
        await ExecuteAsync($"""
            INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                              created_by, last_modified_by, created_at, last_modified_at)
            SELECT gen_random_uuid(), '{TestTenants.Alpha}', '{TestTenants.AlphaWorkspace}', 'note', '{link.ContainerItemId.Value}',
                   n * 1000, jsonb_build_object('title', 'Big ' || n, 'start', '2026-10-03', 'details', repeat('<', 8000)),
                   'active', '{TestTenants.AlphaPrincipal}', '{TestTenants.AlphaPrincipal}', now(), now()
              FROM generate_series(1, 100) n
            """);

        using var response = await _host.WorkerAsync(HttpMethod.Get, $"/internal/worker-executions/calendar/links/{link.Id:D}/changes?limit=100", job, execution);
        var bytes = await response.Content.ReadAsByteArrayAsync(Cancellation);
        Assert.True(bytes.Length <= 4 * 1024 * 1024, $"page was {bytes.Length} bytes");
        using var body = JsonDocument.Parse(bytes);
        var count = body.RootElement.GetProperty("changes").GetArrayLength();
        Assert.InRange(count, 50, 99);
    }

    [Fact]
    public async Task A_full_resync_trashes_unseen_events_in_the_window_unless_the_mass_trash_guard_trips()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);
        var eventDay = CurrentUtcDay;
        var events = Enumerable.Range(0, 3).Select(index => Event($"evt-{index}", "v1", $"E{index}", eventDay, DateTimeOffset.UtcNow)).ToArray();
        await PullAsync(link, job, execution, events);

        // A full round that saw two of the three.
        var (fullJob, fullExecution) = await _host.ClaimJobAsync(Alpha, link, full: true);
        await PullAsync(link, fullJob, fullExecution, full: true, events[0], events[1]);
        await CursorAsync(link, fullJob, fullExecution, full: true);
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM calendar_event_map WHERE link_id = '{link.Id}' AND external_event_id = 'evt-2' AND deleted_at IS NOT NULL"));
        Assert.Equal(2, await CountAsync($"SELECT count(*) FROM item WHERE parent_id = '{link.ContainerItemId.Value}' AND lifecycle_state = 'active'"));

        // Twenty-five more, then a full round that sees none: nothing is trashed.
        var (nextJob, nextExecution) = await _host.ClaimJobAsync(Alpha, link);
        await PullAsync(link, nextJob, nextExecution, [.. Enumerable.Range(10, 25).Select(index => Event($"evt-{index}", "v1", $"E{index}", eventDay, DateTimeOffset.UtcNow))]);
        var (emptyJob, emptyExecution) = await _host.ClaimJobAsync(Alpha, link, full: true);
        await CursorAsync(link, emptyJob, emptyExecution, full: true);
        Assert.Equal(27, await CountAsync($"SELECT count(*) FROM item WHERE parent_id = '{link.ContainerItemId.Value}' AND lifecycle_state = 'active'"));
        Assert.Equal("full resync would remove 27 events; skipped", await TextAsync($"SELECT last_error FROM calendar_link WHERE id = '{link.Id}'"));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM calendar_sync_log WHERE link_id = '{link.Id}' AND action = 'error' AND detail = 'full resync would remove 27 events; skipped'"));
    }

    [Fact]
    public async Task A_full_resync_leaves_an_event_moved_out_of_the_container_active_and_only_ends_its_pair()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);
        var eventDay = CurrentUtcDay;
        var events = Enumerable.Range(0, 3).Select(index => Event($"evt-{index}", "v1", $"E{index}", eventDay, DateTimeOffset.UtcNow)).ToArray();
        await PullAsync(link, job, execution, events);
        var moved = await GuidAsync($"SELECT item_id FROM calendar_event_map WHERE link_id = '{link.Id}' AND external_event_id = 'evt-2'");
        var sibling = await CreateFolderAsync("Elsewhere");
        await ReleaseProtectionAsync(moved);
        await MoveAsync(moved, sibling);

        var (fullJob, fullExecution) = await _host.ClaimJobAsync(Alpha, link, full: true);
        await PullAsync(link, fullJob, fullExecution, full: true, events[0], events[1]);
        await CursorAsync(link, fullJob, fullExecution, full: true);

        // The item now lives in another folder: the reconciliation ends the pair and never trashes it.
        Assert.Equal($"active|{sibling}", await TextAsync($"SELECT lifecycle_state || '|' || parent_id FROM item WHERE id = '{moved}'"));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM calendar_event_map WHERE item_id = '{moved}' AND deleted_at IS NOT NULL"));
    }

    [Fact]
    public async Task A_cursor_claiming_a_full_resync_the_job_was_not_granted_reconciles_nothing_and_drops_the_cursor()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link, full: true);
        var eventDay = CurrentUtcDay;
        var events = Enumerable.Range(0, 3).Select(index => Event($"evt-{index}", "v1", $"E{index}", eventDay, DateTimeOffset.UtcNow)).ToArray();
        await PullAsync(link, job, execution, full: true, events);
        await CursorAsync(link, job, execution, full: true);

        // An incremental round over a fresh cursor whose worker nevertheless claims a full one.
        var (incremental, incrementalExecution) = await _host.ClaimJobAsync(Alpha, link);
        await PullAsync(link, incremental, incrementalExecution, full: true, events[0], events[1]);
        await CursorAsync(link, incremental, incrementalExecution, full: true);

        Assert.Equal(3, await CountAsync($"SELECT count(*) FROM item WHERE parent_id = '{link.ContainerItemId.Value}' AND lifecycle_state = 'active'"));
        Assert.Equal(0, await CountAsync($"SELECT count(*) FROM calendar_event_map WHERE link_id = '{link.Id}' AND deleted_at IS NOT NULL"));
        Assert.Null(await TextAsync($"SELECT sync_cursor FROM calendar_link WHERE id = '{link.Id}'"));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM calendar_sync_log WHERE link_id = '{link.Id}' AND action = 'skipped' AND detail LIKE 'full resync not granted%'"));
    }

    [Fact]
    public async Task A_pulled_change_to_a_locked_item_is_skipped_and_applies_once_it_is_unlocked()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);
        await PullAsync(link, job, execution, Event("evt-1", "v1", "Standup", "2026-10-01", DateTimeOffset.UtcNow.AddMinutes(-10)));
        var itemId = await GuidAsync($"SELECT item_id FROM calendar_event_map WHERE link_id = '{link.Id}' AND external_event_id = 'evt-1'");
        await LockAsync(itemId);

        Assert.Equal((0, 0), await PullAsync(link, job, execution, Event("evt-1", "v2", "Standup moved", "2026-10-02", DateTimeOffset.UtcNow)));
        Assert.Equal((0, 0), await PullAsync(link, job, execution, """{"externalId":"evt-1","version":"","status":"cancelled","title":"","start":"","location":"","details":"","readOnly":false,"updatedAt":"2026-09-30T12:05:00Z"}"""));
        Assert.Equal("active|Standup", await TextAsync($"SELECT lifecycle_state || '|' || (properties ->> 'title') FROM item WHERE id = '{itemId}'"));
        Assert.Equal("v1", await TextAsync($"SELECT external_version FROM calendar_event_map WHERE item_id = '{itemId}' AND deleted_at IS NULL"));
        Assert.Equal(2, await CountAsync($"SELECT count(*) FROM calendar_sync_log WHERE link_id = '{link.Id}' AND action = 'skipped' AND detail = 'item_locked'"));

        await ExecuteAsync($"DELETE FROM item_lock WHERE item_id = '{itemId}'");
        Assert.Equal((1, 0), await PullAsync(link, job, execution, Event("evt-1", "v2", "Standup moved", "2026-10-02", DateTimeOffset.UtcNow)));
        Assert.Equal("Standup moved", await TextAsync($"SELECT properties ->> 'title' FROM item WHERE id = '{itemId}'"));
    }

    [Fact]
    public async Task A_full_resync_neither_trashes_nor_unpairs_a_locked_item_it_did_not_see()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);
        var eventDay = CurrentUtcDay;
        var events = Enumerable.Range(0, 3).Select(index => Event($"evt-{index}", "v1", $"E{index}", eventDay, DateTimeOffset.UtcNow)).ToArray();
        await PullAsync(link, job, execution, events);
        var locked = await GuidAsync($"SELECT item_id FROM calendar_event_map WHERE link_id = '{link.Id}' AND external_event_id = 'evt-2'");
        await LockAsync(locked);

        var (fullJob, fullExecution) = await _host.ClaimJobAsync(Alpha, link, full: true);
        await PullAsync(link, fullJob, fullExecution, full: true, events[0], events[1]);
        await CursorAsync(link, fullJob, fullExecution, full: true);

        Assert.Equal("active", await TextAsync($"SELECT lifecycle_state FROM item WHERE id = '{locked}'"));
        Assert.Equal(0, await CountAsync($"SELECT count(*) FROM calendar_event_map WHERE item_id = '{locked}' AND deleted_at IS NOT NULL"));
    }

    [Fact]
    public async Task A_locked_child_is_never_handed_out_and_a_page_of_them_never_stalls_the_rest()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);
        var hidden = await CreateChildAsync(link.ContainerItemId, "Hidden", """{"start":"2026-10-03"}""");
        await LockAsync(hidden);

        // 250 older locked children ahead of an open one in modified order.
        await ExecuteAsync($"""
            WITH inserted AS (
                INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                                  created_by, last_modified_by, created_at, last_modified_at)
                SELECT gen_random_uuid(), '{TestTenants.Alpha}', '{TestTenants.AlphaWorkspace}', 'note', '{link.ContainerItemId.Value}',
                       900000 + n, jsonb_build_object('title', 'Locked ' || n, 'start', '2026-10-03'), 'active',
                       '{TestTenants.AlphaPrincipal}', '{TestTenants.AlphaPrincipal}', now() - interval '1 day', now() - interval '1 day'
                  FROM generate_series(1, 250) n
                RETURNING id
            ), closure AS (
                INSERT INTO item_closure (tenant_id, workspace_id, ancestor_id, descendant_id, depth)
                SELECT '{TestTenants.Alpha}', '{TestTenants.AlphaWorkspace}', id, id, 0 FROM inserted
            )
            INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
            SELECT id, '{TestTenants.Alpha}', 'pbkdf2-sha256$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
                   '{TestTenants.AlphaPrincipal}', now()
              FROM inserted
            """);
        var open = await CreateChildAsync(link.ContainerItemId, "Open", """{"start":"2026-10-04"}""");

        var change = Assert.Single(await ChangesAsync(link, job, execution));
        Assert.Equal(open, change.GetProperty("itemId").GetGuid());
        Assert.Equal(0, await CountAsync($"SELECT count(*) FROM calendar_event_map WHERE item_id = '{hidden}'"));
    }

    [Fact]
    public async Task The_worker_guard_refuses_a_container_under_a_locked_folder()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var folder = await CreateFolderAsync("Private");
        await MoveAsync(link.ContainerItemId.Value, folder);
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);
        using (var open = await _host.WorkerAsync(HttpMethod.Get, $"/internal/worker-executions/calendar/links/{link.Id:D}/changes?limit=10", job, execution))
        {
            Assert.Equal(HttpStatusCode.OK, open.StatusCode);
        }

        await LockAsync(folder);
        using var locked = await _host.WorkerAsync(HttpMethod.Get, $"/internal/worker-executions/calendar/links/{link.Id:D}/changes?limit=10", job, execution);
        Assert.Equal(HttpStatusCode.Conflict, locked.StatusCode);
        Assert.Equal("calendar.link_unavailable", await ProblemCodeAsync(locked));
    }

    [Fact]
    public async Task Only_the_job_last_recorded_on_the_link_may_act_on_it()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var (first, firstExecution) = await _host.ClaimJobAsync(Alpha, link);
        var (second, secondExecution) = await _host.ClaimJobAsync(Alpha, link);
        var path = $"/internal/worker-executions/calendar/links/{link.Id:D}/changes?limit=10";

        using (var superseded = await _host.WorkerAsync(HttpMethod.Get, path, first, firstExecution))
        {
            Assert.Equal(HttpStatusCode.Conflict, superseded.StatusCode);
            Assert.Equal("calendar.link_unavailable", await ProblemCodeAsync(superseded));
        }

        using var current = await _host.WorkerAsync(HttpMethod.Get, path, second, secondExecution);
        Assert.Equal(HttpStatusCode.OK, current.StatusCode);
    }

    [Fact]
    public async Task A_lost_push_report_is_recovered_from_the_stamped_event_without_a_duplicate_either_way()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);
        var itemId = await CreateChildAsync(link.ContainerItemId, "Lunch", """{"start":"2026-10-03"}""");
        Assert.Equal("create", Assert.Single(await ChangesAsync(link, job, execution)).GetProperty("op").GetString());

        // The worker created the event, stamped with the item id, and its C4 report was lost.
        var (next, nextExecution) = await _host.ClaimJobAsync(Alpha, link);
        await PullAsync(link, next, nextExecution, Event("evt-stamped", "v1", "Lunch", "2026-10-03", DateTimeOffset.UtcNow, nixItemId: itemId));

        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM item WHERE parent_id = '{link.ContainerItemId.Value}' AND lifecycle_state = 'active'"));
        Assert.Equal("evt-stamped|v1", await TextAsync($"SELECT external_event_id || '|' || external_version FROM calendar_event_map WHERE item_id = '{itemId}' AND push_op IS NULL"));
        Assert.Empty(await ChangesAsync(link, next, nextExecution));

        // The late report, if it ever arrives, is recorded and changes nothing.
        await PushedAsync(link, next, nextExecution, $$"""{"results":[{"itemId":"{{itemId:D}}","externalId":"evt-stamped","version":"v1","status":"ok"}]}""");
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM calendar_event_map WHERE link_id = '{link.Id}'"));

        // A stamp naming an item this link never handed out as a create is an ordinary new event.
        await PullAsync(link, next, nextExecution, Event("evt-foreign", "v1", "Foreign", "2026-10-04", DateTimeOffset.UtcNow, nixItemId: Guid.NewGuid()));
        Assert.Equal(2, await CountAsync($"SELECT count(*) FROM item WHERE parent_id = '{link.ContainerItemId.Value}' AND lifecycle_state = 'active'"));
    }

    [Fact]
    public async Task A_stamped_event_deleted_upstream_before_its_lost_report_was_recovered_trashes_the_item_and_is_not_recreated()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);
        var itemId = await CreateChildAsync(link.ContainerItemId, "Lunch", """{"start":"2026-10-03"}""");
        Assert.Single(await ChangesAsync(link, job, execution));

        var (next, nextExecution) = await _host.ClaimJobAsync(Alpha, link);
        Assert.Equal((1, 0), await PullAsync(link, next, nextExecution,
            $$"""{"externalId":"{{itemId:N}}","version":"","status":"cancelled","title":"","start":"","location":"","details":"","readOnly":false,"updatedAt":"2026-09-30T12:05:00Z","nixItemId":"{{itemId:D}}"}"""));

        // The event id is the stamp itself, as the Google id the worker chose for the create.
        Assert.Equal("deleted", await TextAsync($"SELECT lifecycle_state FROM item WHERE id = '{itemId}'"));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM calendar_event_map WHERE item_id = '{itemId}' AND external_event_id = '{itemId:N}' AND deleted_at IS NOT NULL"));
        Assert.Empty(await ChangesAsync(link, next, nextExecution));
    }

    [Fact]
    public async Task A_stamp_naming_another_links_create_or_an_unrelated_item_adopts_nothing_and_writes_nothing_outside_the_container()
    {
        var connection = await _host.ConnectAsync(Alpha);
        var link = await _host.LinkAsync(Alpha, connection);
        var other = await _host.LinkAsync(Alpha, connection, externalCalendarId: "holidays");
        var (otherJob, otherExecution) = await _host.ClaimJobAsync(Alpha, other);
        var foreignCreate = await CreateChildAsync(other.ContainerItemId, "Theirs", """{"start":"2026-10-03"}""");
        Assert.Single(await ChangesAsync(other, otherJob, otherExecution));
        var unrelated = M0SchemaSeed.Alpha.ItemId;
        var unrelatedBefore = await TextAsync($"SELECT properties::text || '|' || lifecycle_state || '|' || COALESCE(parent_id::text, '') FROM item WHERE id = '{unrelated}'");

        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);
        Assert.Equal((2, 0), await PullAsync(link, job, execution,
            Event("evt-forged-1", "v1", "Forged one", "2026-10-05", DateTimeOffset.UtcNow, nixItemId: foreignCreate),
            Event("evt-forged-2", "v1", "Forged two", "2026-10-06", DateTimeOffset.UtcNow, nixItemId: unrelated)));

        // Both are ordinary new events of this link: two new items in its own container.
        Assert.Equal(2, await CountAsync($"SELECT count(*) FROM item WHERE parent_id = '{link.ContainerItemId.Value}' AND lifecycle_state = 'active'"));
        Assert.Equal(0, await CountAsync($"SELECT count(*) FROM calendar_event_map WHERE link_id = '{link.Id}' AND item_id IN ('{foreignCreate}', '{unrelated}')"));
        Assert.Equal("Theirs|create", await TextAsync($"SELECT (SELECT properties ->> 'title' FROM item WHERE id = '{foreignCreate}') || '|' || push_op FROM calendar_event_map WHERE item_id = '{foreignCreate}' AND external_event_id IS NULL"));
        Assert.Equal(unrelatedBefore, await TextAsync($"SELECT properties::text || '|' || lifecycle_state || '|' || COALESCE(parent_id::text, '') FROM item WHERE id = '{unrelated}'"));
    }

    [Fact]
    public async Task A_stamped_event_that_is_not_what_was_pushed_is_paired_but_never_overwrites_the_item()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);
        var itemId = await CreateChildAsync(link.ContainerItemId, "Lunch", """{"start":"2026-10-03","location":"Cafe"}""");
        Assert.Single(await ChangesAsync(link, job, execution));

        var (next, nextExecution) = await _host.ClaimJobAsync(Alpha, link);
        await PullAsync(link, next, nextExecution, Event("evt-forged", "v9", "Overwritten", "2027-01-01", DateTimeOffset.UtcNow.AddHours(1), nixItemId: itemId));

        Assert.Equal("Lunch|2026-10-03|Cafe", await TextAsync($"SELECT (properties ->> 'title') || '|' || (properties ->> 'start') || '|' || (properties ->> 'location') FROM item WHERE id = '{itemId}'"));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM item WHERE parent_id = '{link.ContainerItemId.Value}' AND lifecycle_state = 'active'"));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM calendar_sync_log WHERE link_id = '{link.Id}' AND action = 'conflict' AND item_id = '{itemId}'"));

        // The pair is kept and the next push restores the Nix content over the event, guarded by its version.
        var restore = Assert.Single(await ChangesAsync(link, next, nextExecution));
        Assert.Equal("update|evt-forged|v9|Lunch", $"{restore.GetProperty("op").GetString()}|{restore.GetProperty("externalId").GetString()}|{restore.GetProperty("version").GetString()}|{restore.GetProperty("title").GetString()}");
    }

    [Fact]
    public async Task A_stamped_cancellation_is_adopted_only_when_the_event_id_is_the_stamp_itself()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);
        var itemId = await CreateChildAsync(link.ContainerItemId, "Lunch", """{"start":"2026-10-03"}""");
        Assert.Single(await ChangesAsync(link, job, execution));

        var (next, nextExecution) = await _host.ClaimJobAsync(Alpha, link);
        Assert.Equal((0, 0), await PullAsync(link, next, nextExecution,
            $$"""{"externalId":"forged-cancel","version":"","status":"cancelled","title":"","start":"","location":"","details":"","readOnly":false,"updatedAt":"2026-09-30T12:05:00Z","nixItemId":"{{itemId:D}}"}"""));
        Assert.Equal("active", await TextAsync($"SELECT lifecycle_state FROM item WHERE id = '{itemId}'"));
    }

    [Fact]
    public async Task A_delete_that_keeps_answering_conflict_is_parked_at_the_cap()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);
        var itemId = await CreateChildAsync(link.ContainerItemId, "Doomed", """{"start":"2026-10-03"}""");
        Assert.Single(await ChangesAsync(link, job, execution));
        await PushedAsync(link, job, execution, $$"""{"results":[{"itemId":"{{itemId:D}}","externalId":"evt-doomed","version":"v1","status":"ok"}]}""");
        await DeleteItemAsync(itemId);

        for (var attempt = 0; attempt < 5; attempt++)
        {
            Assert.Equal("delete", Assert.Single(await ChangesAsync(link, job, execution)).GetProperty("op").GetString());
            await PushedAsync(link, job, execution, $$"""{"results":[{"itemId":"{{itemId:D}}","externalId":"evt-doomed","version":"v1","status":"conflict"}]}""");
        }

        Assert.Empty(await ChangesAsync(link, job, execution));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM calendar_event_map WHERE item_id = '{itemId}' AND deleted_at IS NOT NULL"));
    }

    [Fact]
    public async Task A_pull_the_nix_side_wins_rearms_a_parked_update()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);
        await PullAsync(link, job, execution, Event("evt-1", "v1", "Standup", "2026-10-01", DateTimeOffset.UtcNow.AddMinutes(-30)));
        var itemId = await GuidAsync($"SELECT item_id FROM calendar_event_map WHERE link_id = '{link.Id}' AND external_event_id = 'evt-1'");
        await SetPropertiesAsync(itemId, """{"location":"Room 9"}""");
        for (var attempt = 0; attempt < 5; attempt++)
        {
            Assert.Single(await ChangesAsync(link, job, execution));
            await PushedAsync(link, job, execution, $$"""{"results":[{"itemId":"{{itemId:D}}","externalId":"evt-1","version":"v1","status":"failed","detail":"503"}]}""");
        }

        Assert.Empty(await ChangesAsync(link, job, execution));

        // The provider changed too, earlier than Nix: Nix wins, the version moves, and the parked push is re-armed.
        Assert.Equal((0, 1), await PullAsync(link, job, execution, Event("evt-1", "v2", "Standup", "2026-10-01", DateTimeOffset.UtcNow.AddMinutes(-20))));
        var update = Assert.Single(await ChangesAsync(link, job, execution));
        Assert.Equal("v2", update.GetProperty("version").GetString());
    }

    [Fact]
    public async Task A_push_report_naming_an_event_another_item_holds_is_a_conflict_not_a_server_error()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);
        await PullAsync(link, job, execution, Event("evt-1", "v1", "Pulled", "2026-10-01", DateTimeOffset.UtcNow));
        var local = await CreateChildAsync(link.ContainerItemId, "Local", """{"start":"2026-10-03"}""");
        Assert.Single(await ChangesAsync(link, job, execution));

        await PushedAsync(link, job, execution, $$"""{"results":[{"itemId":"{{local:D}}","externalId":"evt-1","version":"v9","status":"ok"}]}""");

        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM calendar_event_map WHERE link_id = '{link.Id}' AND external_event_id = 'evt-1'"));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM calendar_event_map WHERE item_id = '{local}' AND external_event_id IS NULL AND push_op IS NULL AND push_failures = 1"));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM calendar_sync_log WHERE link_id = '{link.Id}' AND action = 'conflict' AND item_id = '{local}'"));
    }

    [Fact]
    public async Task An_upstream_delete_that_keeps_failing_is_parked_after_five_with_a_conflict()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);
        var itemId = await CreateChildAsync(link.ContainerItemId, "Doomed", """{"start":"2026-10-03"}""");
        Assert.Single(await ChangesAsync(link, job, execution));
        await PushedAsync(link, job, execution, $$"""{"results":[{"itemId":"{{itemId:D}}","externalId":"evt-doomed","version":"v1","status":"ok"}]}""");
        await DeleteItemAsync(itemId);

        for (var attempt = 0; attempt < 5; attempt++)
        {
            Assert.Equal("delete", Assert.Single(await ChangesAsync(link, job, execution)).GetProperty("op").GetString());
            await PushedAsync(link, job, execution, $$"""{"results":[{"itemId":"{{itemId:D}}","externalId":"evt-doomed","version":"v1","status":"failed","detail":"google calendar API returned 403"}]}""");
        }

        Assert.Empty(await ChangesAsync(link, job, execution));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM calendar_event_map WHERE item_id = '{itemId}' AND deleted_at IS NOT NULL"));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM calendar_sync_log WHERE link_id = '{link.Id}' AND action = 'conflict' AND item_id = '{itemId}'"));
    }

    [Fact]
    public async Task Children_that_can_never_push_do_not_stall_the_page_and_a_parked_item_rearms_on_its_next_edit()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);

        // 250 older children whose start no provider could take, written past the validator.
        await ExecuteAsync($"""
            INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                              created_by, last_modified_by, created_at, last_modified_at)
            SELECT gen_random_uuid(), '{TestTenants.Alpha}', '{TestTenants.AlphaWorkspace}', 'note', '{link.ContainerItemId.Value}',
                   900000 + n, jsonb_build_object('title', 'Broken ' || n, 'start', 'next tuesday'), 'active',
                   '{TestTenants.AlphaPrincipal}', '{TestTenants.AlphaPrincipal}', now() - interval '1 day', now() - interval '1 day'
              FROM generate_series(1, 250) n
            """);
        var failing = await CreateChildAsync(link.ContainerItemId, "Fails", """{"start":"2026-10-04"}""");
        Assert.Equal(failing, Assert.Single(await ChangesAsync(link, job, execution)).GetProperty("itemId").GetGuid());
        for (var attempt = 0; attempt < 5; attempt++)
        {
            await PushedAsync(link, job, execution, $$"""{"results":[{"itemId":"{{failing:D}}","externalId":"","version":"","status":"failed","detail":"403"}]}""");
            var pending = await ChangesAsync(link, job, execution);
            Assert.Equal(attempt < 4 ? 1 : 0, pending.Count);
        }

        // A new edit re-arms it, with its failure count reset when it is handed out.
        await SetPropertiesAsync(failing, """{"location":"Room 2"}""");
        Assert.Equal(failing, Assert.Single(await ChangesAsync(link, job, execution)).GetProperty("itemId").GetGuid());
        Assert.Equal(0, await CountAsync($"SELECT push_failures::bigint FROM calendar_event_map WHERE item_id = '{failing}'"));
    }

    [Fact]
    public async Task An_isolated_unit_of_work_commits_even_when_the_request_aborts_after_its_work()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        using var aborted = new CancellationTokenSource();
        var isolated = Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions
            .GetRequiredService<IIsolatedUnitOfWork>(_host.Factory.Services);

        await isolated.RunAsync(
            Alpha,
            async (services, token) =>
            {
                await Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions
                    .GetRequiredService<Nix.Abstractions.Calendar.ICalendarSyncStore>(services)
                    .SetLinkErrorAsync(link.Id, null, "kept", DateTimeOffset.UtcNow, token);
                await aborted.CancelAsync();
                return new IsolatedOutcome<bool>(true, Commit: true);
            },
            aborted.Token);

        Assert.Equal("kept", await TextAsync($"SELECT last_error FROM calendar_link WHERE id = '{link.Id}'"));
    }

    [Fact]
    public async Task Inserting_a_link_over_a_container_that_is_gone_reports_it_missing()
    {
        var connection = await _host.ConnectAsync(Alpha);
        await using var work = await _host.BeginAsync(Alpha);
        var now = DateTimeOffset.UtcNow;
        var written = await work.Resolve<Nix.Abstractions.Calendar.ICalendarSyncStore>().InsertLinkAsync(
            new Nix.Domain.Calendar.CalendarLink
            {
                TenantId = Alpha.TenantId,
                Id = Guid.CreateVersion7(),
                PrincipalId = Alpha.PrincipalId,
                ConnectionId = connection,
                WorkspaceId = Alpha.WorkspaceId!.Value,
                ContainerItemId = ItemId.From(Guid.NewGuid()),
                ExternalCalendarId = "primary",
                Name = "Gone",
                Direction = "two_way",
                WindowPastDays = 30,
                WindowFutureDays = 365,
                Status = "active",
                Revision = 1,
                CreatedAt = now,
                UpdatedAt = now,
            },
            Cancellation);
        Assert.Equal(Nix.Abstractions.Calendar.CalendarLinkWrite.ContainerMissing, written);
    }

    [Fact]
    public async Task Calendar_keys_are_refused_on_ordinary_writes_and_allowed_only_to_the_sync_capability()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        await using var work = await _host.BeginAsync(Alpha);
        var dispatcher = work.Resolve<NixDispatcher>();
        var forgedCreate = await dispatcher.SendAsync<CreateItem, Item>(
            new CreateItem(Alpha.WorkspaceId!.Value, "note", "Forged", link.ContainerItemId, new JsonObject { ["$cal_link"] = link.Id.ToString("D") }),
            Cancellation);
        Assert.Equal("scheduling.reserved_property", forgedCreate.Error.Code);

        var plain = await dispatcher.SendAsync<CreateItem, Item>(
            new CreateItem(Alpha.WorkspaceId!.Value, "note", "Plain", link.ContainerItemId, null), Cancellation);
        var forgedWrite = await dispatcher.SendAsync<SetItemProperties, Item>(
            new SetItemProperties(plain.Value.Id, """{"$cal_readonly":false}"""), Cancellation);
        Assert.Equal("scheduling.reserved_property", forgedWrite.Error.Code);
    }

    private static CalendarPullEventText Event(
        string id, string version, string title, string start, DateTimeOffset updatedAt, bool readOnly = false, Guid? nixItemId = null) =>
        new($$"""{"externalId":"{{id}}","version":"{{version}}","status":"confirmed","title":"{{title}}","start":"{{start}}","location":"","details":"","readOnly":{{(readOnly ? "true" : "false")}},"updatedAt":"{{updatedAt.UtcDateTime:yyyy-MM-ddTHH:mm:ss.fffZ}}"{{(nixItemId is { } stamp ? $",\"nixItemId\":\"{stamp:D}\"" : string.Empty)}}}""");

    private Task LockAsync(Guid itemId) => ExecuteAsync($"""
        INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
        VALUES ('{itemId}', '{TestTenants.Alpha}', 'pbkdf2-sha256$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
                '{TestTenants.AlphaPrincipal}', now())
        """);

    private async Task<Guid> CreateFolderAsync(string title)
    {
        await using var work = await _host.BeginAsync(Alpha);
        var created = await work.Resolve<NixDispatcher>().SendAsync<CreateItem, Item>(
            new CreateItem(Alpha.WorkspaceId!.Value, "folder", title, null, null), Cancellation);
        Assert.True(created.IsSuccess, created.IsSuccess ? string.Empty : created.Error.Message);
        await work.CommitAsync(Cancellation);
        return created.Value.Id.Value;
    }

    private async Task MoveAsync(Guid itemId, Guid parentId)
    {
        await using var work = await _host.BeginAsync(Alpha);
        var moved = await work.Resolve<NixDispatcher>().SendAsync<MoveItem, Item>(
            new MoveItem(ItemId.From(itemId), ItemId.From(parentId), null), Cancellation);
        Assert.True(moved.IsSuccess, moved.IsSuccess ? string.Empty : moved.Error.Message);
        await work.CommitAsync(Cancellation);
    }

    private Task<(int Applied, int Conflicts)> PullAsync(Nix.Domain.Calendar.CalendarLink link, Guid job, string execution, params CalendarPullEventText[] events) =>
        PullAsync(link, job, execution, false, events);

    private Task<(int Applied, int Conflicts)> PullAsync(Nix.Domain.Calendar.CalendarLink link, Guid job, string execution, string rawEvent) =>
        PullAsync(link, job, execution, false, new CalendarPullEventText(rawEvent));

    private async Task<(int Applied, int Conflicts)> PullAsync(
        Nix.Domain.Calendar.CalendarLink link, Guid job, string execution, bool full, params CalendarPullEventText[] events)
    {
        var body = $$"""{"full":{{(full ? "true" : "false")}},"events":[{{string.Join(',', events.Select(entry => entry.Json))}}]}""";
        using var response = await _host.WorkerAsync(HttpMethod.Post, $"/internal/worker-executions/calendar/links/{link.Id:D}/pull", job, execution, body);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
        return (document.RootElement.GetProperty("applied").GetInt32(), document.RootElement.GetProperty("conflicts").GetInt32());
    }

    private async Task<IReadOnlyList<JsonElement>> ChangesAsync(Nix.Domain.Calendar.CalendarLink link, Guid job, string execution, int limit = 100)
    {
        using var response = await _host.WorkerAsync(HttpMethod.Get, $"/internal/worker-executions/calendar/links/{link.Id:D}/changes?limit={limit}", job, execution);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
        return [.. document.RootElement.GetProperty("changes").EnumerateArray().Select(change => change.Clone())];
    }

    private async Task PushedAsync(Nix.Domain.Calendar.CalendarLink link, Guid job, string execution, string body)
    {
        using var response = await _host.WorkerAsync(HttpMethod.Post, $"/internal/worker-executions/calendar/links/{link.Id:D}/pushed", job, execution, body);
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
    }

    private async Task CursorAsync(Nix.Domain.Calendar.CalendarLink link, Guid job, string execution, bool full)
    {
        var today = DateTimeOffset.UtcNow.UtcDateTime.Date;
        var body = $$"""{"cursor":"next","full":{{(full ? "true" : "false")}},"windowStart":"{{today.AddDays(-30):yyyy-MM-dd}}T00:00:00Z","windowEnd":"{{today.AddDays(366):yyyy-MM-dd}}T00:00:00Z"}""";
        using var response = await _host.WorkerAsync(HttpMethod.Post, $"/internal/worker-executions/calendar/links/{link.Id:D}/cursor", job, execution, body);
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
    }

    private async Task<string?> SessionCursorAsync(Nix.Domain.Calendar.CalendarLink link, bool full)
    {
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link, full);
        using var response = await _host.WorkerAsync(HttpMethod.Post, $"/internal/worker-executions/calendar/links/{link.Id:D}/session", job, execution);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
        var cursor = document.RootElement.GetProperty("cursor");
        return cursor.ValueKind == JsonValueKind.Null ? null : cursor.GetString();
    }

    private async Task<Guid> CreateChildAsync(ItemId container, string title, string properties)
    {
        await using var work = await _host.BeginAsync(Alpha);
        var created = await work.Resolve<NixDispatcher>().SendAsync<CreateItem, Item>(
            new CreateItem(Alpha.WorkspaceId!.Value, "note", title, container, JsonNode.Parse(properties)!.AsObject()), Cancellation);
        Assert.True(created.IsSuccess, created.IsSuccess ? string.Empty : created.Error.Message);
        await work.CommitAsync(Cancellation);
        return created.Value.Id.Value;
    }

    private async Task SetPropertiesAsync(Guid itemId, string changes)
    {
        await using var work = await _host.BeginAsync(Alpha);
        var written = await work.Resolve<NixDispatcher>().SendAsync<SetItemProperties, Item>(new SetItemProperties(ItemId.From(itemId), changes), Cancellation);
        Assert.True(written.IsSuccess, written.IsSuccess ? string.Empty : written.Error.Message);
        await work.CommitAsync(Cancellation);
    }

    [Fact]
    public async Task A_linked_container_and_its_paired_events_are_protected_until_the_link_is_removed()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);
        await PullAsync(link, job, execution, Event("evt-kept", "v1", "Kept", "2026-10-05", DateTimeOffset.UtcNow));
        var eventId = ItemId.From(await GuidAsync($"SELECT item_id FROM calendar_event_map WHERE external_event_id = 'evt-kept'"));
        var elsewhere = await CreateFolderAsync("Elsewhere");

        await using (var work = await _host.BeginAsync(Alpha))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            foreach (var target in new[] { eventId, link.ContainerItemId })
            {
                var deleted = await dispatcher.SendAsync<DeleteItem, ItemId>(new DeleteItem(target), Cancellation);
                Assert.Equal("items.delete_protected", deleted.Error.Code);
            }

            // Leaving the container is how an event is deleted upstream, so it is refused as one.
            var moved = await dispatcher.SendAsync<MoveItem, Item>(new MoveItem(eventId, ItemId.From(elsewhere), null), Cancellation);
            Assert.Equal("items.delete_protected", moved.Error.Code);

            // The system's protection is not the user's to switch off.
            var unprotected = await dispatcher.SendAsync<SetItemProtection, Item>(new SetItemProtection(eventId, false, null), Cancellation);
            Assert.Equal("items.protection_managed", unprotected.Error.Code);
        }

        await using (var work = await _host.BeginAsync(Alpha))
        {
            Assert.True((await work.Resolve<NixDispatcher>().SendAsync<DeleteCalendarLink, bool>(new DeleteCalendarLink(link.Id), Cancellation)).IsSuccess);
            await work.CommitAsync(Cancellation);
        }

        Assert.Equal(0, await CountAsync($"SELECT count(*) FROM item WHERE id IN ('{eventId.Value}', '{link.ContainerItemId.Value}') AND (no_delete OR managed_by IS NOT NULL)"));
        await DeleteItemAsync(eventId.Value);
    }

    [Fact]
    public async Task Only_somebody_who_manages_the_workspace_unlinks_a_calendar_another_member_linked()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var (job, execution) = await _host.ClaimJobAsync(Alpha, link);
        await PullAsync(link, job, execution, Event("evt-theirs", "v1", "Theirs", "2026-10-05", DateTimeOffset.UtcNow));

        var other = Guid.NewGuid();
        await ExecuteAsync($"""
            INSERT INTO principal
                (principal_id, tenant_id, external_subject, kind, display_name, email, status, deprovisioned_at)
            VALUES ('{other}', '{TestTenants.Alpha}', 'calendar-other-{other:N}', 'user', 'Other',
                    'calendar-other-{other:N}@example.test', 'active', NULL);
            INSERT INTO workspace_member
                (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES ('{TestTenants.AlphaWorkspace}', 'principal', '{other}', '{TestTenants.Alpha}', 'editor',
                    '{TestTenants.AlphaPrincipal}', now());
            """);
        var otherContext = TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, other);
        var unlink = new UnlinkWorkspaceCalendar(Alpha.WorkspaceId!.Value, link.ContainerItemId, TrashItems: false);

        // An editor can neither see the workspace's links nor remove one.
        await using (var work = await _host.BeginAsync(otherContext))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            Assert.Equal("calendar.link_not_found", (await dispatcher.SendAsync<UnlinkWorkspaceCalendar, bool>(unlink, Cancellation)).Error.Code);
            Assert.True((await dispatcher.SendAsync<ListWorkspaceCalendarLinks, WorkspaceCalendarLinksResponse>(
                new ListWorkspaceCalendarLinks(Alpha.WorkspaceId!.Value), Cancellation)).IsFailure);
        }

        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM calendar_link WHERE id = '{link.Id}'"));

        await ExecuteAsync($"UPDATE workspace_member SET role = 'owner' WHERE subject_id = '{other}' AND workspace_id = '{TestTenants.AlphaWorkspace}'");
        await using (var work = await _host.BeginAsync(otherContext))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var listed = await dispatcher.SendAsync<ListWorkspaceCalendarLinks, WorkspaceCalendarLinksResponse>(
                new ListWorkspaceCalendarLinks(Alpha.WorkspaceId!.Value), Cancellation);
            Assert.Contains(listed.Value.Links, entry => entry.ContainerItemId == link.ContainerItemId.Value);
            Assert.True((await dispatcher.SendAsync<UnlinkWorkspaceCalendar, bool>(unlink, Cancellation)).IsSuccess);
            await work.CommitAsync(Cancellation);
        }

        Assert.Equal(0, await CountAsync($"SELECT count(*) FROM calendar_link WHERE id = '{link.Id}'"));
        Assert.Equal(0, await CountAsync($"SELECT count(*) FROM item WHERE workspace_id = '{TestTenants.AlphaWorkspace}' AND (id = '{link.ContainerItemId.Value}' OR parent_id = '{link.ContainerItemId.Value}') AND managed_by IS NOT NULL"));
    }

    [Fact]
    public async Task A_protected_item_refuses_its_own_deletion_an_ancestors_and_new_children()
    {
        var parent = ItemId.From(await CreateFolderAsync("Parent"));
        var child = ItemId.From(await CreateChildAsync(parent, "Child", "{}"));

        await using var work = await _host.BeginAsync(Alpha);
        var dispatcher = work.Resolve<NixDispatcher>();
        Assert.True((await dispatcher.SendAsync<SetItemProtection, Item>(new SetItemProtection(child, true, true), Cancellation)).IsSuccess);

        Assert.Equal("items.delete_protected", (await dispatcher.SendAsync<DeleteItem, ItemId>(new DeleteItem(child), Cancellation)).Error.Code);
        Assert.Equal("items.delete_protected", (await dispatcher.SendAsync<DeleteItem, ItemId>(new DeleteItem(parent), Cancellation)).Error.Code);
        Assert.Equal(
            "items.children_protected",
            (await dispatcher.SendAsync<CreateItem, Item>(new CreateItem(Alpha.WorkspaceId!.Value, "note", "Refused", child, null), Cancellation)).Error.Code);

        Assert.True((await dispatcher.SendAsync<SetItemProtection, Item>(new SetItemProtection(child, false, null), Cancellation)).IsSuccess);
        Assert.True((await dispatcher.SendAsync<DeleteItem, ItemId>(new DeleteItem(parent), Cancellation)).IsSuccess);
    }

    /// <summary>
    /// Puts a paired event back in the state one was in before pairing protected it, so the paths
    /// that handle an event trashed or moved out in Nix (still owed to rows from before the
    /// protection existed) stay covered. No request can reach that state any more.
    /// </summary>
    private Task ReleaseProtectionAsync(Guid itemId) =>
        ExecuteAsync($"UPDATE item SET managed_by = NULL, no_delete = false WHERE id = '{itemId}'");

    private async Task DeleteItemAsync(Guid itemId)
    {
        await ReleaseProtectionAsync(itemId);
        await using var work = await _host.BeginAsync(Alpha);
        Assert.True((await work.Resolve<NixDispatcher>().SendAsync<DeleteItem, ItemId>(new DeleteItem(ItemId.From(itemId)), Cancellation)).IsSuccess);
        await work.CommitAsync(Cancellation);
    }

    private static void AssertSameKeys(JsonElement expected, JsonElement actual) =>
        Assert.Equal(
            expected.EnumerateObject().Select(member => member.Name).Order(StringComparer.Ordinal),
            actual.EnumerateObject().Select(member => member.Name).Order(StringComparer.Ordinal));

    private static JsonElement Fixture(string name)
    {
        using var document = JsonDocument.Parse(FixtureText(name));
        return document.RootElement.Clone();
    }

    private static string FixtureText(string name) =>
        File.ReadAllText(Path.Combine(RepositoryRoot(), "fixtures", "calendar-contract", name));

    private static string RepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Nix.slnx")))
            {
                return directory.FullName;
            }
        }

        throw new InvalidOperationException($"No Nix.slnx above {AppContext.BaseDirectory}.");
    }

    private static async Task<string?> ProblemCodeAsync(HttpResponseMessage response)
    {
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
        return document.RootElement.GetProperty("code").GetString();
    }

    private async Task<long> CountAsync(string sql)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            return await RawSql.CountAsync(connection, transaction: null, sql);
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

    private async Task<Guid> GuidAsync(string sql)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            return Assert.Single(await RawSql.GuidListAsync(connection, transaction: null, sql));
        }
    }

    private async Task ExecuteAsync(string sql)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    /// <summary>One pulled event, already JSON.</summary>
    private sealed record CalendarPullEventText(string Json);
}
