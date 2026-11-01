using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Integration.Tests.Harness;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Custom hostnames and first-publish approval through the real pipeline (ADR-0063 M5): DNS is a
/// fake Core queries itself, Cloudflare is an in-memory API, everything else is the application.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class SiteHostingHttpTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private readonly FakeDns _dns = new();
    private readonly FakeCloudflare _cloudflare = new();
    private SiteScenario _scenario = null!;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static ItemId Root => ItemId.From(M0SchemaSeed.Alpha.ItemId);

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        _scenario = await SiteScenario.CreateAsync(fixture);
        _dns.Cloudflare = _cloudflare;
    }

    public async ValueTask DisposeAsync() => await _scenario.DisposeAsync();

    [Fact]
    public async Task A_custom_hostname_verifies_from_dns_the_first_verifier_keeps_it_and_three_misses_unverify_it()
    {
        await using var host = Host();
        var manager = await host.TokenAsync(SiteScenario.Manager);
        var first = await CreateSiteAsync(host, manager, Root, "first-site");
        var second = await CreateSiteAsync(host, manager, await _scenario.CreateItemAsync("Second", Root, "folder"), "second-site");

        var firstToken = await AddAsync(host, manager, first, "docs.example.org", "checking");
        var secondToken = await AddAsync(host, manager, second, "docs.example.org", "checking");
        Assert.NotEqual(firstToken, secondToken);

        _dns["_nix-site.docs.example.org/TXT"] = ["nix-site-verification=" + firstToken, "nix-site-verification=" + secondToken];
        _dns["docs.example.org/A"] = ["192.0.2.10"];
        Assert.True((await VerifyAsync(host, manager, first, "docs.example.org")).GetProperty("verified").GetBoolean());

        // Squatting: the second claim proves its record too, but the name is served by one site only.
        var squatter = await VerifyAsync(host, manager, second, "docs.example.org");
        Assert.False(squatter.GetProperty("verified").GetBoolean());
        Assert.Equal("hostname_taken", squatter.GetProperty("checkError").GetString());

        _dns.Remove("_nix-site.docs.example.org/TXT");
        Assert.Equal("failing", (await VerifyAsync(host, manager, first, "docs.example.org")).GetProperty("status").GetString());
        await VerifyAsync(host, manager, first, "docs.example.org");
        var dropped = await VerifyAsync(host, manager, first, "docs.example.org");
        Assert.False(dropped.GetProperty("verified").GetBoolean());
        Assert.Equal("txt_missing", dropped.GetProperty("checkError").GetString());
        Assert.Equal(
            ["site.hostname_verified", "site.hostname_unverified"],
            await QueryAsync($"SELECT action FROM audit_event WHERE subject_id = '{first}' AND action LIKE 'site.hostname_%verified' ORDER BY occurred_at"));
    }

    [Fact]
    public async Task On_a_live_site_verifying_writes_host_manifests_with_the_primary_canonical_and_a_redirect_alias()
    {
        await using var host = Host();
        var manager = await host.TokenAsync(SiteScenario.Manager);
        var siteId = await CreateSiteAsync(host, manager, Root, "portfolio");
        var token = await AddAsync(host, manager, siteId, "www.example.org", "checking");
        using (var primary = await host.SendAsync(
            HttpMethod.Patch, $"/api/v1/sites/{siteId}/hostnames/www.example.org", manager, new { primary = true }))
        {
            Assert.Equal(HttpStatusCode.OK, primary.StatusCode);
        }

        using (var alias = await host.SendAsync(
            HttpMethod.Patch, $"/api/v1/sites/{siteId}/hostnames/portfolio.sites.example.net", manager, new { serveMode = "redirect" }))
        {
            Assert.Equal(HttpStatusCode.OK, alias.StatusCode);
        }

        await MakeLiveAsync(siteId);
        _dns["_nix-site.www.example.org/TXT"] = ["nix-site-verification=" + token];
        _dns["www.example.org/A"] = ["192.0.2.10"];
        Assert.True((await VerifyAsync(host, manager, siteId, "www.example.org")).GetProperty("verified").GetBoolean());

        var ops = JsonNode.Parse((await QueryAsync($"SELECT ops::text FROM site_activation WHERE site_id = '{siteId}' AND reason = 'hostnames'")).Single())!.AsArray();
        var bodies = ops.ToDictionary(op => op!["hostname"]!.GetValue<string>(), op => JsonNode.Parse(op!["body"]!.GetValue<string>())!);
        Assert.Equal(["portfolio.sites.example.net", "www.example.org"], bodies.Keys.Order().ToArray());
        Assert.All(bodies.Values, body => Assert.Equal("www.example.org", body["canonicalHost"]!.GetValue<string>()));
        Assert.Equal("https://www.example.org", bodies["portfolio.sites.example.net"]["redirectTo"]!.GetValue<string>());
        Assert.Null(bodies["www.example.org"]["redirectTo"]);

        // That activation is still in flight, so a further change of what is served must wait.
        using var busy = await host.SendAsync(
            HttpMethod.Patch, $"/api/v1/sites/{siteId}/hostnames/portfolio.sites.example.net", manager, new { serveMode = "serve" });
        Assert.Equal(HttpStatusCode.Conflict, busy.StatusCode);
    }

    [Fact]
    public async Task In_a_zone_the_operator_hands_to_the_workspace_nix_creates_verifies_and_removes_only_its_own_records()
    {
        await using var host = Host(new Dictionary<string, string?>
        {
            ["Nix:Sites:Cloudflare:ApiToken"] = "test-token",
            ["Nix:Sites:Cloudflare:AccountId"] = "account",
            ["Nix:Sites:Cloudflare:DefaultTarget"] = "edge.example.net",
            ["Nix:Sites:Cloudflare:ManagedZones:0:Zone"] = "example.com",
            ["Nix:Sites:Cloudflare:ManagedZones:0:WorkspaceId"] = TestTenants.AlphaWorkspace.ToString(),
        });
        var manager = await host.TokenAsync(SiteScenario.Manager);
        var siteId = await CreateSiteAsync(host, manager, Root, "managed");

        using (var added = await host.SendAsync(HttpMethod.Post, $"/api/v1/sites/{siteId}/hostnames", manager, new { hostname = "blog.example.com" }))
        {
            Assert.Equal(HttpStatusCode.OK, added.StatusCode);
            using var site = await SiteHttpHost.JsonAsync(added);
            var custom = site.RootElement.GetProperty("hostnames").EnumerateArray().Single(row => row.GetProperty("kind").GetString() == "custom");
            Assert.True(custom.GetProperty("managed").GetBoolean());
            Assert.True(custom.GetProperty("verified").GetBoolean());
        }

        Assert.Equal(["CNAME", "TXT"], _cloudflare.Records.Values.Select(record => record.Type).Order().ToArray());
        Assert.All(_cloudflare.Records.Values, record => Assert.Equal($"managed-by nix site {siteId:D}", record.Comment));

        using (var removed = await host.SendAsync(HttpMethod.Delete, $"/api/v1/sites/{siteId}/hostnames/blog.example.com", manager))
        {
            Assert.Equal(HttpStatusCode.OK, removed.StatusCode);
        }

        Assert.Empty(_cloudflare.Records);
    }

    [Fact]
    public async Task On_a_suffixed_instance_the_default_hostname_record_is_written_on_create_repaired_on_publish_and_removed_on_delete()
    {
        await using var host = Host(new Dictionary<string, string?>
        {
            ["Nix:Sites:DefaultHostLabelSuffix"] = "-home",
            ["Nix:Sites:Cloudflare:ApiToken"] = "test-token",
            ["Nix:Sites:Cloudflare:AccountId"] = "account",
            ["Nix:Sites:Cloudflare:DefaultTarget"] = "edge.example.net",
            ["Nix:Sites:Cloudflare:DefaultHostnameZoneId"] = "0123456789abcdef0123456789abcdef",
        });
        var manager = await host.TokenAsync(SiteScenario.Manager);
        var siteId = await CreateSiteAsync(host, manager, Root, "notes");

        var record = Assert.Single(_cloudflare.Records.Values);
        Assert.Equal(("CNAME", "notes-home.sites.example.net", "edge.example.net"), (record.Type, record.Name, record.Content));
        Assert.Equal($"managed-by nix site {siteId:D}", record.Comment);
        Assert.Equal(
            ["notes-home.sites.example.net"],
            await QueryAsync($"SELECT hostname FROM site_hostname WHERE site_id = '{siteId}' AND kind = 'default' AND managed_records IS NOT NULL"));

        _cloudflare.Records.Clear();
        using (var published = await host.SendAsync(
            HttpMethod.Post, $"/api/v1/sites/{siteId}/publish", manager, new { idempotencyKey = "first", refreshPaths = false, acknowledgeDisclosure = true }))
        {
            Assert.Equal(HttpStatusCode.Accepted, published.StatusCode);
        }

        Assert.Equal("notes-home.sites.example.net", Assert.Single(_cloudflare.Records.Values).Name);

        var other = await CreateSiteAsync(host, manager, await _scenario.CreateItemAsync("Other", Root, "folder"), "other");
        Assert.Equal(2, _cloudflare.Records.Count);
        using (var deleted = await host.SendAsync(HttpMethod.Delete, $"/api/v1/sites/{other}", manager))
        {
            Assert.True(deleted.IsSuccessStatusCode);
        }

        Assert.Equal("notes-home.sites.example.net", Assert.Single(_cloudflare.Records.Values).Name);
    }

    [Fact]
    public async Task A_first_publish_waits_for_an_operator_and_the_approval_publishes_as_the_manager_who_asked()
    {
        await using var host = Host(new Dictionary<string, string?>
        {
            ["Nix:Sites:RequireOperatorApproval"] = "true",
            ["Nix:Sites:Operators:0"] = SiteScenario.Viewer.ToString(),
        });
        var manager = await host.TokenAsync(SiteScenario.Manager);
        var operatorToken = await host.TokenAsync(SiteScenario.ViewerContext);
        var editor = await host.TokenAsync(SiteScenario.EditorContext);
        var siteId = await CreateSiteAsync(host, manager, Root, "approved");
        object publish = new { idempotencyKey = "first", refreshPaths = false, acknowledgeDisclosure = true };

        using (var refused = await host.SendAsync(HttpMethod.Post, $"/api/v1/sites/{siteId}/publish", manager, publish))
        {
            Assert.Equal("sites.approval_required", await SiteHttpHost.ProblemCodeAsync(refused));
        }

        await RequestAsync(host, manager, siteId);
        using (var waiting = await host.SendAsync(HttpMethod.Post, $"/api/v1/sites/{siteId}/publish", manager, publish))
        {
            Assert.Equal("sites.approval_pending", await SiteHttpHost.ProblemCodeAsync(waiting));
        }

        using (var notOperator = await host.SendAsync(HttpMethod.Get, "/api/v1/sites/approvals", editor))
        {
            Assert.Equal(HttpStatusCode.Forbidden, notOperator.StatusCode);
        }

        using (var listed = await host.SendAsync(HttpMethod.Get, "/api/v1/sites/approvals", operatorToken))
        {
            using var list = await SiteHttpHost.JsonAsync(listed);
            Assert.Equal(siteId, Assert.Single(list.RootElement.GetProperty("approvals").EnumerateArray()).GetProperty("siteId").GetGuid());
        }

        using (var rejected = await host.SendAsync(HttpMethod.Post, $"/api/v1/sites/{siteId}/approval/reject", operatorToken, new { note = "Add an about page first." }))
        {
            Assert.Equal(HttpStatusCode.OK, rejected.StatusCode);
        }

        await RequestAsync(host, manager, siteId);
        using (var approved = await host.SendAsync(HttpMethod.Post, $"/api/v1/sites/{siteId}/approval/approve", operatorToken))
        {
            Assert.Equal(HttpStatusCode.Accepted, approved.StatusCode);
            using var body = await SiteHttpHost.JsonAsync(approved);
            Assert.Equal("approved", body.RootElement.GetProperty("approval").GetProperty("state").GetString());
            Assert.Equal("queued", body.RootElement.GetProperty("build").GetProperty("status").GetString());
        }

        Assert.Equal([TestTenants.AlphaPrincipal.ToString()], await QueryAsync($"SELECT publisher_id::text FROM site_build WHERE site_id = '{siteId}'"));
        Assert.Equal(
            ["site.publish_approval_requested", "site.publish_rejected", "site.publish_approval_requested", "site.publish_approved", "site.published"],
            await QueryAsync($"SELECT action FROM audit_event WHERE subject_id = '{siteId}' AND action LIKE 'site.publish%' ORDER BY occurred_at, action"));
        Assert.Equal([SiteScenario.Viewer.ToString()], await QueryAsync($"SELECT actor_id::text FROM audit_event WHERE subject_id = '{siteId}' AND action = 'site.publish_approved'"));
    }

    [Fact]
    public async Task An_approval_does_not_publish_once_the_manager_who_asked_lost_the_right()
    {
        await using var host = Host(new Dictionary<string, string?>
        {
            ["Nix:Sites:RequireOperatorApproval"] = "true",
            ["Nix:Sites:Operators:0"] = SiteScenario.Viewer.ToString(),
        });
        var manager = await host.TokenAsync(SiteScenario.Manager);
        var operatorToken = await host.TokenAsync(SiteScenario.ViewerContext);
        var siteId = await CreateSiteAsync(host, manager, Root, "demoted");
        await RequestAsync(host, manager, siteId);
        await Sql($"UPDATE workspace_member SET role = 'editor' WHERE tenant_id = '{TestTenants.Alpha}' AND workspace_id = '{TestTenants.AlphaWorkspace}' AND subject_id = '{TestTenants.AlphaPrincipal}'");

        using var approved = await host.SendAsync(HttpMethod.Post, $"/api/v1/sites/{siteId}/approval/approve", operatorToken);

        Assert.Equal(HttpStatusCode.Conflict, approved.StatusCode);
        Assert.Equal(["0"], await QueryAsync($"SELECT count(*)::text FROM site_build WHERE site_id = '{siteId}'"));
        Assert.Equal(["pending"], await QueryAsync($"SELECT approval_state FROM site WHERE id = '{siteId}'"));
    }

    [Fact]
    public async Task A_manager_cannot_check_one_hostname_again_within_a_minute()
    {
        await using var host = Host();
        var manager = await host.TokenAsync(SiteScenario.Manager);
        var siteId = await CreateSiteAsync(host, manager, Root, "cooldown");
        await AddAsync(host, manager, siteId, "docs.example.org", "checking");
        await VerifyAsync(host, manager, siteId, "docs.example.org");

        using var again = await host.SendAsync(HttpMethod.Post, $"/api/v1/sites/{siteId}/hostnames/docs.example.org/verify", manager);

        Assert.Equal(HttpStatusCode.TooManyRequests, again.StatusCode);
        Assert.Equal("sites.check_too_soon", await SiteHttpHost.ProblemCodeAsync(again));
    }

    [Fact]
    public async Task A_primary_hostname_must_be_the_sites_own_and_is_cleared_when_it_goes()
    {
        await using var host = Host();
        var manager = await host.TokenAsync(SiteScenario.Manager);
        var siteId = await CreateSiteAsync(host, manager, Root, "primary");
        await AddAsync(host, manager, siteId, "www.example.org", "checking");
        using (var primary = await host.SendAsync(HttpMethod.Patch, $"/api/v1/sites/{siteId}/hostnames/www.example.org", manager, new { primary = true }))
        {
            Assert.Equal(HttpStatusCode.OK, primary.StatusCode);
        }

        await Assert.ThrowsAnyAsync<Npgsql.PostgresException>(() => Sql($"UPDATE site SET primary_hostname = 'elsewhere.example.org' WHERE id = '{siteId}'"));
        await Sql($"DELETE FROM site_hostname WHERE site_id = '{siteId}' AND hostname = 'www.example.org'");
        Assert.Equal([string.Empty], await QueryAsync($"SELECT coalesce(primary_hostname, '') FROM site WHERE id = '{siteId}'"));
    }

    [Fact]
    public async Task Republishing_an_unpublished_site_needs_the_disclosure_acknowledged_again()
    {
        await using var host = Host();
        var manager = await host.TokenAsync(SiteScenario.Manager);
        var siteId = await CreateSiteAsync(host, manager, Root, "withdrawn");
        await Sql($"UPDATE site SET status = 'unpublished' WHERE id = '{siteId}'");

        using (var refused = await host.SendAsync(
            HttpMethod.Post, $"/api/v1/sites/{siteId}/publish", manager, new { idempotencyKey = "again", refreshPaths = false, acknowledgeDisclosure = false }))
        {
            Assert.Equal((HttpStatusCode)422, refused.StatusCode);
            Assert.Equal("sites.disclosure_required", await SiteHttpHost.ProblemCodeAsync(refused));
        }

        using var accepted = await host.SendAsync(
            HttpMethod.Post, $"/api/v1/sites/{siteId}/publish", manager, new { idempotencyKey = "again", refreshPaths = false, acknowledgeDisclosure = true });
        Assert.Equal(HttpStatusCode.Accepted, accepted.StatusCode);
    }

    private SiteHttpHost Host(Dictionary<string, string?>? extra = null) =>
        SiteHttpHost.Create(fixture, extra, services =>
        {
            services.AddSingleton<ISiteDnsResolver>(_dns);
            services.AddSingleton<ICloudflareDns>(_cloudflare);
        });

    private static async Task<Guid> CreateSiteAsync(SiteHttpHost host, string bearer, ItemId root, string slug)
    {
        using var created = await host.SendAsync(HttpMethod.Post, "/api/v1/sites", bearer, new { rootItemId = root.Value, slug, layout = "docs" });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        using var site = await SiteHttpHost.JsonAsync(created);
        return site.RootElement.GetProperty("id").GetGuid();
    }

    private static async Task<string> AddAsync(SiteHttpHost host, string bearer, Guid siteId, string hostname, string status)
    {
        using var added = await host.SendAsync(HttpMethod.Post, $"/api/v1/sites/{siteId}/hostnames", bearer, new { hostname });
        Assert.Equal(HttpStatusCode.OK, added.StatusCode);
        using var site = await SiteHttpHost.JsonAsync(added);
        var row = site.RootElement.GetProperty("hostnames").EnumerateArray().Single(candidate => candidate.GetProperty("hostname").GetString() == hostname);
        Assert.Equal(status, row.GetProperty("status").GetString());
        var txt = row.GetProperty("records").EnumerateArray().Single(record => record.GetProperty("type").GetString() == "TXT");
        Assert.Equal("_nix-site." + hostname, txt.GetProperty("name").GetString());
        return txt.GetProperty("value").GetString()!["nix-site-verification=".Length..];
    }

    private async Task<JsonElement> VerifyAsync(SiteHttpHost host, string bearer, Guid siteId, string hostname)
    {
        // Each step stands for a later check: step past the manager's cooldown.
        await Sql($"UPDATE site_hostname SET checked_at = checked_at - interval '2 minutes' WHERE hostname = '{hostname}' AND checked_at IS NOT NULL");
        using var verified = await host.SendAsync(HttpMethod.Post, $"/api/v1/sites/{siteId}/hostnames/{hostname}/verify", bearer);
        Assert.Equal(HttpStatusCode.OK, verified.StatusCode);
        using var site = await SiteHttpHost.JsonAsync(verified);
        return site.RootElement.GetProperty("hostnames").EnumerateArray()
            .Single(candidate => candidate.GetProperty("hostname").GetString() == hostname).Clone();
    }

    private static async Task RequestAsync(SiteHttpHost host, string bearer, Guid siteId)
    {
        using var requested = await host.SendAsync(HttpMethod.Post, $"/api/v1/sites/{siteId}/approval", bearer, new { acknowledgeDisclosure = true });
        Assert.Equal(HttpStatusCode.OK, requested.StatusCode);
        using var site = await SiteHttpHost.JsonAsync(requested);
        Assert.Equal("pending", site.RootElement.GetProperty("approval").GetProperty("state").GetString());
    }

    private async Task MakeLiveAsync(Guid siteId)
    {
        var build = Guid.NewGuid();
        await Sql($"""
            INSERT INTO site_build
                (tenant_id, id, site_id, status, job_id, publisher_id, origin, idempotency_key, header, page_count,
                 file_count, total_bytes, loss, created_at, activated_at)
            VALUES ('{TestTenants.Alpha}', '{build}', '{siteId}', 'live', gen_random_uuid(), '{TestTenants.AlphaPrincipal}',
                    'manual', 'live-{siteId}', jsonb_build_object(), 1, 0, 0, '[]'::jsonb, now(), now());
            UPDATE site SET status = 'published', live_build_id = '{build}' WHERE id = '{siteId}';
            """);
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

    /// <summary>Public DNS as Core sees it: a table, plus whatever the fake Cloudflare zone holds.</summary>
    private sealed class FakeDns : Dictionary<string, string[]>, ISiteDnsResolver
    {
        public FakeCloudflare? Cloudflare { get; set; }

        public Task<IReadOnlyList<string>> QueryAsync(string name, string type, CancellationToken cancellationToken)
        {
            var zone = Cloudflare?.Records.Values
                .Where(record => record.Name == name && (record.Type == type || (record.Type == "CNAME" && type is "A" or "AAAA")))
                .Select(record => record.Type == "CNAME" && type != "CNAME" ? "192.0.2.20" : record.Content) ?? [];
            return Task.FromResult<IReadOnlyList<string>>([.. (TryGetValue(name + "/" + type, out var values) ? values : []).Concat(zone)]);
        }
    }

    /// <summary>The Cloudflare API slice in memory.</summary>
    private sealed class FakeCloudflare : ICloudflareDns
    {
        private int _next;

        public Dictionary<string, CloudflareDnsRecord> Records { get; } = [];

        public Task<string?> FindZoneIdAsync(string zoneName, CancellationToken cancellationToken) => Task.FromResult<string?>("zone");

        public Task<IReadOnlyList<CloudflareDnsRecord>> ListRecordsAsync(string zoneId, string name, CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<CloudflareDnsRecord>>([.. Records.Values.Where(record => record.Name == name)]);

        public Task<CloudflareDnsRecord> CreateRecordAsync(string zoneId, CloudflareDnsRecordInput record, CancellationToken cancellationToken)
        {
            var created = new CloudflareDnsRecord("r" + Interlocked.Increment(ref _next), record.Type, record.Name, record.Content, record.Proxied, record.Comment);
            Records[created.Id] = created;
            return Task.FromResult(created);
        }

        public Task<CloudflareDnsRecord> UpdateRecordAsync(string zoneId, string recordId, CloudflareDnsRecordInput record, CancellationToken cancellationToken) =>
            Task.FromResult(Records[recordId] = new CloudflareDnsRecord(recordId, record.Type, record.Name, record.Content, record.Proxied, record.Comment));

        public Task DeleteRecordAsync(string zoneId, string recordId, CancellationToken cancellationToken)
        {
            Records.Remove(recordId);
            return Task.CompletedTask;
        }

        public Task<JsonObject> GetTunnelConfigAsync(CancellationToken cancellationToken) => Task.FromResult(new JsonObject());

        public Task PutTunnelConfigAsync(JsonObject config, CancellationToken cancellationToken) => Task.CompletedTask;
    }
}
