using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Scheduling;
using Nix.Domain.Tenancy;
using Nix.Features.Sites;
using Nix.Integration.Tests.Harness;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Automatic republish: the planner finds changed sites after their debounce, firing builds as the
/// principal who turned the mode on, and stops for good when that principal loses the authority.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class SiteRebuildTriggerTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private SiteScenario _scenario = null!;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static ItemId Root => ItemId.From(M0SchemaSeed.Alpha.ItemId);

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        _scenario = await SiteScenario.CreateAsync(fixture);
    }

    public async ValueTask DisposeAsync() => await _scenario.DisposeAsync();

    [Fact]
    public async Task A_changed_auto_site_is_planned_for_its_last_change_plus_the_debounce()
    {
        var (siteId, page) = await LiveSiteAsync("debounce", "auto", debounce: 600);
        await Sql($"UPDATE item SET last_modified_at = now() WHERE id = '{page.Value}'");
        var changedAt = await ChangedAtAsync(page);

        var plan = await PlanAsync();

        var trigger = Assert.Single(plan.Triggers);
        Assert.Equal(TestTenants.Alpha, trigger.TenantId.Value);
        Assert.Equal(TestTenants.AlphaPrincipal, trigger.PrincipalId.Value);
        Assert.Equal(TestTenants.AlphaWorkspace, trigger.WorkspaceId!.Value.Value);
        Assert.InRange((trigger.FireAt - changedAt).TotalSeconds, 599, 601);
        Assert.StartsWith($"site.rebuild:{siteId:N}:{changedAt.ToUnixTimeMilliseconds()}", trigger.DedupeKey, StringComparison.Ordinal);
        Assert.True(plan.Complete);
    }

    [Fact]
    public async Task A_change_older_than_the_debounce_is_planned_to_fire_now_and_never_in_the_past()
    {
        var (_, page) = await LiveSiteAsync("overdue", "auto", debounce: 60);
        await Sql($"UPDATE item SET last_modified_at = now() - interval '2 hours' WHERE id = '{page.Value}'");
        await Sql("UPDATE site_build SET created_at = now() - interval '3 hours'");

        var before = DateTimeOffset.UtcNow;
        var plan = await PlanAsync();

        var trigger = Assert.Single(plan.Triggers);
        Assert.True(trigger.FireAt >= before.AddSeconds(-1));
    }

    [Fact]
    public async Task Manual_on_release_unchanged_and_draft_sites_are_not_planned()
    {
        var (_, manualPage) = await LiveSiteAsync("manual", "manual", debounce: 60);
        await Sql($"UPDATE item SET last_modified_at = now() WHERE id = '{manualPage.Value}'");
        var (_, releasePage) = await LiveSiteAsync("release", "on_release", debounce: 60);
        await Sql($"UPDATE item SET last_modified_at = now() WHERE id = '{releasePage.Value}'");
        await LiveSiteAsync("quiet", "auto", debounce: 60);
        await Sql("UPDATE site_build SET created_at = now() + interval '1 hour' WHERE site_id IN (SELECT id FROM site WHERE slug = 'quiet')");
        var draftRoot = await _scenario.CreateItemAsync("Draft root", Root, "folder");
        var draft = await _scenario.SendAsync<CreateSite, SiteResponse>(
            SiteScenario.Manager, new CreateSite(new CreateSiteRequest(draftRoot.Value, "drafted", "docs", null)));
        Assert.True(draft.IsSuccess);

        var plan = await PlanAsync();

        Assert.Empty(plan.Triggers);
    }

    [Fact]
    public async Task Firing_queues_an_automatic_build_as_the_principal_who_turned_the_mode_on()
    {
        var (siteId, page) = await LiveSiteAsync("fire", "auto", debounce: 60);
        await Sql($"UPDATE item SET last_modified_at = now() WHERE id = '{page.Value}'");
        var trigger = Assert.Single((await PlanAsync()).Triggers);

        var outcome = await FireAsync(trigger);

        Assert.Equal(TriggerFireStatus.Fired, outcome.Status);
        Assert.Equal(
            [$"auto:queued:{TestTenants.AlphaPrincipal:D}"],
            await QueryAsync($"SELECT origin || ':' || status || ':' || publisher_id::text FROM site_build WHERE site_id = '{siteId}' AND status = 'queued'"));
        Assert.Equal(["1"], await QueryAsync($"SELECT count(*)::text FROM worker_job WHERE kind = 'site.build' AND payload ->> 'siteId' = '{siteId}'"));

        // The same trigger firing again (a retry after a crash) is the same build, not a second one.
        var again = await FireAsync(trigger);
        Assert.Equal(TriggerFireStatus.Fired, again.Status);
        Assert.Equal(["1"], await QueryAsync($"SELECT count(*)::text FROM site_build WHERE site_id = '{siteId}' AND status = 'queued'"));
        Assert.Equal(["1"], await QueryAsync($"SELECT count(*)::text FROM worker_job WHERE kind = 'site.build' AND payload ->> 'siteId' = '{siteId}'"));
    }

    [Fact]
    public async Task A_change_during_a_build_is_planned_after_it_and_a_failed_build_backs_off()
    {
        var (siteId, page) = await LiveSiteAsync("in-flight", "auto", debounce: 60);
        await Sql($"UPDATE item SET last_modified_at = now() WHERE id = '{page.Value}'");
        var trigger = Assert.Single((await PlanAsync()).Triggers);
        Assert.EndsWith(":0", trigger.DedupeKey, StringComparison.Ordinal);
        Assert.Equal(TriggerFireStatus.Fired, (await FireAsync(trigger)).Status);

        // An edit while the build is queued is not planned yet: firing now would be refused and lost.
        await Sql($"UPDATE item SET last_modified_at = now() + interval '1 second' WHERE id = '{page.Value}'");
        Assert.Empty((await PlanAsync()).Triggers);

        // The build fails: the site is planned again, under a new key, after a doubled debounce.
        await Sql($"UPDATE worker_job SET status = 'failed' WHERE kind = 'site.build' AND payload ->> 'siteId' = '{siteId}'");
        var retry = Assert.Single((await PlanAsync()).Triggers);
        Assert.EndsWith(":1", retry.DedupeKey, StringComparison.Ordinal);
        var failedAt = DateTimeOffset.Parse(
            (await QueryAsync($"SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') FROM site_build WHERE site_id = '{siteId}' AND origin = 'auto'")).Single(),
            System.Globalization.CultureInfo.InvariantCulture);
        Assert.True(retry.FireAt >= failedAt.AddSeconds(119));
    }

    [Fact]
    public async Task Locking_a_page_counts_as_a_change()
    {
        var (siteId, page) = await LiveSiteAsync("locked", "auto", debounce: 60);
        await Sql($"UPDATE item SET last_modified_at = now() - interval '2 hours' WHERE id IN (SELECT descendant_id FROM item_closure WHERE ancestor_id = (SELECT root_item_id FROM site WHERE id = '{siteId}'))");
        Assert.Empty((await PlanAsync()).Triggers);

        await Sql($"INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at) VALUES ('{page.Value}', '{TestTenants.Alpha}', 'pbkdf2-sha256$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', '{TestTenants.AlphaPrincipal}', now())");

        var trigger = Assert.Single((await PlanAsync()).Triggers);
        Assert.Contains($"site.rebuild:{siteId:N}:", trigger.DedupeKey, StringComparison.Ordinal);
    }

    [Fact]
    public async Task When_the_principal_loses_manager_rights_the_mode_stops_and_the_stop_is_audited()
    {
        var (siteId, page) = await LiveSiteAsync("demoted", "auto", debounce: 60);
        await Sql($"UPDATE item SET last_modified_at = now() WHERE id = '{page.Value}'");
        var trigger = Assert.Single((await PlanAsync()).Triggers);

        // The seeded principal is a tenant administrator, which is what makes them an owner of the
        // workspace; without that grant they are the editor the seed also gives them.
        await Sql($"UPDATE workspace_member SET role = 'editor' WHERE tenant_id = '{TestTenants.Alpha}' AND workspace_id = '{TestTenants.AlphaWorkspace}' AND subject_id = '{TestTenants.AlphaPrincipal}'");

        var outcome = await FireAsync(trigger);

        Assert.Equal(TriggerFireStatus.Skipped, outcome.Status);
        Assert.Equal("manager_lost", outcome.Reason);
        Assert.Equal(["manual:"], await QueryAsync($"SELECT republish_mode || ':' || coalesce(auto_principal_id::text, '') FROM site WHERE id = '{siteId}'"));
        Assert.Equal(["site.auto_republish_stopped"], await QueryAsync($"SELECT action FROM audit_event WHERE subject_id = '{siteId}' AND action = 'site.auto_republish_stopped'"));
        Assert.Equal(["0"], await QueryAsync($"SELECT count(*)::text FROM site_build WHERE site_id = '{siteId}' AND status = 'queued'"));
        Assert.Empty((await PlanAsync()).Triggers);
    }

    [Fact]
    public async Task A_trigger_for_a_site_whose_mode_changed_does_nothing()
    {
        var (siteId, page) = await LiveSiteAsync("changed-mind", "auto", debounce: 60);
        await Sql($"UPDATE item SET last_modified_at = now() WHERE id = '{page.Value}'");
        var trigger = Assert.Single((await PlanAsync()).Triggers);
        var update = await _scenario.SendAsync<UpdateSite, SiteResponse>(
            SiteScenario.Manager, new UpdateSite(siteId, new UpdateSiteRequest(null, null, "manual", null, null, null)));
        Assert.True(update.IsSuccess);

        var outcome = await FireAsync(trigger);

        Assert.Equal("mode_changed", outcome.Reason);
        Assert.Equal(["0"], await QueryAsync($"SELECT count(*)::text FROM site_build WHERE site_id = '{siteId}' AND status = 'queued'"));
    }

    /// <summary>A published site with a live build requested an hour ago, over a root with one child page.</summary>
    private async Task<(Guid SiteId, ItemId Page)> LiveSiteAsync(string slug, string mode, int debounce)
    {
        var root = await _scenario.CreateItemAsync("Root " + slug, Root, "folder");
        var page = await _scenario.CreateItemAsync("Page " + slug, root);
        var created = await _scenario.SendAsync<CreateSite, SiteResponse>(
            SiteScenario.Manager, new CreateSite(new CreateSiteRequest(root.Value, slug, "docs", null)));
        Assert.True(created.IsSuccess, created.IsFailure ? created.Error.Message : string.Empty);
        var siteId = created.Value.Id;
        var updated = await _scenario.SendAsync<UpdateSite, SiteResponse>(
            SiteScenario.Manager, new UpdateSite(siteId, new UpdateSiteRequest(null, null, mode, debounce, null, null)));
        Assert.True(updated.IsSuccess, updated.IsFailure ? updated.Error.Message : string.Empty);
        var build = Guid.NewGuid();
        await Sql($"""
            INSERT INTO site_build
                (tenant_id, id, site_id, status, job_id, publisher_id, origin, idempotency_key, header, page_count,
                 file_count, total_bytes, loss, created_at, activated_at)
            VALUES ('{TestTenants.Alpha}', '{build}', '{siteId}', 'live', gen_random_uuid(), '{TestTenants.AlphaPrincipal}',
                    'manual', 'live-{slug}', jsonb_build_object(), 2, 0, 0, '[]'::jsonb, now() - interval '1 hour', now() - interval '1 hour');
            UPDATE site SET status = 'published', live_build_id = '{build}' WHERE id = '{siteId}';
            """);
        return (siteId, page);
    }

    private async Task<TriggerPlan> PlanAsync()
    {
        await using var scope = _scenario.UnscopedScope();
        var source = scope.ServiceProvider.GetServices<ITriggerSource>().OfType<SiteRebuildTriggerSource>().Single();
        var now = DateTimeOffset.UtcNow;
        return await source.PlanAsync(new PlanWindow(now, now.AddHours(48)), Cancellation);
    }

    private async Task<TriggerOutcome> FireAsync(DesiredTrigger desired)
    {
        var due = new DueTrigger(
            desired.TenantId,
            Guid.NewGuid(),
            desired.WorkspaceId,
            desired.PrincipalId,
            TriggerKind.System,
            SiteRebuildTriggerSource.SourceName,
            desired.SourceItemId,
            desired.RuleId,
            desired.FireAt,
            desired.DedupeKey,
            Attempts: 1);
        var context = new Nix.Abstractions.NixSessionContext(desired.TenantId, desired.WorkspaceId, desired.PrincipalId);
        return await _scenario.RunAsync(context, async unit =>
            await unit.Resolve<IEnumerable<ITriggerSource>>().OfType<SiteRebuildTriggerSource>().Single().FireAsync(due, Cancellation));
    }

    private async Task<List<string>> QueryAsync(string sql)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            return [.. await RawSql.TextListAsync(connection, sql)];
        }
    }

    private async Task<DateTimeOffset> ChangedAtAsync(ItemId page)
    {
        var micros = long.Parse((await QueryAsync($"SELECT (extract(epoch from last_modified_at) * 1000000)::bigint::text FROM item WHERE id = '{page.Value}'")).Single(), System.Globalization.CultureInfo.InvariantCulture);
        return DateTimeOffset.UnixEpoch.AddTicks(micros * 10);
    }

    private async Task Sql(string statement)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, statement);
        }
    }
}
