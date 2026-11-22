using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Features.BrowserAuth;
using Nix.Http;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.Identity;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>Browser approval and CLI refresh over real Core HTTP and Postgres.</summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class CliBrowserLoginTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private const string Origin = "https://nix.cli.test";
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _cli = null!;
    private HttpClient _browser = null!;
    private MintedBrowserSessionSecret _browserSecret = null!;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        _browserSecret = BrowserSessionSecret.Mint();
        await SqlAsync($"UPDATE browser_session SET token_hash = '{_browserSecret.Hash}' WHERE tenant_id = '{M0SchemaSeed.Alpha.TenantId:D}'");
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        _factory = new ApplicationFactory(fixture.ApplicationConnectionString, key.ExportECPrivateKeyPem());
        _cli = _factory.CreateClient(new WebApplicationFactoryClientOptions { BaseAddress = new Uri(Origin), HandleCookies = false, AllowAutoRedirect = false });
        _browser = _factory.CreateClient(new WebApplicationFactoryClientOptions { BaseAddress = new Uri(Origin), HandleCookies = false, AllowAutoRedirect = false });
        _browser.DefaultRequestHeaders.Add("Cookie", "__Host-nix_session=" + _browserSecret.Token);
    }

    public async ValueTask DisposeAsync()
    {
        _cli.Dispose();
        _browser.Dispose();
        await _factory.DisposeAsync();
    }

    [Fact]
    public async Task Explicit_approval_returns_a_distinct_refreshable_revocable_session()
    {
        var start = await StartAsync();
        Assert.Equal(Origin, start.VerificationUri.GetLeftPart(UriPartial.Authority));
        Assert.DoesNotContain(start.DeviceCode, start.VerificationUri.AbsoluteUri, StringComparison.Ordinal);
        Assert.Equal("pending", (await PollAsync(start.DeviceCode)).Status);
        var anonymous = await _cli.GetAsync(start.VerificationUri, Cancellation);
        Assert.Equal(HttpStatusCode.Redirect, anonymous.StatusCode);
        Assert.StartsWith("/auth/login?returnTo=", anonymous.Headers.Location?.OriginalString, StringComparison.Ordinal);

        await SqlAsync($"UPDATE principal SET display_name = '<script>evil</script>' WHERE principal_id = '{M0SchemaSeed.Alpha.PrincipalId:D}'");
        var consent = await _browser.GetAsync(start.VerificationUri, Cancellation);
        consent.EnsureSuccessStatusCode();
        var html = await consent.Content.ReadAsStringAsync(Cancellation);
        Assert.Contains(start.UserCode, html, StringComparison.Ordinal);
        Assert.Contains("linked provider account", html, StringComparison.Ordinal);
        Assert.Contains("account connections and personal access tokens", html, StringComparison.Ordinal);
        Assert.Contains("&lt;script&gt;evil&lt;/script&gt;", html, StringComparison.Ordinal);
        Assert.DoesNotContain("<script>", html, StringComparison.Ordinal);
        Assert.Contains("frame-ancestors 'none'", consent.Headers.GetValues("Content-Security-Policy").Single(), StringComparison.Ordinal);
        Assert.Contains("no-store", consent.Headers.CacheControl?.ToString(), StringComparison.Ordinal);
        Assert.DoesNotContain(start.DeviceCode, html, StringComparison.Ordinal);
        Assert.DoesNotContain(_browserSecret.Token, html, StringComparison.Ordinal);

        await ApproveAsync(start.UserCode);
        var approved = await PollAsync(start.DeviceCode);
        Assert.Equal("approved", approved.Status);
        Assert.StartsWith(CliSessionSecret.Prefix, approved.RefreshToken, StringComparison.Ordinal);
        Assert.NotEqual(_browserSecret.Token, approved.RefreshToken);
        Assert.Equal(M0SchemaSeed.Alpha.PrincipalId.ToString("D"), approved.Profile?.Subject);
        Assert.True(approved.ExpiresAt <= approved.SessionExpiresAt);
        var jwt = new JwtSecurityTokenHandler().ReadJwtToken(approved.AccessToken);
        Assert.True(jwt.ValidTo <= approved.SessionExpiresAt?.UtcDateTime);
        Assert.NotNull(jwt.Claims.Single(claim => claim.Type == SelfIssuedTokenService.BrowserSessionClaim));
        Assert.DoesNotContain(jwt.Claims, claim => claim.Type is "role" or "roles");
        Assert.Equal(HttpStatusCode.OK, await WorkspacesAsync(approved.AccessToken!));
        Assert.Equal("expired", (await PollAsync(start.DeviceCode)).Status);

        var refresh = await _cli.PostAsJsonAsync("/auth/cli/token", new CliLoginTokenRequest(approved.RefreshToken), Cancellation);
        refresh.EnsureSuccessStatusCode();
        var renewed = await refresh.Content.ReadFromJsonAsync<CliLoginTokenResponse>(Cancellation);
        Assert.NotEqual(approved.AccessToken, renewed?.AccessToken);
        var refused = await _cli.PostAsJsonAsync("/auth/cli/token", new CliLoginTokenRequest(_browserSecret.Token), Cancellation);
        Assert.Equal(HttpStatusCode.Unauthorized, refused.StatusCode);
        using var confused = new HttpRequestMessage(HttpMethod.Get, "/auth/session");
        confused.Headers.Add("Cookie", "__Host-nix_session=" + approved.RefreshToken);
        var anonymousSession = await _cli.SendAsync(confused, Cancellation);
        using var anonymousBody = JsonDocument.Parse(await anonymousSession.Content.ReadAsStringAsync(Cancellation));
        Assert.False(anonymousBody.RootElement.GetProperty("authenticated").GetBoolean());

        var logout = await _cli.PostAsJsonAsync("/auth/cli/logout", new CliLoginTokenRequest(approved.RefreshToken), Cancellation);
        Assert.Equal(HttpStatusCode.NoContent, logout.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, await WorkspacesAsync(approved.AccessToken!));
        var ended = await _cli.PostAsJsonAsync("/auth/cli/token", new CliLoginTokenRequest(approved.RefreshToken), Cancellation);
        Assert.Equal(HttpStatusCode.Unauthorized, ended.StatusCode);
        var browserSession = await _browser.GetAsync(new Uri("/auth/session", UriKind.Relative), Cancellation);
        using var standing = JsonDocument.Parse(await browserSession.Content.ReadAsStringAsync(Cancellation));
        Assert.True(standing.RootElement.GetProperty("authenticated").GetBoolean());
    }

    [Fact]
    public async Task Concurrent_polling_consumes_approval_only_once()
    {
        var start = await StartAsync();
        await ApproveAsync(start.UserCode);
        var results = await Task.WhenAll(Enumerable.Range(0, 16).Select(_ => PollAsync(start.DeviceCode)));
        Assert.Single(results, result => result.Status == "approved");
        Assert.Equal(15, results.Count(result => result.Status == "expired"));
        Assert.Equal(1, await CountAsync("SELECT count(*) FROM cli_session_link"));
    }

    [Fact]
    public async Task Browser_logout_revokes_existing_cli_access_and_refresh()
    {
        var approved = await LoginAsync();
        using var request = new HttpRequestMessage(HttpMethod.Post, "/auth/logout");
        request.Headers.Add("Origin", Origin);
        var logout = await _browser.SendAsync(request, Cancellation);
        Assert.Equal(HttpStatusCode.NoContent, logout.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, await WorkspacesAsync(approved.AccessToken!));
        var refresh = await _cli.PostAsJsonAsync("/auth/cli/token", new CliLoginTokenRequest(approved.RefreshToken), Cancellation);
        Assert.Equal(HttpStatusCode.Unauthorized, refresh.StatusCode);
    }

    [Theory]
    [InlineData("https://other.test")]
    [InlineData("https://nix.cli.test:444")]
    [InlineData("")]
    public async Task Approval_refuses_missing_or_foreign_origins(string origin)
    {
        ArgumentNullException.ThrowIfNull(origin);
        var start = await StartAsync();
        var response = await DecisionAsync(start.UserCode, "approve", origin);
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal("pending", (await PollAsync(start.DeviceCode)).Status);
    }

    [Theory]
    [InlineData("denied")]
    [InlineData("expired")]
    [InlineData("suspended")]
    [InlineData("service")]
    [InlineData("parent_revoked")]
    public async Task Denied_expired_or_no_longer_human_and_active_pairings_cannot_issue_tokens(string condition)
    {
        var start = await StartAsync();
        if (condition == "denied")
        {
            (await DecisionAsync(start.UserCode, "deny", Origin)).EnsureSuccessStatusCode();
        }
        else
        {
            await ApproveAsync(start.UserCode);
            if (condition == "expired")
            {
                await SqlAsync("UPDATE cli_login_pairing SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute'");
            }
            else if (condition == "parent_revoked")
            {
                await SqlAsync($"UPDATE browser_session SET revoked_at = now() WHERE token_hash = '{_browserSecret.Hash}'");
            }
            else
            {
                await SqlAsync($"UPDATE principal SET {(condition == "service" ? "kind = 'service'" : "status = 'suspended'")} WHERE principal_id = '{M0SchemaSeed.Alpha.PrincipalId:D}'");
            }
        }

        var poll = await PollAsync(start.DeviceCode);
        Assert.Equal(condition == "denied" ? "denied" : "expired", poll.Status);
        Assert.Null(poll.AccessToken);
        Assert.Equal(0, await CountAsync("SELECT count(*) FROM cli_session_link"));
    }

    [Fact]
    public async Task Child_link_cannot_be_orphaned_by_parent_deletion()
    {
        var approved = await LoginAsync();
        var exception = await Assert.ThrowsAsync<PostgresException>(() => SqlAsync($"DELETE FROM browser_session WHERE token_hash = '{_browserSecret.Hash}'"));
        Assert.Equal(PostgresErrorCodes.ForeignKeyViolation, exception.SqlState);
        Assert.Equal(1, await CountAsync("SELECT count(*) FROM cli_session_link"));
        Assert.Equal(HttpStatusCode.OK, await WorkspacesAsync(approved.AccessToken!));
    }

    [Fact]
    public async Task Browser_approval_rejects_replayed_duplicate_or_oversized_forms()
    {
        var start = await StartAsync();
        using var request = new HttpRequestMessage(HttpMethod.Post, "/auth/cli/approve");
        request.Headers.Add("Origin", Origin);
        request.Content = new FormUrlEncodedContent(new[]
        {
            new KeyValuePair<string, string>("userCode", start.UserCode),
            new KeyValuePair<string, string>("userCode", start.UserCode),
            new KeyValuePair<string, string>("decision", "approve"),
        });
        Assert.Equal(HttpStatusCode.BadRequest, (await _browser.SendAsync(request, Cancellation)).StatusCode);
        var oversized = await DecisionAsync(new string('A', 129), "approve", Origin);
        Assert.Equal(HttpStatusCode.BadRequest, oversized.StatusCode);
        await ApproveAsync(start.UserCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await DecisionAsync(start.UserCode, "approve", Origin)).StatusCode);
    }

    [Fact]
    public async Task Pairing_capacity_is_atomic_bounded_and_prunes_expired_rows()
    {
        await SqlAsync("INSERT INTO cli_login_pairing(device_hash,user_hash) SELECT md5('device'||n)||md5('device'||n), md5('user'||n)||md5('user'||n) FROM generate_series(1,1023) n");
        await using var dataSource = NpgsqlDataSource.Create(fixture.ApplicationConnectionString);
        var store = new CliLoginSessionStore(dataSource);
        var results = await Task.WhenAll(Enumerable.Range(0, 12).Select(async _ =>
        {
            var device = CliSessionSecret.MintDevice();
            return await store.StartAsync(device.Hash, BrowserSessionSecret.Hash(CliSessionSecret.MintUserCode()), Cancellation);
        }));
        Assert.Single(results, result => result);
        Assert.Equal(1024, await CountAsync("SELECT count(*) FROM cli_login_pairing"));
        await SqlAsync("UPDATE cli_login_pairing SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute'");
        Assert.True(await store.StartAsync(CliSessionSecret.MintDevice().Hash, CliSessionSecret.Mint().Hash, Cancellation));
        Assert.Equal(1, await CountAsync("SELECT count(*) FROM cli_login_pairing"));
    }

    [Fact]
    public async Task Capability_tables_and_functions_have_no_ambient_tenant_or_public_grants()
    {
        await using var connection = new NpgsqlConnection(fixture.ApplicationConnectionString);
        await connection.OpenAsync(Cancellation);
        var exception = await Assert.ThrowsAsync<PostgresException>(() => RawSql.CountAsync(connection, null, "SELECT count(*) FROM cli_login_pairing"));
        Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, exception.SqlState);
        var migrator = await fixture.OpenMigratorConnectionAsync();
        await using (migrator.ConfigureAwait(false))
        {
            var definitions = await RawSql.TextListAsync(migrator, """
                SELECT p.proname || '|' || owner.rolname || '|' || p.prosecdef::text || '|'
                    || coalesce(array_to_string(p.proconfig, ','), '') || '|'
                    || has_function_privilege('public', p.oid, 'EXECUTE')::text || '|'
                    || has_function_privilege('nix_app', p.oid, 'EXECUTE')::text
                  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles owner ON owner.oid = p.proowner
                 WHERE n.nspname = 'public' AND p.proname IN ('nix_start_cli_login','nix_find_pending_cli_login',
                   'nix_decide_cli_login','nix_redeem_cli_login','nix_resolve_cli_session','nix_revoke_cli_session')
                """);
            Assert.Equal(6, definitions.Count);
            Assert.All(definitions, definition =>
            {
                Assert.Contains("|nix_migrator|true|search_path=pg_catalog, public, pg_temp|", definition, StringComparison.Ordinal);
                Assert.EndsWith("|false|true", definition, StringComparison.Ordinal);
            });
            Assert.Equal(2, await RawSql.CountAsync(migrator, null, "SELECT count(*) FROM pg_class WHERE relname IN ('cli_login_pairing','cli_session_link') AND relrowsecurity AND relforcerowsecurity"));
        }
    }

    [Theory]
    [InlineData("parent_expired")]
    [InlineData("child_expired")]
    [InlineData("principal_suspended")]
    [InlineData("principal_service")]
    public async Task Refresh_and_existing_access_stop_when_the_approved_authority_ends(string condition)
    {
        ArgumentNullException.ThrowIfNull(condition);
        var approved = await LoginAsync();
        if (condition.StartsWith("principal_", StringComparison.Ordinal))
        {
            await SqlAsync($"UPDATE principal SET {(condition == "principal_service" ? "kind = 'service'" : "status = 'suspended'")} WHERE principal_id = '{M0SchemaSeed.Alpha.PrincipalId:D}'");
        }
        else
        {
            var hash = condition == "parent_expired" ? _browserSecret.Hash : BrowserSessionSecret.Hash(approved.RefreshToken!);
            await SqlAsync($"UPDATE browser_session SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE token_hash = '{hash}'");
        }

        Assert.Equal(HttpStatusCode.Unauthorized, await WorkspacesAsync(approved.AccessToken!));
        var refresh = await _cli.PostAsJsonAsync("/auth/cli/token", new CliLoginTokenRequest(approved.RefreshToken), Cancellation);
        Assert.Equal(HttpStatusCode.Unauthorized, refresh.StatusCode);
    }

    [Fact]
    public async Task Parent_bound_session_resolution_uses_exact_indexes_on_a_realistic_table()
    {
        await SqlAsync($"""
            INSERT INTO browser_session(session_id,tenant_id,principal_id,token_hash,created_at,expires_at)
            SELECT md5('session'||n)::uuid, '{M0SchemaSeed.Alpha.TenantId:D}', '{M0SchemaSeed.Alpha.PrincipalId:D}',
                md5('hash'||n)||md5('hash'||n), now(), now()+interval '8 hours' FROM generate_series(1,2000) n;
            INSERT INTO cli_session_link(session_id,source_session_id)
            SELECT md5('session'||n)::uuid, (SELECT session_id FROM browser_session WHERE token_hash = '{_browserSecret.Hash}')
                FROM generate_series(1,2000) n WHERE n % 2 = 0;
            ANALYZE browser_session; ANALYZE cli_session_link; ANALYZE principal;
            """);
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            // SECURITY DEFINER functions stay opaque to outer EXPLAIN; inspect the actual resolver body.
            var plan = await RawSql.TextListAsync(connection, """
                EXPLAIN (ANALYZE, BUFFERS)
                SELECT s.session_id, s.tenant_id, s.principal_id, p.status, p.display_name, s.expires_at
                  FROM browser_session s JOIN principal p ON p.tenant_id = s.tenant_id AND p.principal_id = s.principal_id
                  LEFT JOIN cli_session_link l ON l.session_id = s.session_id
                  LEFT JOIN browser_session parent ON parent.session_id = l.source_session_id
                 WHERE s.session_id = md5('session2000')::uuid AND s.revoked_at IS NULL AND s.expires_at > now()
                   AND p.status = 'active'
                   AND (l.session_id IS NULL OR (p.kind = 'user' AND parent.revoked_at IS NULL AND parent.expires_at > now()
                       AND parent.tenant_id = s.tenant_id AND parent.principal_id = s.principal_id)) LIMIT 1
                """);
            var text = string.Join('\n', plan);
            TestContext.Current.TestOutputHelper?.WriteLine(text);
            Assert.Contains("PK_browser_session", text, StringComparison.Ordinal);
            Assert.Contains("cli_session_link_pkey", text, StringComparison.Ordinal);
            Assert.Contains("Buffers:", text, StringComparison.Ordinal);
            Assert.DoesNotContain("Seq Scan on browser_session", text, StringComparison.Ordinal);
            Assert.DoesNotContain("Seq Scan on cli_session_link", text, StringComparison.Ordinal);
            Assert.Equal(1, await RawSql.CountAsync(connection, null, "SELECT count(*) FROM nix_resolve_browser_session_by_id(md5('session2000')::uuid)"));
            await RawSql.ExecuteAsync(connection, null, $"UPDATE browser_session SET revoked_at = now() WHERE token_hash = '{_browserSecret.Hash}'");
            Assert.Equal(0, await RawSql.CountAsync(connection, null, "SELECT count(*) FROM nix_resolve_browser_session_by_id(md5('session2000')::uuid)"));
        }
    }

    [Fact]
    public void Every_cli_mutation_declares_a_small_kestrel_body_limit_and_a_named_rate_limit()
    {
        // TestServer does not enforce Kestrel's body feature for chunked streams. Existing
        // RequestBodyLimitTests prove the declared limit reaches that feature before reads.
        var endpoints = _factory.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
            .Where(endpoint => endpoint.RoutePattern.RawText?.StartsWith("/auth/cli/", StringComparison.Ordinal) == true)
            .Where(endpoint => endpoint.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods.Contains("POST") == true)
            .ToArray();
        Assert.Equal(5, endpoints.Length);
        Assert.All(endpoints, endpoint =>
        {
            Assert.Equal(2048, endpoint.Metadata.GetMetadata<RequestBodyLimitMetadata>()?.MaxRequestBodyBytes);
            Assert.NotNull(endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()?.PolicyName);
        });
    }

    [Fact]
    public async Task Consent_enhancement_has_a_fresh_nonce_and_only_same_origin_script_and_connection_authority()
    {
        var start = await StartAsync();
        var first = await _browser.GetAsync(start.VerificationUri, Cancellation);
        first.EnsureSuccessStatusCode();
        var firstHtml = await first.Content.ReadAsStringAsync(Cancellation);
        var firstNonce = firstHtml.Split("nonce=\"", StringSplitOptions.None)[1].Split('"')[0];
        Assert.Equal(24, Convert.FromBase64String(firstNonce).Length);
        Assert.Contains($"script-src 'nonce-{firstNonce}'; connect-src 'self'", first.Headers.GetValues("Content-Security-Policy").Single(), StringComparison.Ordinal);
        Assert.Contains($"<script defer nonce=\"{firstNonce}\" src=\"/auth/cli/consent.js\"></script>", firstHtml, StringComparison.Ordinal);
        Assert.Contains("data-nix-cli-consent method=\"post\" action=\"/auth/cli/approve\"", firstHtml, StringComparison.Ordinal);
        Assert.Contains("role=\"status\" aria-live=\"polite\"", firstHtml, StringComparison.Ordinal);
        var scriptPolicy = first.Headers.GetValues("Content-Security-Policy").Single().Split("script-src", StringSplitOptions.None)[1].Split(';')[0];
        Assert.DoesNotContain("unsafe-inline", scriptPolicy, StringComparison.Ordinal);
        Assert.DoesNotContain("'self'", scriptPolicy, StringComparison.Ordinal);
        var second = await _browser.GetAsync(start.VerificationUri, Cancellation);
        var secondHtml = await second.Content.ReadAsStringAsync(Cancellation);
        var secondNonce = secondHtml.Split("nonce=\"", StringSplitOptions.None)[1].Split('"')[0];
        Assert.NotEqual(firstNonce, secondNonce);
        var invalid = await _browser.GetAsync(new Uri("/auth/cli?user_code=invalid", UriKind.Relative), Cancellation);
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        Assert.DoesNotContain("<script", await invalid.Content.ReadAsStringAsync(Cancellation), StringComparison.Ordinal);
        Assert.Contains("script-src 'none'; connect-src 'none'", invalid.Headers.GetValues("Content-Security-Policy").Single(), StringComparison.Ordinal);
        // Well formed but never issued: the store is asked and must refuse, not offer approval.
        var unknown = await _browser.GetAsync(new Uri("/auth/cli?user_code=ABCDEFGHJK", UriKind.Relative), Cancellation);
        Assert.Equal(HttpStatusCode.BadRequest, unknown.StatusCode);
        Assert.DoesNotContain("<script", await unknown.Content.ReadAsStringAsync(Cancellation), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Consent_script_is_bounded_public_static_and_never_carries_identity_or_challenge_data()
    {
        var first = await _cli.GetAsync(new Uri("/auth/cli/consent.js", UriKind.Relative), Cancellation);
        first.EnsureSuccessStatusCode();
        Assert.Equal("text/javascript", first.Content.Headers.ContentType?.MediaType);
        Assert.Equal("nosniff", first.Headers.GetValues("X-Content-Type-Options").Single());
        Assert.Contains("no-store", first.Headers.CacheControl?.ToString(), StringComparison.Ordinal);
        var firstScript = await first.Content.ReadAsStringAsync(Cancellation);
        Assert.InRange(firstScript.Length, 100, 4096);
        Assert.DoesNotContain(_browserSecret.Token, firstScript, StringComparison.Ordinal);
        Assert.DoesNotContain("alpha user", firstScript, StringComparison.Ordinal);
        var second = await _browser.GetAsync(new Uri("/auth/cli/consent.js?user_code=ABCDEFGHJK", UriKind.Relative), Cancellation);
        Assert.Equal(firstScript, await second.Content.ReadAsStringAsync(Cancellation));
        Assert.DoesNotContain("ABCDEFGHJK", firstScript, StringComparison.Ordinal);
        Assert.DoesNotContain("innerHTML", firstScript, StringComparison.Ordinal);
    }

    private async Task<CliLoginStartResponse> StartAsync()
    {
        var response = await _cli.PostAsJsonAsync("/auth/cli/start", new CliLoginStartRequest(), Cancellation);
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<CliLoginStartResponse>(Cancellation))!;
    }

    private async Task<CliLoginPollResponse> PollAsync(string code)
    {
        var response = await _cli.PostAsJsonAsync("/auth/cli/poll", new CliLoginPollRequest(code), Cancellation);
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<CliLoginPollResponse>(Cancellation))!;
    }

    private async Task<CliLoginPollResponse> LoginAsync()
    {
        var start = await StartAsync();
        await ApproveAsync(start.UserCode);
        return await PollAsync(start.DeviceCode);
    }

    private async Task ApproveAsync(string code) => (await DecisionAsync(code, "approve", Origin)).EnsureSuccessStatusCode();

    private async Task<HttpResponseMessage> DecisionAsync(string code, string decision, string origin)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/auth/cli/approve");
        if (origin.Length > 0) { request.Headers.Add("Origin", origin); }
        request.Content = new FormUrlEncodedContent(new Dictionary<string, string> { ["userCode"] = code, ["decision"] = decision });
        return await _browser.SendAsync(request, Cancellation);
    }

    private async Task<HttpStatusCode> WorkspacesAsync(string token)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/v1/workspaces");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return (await _cli.SendAsync(request, Cancellation)).StatusCode;
    }

    private async Task SqlAsync(string sql)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false)) { await RawSql.ExecuteAsync(connection, null, sql); }
    }

    private async Task<long> CountAsync(string sql)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false)) { return await RawSql.CountAsync(connection, null, sql); }
    }

    private sealed class ApplicationFactory(string connection, string key) : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseSetting("ConnectionStrings:Nix", connection);
            builder.UseSetting("Nix:Bff:Authority", "https://issuer.alpha.test");
            builder.UseSetting("Nix:Bff:ClientId", "nix-browser-test");
            builder.UseSetting("Nix:Bff:PublicOrigin", Origin);
            builder.UseSetting(SelfIssuedTokenService.IssuerConfigurationKey, "https://core.cli.test");
            builder.UseSetting(SelfIssuedTokenService.AudienceConfigurationKey, "nix");
            builder.UseSetting(SelfIssuedTokenService.KeyIdConfigurationKey, "cli-test-key");
            builder.UseSetting(SelfIssuedTokenService.SigningKeyConfigurationKey, key);
        }
    }
}
