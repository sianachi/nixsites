using System.Net;
using System.Text.Json;
using Nix.Domain.Items;
using Nix.Integration.Tests.Harness;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Sites through the real pipeline: who may read, who may change and publish, what is written to
/// the audit log, and that a repeated publish is the same build.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class SiteHttpTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private SiteHttpHost _host = null!;
    private SiteScenario _scenario = null!;
    private string _manager = null!;
    private string _editor = null!;
    private string _viewer = null!;
    private string _outsider = null!;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static ItemId Root => ItemId.From(M0SchemaSeed.Alpha.ItemId);

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        _scenario = await SiteScenario.CreateAsync(fixture);
        _host = SiteHttpHost.Create(fixture);
        _manager = await _host.TokenAsync(SiteScenario.Manager);
        _editor = await _host.TokenAsync(SiteScenario.EditorContext);
        _viewer = await _host.TokenAsync(SiteScenario.ViewerContext);
        _outsider = await _host.TokenAsync(SiteScenario.OutsiderContext);
    }

    public async ValueTask DisposeAsync()
    {
        await _host.DisposeAsync();
        await _scenario.DisposeAsync();
    }

    [Fact]
    public async Task A_manager_creates_publishes_and_reads_a_site_and_every_step_is_audited()
    {
        var siteId = await CreateSiteAsync(Root, "docs-demo");

        using (var get = await _host.SendAsync(HttpMethod.Get, $"/api/v1/sites/{siteId}", _manager))
        {
            Assert.Equal(HttpStatusCode.OK, get.StatusCode);
            using var site = await SiteHttpHost.JsonAsync(get);
            Assert.True(site.RootElement.GetProperty("canManage").GetBoolean());
            Assert.Equal("draft", site.RootElement.GetProperty("status").GetString());
            var host = Assert.Single(site.RootElement.GetProperty("hostnames").EnumerateArray());
            Assert.Equal("docs-demo.sites.example.net", host.GetProperty("hostname").GetString());
            Assert.True(host.GetProperty("verified").GetBoolean());
            Assert.Equal("https://docs-demo.sites.example.net/", host.GetProperty("url").GetString());
        }

        using (var byItem = await _host.SendAsync(HttpMethod.Get, $"/api/v1/items/{Root.Value}/site", _manager))
        {
            Assert.Equal(HttpStatusCode.OK, byItem.StatusCode);
        }

        using (var listed = await _host.SendAsync(HttpMethod.Get, $"/api/v1/workspaces/{TestTenants.AlphaWorkspace}/sites", _manager))
        {
            using var list = await SiteHttpHost.JsonAsync(listed);
            Assert.Single(list.RootElement.GetProperty("sites").EnumerateArray());
        }

        using (var refused = await _host.SendAsync(
            HttpMethod.Post, $"/api/v1/sites/{siteId}/publish", _manager, new { idempotencyKey = "first", refreshPaths = false, acknowledgeDisclosure = false }))
        {
            Assert.Equal((HttpStatusCode)422, refused.StatusCode);
            Assert.Equal("sites.disclosure_required", await SiteHttpHost.ProblemCodeAsync(refused));
        }

        Guid firstBuild;
        using (var accepted = await _host.SendAsync(
            HttpMethod.Post, $"/api/v1/sites/{siteId}/publish", _manager, new { idempotencyKey = "first", refreshPaths = false, acknowledgeDisclosure = true }))
        {
            Assert.Equal(HttpStatusCode.Accepted, accepted.StatusCode);
            using var build = await SiteHttpHost.JsonAsync(accepted);
            firstBuild = build.RootElement.GetProperty("id").GetGuid();
            Assert.Equal("queued", build.RootElement.GetProperty("status").GetString());
            Assert.Equal(1, build.RootElement.GetProperty("pageCount").GetInt32());
        }

        using (var repeated = await _host.SendAsync(
            HttpMethod.Post, $"/api/v1/sites/{siteId}/publish", _manager, new { idempotencyKey = "first", refreshPaths = false, acknowledgeDisclosure = true }))
        {
            Assert.Equal(HttpStatusCode.Accepted, repeated.StatusCode);
            using var again = await SiteHttpHost.JsonAsync(repeated);
            Assert.Equal(firstBuild, again.RootElement.GetProperty("id").GetGuid());
        }

        using (var another = await _host.SendAsync(
            HttpMethod.Post, $"/api/v1/sites/{siteId}/publish", _manager, new { idempotencyKey = "second", refreshPaths = false, acknowledgeDisclosure = true }))
        {
            Assert.Equal(HttpStatusCode.Conflict, another.StatusCode);
            Assert.Equal("sites.build_in_progress", await SiteHttpHost.ProblemCodeAsync(another));
        }

        Assert.Equal(["1"], await QueryAsync($"SELECT count(*)::text FROM site_build WHERE site_id = '{siteId}'"));
        Assert.Equal(["1"], await QueryAsync($"SELECT count(*)::text FROM worker_job WHERE kind = 'site.build' AND payload ->> 'siteId' = '{siteId}'"));
        Assert.Equal(
            ["site.created", "site.published"],
            await QueryAsync($"SELECT action FROM audit_event WHERE subject_type = 'site' AND subject_id = '{siteId}' ORDER BY occurred_at, action DESC"));
        var envelopes = await QueryAsync($"SELECT coalesce(before::text, '') || coalesce(after::text, '') FROM audit_event WHERE subject_type = 'site' AND subject_id = '{siteId}'");
        Assert.All(envelopes, envelope => Assert.DoesNotContain("title", envelope, StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task An_editor_and_a_viewer_can_read_a_site_but_not_change_or_publish_it()
    {
        var siteId = await CreateSiteAsync(Root, "readers");

        foreach (var token in new[] { _editor, _viewer })
        {
            using (var read = await _host.SendAsync(HttpMethod.Get, $"/api/v1/sites/{siteId}", token))
            {
                Assert.Equal(HttpStatusCode.OK, read.StatusCode);
                using var site = await SiteHttpHost.JsonAsync(read);
                Assert.False(site.RootElement.GetProperty("canManage").GetBoolean());
            }

            foreach (var (method, path, body) in Mutations(siteId))
            {
                using var response = await _host.SendAsync(method, path, token, body);
                Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
                Assert.Equal("sites.manager_required", await SiteHttpHost.ProblemCodeAsync(response));
            }
        }

        Assert.Equal(["0"], await QueryAsync($"SELECT count(*)::text FROM site_build WHERE site_id = '{siteId}'"));
    }

    [Fact]
    public async Task A_token_without_the_admin_scope_can_read_a_site_but_not_change_or_publish_it_even_for_a_manager()
    {
        var siteId = await CreateSiteAsync(Root, "scoped-token");
        var ordinary = await _host.TokenAsync(SiteScenario.Manager, admin: false);

        using (var read = await _host.SendAsync(HttpMethod.Get, $"/api/v1/sites/{siteId}", ordinary))
        {
            Assert.Equal(HttpStatusCode.OK, read.StatusCode);
        }

        foreach (var (method, path, body) in Mutations(siteId))
        {
            using var response = await _host.SendAsync(method, path, ordinary, body);
            Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
            Assert.Equal("auth.insufficient_scope", await SiteHttpHost.ProblemCodeAsync(response));
        }

        using var create = await _host.SendAsync(
            HttpMethod.Post, "/api/v1/sites", ordinary, new { rootItemId = Root.Value, slug = "no-admin", layout = "docs" });
        Assert.Equal(HttpStatusCode.Forbidden, create.StatusCode);
        Assert.Equal(["0"], await QueryAsync($"SELECT count(*)::text FROM site_build WHERE site_id = '{siteId}'"));
    }

    [Fact]
    public async Task A_non_member_learns_nothing_about_a_site_and_cannot_make_one()
    {
        var siteId = await CreateSiteAsync(Root, "private-site");

        using (var read = await _host.SendAsync(HttpMethod.Get, $"/api/v1/sites/{siteId}", _outsider))
        {
            Assert.Equal(HttpStatusCode.NotFound, read.StatusCode);
            Assert.Equal("sites.not_found", await SiteHttpHost.ProblemCodeAsync(read));
        }

        using (var byItem = await _host.SendAsync(HttpMethod.Get, $"/api/v1/items/{Root.Value}/site", _outsider))
        {
            Assert.Equal(HttpStatusCode.NotFound, byItem.StatusCode);
        }

        using (var listed = await _host.SendAsync(HttpMethod.Get, $"/api/v1/workspaces/{TestTenants.AlphaWorkspace}/sites", _outsider))
        {
            Assert.Equal(HttpStatusCode.NotFound, listed.StatusCode);
        }

        foreach (var (method, path, body) in Mutations(siteId))
        {
            using var response = await _host.SendAsync(method, path, _outsider, body);
            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        }

        using var create = await _host.SendAsync(
            HttpMethod.Post, "/api/v1/sites", _outsider, new { rootItemId = Root.Value, slug = "outsider-site", layout = "docs" });
        Assert.Equal(HttpStatusCode.NotFound, create.StatusCode);
    }

    [Fact]
    public async Task Slugs_and_roots_are_unique_across_every_tenant_and_a_pending_hostname_blocks_no_one()
    {
        await M0SchemaSeed.SeedSitesAsync(fixture);
        var siteId = await CreateSiteAsync(await _scenario.CreateItemAsync("First root", Root, "folder"), "first-site");

        using (var slug = await _host.SendAsync(
            HttpMethod.Post, "/api/v1/sites", _manager, new { rootItemId = Root.Value, slug = "seed-beta", layout = "docs" }))
        {
            Assert.Equal(HttpStatusCode.Conflict, slug.StatusCode);
            Assert.NotNull(await SiteHttpHost.ProblemCodeAsync(slug));
        }

        var second = await _scenario.CreateItemAsync("Second root", Root, "folder");
        using (var twice = await _host.SendAsync(
            HttpMethod.Post, "/api/v1/sites", _manager, new { rootItemId = Root.Value, slug = "other-slug", layout = "docs" }))
        {
            Assert.Equal(HttpStatusCode.Conflict, twice.StatusCode);
            Assert.Equal("sites.exists", await SiteHttpHost.ProblemCodeAsync(twice));
        }

        using (var taken = await _host.SendAsync(
            HttpMethod.Post, "/api/v1/sites", _manager, new { rootItemId = second.Value, slug = "first-site", layout = "docs" }))
        {
            Assert.Equal(HttpStatusCode.Conflict, taken.StatusCode);
            Assert.Equal("sites.slug_taken", await SiteHttpHost.ProblemCodeAsync(taken));
        }

        var secondSite = await CreateSiteAsync(second, "second-site");
        using (var mine = await _host.SendAsync(
            HttpMethod.Put, $"/api/v1/sites/{siteId}/hostnames", _manager, HostsBody("docs.example.org")))
        {
            Assert.Equal(HttpStatusCode.OK, mine.StatusCode);
            using var site = await SiteHttpHost.JsonAsync(mine);
            var custom = site.RootElement.GetProperty("hostnames").EnumerateArray().Single(host => host.GetProperty("kind").GetString() == "custom");
            Assert.False(custom.GetProperty("verified").GetBoolean());
        }

        // An unverified claim squats nothing: another site may claim the name too, and only a
        // verified hostname is unique (SiteHardeningTests proves the index).
        using (var pending = await _host.SendAsync(
            HttpMethod.Put, $"/api/v1/sites/{secondSite}/hostnames", _manager, HostsBody("docs.example.org")))
        {
            Assert.Equal(HttpStatusCode.OK, pending.StatusCode);
        }

        foreach (var bad in new[] { "nodots", "x.sites.example.net", "sites.example.net", "a b.example.org" })
        {
            using var refused = await _host.SendAsync(
                HttpMethod.Put, $"/api/v1/sites/{secondSite}/hostnames", _manager, HostsBody(bad));
            Assert.Equal((HttpStatusCode)422, refused.StatusCode);
        }

        Assert.Equal(
            ["site.hostname_changed"],
            await QueryAsync($"SELECT action FROM audit_event WHERE subject_id = '{siteId}' AND action = 'site.hostname_changed'"));
    }

    [Fact]
    public async Task A_page_path_can_be_pinned_and_its_old_path_becomes_a_redirect()
    {
        var guide = await _scenario.CreateItemAsync("Guide", Root);
        var other = await _scenario.CreateItemAsync("Other", Root);
        var siteId = await CreateSiteAsync(Root, "paths");
        using (var published = await _host.SendAsync(
            HttpMethod.Post, $"/api/v1/sites/{siteId}/publish", _manager, new { idempotencyKey = "paths", refreshPaths = false, acknowledgeDisclosure = true }))
        {
            Assert.Equal(HttpStatusCode.Accepted, published.StatusCode);
        }

        using (var changed = await _host.SendAsync(
            HttpMethod.Put, $"/api/v1/sites/{siteId}/pages/{guide.Value}/path", _manager, new { path = "/blog/guide/" }))
        {
            Assert.Equal(HttpStatusCode.OK, changed.StatusCode);
            using var page = await SiteHttpHost.JsonAsync(changed);
            Assert.True(page.RootElement.GetProperty("pinned").GetBoolean());
            Assert.Equal("/blog/guide/", page.RootElement.GetProperty("path").GetString());
        }

        Assert.Equal(
            [$"/guide/:{guide.Value}"],
            await QueryAsync($"SELECT from_path || ':' || item_id::text FROM site_redirect WHERE site_id = '{siteId}'"));

        using (var taken = await _host.SendAsync(
            HttpMethod.Put, $"/api/v1/sites/{siteId}/pages/{other.Value}/path", _manager, new { path = "/blog/guide/" }))
        {
            Assert.Equal(HttpStatusCode.Conflict, taken.StatusCode);
            Assert.Equal("sites.path_taken", await SiteHttpHost.ProblemCodeAsync(taken));
        }

        using (var root = await _host.SendAsync(
            HttpMethod.Put, $"/api/v1/sites/{siteId}/pages/{Root.Value}/path", _manager, new { path = "/home/" }))
        {
            Assert.Equal((HttpStatusCode)422, root.StatusCode);
            Assert.Equal("sites.root_path_fixed", await SiteHttpHost.ProblemCodeAsync(root));
        }

        using (var invalid = await _host.SendAsync(
            HttpMethod.Put, $"/api/v1/sites/{siteId}/pages/{guide.Value}/path", _manager, new { path = "Not A Path" }))
        {
            Assert.Equal((HttpStatusCode)422, invalid.StatusCode);
        }

        using var listed = await _host.SendAsync(HttpMethod.Get, $"/api/v1/sites/{siteId}/pages", _manager);
        using var pages = await SiteHttpHost.JsonAsync(listed);
        Assert.Equal(
            ["/", "/blog/guide/", "/other/"],
            pages.RootElement.GetProperty("pages").EnumerateArray().Select(page => page.GetProperty("path").GetString()!).ToArray());
    }

    [Fact]
    public async Task A_site_can_be_updated_only_inside_its_own_subtree_and_a_live_or_building_site_cannot_be_deleted()
    {
        var outside = await _scenario.CreateItemAsync("Outside", Root);
        var second = await _scenario.CreateItemAsync("Second root", Root, "folder");
        var siteId = await CreateSiteAsync(second, "scoped");

        using (var excluded = await _host.SendAsync(
            HttpMethod.Patch, $"/api/v1/sites/{siteId}", _manager, new { excludedItemIds = new[] { outside.Value } }))
        {
            Assert.Equal((HttpStatusCode)422, excluded.StatusCode);
            Assert.Equal("sites.item_outside_site", await SiteHttpHost.ProblemCodeAsync(excluded));
        }

        using (var mode = await _host.SendAsync(
            HttpMethod.Patch, $"/api/v1/sites/{siteId}", _manager, new { republishMode = "auto", debounceSeconds = 120 }))
        {
            Assert.Equal(HttpStatusCode.OK, mode.StatusCode);
            using var site = await SiteHttpHost.JsonAsync(mode);
            Assert.Equal("auto", site.RootElement.GetProperty("republishMode").GetString());
        }

        Assert.Equal([TestTenants.AlphaPrincipal.ToString("D")], await QueryAsync($"SELECT auto_principal_id::text FROM site WHERE id = '{siteId}'"));

        using (var tooShort = await _host.SendAsync(
            HttpMethod.Patch, $"/api/v1/sites/{siteId}", _manager, new { debounceSeconds = 5 }))
        {
            Assert.Equal((HttpStatusCode)422, tooShort.StatusCode);
        }

        using (var published = await _host.SendAsync(
            HttpMethod.Post, $"/api/v1/sites/{siteId}/publish", _manager, new { idempotencyKey = "delete", refreshPaths = false, acknowledgeDisclosure = true }))
        {
            Assert.Equal(HttpStatusCode.Accepted, published.StatusCode);
        }

        using (var building = await _host.SendAsync(HttpMethod.Delete, $"/api/v1/sites/{siteId}", _manager))
        {
            Assert.Equal(HttpStatusCode.Conflict, building.StatusCode);
            Assert.Equal("sites.build_in_progress", await SiteHttpHost.ProblemCodeAsync(building));
        }

        var draft = await CreateSiteAsync(await _scenario.CreateItemAsync("Draft root", Root, "folder"), "draft-site");
        using (var deleted = await _host.SendAsync(HttpMethod.Delete, $"/api/v1/sites/{draft}", _manager))
        {
            Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);
        }

        Assert.Equal(["site.deleted"], await QueryAsync($"SELECT action FROM audit_event WHERE subject_id = '{draft}' AND action = 'site.deleted'"));
        Assert.Equal(["0"], await QueryAsync($"SELECT count(*)::text FROM site WHERE id = '{draft}'"));
    }

    [Fact]
    public async Task The_custom_layout_needs_a_theme_page_under_the_site_root()
    {
        var outside = await _scenario.CreateItemAsync("Outside theme", Root);
        var second = await _scenario.CreateItemAsync("Themed root", Root, "folder");
        var theme = await _scenario.CreateItemAsync("Theme", second);
        var siteId = await CreateSiteAsync(second, "themed");

        static object Settings(Guid? themeItemId) => new
        {
            name = "Themed",
            description = string.Empty,
            accent = "#2f5fd0",
            navigation = Array.Empty<object>(),
            footerText = string.Empty,
            builtWithNix = true,
            language = "en",
            themeItemId,
        };

        using (var missing = await _host.SendAsync(
            HttpMethod.Patch, $"/api/v1/sites/{siteId}", _manager, new { layout = "custom" }))
        {
            Assert.Equal((HttpStatusCode)422, missing.StatusCode);
        }

        using (var elsewhere = await _host.SendAsync(
            HttpMethod.Patch, $"/api/v1/sites/{siteId}", _manager, new { layout = "custom", settings = Settings(outside.Value) }))
        {
            Assert.Equal((HttpStatusCode)422, elsewhere.StatusCode);
            Assert.Equal("sites.item_outside_site", await SiteHttpHost.ProblemCodeAsync(elsewhere));
        }

        // The theme page is never published, so the home page cannot be it.
        using (var root = await _host.SendAsync(
            HttpMethod.Patch, $"/api/v1/sites/{siteId}", _manager, new { layout = "custom", settings = Settings(second.Value) }))
        {
            Assert.Equal((HttpStatusCode)422, root.StatusCode);
            Assert.Equal("sites.item_outside_site", await SiteHttpHost.ProblemCodeAsync(root));
        }

        using (var chosen = await _host.SendAsync(
            HttpMethod.Patch, $"/api/v1/sites/{siteId}", _manager, new { layout = "custom", settings = Settings(theme.Value) }))
        {
            Assert.Equal(HttpStatusCode.OK, chosen.StatusCode);
            using var site = await SiteHttpHost.JsonAsync(chosen);
            Assert.Equal("custom", site.RootElement.GetProperty("layout").GetString());
            Assert.Equal(theme.Value, site.RootElement.GetProperty("settings").GetProperty("themeItemId").GetGuid());
        }

        // Dropping the theme while the layout stays custom is refused the same way.
        using (var dropped = await _host.SendAsync(
            HttpMethod.Patch, $"/api/v1/sites/{siteId}", _manager, new { settings = Settings(null) }))
        {
            Assert.Equal((HttpStatusCode)422, dropped.StatusCode);
        }
    }

    private static object HostsBody(string hostname) => new { hostnames = new List<string> { hostname } };

    private static IEnumerable<(HttpMethod Method, string Path, object? Body)> Mutations(Guid siteId)
    {
        yield return (HttpMethod.Patch, $"/api/v1/sites/{siteId}", new { republishMode = "manual" });
        yield return (HttpMethod.Delete, $"/api/v1/sites/{siteId}", null);
        yield return (HttpMethod.Put, $"/api/v1/sites/{siteId}/hostnames", HostsBody("docs.example.org"));
        yield return (HttpMethod.Post, $"/api/v1/sites/{siteId}/publish", new { idempotencyKey = "x", refreshPaths = false, acknowledgeDisclosure = true });
        yield return (HttpMethod.Post, $"/api/v1/sites/{siteId}/rollback", new { buildId = Guid.NewGuid() });
        yield return (HttpMethod.Post, $"/api/v1/sites/{siteId}/unpublish", null);
        yield return (HttpMethod.Put, $"/api/v1/sites/{siteId}/pages/{M0SchemaSeed.Alpha.ItemId}/path", new { path = "/x/" });
    }

    private async Task<Guid> CreateSiteAsync(ItemId root, string slug)
    {
        using var created = await _host.SendAsync(
            HttpMethod.Post, "/api/v1/sites", _manager, new { rootItemId = root.Value, slug, layout = "docs" });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        using var site = await SiteHttpHost.JsonAsync(created);
        return site.RootElement.GetProperty("id").GetGuid();
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
