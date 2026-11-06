using System.Globalization;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Items;
using Nix.Domain.Notifications;
using Nix.Features.Items;
using Nix.Features.Properties;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence.Scheduling;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Item expiry against real Postgres: the write-time checks, the finder, the plan -&gt; dispatch
/// -&gt; trash path through <c>DeleteItem</c>, and what a blocked folder tells its setter.
/// </summary>
/// <remarks>
/// The planner and dispatcher run on the system clock, so an item "past its expiry" is made by
/// writing a valid future date through the write path (which stamps <c>$expiry_set_by</c>) and
/// then moving the stored date into the past as the migrator. A later day is simulated by moving
/// the trash triggers' day-stamped dedupe keys back.
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class ExpiryIntegrationTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static readonly Guid Colleague = new("14141414-1111-4111-8111-141414141414");

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        await Sql("DELETE FROM scheduled_trigger; DELETE FROM notification; DELETE FROM principal_preferences;");
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task The_warning_and_the_expiry_each_fire_once()
    {
        var context = TestTenants.AlphaContext;
        var itemId = await CreateAsync(context, "Draft contract");
        await SetExpiryAsync(context, itemId, DaysFromNow(3));

        await PlanAndDispatchAsync();
        await PlanAndDispatchAsync();

        var warning = Assert.Single(await NotificationsAsync(context, itemId));
        Assert.StartsWith("Moves to trash on", warning.Body, StringComparison.Ordinal);
        Assert.Equal(0, await CountAsync($"SELECT count(*) FROM item WHERE id = '{itemId}' AND lifecycle_state = 'deleted'"));

        await ForgeExpiryAsync(itemId, DateTimeOffset.UtcNow.AddMinutes(-1));
        await PlanAndDispatchAsync();
        await PlanAndDispatchAsync();

        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM item WHERE id = '{itemId}' AND lifecycle_state = 'deleted'"));
        var notices = await NotificationsAsync(context, itemId);
        Assert.Equal(2, notices.Count);
        Assert.Single(notices, notice => notice.Body == "Moved to trash because its expiry passed.");
    }

    [Fact]
    public async Task A_date_beyond_the_horizon_plans_nothing()
    {
        var context = TestTenants.AlphaContext;
        var itemId = await CreateAsync(context, "Far away");
        await SetExpiryAsync(context, itemId, DaysFromNow(30));

        await PlanAndDispatchAsync();

        Assert.Empty(await NotificationsAsync(context, itemId));
        Assert.Equal(0, await CountAsync($"SELECT count(*) FROM scheduled_trigger WHERE source_item_id = '{itemId}'"));
    }

    [Fact]
    public async Task A_past_or_malformed_date_is_refused_and_null_clears()
    {
        var context = TestTenants.AlphaContext;
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var past = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(context.WorkspaceId!.Value, "note", "Late", null, new JsonObject { ["expiry"] = PastText() }), Cancellation);
            Assert.True(past.IsFailure);
            Assert.Equal(PropertyErrors.InvalidPropertiesCode, past.Error.Code);

            var created = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(context.WorkspaceId!.Value, "note", "On time", null, new JsonObject { ["expiry"] = DaysFromNow(2) }), Cancellation);
            Assert.True(created.IsSuccess, created.IsSuccess ? "" : created.Error.Message);
            Assert.Contains(ItemProperties.ExpirySetByKey, created.Value.Properties!, StringComparison.Ordinal);

            foreach (var bad in new[] { PastText(), "soon", "2999-01-01T09:00:00+00:00" })
            {
                var refused = await dispatcher.SendAsync<SetItemProperties, Item>(
                    new SetItemProperties(created.Value.Id, new JsonObject { ["expiry"] = bad }.ToJsonString()), Cancellation);
                Assert.True(refused.IsFailure, bad);
            }

            var forged = await dispatcher.SendAsync<SetItemProperties, Item>(
                new SetItemProperties(created.Value.Id, new JsonObject { [ItemProperties.ExpirySetByKey] = Guid.NewGuid().ToString() }.ToJsonString()), Cancellation);
            Assert.True(forged.IsFailure);

            var cleared = await dispatcher.SendAsync<SetItemProperties, Item>(
                new SetItemProperties(created.Value.Id, """{"expiry":null}"""), Cancellation);
            Assert.True(cleared.IsSuccess, cleared.IsSuccess ? "" : cleared.Error.Message);
            Assert.DoesNotContain(ItemProperties.ExpirySetByKey, cleared.Value.Properties!, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task An_old_expiry_with_no_setter_stamp_is_ignored()
    {
        var context = TestTenants.AlphaContext;
        var itemId = await CreateAsync(context, "User data");
        await Sql($"UPDATE item SET properties = properties || jsonb_build_object('expiry', '{PastText()}'::text) WHERE id = '{itemId}'");

        await PlanAndDispatchAsync();

        Assert.Equal(0, await CountAsync($"SELECT count(*) FROM item WHERE id = '{itemId}' AND lifecycle_state = 'deleted'"));
        Assert.Empty(await NotificationsAsync(context, itemId));
    }

    [Fact]
    public async Task A_folder_with_a_no_delete_descendant_is_left_whole_and_the_notice_names_the_blocker()
    {
        var context = TestTenants.AlphaContext;
        var (folderId, childId) = await BlockedFolderAsync(context, protect: true);

        await PlanAndDispatchAsync();
        await PlanAndDispatchAsync();

        Assert.Equal(0, await CountAsync($"SELECT count(*) FROM item WHERE id IN ('{folderId}', '{childId}') AND lifecycle_state <> 'active'"));
        var notice = Assert.Single(await NotificationsAsync(context, folderId));
        Assert.Contains("Pinned note", notice.Body, StringComparison.Ordinal);
        Assert.Contains("protected from deletion", notice.Body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_folder_with_a_pinned_descendant_is_left_whole_and_the_notice_names_the_blocker()
    {
        // Needs the DeleteItem check that lane 2 adds (pins block a trash, under the topology
        // lock). Red until that merges: the folder is trashed without it.
        var context = TestTenants.AlphaContext;
        var (folderId, childId) = await BlockedFolderAsync(context, protect: false);
        var holderId = await CreateAsync(context, "Record");
        var version = Guid.NewGuid();
        await Sql($"""
            INSERT INTO file_version
                (file_version_id, tenant_id, workspace_id, item_id, version, object_key, file_name, media_type,
                 byte_length, sha256, previewable, created_by, created_at)
            VALUES ('{version}', '{TestTenants.Alpha}', '{TestTenants.AlphaWorkspace}', '{childId}', 1,
                    'files/expiry/{version}', 'x.bin', 'application/octet-stream', 4, repeat('c', 64), false,
                    '{TestTenants.AlphaPrincipal}', now());
            INSERT INTO item_reference
                (id, tenant_id, workspace_id, holder_item_id, target_item_id, target_file_version_id, role, created_by, created_at)
            VALUES (gen_random_uuid(), '{TestTenants.Alpha}', '{TestTenants.AlphaWorkspace}', '{holderId}', '{childId}',
                    '{version}', 'pin', '{TestTenants.AlphaPrincipal}', now());
            """);

        await PlanAndDispatchAsync();

        Assert.Equal(0, await CountAsync($"SELECT count(*) FROM item WHERE id IN ('{folderId}', '{childId}') AND lifecycle_state <> 'active'"));
        var notice = Assert.Single(await NotificationsAsync(context, folderId));
        Assert.Contains("Pinned note", notice.Body, StringComparison.Ordinal);
        Assert.Contains("pinned", notice.Body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_blocked_folder_trashes_whole_on_the_first_retry_after_the_block_lifts()
    {
        var context = TestTenants.AlphaContext;
        var (folderId, childId) = await BlockedFolderAsync(context, protect: true);

        await PlanAndDispatchAsync();
        await ShiftTriggersBackADayAsync();
        await PlanAndDispatchAsync();

        // Retried the next day and still blocked: no second notice inside 30 days.
        Assert.Equal(0, await CountAsync($"SELECT count(*) FROM item WHERE id = '{folderId}' AND lifecycle_state <> 'active'"));
        Assert.Single(await NotificationsAsync(context, folderId));

        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var lifted = await work.Resolve<NixDispatcher>().SendAsync<SetItemProtection, Item>(
                new SetItemProtection(ItemId.From(childId), false, null), Cancellation);
            Assert.True(lifted.IsSuccess, lifted.IsSuccess ? "" : lifted.Error.Message);
            await work.CommitAsync(Cancellation);
        }

        await ShiftTriggersBackADayAsync();
        await PlanAndDispatchAsync();

        // One row flag: the folder is trashed and nothing under it was rewritten.
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM item WHERE id = '{folderId}' AND lifecycle_state = 'deleted'"));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM item WHERE id = '{childId}' AND lifecycle_state = 'active'"));
    }

    [Fact]
    public async Task Restoring_an_expired_item_clears_the_date_so_it_stays()
    {
        var context = TestTenants.AlphaContext;
        var itemId = await CreateAsync(context, "Short lived");
        await SetExpiryAsync(context, itemId, DaysFromNow(30));
        await ForgeExpiryAsync(itemId, DateTimeOffset.UtcNow.AddMinutes(-1));
        await PlanAndDispatchAsync();
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM item WHERE id = '{itemId}' AND lifecycle_state = 'deleted'"));

        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var restored = await work.Resolve<NixDispatcher>().SendAsync<RestoreItem, Item>(new RestoreItem(ItemId.From(itemId)), Cancellation);
            Assert.True(restored.IsSuccess, restored.IsSuccess ? "" : restored.Error.Message);
            Assert.DoesNotContain("expiry", restored.Value.Properties!, StringComparison.Ordinal);
            await work.CommitAsync(Cancellation);
        }

        await PlanAndDispatchAsync();
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM item WHERE id = '{itemId}' AND lifecycle_state = 'active'"));
    }

    [Fact]
    public async Task A_site_root_is_skipped_and_the_setter_is_told()
    {
        var context = TestTenants.AlphaContext;
        var itemId = await CreateAsync(context, "Docs home");
        await SetExpiryAsync(context, itemId, DaysFromNow(30));
        var site = Guid.NewGuid();
        var build = Guid.NewGuid();
        // A draft site with a stored build object: the "stored" arm of HasLiveOrStoredSiteAsync.
        await Sql($"""
            INSERT INTO site
                (tenant_id, id, workspace_id, root_item_id, slug, layout, settings, republish_mode,
                 debounce_seconds, status, created_by, created_at, updated_at)
            VALUES ('{TestTenants.Alpha}', '{site}', '{TestTenants.AlphaWorkspace}', '{itemId}', 'expiry-site',
                    'docs', jsonb_build_object(), 'manual', 300, 'draft', '{TestTenants.AlphaPrincipal}', now(), now());
            INSERT INTO site_build
                (tenant_id, id, site_id, status, job_id, publisher_id, origin, idempotency_key, header,
                 page_count, file_count, total_bytes, loss, created_at)
            VALUES ('{TestTenants.Alpha}', '{build}', '{site}', 'queued', gen_random_uuid(), '{TestTenants.AlphaPrincipal}',
                    'manual', 'expiry', jsonb_build_object(), 1, 0, 0, '[]'::jsonb, now());
            INSERT INTO site_build_object (tenant_id, build_id, key, sha256, byte_length, kind, created_at)
            VALUES ('{TestTenants.Alpha}', '{build}', 'sites/expiry/index.html', repeat('a', 64), 1, 'build', now());
            """);
        await ForgeExpiryAsync(itemId, DateTimeOffset.UtcNow.AddMinutes(-1));

        await PlanAndDispatchAsync();

        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM item WHERE id = '{itemId}' AND lifecycle_state = 'active'"));
        var notice = Assert.Single(await NotificationsAsync(context, itemId));
        Assert.Contains("root of a site", notice.Body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_setter_who_lost_write_access_gets_a_skip_notice_and_the_item_stays()
    {
        await Sql($"""
            INSERT INTO principal (principal_id, tenant_id, external_subject, kind, display_name, email, status, deprovisioned_at)
            VALUES ('{Colleague}', '{TestTenants.Alpha}', 'alpha-expiry-colleague', 'user', 'Colleague', 'expiry-colleague@example.test', 'active', NULL);
            INSERT INTO workspace_member (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES ('{TestTenants.AlphaWorkspace}', 'principal', '{Colleague}', '{TestTenants.Alpha}', 'editor', '{TestTenants.AlphaPrincipal}', now());
            """);
        var context = TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, Colleague);
        var itemId = await CreateAsync(context, "Colleague note");
        await SetExpiryAsync(context, itemId, DaysFromNow(30));
        await Sql($"UPDATE workspace_member SET role = 'viewer' WHERE subject_id = '{Colleague}'");
        await ForgeExpiryAsync(itemId, DateTimeOffset.UtcNow.AddMinutes(-1));

        await PlanAndDispatchAsync();

        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM item WHERE id = '{itemId}' AND lifecycle_state = 'active'"));
        var notice = Assert.Single(await NotificationsAsync(context, itemId));
        Assert.Contains("write access", notice.Body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Expiry_runs_per_tenant_and_notices_stay_in_their_tenant()
    {
        var alpha = TestTenants.AlphaContext;
        var beta = TestTenants.BetaContext;
        var alphaItem = await CreateAsync(alpha, "Alpha expiring");
        var betaItem = await CreateAsync(beta, "Beta expiring");
        foreach (var (context, id) in new[] { (alpha, alphaItem), (beta, betaItem) })
        {
            await SetExpiryAsync(context, id, DaysFromNow(30));
            await ForgeExpiryAsync(id, DateTimeOffset.UtcNow.AddMinutes(-1));
        }

        await PlanAndDispatchAsync();

        Assert.Equal(2, await CountAsync($"SELECT count(*) FROM item WHERE id IN ('{alphaItem}', '{betaItem}') AND lifecycle_state = 'deleted'"));
        Assert.Single(await NotificationsAsync(alpha, alphaItem));
        Assert.Single(await NotificationsAsync(beta, betaItem));
        Assert.Empty(await NotificationsAsync(alpha, betaItem));
        Assert.Empty(await NotificationsAsync(beta, alphaItem));
    }

    private async Task<(Guid FolderId, Guid ChildId)> BlockedFolderAsync(NixSessionContext context, bool protect)
    {
        var folderId = await CreateAsync(context, "Project", "folder");
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        Guid childId;
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var child = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(context.WorkspaceId!.Value, "note", "Pinned note", ItemId.From(folderId), null), Cancellation);
            Assert.True(child.IsSuccess, child.IsSuccess ? "" : child.Error.Message);
            childId = child.Value.Id.Value;
            if (protect)
            {
                var protectedChild = await dispatcher.SendAsync<SetItemProtection, Item>(
                    new SetItemProtection(child.Value.Id, true, null), Cancellation);
                Assert.True(protectedChild.IsSuccess, protectedChild.IsSuccess ? "" : protectedChild.Error.Message);
            }

            await work.CommitAsync(Cancellation);
        }

        await SetExpiryAsync(context, folderId, DaysFromNow(30));
        await ForgeExpiryAsync(folderId, DateTimeOffset.UtcNow.AddMinutes(-1));
        return (folderId, childId);
    }

    private async Task<Guid> CreateAsync(NixSessionContext context, string title, string type = "note")
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var created = await work.Resolve<NixDispatcher>().SendAsync<CreateItem, Item>(
                new CreateItem(context.WorkspaceId!.Value, type, title, null, null), Cancellation);
            Assert.True(created.IsSuccess, created.IsSuccess ? "" : created.Error.Message);
            await work.CommitAsync(Cancellation);
            return created.Value.Id.Value;
        }
    }

    private async Task SetExpiryAsync(NixSessionContext context, Guid itemId, string text)
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var written = await work.Resolve<NixDispatcher>().SendAsync<SetItemProperties, Item>(
                new SetItemProperties(ItemId.From(itemId), new JsonObject { ["expiry"] = text }.ToJsonString()), Cancellation);
            Assert.True(written.IsSuccess, written.IsSuccess ? "" : written.Error.Message);
            await work.CommitAsync(Cancellation);
        }
    }

    /// <summary>Moves the stored date into the past, as storage would hold it once the day came.</summary>
    private Task ForgeExpiryAsync(Guid itemId, DateTimeOffset when) =>
        Sql($"UPDATE item SET properties = properties || jsonb_build_object('expiry', '{Text(when)}'::text) WHERE id = '{itemId}'");

    /// <summary>Makes every trash trigger look a day older, so the next pass plans a new day's retry.</summary>
    private Task ShiftTriggersBackADayAsync() => Sql("""
        UPDATE scheduled_trigger
           SET dedupe_key = regexp_replace(
                   dedupe_key, '[0-9]{4}-[0-9]{2}-[0-9]{2}$',
                   to_char(to_date(substring(dedupe_key from '[0-9]{4}-[0-9]{2}-[0-9]{2}$'), 'YYYY-MM-DD') - 1, 'YYYY-MM-DD'))
         WHERE dedupe_key LIKE 'expiry:%';
        """);

    private async Task PlanAndDispatchAsync()
    {
        var scopeFactory = fixture.Application.CreateUnscopedScope().ServiceProvider.GetRequiredService<IServiceScopeFactory>();
        var leases = fixture.Application.CreateUnscopedScope().ServiceProvider.GetRequiredService<IScheduledTriggerLeaseStore>();
        var retention = fixture.Application.CreateUnscopedScope().ServiceProvider.GetRequiredService<IRetentionStore>();
        using var planner = new TriggerPlanner(scopeFactory, TimeProvider.System);
        using var dispatcher = new ScheduleDispatcher(leases, retention, scopeFactory, TimeProvider.System);
        await planner.PlanOnceAsync(Cancellation);
        await dispatcher.DispatchOnceAsync(Cancellation);
    }

    private async Task<IReadOnlyList<Notification>> NotificationsAsync(NixSessionContext context, Guid itemId)
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            return await work.DbContext.Set<Notification>().AsNoTracking()
                .Where(row => row.ItemId == ItemId.From(itemId)).ToListAsync(Cancellation);
        }
    }

    private async Task Sql(string sql)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    private async Task<int> CountAsync(string sql)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            return (int)await RawSql.CountAsync(connection, transaction: null, sql);
        }
    }

    private static string Text(DateTimeOffset when) =>
        $"{when.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture)}+00:00[Etc/UTC]";

    private static string DaysFromNow(int days) => Text(DateTimeOffset.UtcNow.AddDays(days));

    private static string PastText() => Text(DateTimeOffset.UtcNow.AddDays(-1));
}
