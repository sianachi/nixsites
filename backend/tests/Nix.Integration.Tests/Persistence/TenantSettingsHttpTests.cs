using System.Net;
using Nix.Features.PublicLinks;
using Nix.Integration.Tests.Harness;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The organization's MCP and public link switches through the real pipeline: administrators only,
/// interactive sessions only, audited, shown in <c>/me</c>, and capped by what the deployment offers.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class TenantSettingsHttpTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private const string Route = "/api/v1/tenant/settings";

    private static readonly Dictionary<string, string?> Offered = new()
    {
        [PublicLinkSettings.EnabledKey] = "true",
        ["Nix:Mcp:PublicUrl"] = "https://nix.example.test/mcp",
    };

    private static readonly string[] FlagNames = ["mcpEnabled", "publicLinksEnabled", "mcpAvailable", "publicLinksAvailable"];

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
    public async Task An_administrator_reads_and_changes_the_switches_and_an_omitted_field_stays()
    {
        await using var host = SiteHttpHost.Create(fixture, Offered);
        var admin = await host.InteractiveTokenAsync(SiteScenario.Manager);

        using (var initial = await host.SendAsync(HttpMethod.Get, Route, admin))
        {
            Assert.Equal(HttpStatusCode.OK, initial.StatusCode);
            Assert.Equal("true,true,true,true", await Flags(initial));
        }

        using (var mcpOff = await host.SendAsync(HttpMethod.Put, Route, admin, new { mcpEnabled = false }))
        {
            Assert.Equal("false,true,true,true", await Flags(mcpOff));
        }

        using (var linksOff = await host.SendAsync(HttpMethod.Put, Route, admin, new { publicLinksEnabled = false }))
        {
            Assert.Equal("false,false,true,true", await Flags(linksOff));
        }

        // The same values again change nothing and are not audited a second time.
        using (var same = await host.SendAsync(HttpMethod.Put, Route, admin, new { publicLinksEnabled = false }))
        {
            Assert.Equal(HttpStatusCode.OK, same.StatusCode);
        }

        using (var read = await host.SendAsync(HttpMethod.Get, Route, admin))
        {
            Assert.Equal("false,false,true,true", await Flags(read));
        }

        Assert.Equal(["tenant.settings_changed", "tenant.settings_changed"], await QueryAsync("SELECT action FROM audit_event WHERE action LIKE 'tenant.settings%'"));
    }

    [Fact]
    public async Task A_person_who_is_not_an_administrator_is_refused()
    {
        await using var host = SiteHttpHost.Create(fixture, Offered);
        var editor = await host.InteractiveTokenAsync(SiteScenario.EditorContext);

        foreach (var method in new[] { HttpMethod.Get, HttpMethod.Put })
        {
            using var response = await host.SendAsync(method, Route, editor, method == HttpMethod.Put ? new { mcpEnabled = false } : null);
            Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
            Assert.Equal("roles.administrator_required", await SiteHttpHost.ProblemCodeAsync(response));
        }

        Assert.Equal(["true,true"], await QueryAsync("SELECT mcp_enabled || ',' || public_links_enabled FROM tenant WHERE tenant_id = '" + TestTenants.Alpha + "'"));
    }

    [Fact]
    public async Task An_access_token_is_refused_even_with_every_scope_and_an_administrator_behind_it()
    {
        await using var host = SiteHttpHost.Create(fixture, Offered);
        var token = await host.TokenAsync(SiteScenario.Manager);

        foreach (var method in new[] { HttpMethod.Get, HttpMethod.Put })
        {
            using var response = await host.SendAsync(method, Route, token, method == HttpMethod.Put ? new { mcpEnabled = false } : null);
            Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        }

        Assert.Equal(["true,true"], await QueryAsync("SELECT mcp_enabled || ',' || public_links_enabled FROM tenant WHERE tenant_id = '" + TestTenants.Alpha + "'"));
    }

    [Fact]
    public async Task Me_shows_the_mcp_url_and_public_links_only_while_the_tenant_switch_and_the_install_allow_them()
    {
        await using var host = SiteHttpHost.Create(fixture, Offered);
        var admin = await host.InteractiveTokenAsync(SiteScenario.Manager);
        var editor = await host.TokenAsync(SiteScenario.EditorContext, admin: false);

        Assert.Equal("https://nix.example.test/mcp|true|true", await MeFeatures(host, editor));

        using (var off = await host.SendAsync(HttpMethod.Put, Route, admin, new { mcpEnabled = false, publicLinksEnabled = false }))
        {
            Assert.Equal(HttpStatusCode.OK, off.StatusCode);
        }

        Assert.Equal("|false|false", await MeFeatures(host, editor));

        using (var on = await host.SendAsync(HttpMethod.Put, Route, admin, new { mcpEnabled = true, publicLinksEnabled = true }))
        {
            Assert.Equal(HttpStatusCode.OK, on.StatusCode);
        }

        Assert.Equal("https://nix.example.test/mcp|true|true", await MeFeatures(host, editor));
    }

    [Fact]
    public async Task The_install_is_the_ceiling_whatever_the_tenant_says()
    {
        await using var host = SiteHttpHost.Create(
            fixture,
            new Dictionary<string, string?> { [PublicLinkSettings.EnabledKey] = "false", ["Nix:Mcp:PublicUrl"] = string.Empty });
        var admin = await host.InteractiveTokenAsync(SiteScenario.Manager);

        using (var read = await host.SendAsync(HttpMethod.Get, Route, admin))
        {
            Assert.Equal("true,true,false,false", await Flags(read));
        }

        Assert.Equal("|false|true", await MeFeatures(host, admin));
    }

    private static async Task<string> Flags(HttpResponseMessage response)
    {
        using var body = await SiteHttpHost.JsonAsync(response);
        var root = body.RootElement;
        return string.Join(',', FlagNames.Select(name => root.GetProperty(name).GetBoolean() ? "true" : "false"));
    }

    private static async Task<string> MeFeatures(SiteHttpHost host, string bearer)
    {
        using var me = await host.SendAsync(HttpMethod.Get, "/api/v1/me", bearer);
        using var body = await SiteHttpHost.JsonAsync(me);
        var features = body.RootElement.GetProperty("features");
        var url = features.GetProperty("mcpUrl").GetString() ?? string.Empty;
        var links = features.GetProperty("publicLinks").GetBoolean() ? "true" : "false";
        var mcp = features.GetProperty("mcpEnabled").GetBoolean() ? "true" : "false";
        return $"{url}|{links}|{mcp}";
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
