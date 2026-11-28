using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Items;
using Nix.Features.Items;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence.Scheduling;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The two calendar trigger sources (Amendment 1 A5): the five-minute planned poll, the dirty feed
/// the item trigger inserts, firing re-verified as the owner, coalescing onto a running round,
/// access loss, and retention.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class CalendarSchedulingTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static readonly Guid Colleague = new("1d1d1d1d-1111-4111-8111-1d1d1d1d1d1d");

    private CalendarSyncHost _host = null!;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static NixSessionContext Alpha => TestTenants.AlphaContext;

    private static NixSessionContext Peer => TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, Colleague);

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        await ExecuteAsync($"""
            INSERT INTO principal
                (principal_id, tenant_id, external_subject, kind, display_name, email, status, deprovisioned_at)
            VALUES ('{Colleague}', '{TestTenants.Alpha}', 'alpha-calendar-colleague', 'user', 'Colleague',
                    'calendar-colleague@example.test', 'active', NULL);
            INSERT INTO workspace_member
                (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES ('{TestTenants.AlphaWorkspace}', 'principal', '{Colleague}', '{TestTenants.Alpha}', 'editor',
                    '{TestTenants.AlphaPrincipal}', now());
            DELETE FROM scheduled_trigger;
            """);
        _host = await CalendarSyncHost.StartAsync(fixture);
    }

    public async ValueTask DisposeAsync() => await _host.DisposeAsync();

    [Fact]
    public async Task The_planner_keeps_exactly_one_staggered_trigger_per_active_link()
    {
        var connection = await _host.ConnectAsync(Alpha);
        var active = await _host.LinkAsync(Alpha, connection);
        var paused = await _host.LinkAsync(Alpha, connection, externalCalendarId: "holidays");
        await ExecuteAsync($"UPDATE calendar_link SET status = 'paused' WHERE id = '{paused.Id}'");

        await PlanAsync();
        await PlanAsync();

        Assert.Equal(1, await CountAsync("SELECT count(*) FROM scheduled_trigger WHERE source = 'calendar.sync'"));
        Assert.Equal(1, await CountAsync($"""
            SELECT count(*) FROM scheduled_trigger
             WHERE source = 'calendar.sync' AND kind = 'calendar' AND rule_id = '{active.Id}' AND status = 'pending'
               AND principal_id = '{TestTenants.AlphaPrincipal}' AND dedupe_key LIKE 'cal:p:{active.Id:D}:%'
               AND fire_at >= now() AND fire_at < now() + interval '5 minutes'
            """));
    }

    [Fact]
    public async Task Another_members_write_in_the_container_marks_the_owners_link_dirty_on_the_minutes_trailing_edge()
    {
        var twoWay = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var importOnly = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha, provider: "microsoft"), direction: "import_only");

        var itemId = await CreateChildAsync(Peer, twoWay.ContainerItemId, "From a colleague");
        await CreateChildAsync(Peer, importOnly.ContainerItemId, "Imported only");

        Assert.Equal(1, await CountAsync($"""
            SELECT count(*) FROM scheduled_trigger
             WHERE source = 'calendar.dirty' AND rule_id = '{twoWay.Id}' AND principal_id = '{TestTenants.AlphaPrincipal}'
               AND dedupe_key LIKE 'cal:d:{twoWay.Id:D}:%' AND fire_at = date_trunc('minute', created_at) + interval '1 minute'
            """));
        Assert.Equal(0, await CountAsync($"SELECT count(*) FROM scheduled_trigger WHERE rule_id = '{importOnly.Id}'"));

        // More writes in the same minute coalesce onto that one trigger.
        await using (var work = await _host.BeginAsync(Peer))
        {
            await work.Resolve<NixDispatcher>().SendAsync<Nix.Features.Properties.SetItemProperties, Item>(
                new(ItemId.From(itemId), """{"location":"Room 2"}"""), Cancellation);
            await work.CommitAsync(Cancellation);
        }

        Assert.InRange(await CountAsync($"SELECT count(*) FROM scheduled_trigger WHERE source = 'calendar.dirty' AND rule_id = '{twoWay.Id}'"), 1, 2);
    }

    [Fact]
    public async Task A_due_trigger_fires_one_job_under_the_owner_and_a_second_coalesces_onto_it()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var slot = new DateTimeOffset(2026, 9, 30, 12, 5, 0, TimeSpan.Zero);
        await InsertTriggerAsync("calendar.sync", Nix.Domain.Calendar.CalendarSyncRules.PlannedKey(link.Id, slot), link);

        await DispatchAsync();

        Assert.Equal("fired|enqueued", await TextAsync("SELECT status || '|' || (detail ->> 'reason') FROM scheduled_trigger WHERE source = 'calendar.sync'"));
        Assert.Equal(1, await CountAsync($"""
            SELECT count(*) FROM worker_job
             WHERE kind = 'calendar.sync' AND actor_id = '{TestTenants.AlphaPrincipal}' AND workspace_id = '{TestTenants.AlphaWorkspace}'
               AND idempotency_key = 'link:{link.Id:D}:p:202609301205'
            """));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM calendar_link WHERE id = '{link.Id}' AND last_job_id IS NOT NULL"));

        // The job is still queued: a dirty trigger now skips, and leaves a follow-up for later.
        await InsertTriggerAsync("calendar.dirty", Nix.Domain.Calendar.CalendarSyncRules.DirtyKey(link.Id, slot), link);
        await DispatchAsync();
        Assert.Equal("skipped|already_running", await TextAsync($"SELECT status || '|' || (detail ->> 'reason') FROM scheduled_trigger WHERE dedupe_key = 'cal:d:{link.Id:D}:202609301205'"));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM scheduled_trigger WHERE source = 'calendar.dirty' AND status = 'pending' AND rule_id = '{link.Id}'"));
        Assert.Equal(1, await CountAsync("SELECT count(*) FROM worker_job WHERE kind = 'calendar.sync'"));
    }

    [Fact]
    public async Task An_owner_who_lost_write_access_is_skipped_and_the_link_marked_errored()
    {
        var link = await _host.LinkAsync(Peer, await _host.ConnectAsync(Peer));
        await ExecuteAsync($"DELETE FROM workspace_member WHERE subject_id = '{Colleague}'");
        await InsertTriggerAsync("calendar.sync", Nix.Domain.Calendar.CalendarSyncRules.PlannedKey(link.Id, DateTimeOffset.UtcNow.AddMinutes(-1)), link);

        await DispatchAsync();

        Assert.Equal("skipped|access_lost", await TextAsync($"SELECT status || '|' || (detail ->> 'reason') FROM scheduled_trigger WHERE rule_id = '{link.Id}'"));
        Assert.Equal("error|access_lost", await TextAsync($"SELECT status || '|' || last_error FROM calendar_link WHERE id = '{link.Id}'"));
        Assert.Equal(0, await CountAsync("SELECT count(*) FROM worker_job WHERE kind = 'calendar.sync'"));
    }

    [Fact]
    public async Task A_link_or_connection_that_went_away_is_skipped_by_name()
    {
        var connection = await _host.ConnectAsync(Alpha);
        var link = await _host.LinkAsync(Alpha, connection);
        await ExecuteAsync($"UPDATE calendar_connection SET status = 'needs_reauth' WHERE id = '{connection}'");
        await InsertTriggerAsync("calendar.sync", Nix.Domain.Calendar.CalendarSyncRules.PlannedKey(link.Id, DateTimeOffset.UtcNow.AddMinutes(-1)), link);
        await DispatchAsync();
        Assert.Equal("skipped|connection_inactive", await TextAsync($"SELECT status || '|' || (detail ->> 'reason') FROM scheduled_trigger WHERE rule_id = '{link.Id}'"));
    }

    [Fact]
    public async Task A_trigger_over_a_locked_container_is_skipped_and_enqueues_nothing()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        await ExecuteAsync($"""
            INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
            VALUES ('{link.ContainerItemId.Value}', '{TestTenants.Alpha}',
                    'pbkdf2-sha256$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', '{TestTenants.AlphaPrincipal}', now())
            """);
        await InsertTriggerAsync("calendar.sync", Nix.Domain.Calendar.CalendarSyncRules.PlannedKey(link.Id, DateTimeOffset.UtcNow.AddMinutes(-1)), link);

        await DispatchAsync();

        Assert.Equal("skipped|container_locked", await TextAsync($"SELECT status || '|' || (detail ->> 'reason') FROM scheduled_trigger WHERE rule_id = '{link.Id}'"));
        Assert.Equal(0, await CountAsync("SELECT count(*) FROM worker_job WHERE kind = 'calendar.sync'"));
    }

    [Fact]
    public async Task Two_triggers_firing_at_once_for_one_link_enqueue_one_round()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        var minute = new DateTimeOffset(2026, 9, 30, 12, 5, 0, TimeSpan.Zero);
        var planned = Due(link, Nix.Domain.Calendar.CalendarSyncRules.PlannedSource, Nix.Domain.Calendar.CalendarSyncRules.PlannedKey(link.Id, minute));
        var dirty = Due(link, Nix.Domain.Calendar.CalendarSyncRules.DirtySource, Nix.Domain.Calendar.CalendarSyncRules.DirtyKey(link.Id, minute));

        // The first firing holds its transaction open while the second starts.
        await using var first = await _host.BeginAsync(Alpha);
        var firstOutcome = await first.Resolve<Nix.Features.CalendarSync.CalendarSyncFiring>()
            .FireAsync(planned, Nix.Domain.Calendar.CalendarTriggerKind.Planned, Cancellation);
        Assert.Equal("enqueued", firstOutcome.Reason);

        var second = Task.Run(async () =>
        {
            await using var work = await _host.BeginAsync(Alpha);
            var outcome = await work.Resolve<Nix.Features.CalendarSync.CalendarSyncFiring>()
                .FireAsync(dirty, Nix.Domain.Calendar.CalendarTriggerKind.Dirty, Cancellation);
            await work.CommitAsync(Cancellation);
            return outcome;
        }, Cancellation);
        await Task.Delay(TimeSpan.FromMilliseconds(500), Cancellation);
        await first.CommitAsync(Cancellation);

        Assert.Equal("already_running", (await second).Reason);
        Assert.Equal(1, await CountAsync("SELECT count(*) FROM worker_job WHERE kind = 'calendar.sync'"));
        Assert.Equal(1, await CountAsync($"""
            SELECT count(*) FROM calendar_link link JOIN worker_job job ON job.job_id = link.last_job_id WHERE link.id = '{link.Id}'
            """));
    }

    [Fact]
    public async Task Retention_removes_log_rows_and_tombstones_older_than_thirty_days()
    {
        var link = await _host.LinkAsync(Alpha, await _host.ConnectAsync(Alpha));
        await ExecuteAsync($"""
            INSERT INTO calendar_sync_log (tenant_id, id, link_id, principal_id, at, direction, action, item_id, external_event_id, detail)
            SELECT '{TestTenants.Alpha}', gen_random_uuid(), '{link.Id}', '{TestTenants.AlphaPrincipal}',
                   now() - CASE WHEN n <= 3 THEN interval '40 days' ELSE interval '1 day' END, 'pull', 'created', NULL, NULL, 'x'
              FROM generate_series(1, 5) n;
            INSERT INTO calendar_event_map (tenant_id, id, link_id, principal_id, item_id, external_event_id, push_failures,
                                            deleted_at, created_at, updated_at)
            SELECT '{TestTenants.Alpha}', gen_random_uuid(), '{link.Id}', '{TestTenants.AlphaPrincipal}', gen_random_uuid(),
                   'old-' || n, 0, now() - CASE WHEN n = 1 THEN interval '40 days' ELSE interval '1 day' END, now(), now()
              FROM generate_series(1, 2) n;
            """);

        await using var scope = fixture.Application.CreateUnscopedScope();
        Assert.Equal(3, await scope.ServiceProvider.GetRequiredService<IRetentionStore>().PurgeCalendarSyncLogAsync(500, Cancellation));

        Assert.Equal(2, await CountAsync($"SELECT count(*) FROM calendar_sync_log WHERE link_id = '{link.Id}'"));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM calendar_event_map WHERE link_id = '{link.Id}' AND external_event_id LIKE 'old-%'"));
    }

    private async Task PlanAsync()
    {
        await using var scope = fixture.Application.CreateUnscopedScope();
        using var planner = new TriggerPlanner(scope.ServiceProvider.GetRequiredService<IServiceScopeFactory>(), TimeProvider.System);
        await planner.PlanOnceAsync(Cancellation);
    }

    private async Task DispatchAsync()
    {
        await using var scope = fixture.Application.CreateUnscopedScope();
        var provider = scope.ServiceProvider;
        using var dispatcher = new ScheduleDispatcher(
            provider.GetRequiredService<IScheduledTriggerLeaseStore>(),
            provider.GetRequiredService<IRetentionStore>(),
            provider.GetRequiredService<IServiceScopeFactory>(),
            TimeProvider.System);
        await dispatcher.DispatchOnceAsync(Cancellation);
    }

    private Task InsertTriggerAsync(string source, string key, Nix.Domain.Calendar.CalendarLink link) => ExecuteAsync($"""
        INSERT INTO scheduled_trigger (tenant_id, id, workspace_id, principal_id, kind, source, source_item_id, rule_id,
                                       fire_at, dedupe_key, status, attempts, created_at, updated_at)
        VALUES ('{link.TenantId.Value}', gen_random_uuid(), '{link.WorkspaceId.Value}', '{link.PrincipalId.Value}', 'calendar',
                '{source}', '{link.ContainerItemId.Value}', '{link.Id}', now() - interval '1 second', '{key}', 'pending', 0, now(), now())
        """);

    private static DueTrigger Due(Nix.Domain.Calendar.CalendarLink link, string source, string key) => new(
        link.TenantId,
        Guid.NewGuid(),
        link.WorkspaceId,
        link.PrincipalId,
        Nix.Domain.Scheduling.TriggerKind.Calendar,
        source,
        link.ContainerItemId.Value,
        link.Id,
        DateTimeOffset.UtcNow,
        key,
        0);

    private async Task<Guid> CreateChildAsync(NixSessionContext context, ItemId container, string title)
    {
        await using var work = await _host.BeginAsync(context);
        var created = await work.Resolve<NixDispatcher>().SendAsync<CreateItem, Item>(
            new CreateItem(context.WorkspaceId!.Value, "note", title, container, new JsonObject { ["start"] = "2026-10-01" }), Cancellation);
        Assert.True(created.IsSuccess, created.IsSuccess ? string.Empty : created.Error.Message);
        await work.CommitAsync(Cancellation);
        return created.Value.Id.Value;
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

    private async Task ExecuteAsync(string sql)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }
}
