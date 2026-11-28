using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Sites;
using Nix.Features.Sites;
using Nix.Integration.Tests.Harness;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// [SEC] A captured Mermaid diagram (ADR-0063) is the one non-raster file a site may copy: an SVG
/// of at most <see cref="SiteRules.MaximumDiagramBytes"/>, under the same eligibility rules as an
/// image. The worker re-sanitises its bytes before publishing; Core only bounds what it hands over.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class SiteDiagramFileTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private SiteScenario _scenario = null!;
    private Guid _siteId;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static ItemId Root => ItemId.From(M0SchemaSeed.Alpha.ItemId);

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        _scenario = await SiteScenario.CreateAsync(fixture);
        var created = await _scenario.SendAsync<CreateSite, SiteResponse>(
            SiteScenario.Manager, new CreateSite(new CreateSiteRequest(Root.Value, "diagrams", "docs", null)));
        _siteId = created.Value.Id;
    }

    public async ValueTask DisposeAsync() => await _scenario.DisposeAsync();

    [Fact]
    public async Task A_diagram_within_its_cap_is_eligible_and_a_larger_one_or_another_type_is_not()
    {
        var diagram = await _scenario.CreateFileAsync("diagram.svg", "image/svg+xml", new string('a', 64), byteLength: 4096, parent: Root);
        var oversized = await _scenario.CreateFileAsync("huge.svg", "image/svg+xml", new string('b', 64), byteLength: SiteRules.MaximumDiagramBytes + 1, parent: Root);
        var gif = await _scenario.CreateFileAsync("anim.gif", "image/gif", new string('c', 64), parent: Root);
        var outside = await _scenario.CreateFileAsync("elsewhere.svg", "image/svg+xml", new string('d', 64));

        var found = await _scenario.ReadAsync(SiteScenario.Manager, async unit => new[]
        {
            await FindFileAsync(unit, diagram),
            await FindFileAsync(unit, oversized),
            await FindFileAsync(unit, gif),
            await FindFileAsync(unit, outside),
        });

        Assert.Equal("image/svg+xml", found[0]?.MediaType);
        Assert.Null(found[1]);
        Assert.Null(found[2]);
        Assert.Null(found[3]);
    }

    private async Task<SiteFileCandidate?> FindFileAsync(NixUnitOfWork unit, ItemId file)
    {
        var store = unit.Resolve<ISiteStore>();
        var site = await store.FindAsync(_siteId, Cancellation);
        return await store.FindFileAsync(site!, file, DateTimeOffset.UtcNow, Cancellation);
    }
}
