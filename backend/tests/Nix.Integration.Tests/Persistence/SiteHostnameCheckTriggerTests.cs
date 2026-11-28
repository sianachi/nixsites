using Nix.Abstractions.Scheduling;
using Nix.Domain.Items;
using Nix.Domain.Scheduling;
using Nix.Features.Sites;
using Nix.Integration.Tests.Harness;

namespace Nix.Integration.Tests.Persistence;

/// <summary>The background hostname checker: a claim never verified within a week is withdrawn, as the system.</summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class SiteHostnameCheckTriggerTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private SiteScenario _scenario = null!;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        _scenario = await SiteScenario.CreateAsync(fixture);
    }

    public async ValueTask DisposeAsync() => await _scenario.DisposeAsync();

    [Fact]
    public async Task An_abandoned_claim_is_withdrawn_with_a_system_audit_and_its_primary_cleared()
    {
        var created = await _scenario.SendAsync<CreateSite, SiteResponse>(
            SiteScenario.Manager, new CreateSite(new CreateSiteRequest(M0SchemaSeed.Alpha.ItemId, "abandoned", "docs", null)));
        Assert.True(created.IsSuccess, created.IsFailure ? created.Error.Message : string.Empty);
        var siteId = created.Value.Id;
        var added = await _scenario.SendAsync<AddSiteHostname, SiteResponse>(SiteScenario.Manager, new AddSiteHostname(siteId, "old.example.org", null));
        Assert.True(added.IsSuccess, added.IsFailure ? added.Error.Message : string.Empty);
        var primary = await _scenario.SendAsync<UpdateSiteHostname, SiteResponse>(SiteScenario.Manager, new UpdateSiteHostname(siteId, "old.example.org", null, true));
        Assert.True(primary.IsSuccess);
        await Sql("UPDATE site_hostname SET created_at = now() - interval '8 days', checked_at = now() - interval '1 hour' WHERE hostname = 'old.example.org'");

        var plan = await PlanAsync();
        var trigger = Assert.Single(plan.Triggers);
        var outcome = await FireAsync(trigger);

        Assert.Equal(TriggerFireStatus.Fired, outcome.Status);
        Assert.Equal("hostname_expired", outcome.Reason);
        Assert.Equal(["0"], await QueryAsync("SELECT count(*)::text FROM site_hostname WHERE hostname = 'old.example.org'"));
        Assert.Equal([string.Empty], await QueryAsync($"SELECT coalesce(primary_hostname, '') FROM site WHERE id = '{siteId}'"));
        Assert.Equal(
            [SiteAudit.SystemActor.Value.ToString()],
            await QueryAsync($"SELECT actor_id::text FROM audit_event WHERE subject_id = '{siteId}' AND action = 'site.hostname_expired'"));
    }

    private async Task<TriggerPlan> PlanAsync()
    {
        await using var scope = _scenario.UnscopedScope();
        var source = Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions
            .GetServices<ITriggerSource>(scope.ServiceProvider).OfType<SiteHostnameCheckTriggerSource>().Single();
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
            SiteHostnameCheckTriggerSource.SourceName,
            desired.SourceItemId,
            desired.RuleId,
            desired.FireAt,
            desired.DedupeKey,
            Attempts: 1);
        var context = new Nix.Abstractions.NixSessionContext(desired.TenantId, desired.WorkspaceId, desired.PrincipalId);
        return await _scenario.RunAsync(context, async unit =>
            await unit.Resolve<IEnumerable<ITriggerSource>>().OfType<SiteHostnameCheckTriggerSource>().Single().FireAsync(due, Cancellation));
    }

    private async Task Sql(string statement)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, statement);
        }
    }

    private async Task<List<string>> QueryAsync(string sql)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            return [.. await RawSql.TextListAsync(connection, sql)];
        }
    }
}
