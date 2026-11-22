using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.WebUtilities;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Integration.Tests.Harness;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// [SEC] Connecting and disconnecting a calendar account (Amendment 1 A1): the authorize call is
/// interactive-only and builds a PKCE S256 URL with a protected state; the callback on the BFF
/// boundary accepts only the session that started it, only within ten minutes, and stores the
/// grant protected; reconnecting updates the row; disconnecting revokes upstream and stops links.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class CalendarOAuthHttpTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private CalendarSyncHost _host = null!;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        _host = await CalendarSyncHost.StartAsync(fixture);
    }

    public async ValueTask DisposeAsync() => await _host.DisposeAsync();

    [Fact]
    public async Task A_personal_access_token_can_read_connections_but_never_start_or_end_one()
    {
        var token = await _host.AccessTokenAsync(TestTenants.AlphaContext, [AccessTokenScopes.Read, AccessTokenScopes.Write, AccessTokenScopes.Admin]);

        using (var list = await _host.SendAsync(HttpMethod.Get, "/api/v1/me/calendar/connections", token))
        {
            Assert.Equal(HttpStatusCode.OK, list.StatusCode);
            using var body = JsonDocument.Parse(await list.Content.ReadAsStringAsync(Cancellation));
            Assert.Equal(
                ["google", "microsoft"],
                body.RootElement.GetProperty("providers").EnumerateArray().Select(provider => provider.GetProperty("provider").GetString()));
            Assert.All(body.RootElement.GetProperty("providers").EnumerateArray(), provider => Assert.True(provider.GetProperty("available").GetBoolean()));
        }

        using var authorize = await _host.SendAsync(HttpMethod.Post, "/api/v1/me/calendar/connections/google/authorize", token, new { });
        Assert.Equal(HttpStatusCode.Forbidden, authorize.StatusCode);
        using var disconnect = await _host.SendAsync(HttpMethod.Delete, $"/api/v1/me/calendar/connections/{Guid.NewGuid():D}", token);
        Assert.Equal(HttpStatusCode.Forbidden, disconnect.StatusCode);
    }

    [Fact]
    public async Task Authorize_builds_a_pkce_url_with_protected_state_and_the_callback_stores_the_grant()
    {
        var cookie = await _host.SignInAsync(TestTenants.AlphaContext);
        var bearer = await _host.BearerAsync(cookie);
        var (state, nonce, query) = await AuthorizeAsync(bearer, "google", "/w/somewhere/settings?tab=integrations");

        Assert.Equal("Google-client", query["client_id"]);
        Assert.Equal($"{CalendarSyncHost.PublicOrigin}/auth/calendar/callback/google", query["redirect_uri"]);
        Assert.Equal("S256", query["code_challenge_method"]);
        Assert.Equal("offline", query["access_type"]);
        Assert.Equal("consent", query["prompt"]);
        Assert.Contains("https://www.googleapis.com/auth/calendar.events", query["scope"].ToString(), StringComparison.Ordinal);
        Assert.DoesNotContain(nonce, state, StringComparison.Ordinal);

        using var callback = await CallbackAsync("google", cookie, nonce, $"code=good-code&state={Uri.EscapeDataString(state)}");
        Assert.Equal(HttpStatusCode.Redirect, callback.StatusCode);
        Assert.Equal("/w/somewhere/settings?tab=integrations&calendar_status=connected", callback.Headers.Location?.OriginalString);
        Assert.Equal("no-store", callback.Headers.CacheControl?.ToString());

        var token = _host.Provider.CallsTo("/token").Single();
        Assert.Equal("authorization_code", token.Form["grant_type"]);
        Assert.Equal("Google-secret", token.Form["client_secret"]);
        Assert.False(string.IsNullOrEmpty(token.Form["code_verifier"]));

        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            Assert.Equal("active|person@gmail.test|google-subject-1", await RawSql.TextAsync(connection, null,
                $"SELECT status || '|' || account_email || '|' || account_subject FROM calendar_connection WHERE principal_id = '{TestTenants.AlphaPrincipal}' AND provider = 'google' AND account_subject = 'google-subject-1'"));
        }

        // Reconnecting the same account updates the row rather than adding one.
        await ExecuteAsync("UPDATE calendar_connection SET status = 'needs_reauth' WHERE account_subject = 'google-subject-1'");
        var (again, againNonce, _) = await AuthorizeAsync(bearer, "google", null);
        using var reconnect = await CallbackAsync("google", cookie, againNonce, $"code=good-code&state={Uri.EscapeDataString(again)}");
        Assert.EndsWith("calendar_status=connected", reconnect.Headers.Location?.OriginalString, StringComparison.Ordinal);
        Assert.Equal(1, await CountAsync("SELECT count(*) FROM calendar_connection WHERE account_subject = 'google-subject-1' AND status = 'active'"));
        Assert.Equal(1, await CountAsync("SELECT count(*) FROM calendar_connection WHERE account_subject = 'google-subject-1'"));
    }

    [Fact]
    public async Task The_callback_refuses_another_session_a_missing_nonce_an_expired_state_and_reports_a_cancelled_consent()
    {
        var cookie = await _host.SignInAsync(TestTenants.AlphaContext);
        var bearer = await _host.BearerAsync(cookie);
        var (state, nonce, microsoftQuery) = await AuthorizeAsync(bearer, "microsoft", "/settings?tab=integrations");
        Assert.Equal("openid email offline_access Calendars.ReadWrite", microsoftQuery["scope"].ToString());

        // A different signed-in principal (Beta) holding the same state and nonce.
        var other = await _host.SignInAsync(TestTenants.BetaContext);
        using (var foreign = await CallbackAsync("microsoft", other, nonce, $"code=good-code&state={Uri.EscapeDataString(state)}"))
        {
            Assert.Equal("/settings?tab=integrations&calendar_status=failed", foreign.Headers.Location?.OriginalString);
        }

        using (var noNonce = await CallbackAsync("microsoft", cookie, null, $"code=good-code&state={Uri.EscapeDataString(state)}"))
        {
            Assert.Equal("/settings?tab=integrations&calendar_status=failed", noNonce.Headers.Location?.OriginalString);
        }

        using (var wrongProvider = await CallbackAsync("google", cookie, nonce, $"code=good-code&state={Uri.EscapeDataString(state)}"))
        {
            Assert.Equal("/settings?tab=integrations&calendar_status=failed", wrongProvider.Headers.Location?.OriginalString);
        }

        using (var anonymous = await CallbackAsync("microsoft", null, nonce, $"code=good-code&state={Uri.EscapeDataString(state)}"))
        {
            Assert.StartsWith("/auth/login?returnTo=", anonymous.Headers.Location?.OriginalString, StringComparison.Ordinal);
        }

        using (var cancelled = await CallbackAsync("microsoft", cookie, nonce, $"error=access_denied&state={Uri.EscapeDataString(state)}"))
        {
            Assert.Equal("/settings?tab=integrations&calendar_status=cancelled", cancelled.Headers.Location?.OriginalString);
        }

        // A state protected by the host's own key ring but already past its ten minutes.
        var protector = Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions
            .GetRequiredService<Nix.Features.CalendarSync.CalendarTokenProtector>(_host.Factory.Services);
        var stale = protector.ProtectState(
            Nix.Features.CalendarSync.CalendarOAuthState.Encode(new(
                nonce, TestTenants.Alpha, TestTenants.AlphaPrincipal, "microsoft", "verifier", DateTimeOffset.UtcNow.AddMinutes(-11), "/settings")),
            TimeSpan.FromMinutes(30));
        using (var expired = await CallbackAsync("microsoft", cookie, nonce, $"code=good-code&state={Uri.EscapeDataString(stale)}"))
        {
            Assert.Equal("/settings?tab=integrations&calendar_status=failed", expired.Headers.Location?.OriginalString);
        }

        Assert.Empty(_host.Provider.CallsTo("/oauth2/v2.0/token"));
        Assert.Equal(0, await CountAsync("SELECT count(*) FROM calendar_connection WHERE provider = 'microsoft'"));

        using var accepted = await CallbackAsync("microsoft", cookie, nonce, $"code=good-code&state={Uri.EscapeDataString(state)}");
        Assert.Equal("/settings?tab=integrations&calendar_status=connected", accepted.Headers.Location?.OriginalString);
        Assert.Equal("common", _host.Provider.CallsTo("/oauth2/v2.0/token").Single().Path.Split('/')[1]);
        Assert.Equal(1, await CountAsync("SELECT count(*) FROM calendar_connection WHERE provider = 'microsoft' AND account_subject = 'tenant-1:google-subject-1'"));
    }

    [Fact]
    public async Task Disconnecting_revokes_upstream_drops_the_tokens_and_stops_the_links_but_keeps_their_items()
    {
        var cookie = await _host.SignInAsync(TestTenants.AlphaContext);
        var bearer = await _host.BearerAsync(cookie);
        var connectionId = await _host.ConnectAsync(TestTenants.AlphaContext, refreshToken: "refresh-to-revoke");
        var link = await _host.LinkAsync(TestTenants.AlphaContext, connectionId);
        await ExecuteAsync($"""
            INSERT INTO scheduled_trigger (tenant_id, id, workspace_id, principal_id, kind, source, source_item_id, rule_id,
                                           fire_at, dedupe_key, status, attempts, created_at, updated_at)
            VALUES ('{TestTenants.Alpha}', gen_random_uuid(), '{TestTenants.AlphaWorkspace}', '{TestTenants.AlphaPrincipal}', 'calendar',
                    'calendar.sync', '{link.ContainerItemId.Value}', '{link.Id}', now() + interval '5 minutes',
                    'cal:p:{link.Id:D}:209901010000', 'pending', 0, now(), now())
            """);

        using var deleted = await _host.SendAsync(HttpMethod.Delete, $"/api/v1/me/calendar/connections/{connectionId:D}", bearer);
        Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);

        Assert.Equal("refresh-to-revoke", _host.Provider.CallsTo("/revoke").Single().Form["token"]);
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM calendar_connection WHERE id = '{connectionId}' AND status = 'revoked' AND refresh_token_protected IS NULL AND access_token_protected IS NULL"));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM calendar_link WHERE id = '{link.Id}' AND status = 'stopped'"));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM item WHERE id = '{link.ContainerItemId.Value}' AND lifecycle_state = 'active'"));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM scheduled_trigger WHERE rule_id = '{link.Id}' AND status = 'cancelled'"));

        // An interactive client sees the revoked connection in its list, and its links as stopped.
        using var list = await _host.SendAsync(HttpMethod.Get, "/api/v1/me/calendar/links", bearer);
        using var body = JsonDocument.Parse(await list.Content.ReadAsStringAsync(Cancellation));
        Assert.Equal("stopped", body.RootElement.GetProperty("links").EnumerateArray().Single(entry => entry.GetProperty("id").GetGuid() == link.Id).GetProperty("status").GetString());
    }

    [Fact]
    public async Task Links_are_created_against_a_listed_calendar_and_refuse_admin_less_tokens_duplicates_and_schema_clashes()
    {
        var cookie = await _host.SignInAsync(TestTenants.AlphaContext);
        var bearer = await _host.BearerAsync(cookie);
        var connectionId = await _host.ConnectAsync(TestTenants.AlphaContext);

        using (var calendars = await _host.SendAsync(HttpMethod.Get, $"/api/v1/me/calendar/connections/{connectionId:D}/calendars", bearer))
        {
            using var body = JsonDocument.Parse(await calendars.Content.ReadAsStringAsync(Cancellation));
            Assert.Equal(["primary", "holidays"], body.RootElement.GetProperty("calendars").EnumerateArray().Select(entry => entry.GetProperty("id").GetString()));
            Assert.True(body.RootElement.GetProperty("calendars")[1].GetProperty("readOnly").GetBoolean());
        }

        var request = new
        {
            connectionId,
            externalCalendarId = "primary",
            workspaceId = TestTenants.AlphaWorkspace,
            container = new { create = new { parentId = (Guid?)null, title = "Work calendar" } },
            direction = "two_way",
        };
        var writer = await _host.AccessTokenAsync(TestTenants.AlphaContext, [AccessTokenScopes.Read, AccessTokenScopes.Write]);
        using (var refused = await _host.SendAsync(HttpMethod.Post, "/api/v1/me/calendar/links", writer, request))
        {
            Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        }

        Guid linkId;
        Guid containerId;
        using (var created = await _host.SendAsync(HttpMethod.Post, "/api/v1/me/calendar/links", bearer, request))
        {
            Assert.Equal(HttpStatusCode.Created, created.StatusCode);
            using var body = JsonDocument.Parse(await created.Content.ReadAsStringAsync(Cancellation));
            linkId = body.RootElement.GetProperty("id").GetGuid();
            containerId = body.RootElement.GetProperty("containerItemId").GetGuid();
            Assert.Equal("Work", body.RootElement.GetProperty("name").GetString());
            Assert.Equal("google", body.RootElement.GetProperty("provider").GetString());
        }

        // A full first round is enqueued at once, under the owner.
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM worker_job WHERE kind = 'calendar.sync' AND payload::jsonb = jsonb_build_object('linkId', '{linkId:D}', 'full', true)"));
        Assert.Equal("datetime", await TextAsync($"SELECT schema -> 'properties' -> 0 ->> 'type' FROM item WHERE id = '{containerId}'"));

        using (var duplicate = await _host.SendAsync(HttpMethod.Post, "/api/v1/me/calendar/links", bearer, request))
        {
            Assert.Equal(HttpStatusCode.Conflict, duplicate.StatusCode);
            Assert.Equal("calendar.link_exists", await HttpProblem.CodeAsync(duplicate));
        }

        // A read-only calendar can only be imported.
        using (var readOnly = await _host.SendAsync(HttpMethod.Post, "/api/v1/me/calendar/links", bearer,
            new { connectionId, externalCalendarId = "holidays", workspaceId = TestTenants.AlphaWorkspace, container = new { create = new { title = "Holidays" } }, direction = "two_way" }))
        {
            Assert.Equal(HttpStatusCode.UnprocessableEntity, readOnly.StatusCode);
        }

        // An existing container whose start is a plain date clashes.
        await ExecuteAsync($$"""
            UPDATE item SET schema = '{"properties":[{"key":"start","label":"Start","type":"date","options":[],"required":false}],"inherit":true}'::jsonb
             WHERE id = '{{M0SchemaSeed.Alpha.ItemId}}'
            """);
        using (var clash = await _host.SendAsync(HttpMethod.Post, "/api/v1/me/calendar/links", bearer,
            new { connectionId, externalCalendarId = "holidays", workspaceId = TestTenants.AlphaWorkspace, container = new { itemId = M0SchemaSeed.Alpha.ItemId }, direction = "import_only" }))
        {
            Assert.Equal(HttpStatusCode.Conflict, clash.StatusCode);
            Assert.Equal("calendar.container_schema_conflict", await HttpProblem.CodeAsync(clash));
        }

        using (var patched = await _host.SendAsync(HttpMethod.Patch, $"/api/v1/me/calendar/links/{linkId:D}", bearer, new { revision = 1, status = "paused" }))
        {
            Assert.Equal(HttpStatusCode.OK, patched.StatusCode);
        }

        using (var stale = await _host.SendAsync(HttpMethod.Patch, $"/api/v1/me/calendar/links/{linkId:D}", bearer, new { revision = 1, status = "active" }))
        {
            Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
            Assert.Equal("calendar.conflict", await HttpProblem.CodeAsync(stale));
        }

        using (var sync = await _host.SendAsync(HttpMethod.Post, $"/api/v1/me/calendar/links/{linkId:D}/sync", writer, new { }))
        {
            Assert.Equal(HttpStatusCode.Conflict, sync.StatusCode);
            Assert.Equal("calendar.link_inactive", await HttpProblem.CodeAsync(sync));
        }

        using (var log = await _host.SendAsync(HttpMethod.Get, $"/api/v1/me/calendar/links/{linkId:D}/log", writer))
        {
            Assert.Equal(HttpStatusCode.OK, log.StatusCode);
        }

        using var removed = await _host.SendAsync(HttpMethod.Delete, $"/api/v1/me/calendar/links/{linkId:D}", bearer);
        Assert.Equal(HttpStatusCode.NoContent, removed.StatusCode);
        Assert.Equal(0, await CountAsync($"SELECT count(*) FROM calendar_link WHERE id = '{linkId}'"));
        Assert.Equal(1, await CountAsync($"SELECT count(*) FROM item WHERE id = '{containerId}' AND lifecycle_state = 'active'"));
    }

    [Fact]
    public async Task A_grant_that_cannot_be_stored_redirects_failed_rather_than_erroring()
    {
        var cookie = await _host.SignInAsync(TestTenants.AlphaContext);
        var bearer = await _host.BearerAsync(cookie);
        _host.Provider.Subject = "subject\u0000with-a-nul";
        var (state, nonce, _) = await AuthorizeAsync(bearer, "google", "/settings?tab=integrations");

        using var callback = await CallbackAsync("google", cookie, nonce, $"code=good-code&state={Uri.EscapeDataString(state)}");
        Assert.Equal(HttpStatusCode.Redirect, callback.StatusCode);
        Assert.Equal("/settings?tab=integrations&calendar_status=failed", callback.Headers.Location?.OriginalString);
        Assert.Equal(0, await CountAsync("SELECT count(*) FROM calendar_connection WHERE account_subject LIKE 'subject%'"));
    }

    [Fact]
    public async Task A_link_over_a_read_only_calendar_cannot_be_switched_to_two_way()
    {
        var cookie = await _host.SignInAsync(TestTenants.AlphaContext);
        var bearer = await _host.BearerAsync(cookie);
        var connectionId = await _host.ConnectAsync(TestTenants.AlphaContext);
        Guid linkId;
        using (var created = await _host.SendAsync(HttpMethod.Post, "/api/v1/me/calendar/links", bearer,
            new { connectionId, externalCalendarId = "holidays", workspaceId = TestTenants.AlphaWorkspace, container = new { create = new { title = "Holidays" } }, direction = "import_only" }))
        {
            Assert.Equal(HttpStatusCode.Created, created.StatusCode);
            using var body = JsonDocument.Parse(await created.Content.ReadAsStringAsync(Cancellation));
            linkId = body.RootElement.GetProperty("id").GetGuid();
        }

        using (var refused = await _host.SendAsync(HttpMethod.Patch, $"/api/v1/me/calendar/links/{linkId:D}", bearer, new { revision = 1, direction = "two_way" }))
        {
            Assert.Equal(HttpStatusCode.UnprocessableEntity, refused.StatusCode);
        }

        Assert.Equal("import_only|1", await TextAsync($"SELECT direction || '|' || revision FROM calendar_link WHERE id = '{linkId}'"));

        // Writable upstream, the same change is accepted.
        _host.Provider.Calendars = [("primary", "Work", true, true), ("holidays", "Holidays", false, true)];
        using var accepted = await _host.SendAsync(HttpMethod.Patch, $"/api/v1/me/calendar/links/{linkId:D}", bearer, new { revision = 1, direction = "two_way" });
        Assert.Equal(HttpStatusCode.OK, accepted.StatusCode);
    }

    private async Task<(string State, string Nonce, Dictionary<string, Microsoft.Extensions.Primitives.StringValues> Query)> AuthorizeAsync(
        string bearer, string provider, string? returnTo)
    {
        using var response = await _host.SendAsync(HttpMethod.Post, $"/api/v1/me/calendar/connections/{provider}/authorize", bearer, new { returnTo });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var setCookie = Assert.Single(response.Headers.GetValues("Set-Cookie"));
        Assert.StartsWith("nix_calendar_oauth=", setCookie, StringComparison.Ordinal);
        Assert.Contains("path=/auth/calendar/callback", setCookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("httponly", setCookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("secure", setCookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("samesite=lax", setCookie, StringComparison.OrdinalIgnoreCase);
        var nonce = setCookie["nix_calendar_oauth=".Length..setCookie.IndexOf(';', StringComparison.Ordinal)];
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
        var url = new Uri(body.RootElement.GetProperty("authorizationUrl").GetString()!);
        Assert.StartsWith(_host.Provider.Origin.TrimEnd('/'), url.GetLeftPart(UriPartial.Authority), StringComparison.Ordinal);
        var query = QueryHelpers.ParseQuery(url.Query);
        return (query["state"].ToString(), nonce, query);
    }

    private async Task<HttpResponseMessage> CallbackAsync(string provider, string? sessionCookie, string? nonce, string query)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, $"/auth/calendar/callback/{provider}?{query}");
        var cookies = new List<string>();
        if (sessionCookie is not null)
        {
            cookies.Add($"__Host-nix_session={sessionCookie}");
        }

        if (nonce is not null)
        {
            cookies.Add($"nix_calendar_oauth={nonce}");
        }

        if (cookies.Count > 0)
        {
            request.Headers.Add("Cookie", string.Join("; ", cookies));
        }

        return await _host.Client.SendAsync(request, Cancellation);
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
