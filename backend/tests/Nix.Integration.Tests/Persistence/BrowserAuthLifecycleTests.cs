using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.IdentityModel.Tokens;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Provisioning;
using Nix.Integration.Tests.Harness;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>The complete same-origin browser session lifecycle over real Postgres and HTTP.</summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class BrowserAuthLifecycleTests : IAsyncLifetime
{
    private const string Issuer = "https://issuer.alpha.test";
    private const string ClientId = "nix-browser-test";
    private const string Subject = "browser-user-without-azp";
    private const string PublicOrigin = "https://nix.browser.test";
    private const string AccountPage = "https://issuer.alpha.test/ui/console/users/me?id=security";

    private readonly NixPostgresFixture _fixture;
    private RSA _providerKey = null!;
    private ProviderHandler _provider = null!;
    private ConfiguredApplicationFactory _factory = null!;
    private HttpClient _client = null!;

    public BrowserAuthLifecycleTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);

        _providerKey = RSA.Create(2048);
        var keyId = $"browser-{Guid.NewGuid():N}";
        var jwksUri = $"{Issuer}/keys/{Guid.NewGuid():N}";
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null,
                $"""
                UPDATE identity_provider
                   SET audience = '{ClientId}',
                       jwks_uri = '{jwksUri}',
                       allowed_algorithms = ARRAY['RS256']::text[],
                       jit_provisioning_enabled = true,
                       userinfo_uri = '{Issuer}/userinfo'
                 WHERE provider_id = '{M0SchemaSeed.Alpha.ProviderId:D}'::uuid;
                """);
        }

        string coreSigningKey;
        using (var coreKey = ECDsa.Create(ECCurve.NamedCurves.nistP256))
        {
            coreSigningKey = coreKey.ExportECPrivateKeyPem();
        }

        _provider = new ProviderHandler(Issuer, ClientId, Subject, _providerKey, keyId);
        _factory = new ConfiguredApplicationFactory(
            _fixture.ApplicationConnectionString,
            coreSigningKey,
            jwksUri,
            _provider,
            Jwks(_providerKey, keyId));
        _client = _factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            AllowAutoRedirect = false,
            HandleCookies = true,
            BaseAddress = new Uri(PublicOrigin),
        });
    }

    public async ValueTask DisposeAsync()
    {
        _client.Dispose();
        await _factory.DisposeAsync();
        _provider.Dispose();
        _providerKey.Dispose();
    }

    [Fact]
    public async Task A_token_without_azp_creates_one_personal_workspace_and_a_revocable_browser_session()
    {
        var login = await _client.GetAsync(new Uri("/auth/login?returnTo=%2F", UriKind.Relative), Cancellation);
        Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);
        Assert.Contains(login.Headers.GetValues("Set-Cookie"), value =>
            value.StartsWith("__Host-nix_oidc=", StringComparison.Ordinal)
            && value.Contains("path=/;", StringComparison.OrdinalIgnoreCase)
            && !value.Contains("domain=", StringComparison.OrdinalIgnoreCase)
            && value.Contains("secure", StringComparison.OrdinalIgnoreCase)
            && value.Contains("httponly", StringComparison.OrdinalIgnoreCase)
            && value.Contains("samesite=lax", StringComparison.OrdinalIgnoreCase));
        var providerRedirect = login.Headers.Location ?? throw new InvalidOperationException("Missing provider redirect.");
        var query = QueryHelpers.ParseQuery(providerRedirect.Query);
        Assert.Equal(ClientId, query["client_id"]);
        Assert.Equal($"{PublicOrigin}/auth/callback", query["redirect_uri"]);
        _provider.Nonce = query["nonce"].ToString();
        var state = query["state"].ToString();

        var callback = await _client.GetAsync(
            new Uri($"/auth/callback?code=provider-code&state={Uri.EscapeDataString(state)}", UriKind.Relative),
            Cancellation);
        Assert.Equal(HttpStatusCode.Redirect, callback.StatusCode);
        Assert.Equal("/", callback.Headers.Location?.OriginalString);
        Assert.Contains(callback.Headers.GetValues("Set-Cookie"), value =>
            value.StartsWith("__Host-nix_session=", StringComparison.Ordinal)
            && value.Contains("path=/", StringComparison.OrdinalIgnoreCase)
            && value.Contains("secure", StringComparison.OrdinalIgnoreCase)
            && value.Contains("httponly", StringComparison.OrdinalIgnoreCase)
            && value.Contains("samesite=lax", StringComparison.OrdinalIgnoreCase));

        var restored = await _client.GetAsync(new Uri("/auth/session", UriKind.Relative), Cancellation);
        restored.EnsureSuccessStatusCode();
        using var session = JsonDocument.Parse(await restored.Content.ReadAsStringAsync(Cancellation));
        Assert.True(session.RootElement.GetProperty("authenticated").GetBoolean());
        Assert.Equal("Browser Person", session.RootElement.GetProperty("profile").GetProperty("name").GetString());
        Assert.Equal(AccountPage, session.RootElement.GetProperty("accountUrl").GetString());
        var accessToken = session.RootElement.GetProperty("accessToken").GetString();
        Assert.False(string.IsNullOrWhiteSpace(accessToken));

        using var listRequest = new HttpRequestMessage(HttpMethod.Get, "/api/v1/workspaces");
        listRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        var workspaces = await _client.SendAsync(listRequest, Cancellation);
        workspaces.EnsureSuccessStatusCode();
        using var listed = JsonDocument.Parse(await workspaces.Content.ReadAsStringAsync(Cancellation));
        var rows = listed.RootElement.GetProperty("items");
        Assert.Equal(1, rows.GetArrayLength());
        Assert.Equal("personal", rows[0].GetProperty("kind").GetString());

        var principalId = DeterministicProvisioningId.Principal(
            Nix.Domain.Tenancy.TenantId.From(M0SchemaSeed.Alpha.TenantId),
            Issuer,
            Subject);
        var personalWorkspace = DeterministicProvisioningId.PersonalWorkspace(principalId);
        Assert.Equal(personalWorkspace.Value, rows[0].GetProperty("id").GetGuid());

        using var logoutRequest = new HttpRequestMessage(HttpMethod.Post, "/auth/logout");
        logoutRequest.Headers.TryAddWithoutValidation("Origin", PublicOrigin);
        var logout = await _client.SendAsync(logoutRequest, Cancellation);
        Assert.Equal(HttpStatusCode.NoContent, logout.StatusCode);

        var anonymous = await _client.GetAsync(new Uri("/auth/session", UriKind.Relative), Cancellation);
        using var ended = JsonDocument.Parse(await anonymous.Content.ReadAsStringAsync(Cancellation));
        Assert.False(ended.RootElement.GetProperty("authenticated").GetBoolean());
        Assert.Equal(JsonValueKind.Null, ended.RootElement.GetProperty("accountUrl").ValueKind);

        using var staleRequest = new HttpRequestMessage(HttpMethod.Get, "/api/v1/workspaces");
        staleRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        var stale = await _client.SendAsync(staleRequest, Cancellation);
        Assert.Equal(HttpStatusCode.Unauthorized, stale.StatusCode);
    }

    [Fact]
    public async Task Native_login_hands_off_a_one_time_code_and_redeem_sets_the_session_once()
    {
        var verifier = NewVerifier();
        var callback = await NativeCallbackAsync(Challenge(verifier));
        Assert.Equal(HttpStatusCode.Redirect, callback.StatusCode);
        var location = callback.Headers.Location?.OriginalString ?? "";
        Assert.StartsWith("app.nix.shell://auth?code=", location, StringComparison.Ordinal);
        var code = location["app.nix.shell://auth?code=".Length..];
        Assert.Matches("^[A-Za-z0-9_-]{43}$", code);
        Assert.False(callback.Headers.TryGetValues("Set-Cookie", out var cookies)
            && cookies.Any(value => value.StartsWith("__Host-nix_session=", StringComparison.Ordinal)));
        Assert.False(await IsSignedInAsync());

        Assert.Equal(0L, await CountAsync($"SELECT count(*) FROM native_login_handoff WHERE payload LIKE '%nixsession_%' OR code_hash = '{code}'"));
        Assert.Equal(1L, await CountAsync("SELECT count(*) FROM native_login_handoff"));

        var redeemed = await RedeemAsync(code, verifier);
        Assert.Equal(HttpStatusCode.NoContent, redeemed.StatusCode);
        Assert.Contains("no-store", redeemed.Headers.CacheControl?.ToString(), StringComparison.Ordinal);
        Assert.Contains(redeemed.Headers.GetValues("Set-Cookie"), value =>
            value.StartsWith("__Host-nix_session=", StringComparison.Ordinal)
            && value.Contains("secure", StringComparison.OrdinalIgnoreCase)
            && value.Contains("httponly", StringComparison.OrdinalIgnoreCase)
            && value.Contains("samesite=lax", StringComparison.OrdinalIgnoreCase));
        Assert.True(await IsSignedInAsync());

        await AssertRefusedAsync(await RedeemAsync(code, verifier));
    }

    [Fact]
    public async Task The_native_authorize_request_forces_a_fresh_login_and_the_normal_one_does_not()
    {
        var native = await _client.GetAsync(
            new Uri($"/auth/login?native={Challenge(NewVerifier())}&returnTo=%2F", UriKind.Relative), Cancellation);
        Assert.Equal("login", QueryHelpers.ParseQuery(native.Headers.Location!.Query)["prompt"].ToString());

        var normal = await _client.GetAsync(new Uri("/auth/login?returnTo=%2F", UriKind.Relative), Cancellation);
        Assert.False(QueryHelpers.ParseQuery(normal.Headers.Location!.Query).ContainsKey("prompt"));
    }

    [Fact]
    public async Task One_account_holds_at_most_three_live_handoffs_and_expired_ones_free_the_quota()
    {
        for (var i = 0; i < 3; i++)
        {
            Assert.StartsWith("app.nix.shell://auth?code=", (await NativeCallbackAsync(Challenge(NewVerifier()))).Headers.Location!.OriginalString, StringComparison.Ordinal);
        }

        var refused = await NativeCallbackAsync(Challenge(NewVerifier()));
        Assert.Equal(HttpStatusCode.ServiceUnavailable, refused.StatusCode);
        Assert.Equal(3L, await CountAsync("SELECT count(*) FROM native_login_handoff"));

        await SqlAsync("UPDATE native_login_handoff SET expires_at = now() - interval '1 second'");
        Assert.Equal(HttpStatusCode.Redirect, (await NativeCallbackAsync(Challenge(NewVerifier()))).StatusCode);
    }

    [Fact]
    public async Task Redeeming_purges_other_expired_handoffs()
    {
        await NativeCodeAsync(Challenge(NewVerifier()));
        var verifier = NewVerifier();
        var code = await NativeCodeAsync(Challenge(verifier));
        await SqlAsync("UPDATE native_login_handoff SET expires_at = now() - interval '1 second' WHERE code_hash <> '" + BrowserSessionSecret.Hash(code) + "'");

        Assert.Equal(HttpStatusCode.NoContent, (await RedeemAsync(code, verifier)).StatusCode);
        Assert.Equal(0L, await CountAsync("SELECT count(*) FROM native_login_handoff"));
    }

    [Fact]
    public async Task A_wrong_verifier_is_refused_and_burns_the_code()
    {
        var verifier = NewVerifier();
        var code = await NativeCodeAsync(Challenge(verifier));

        await AssertRefusedAsync(await RedeemAsync(code, NewVerifier()));
        await AssertRefusedAsync(await RedeemAsync(code, verifier));
        Assert.False(await IsSignedInAsync());
    }

    [Fact]
    public async Task An_expired_code_is_refused()
    {
        var verifier = NewVerifier();
        var code = await NativeCodeAsync(Challenge(verifier));
        await SqlAsync("UPDATE native_login_handoff SET expires_at = now() - interval '1 second'");

        await AssertRefusedAsync(await RedeemAsync(code, verifier));
        Assert.False(await IsSignedInAsync());
    }

    [Fact]
    public async Task Concurrent_redeems_succeed_exactly_once()
    {
        var verifier = NewVerifier();
        var code = await NativeCodeAsync(Challenge(verifier));

        var results = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => RedeemAsync(code, verifier)));

        Assert.Single(results, response => response.StatusCode == HttpStatusCode.NoContent);
        Assert.Equal(11, results.Count(response => response.StatusCode == HttpStatusCode.BadRequest));
    }

    [Theory]
    [InlineData("short")]
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+")]
    [InlineData("")]
    public async Task A_malformed_native_challenge_is_refused_like_other_bad_login_input(string challenge)
    {
        ArgumentNullException.ThrowIfNull(challenge);
        var response = await _client.GetAsync(
            new Uri($"/auth/login?native={Uri.EscapeDataString(challenge)}&returnTo=%2F", UriKind.Relative), Cancellation);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Null(response.Headers.Location);
    }

    [Theory]
    [InlineData("https://other.example.test")]
    [InlineData("")]
    public async Task Redeem_requires_the_exact_configured_origin(string origin)
    {
        ArgumentNullException.ThrowIfNull(origin);
        var verifier = NewVerifier();
        var code = await NativeCodeAsync(Challenge(verifier));

        var refused = await RedeemAsync(code, verifier, origin);
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await RedeemAsync(code, verifier)).StatusCode);
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("{}")]
    [InlineData("""{"code":1,"verifier":2}""")]
    public async Task Malformed_redeem_bodies_get_the_same_refusal(string body)
    {
        ArgumentNullException.ThrowIfNull(body);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/auth/native/redeem")
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
        request.Headers.TryAddWithoutValidation("Origin", PublicOrigin);
        await AssertRefusedAsync(await _client.SendAsync(request, Cancellation));
    }

    private static string NewVerifier() => Base64UrlTextEncoder.Encode(RandomNumberGenerator.GetBytes(48));

    private static string Challenge(string verifier) =>
        Base64UrlTextEncoder.Encode(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));

    private async Task<HttpResponseMessage> NativeCallbackAsync(string challenge)
    {
        var login = await _client.GetAsync(
            new Uri($"/auth/login?native={challenge}&returnTo=%2F", UriKind.Relative), Cancellation);
        Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);
        var query = QueryHelpers.ParseQuery(login.Headers.Location!.Query);
        _provider.Nonce = query["nonce"].ToString();
        return await _client.GetAsync(
            new Uri($"/auth/callback?code=provider-code&state={Uri.EscapeDataString(query["state"].ToString())}", UriKind.Relative),
            Cancellation);
    }

    private async Task<string> NativeCodeAsync(string challenge)
    {
        var callback = await NativeCallbackAsync(challenge);
        return callback.Headers.Location!.OriginalString["app.nix.shell://auth?code=".Length..];
    }

    private async Task<HttpResponseMessage> RedeemAsync(string code, string verifier, string origin = PublicOrigin)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/auth/native/redeem")
        {
            Content = JsonContent.Create(new { code, verifier }),
        };
        request.Headers.TryAddWithoutValidation("Origin", origin);
        return await _client.SendAsync(request, Cancellation);
    }

    private static async Task AssertRefusedAsync(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
        Assert.Equal("invalid_handoff", body.RootElement.GetProperty("code").GetString());
    }

    private async Task<bool> IsSignedInAsync()
    {
        var response = await _client.GetAsync(new Uri("/auth/session", UriKind.Relative), Cancellation);
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
        return body.RootElement.GetProperty("authenticated").GetBoolean();
    }

    private async Task SqlAsync(string sql)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, sql);
        }
    }

    private async Task<long> CountAsync(string sql)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            return await RawSql.CountAsync(connection, null, sql);
        }
    }

    [Fact]
    public async Task Browser_session_mutations_require_the_exact_configured_origin()
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/auth/token");
        request.Headers.TryAddWithoutValidation("Origin", "https://other.example.test");

        var response = await _client.SendAsync(request, Cancellation);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
        Assert.Equal("auth.cross_origin_refused", body.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public async Task Browser_session_resolvers_are_narrow_owned_and_stop_returning_revoked_rows()
    {
        var migrator = await _fixture.OpenMigratorConnectionAsync();
        await using (migrator.ConfigureAwait(false))
        {
            var definitions = await RawSql.TextListAsync(migrator,
                """
                SELECT p.proname || '|' || owner.rolname || '|' || p.prosecdef::text || '|'
                    || coalesce(array_to_string(p.proconfig, ','), '') || '|'
                    || has_function_privilege('public', p.oid, 'EXECUTE')::text || '|'
                    || has_function_privilege('nix_app', p.oid, 'EXECUTE')::text
                  FROM pg_proc p
                  JOIN pg_namespace n ON n.oid = p.pronamespace
                  JOIN pg_roles owner ON owner.oid = p.proowner
                 WHERE n.nspname = 'public'
                   AND p.proname IN (
                       'nix_resolve_browser_session_by_hash',
                       'nix_resolve_browser_session_by_id')
                 ORDER BY p.proname
                """);

            Assert.Equal(2, definitions.Count);
            Assert.All(definitions, definition =>
            {
                Assert.Contains("|nix_migrator|true|search_path=pg_catalog, public, pg_temp|", definition, StringComparison.Ordinal);
                Assert.EndsWith("|false|true", definition, StringComparison.Ordinal);
            });
        }

        var tokenHash = new string('a', BrowserSession.TokenHashLength);
        var runtime = new NpgsqlConnection(_fixture.ApplicationConnectionString);
        await using (runtime.ConfigureAwait(false))
        {
            await runtime.OpenAsync(Cancellation);
            Assert.Equal(1, await RawSql.CountAsync(
                runtime,
                null,
                $"SELECT count(*) FROM nix_resolve_browser_session_by_hash('{tokenHash}')"));
        }

        var revoke = await _fixture.OpenMigratorConnectionAsync();
        await using (revoke.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(revoke, null,
                $"""
                UPDATE browser_session
                   SET revoked_at = now()
                 WHERE token_hash = '{tokenHash}'
                """);
        }

        var after = new NpgsqlConnection(_fixture.ApplicationConnectionString);
        await using (after.ConfigureAwait(false))
        {
            await after.OpenAsync(Cancellation);
            Assert.Equal(0, await RawSql.CountAsync(
                after,
                null,
                $"SELECT count(*) FROM nix_resolve_browser_session_by_hash('{tokenHash}')"));
        }
    }

    private static string Jwks(RSA rsa, string keyId)
    {
        var parameters = rsa.ExportParameters(false);
        return JsonSerializer.Serialize(new
        {
            keys = new[]
            {
                new
                {
                    kty = "RSA",
                    use = "sig",
                    alg = "RS256",
                    kid = keyId,
                    n = Base64UrlEncoder.Encode(parameters.Modulus),
                    e = Base64UrlEncoder.Encode(parameters.Exponent),
                },
            },
        });
    }

    private sealed class ConfiguredApplicationFactory(
        string connectionString,
        string coreSigningKey,
        string jwksUri,
        ProviderHandler provider,
        string jwks) : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseSetting("ConnectionStrings:Nix", connectionString);
            builder.UseSetting("Nix:Bff:Authority", Issuer);
            builder.UseSetting("Nix:Bff:ClientId", ClientId);
            builder.UseSetting("Nix:Bff:PublicOrigin", PublicOrigin);
            builder.UseSetting("Nix:Bff:AccountPage", AccountPage);
            builder.UseSetting(SelfIssuedTokenService.IssuerConfigurationKey, "https://core.browser.test");
            builder.UseSetting(SelfIssuedTokenService.AudienceConfigurationKey, "nix");
            builder.UseSetting(SelfIssuedTokenService.KeyIdConfigurationKey, "browser-core-key");
            builder.UseSetting(SelfIssuedTokenService.SigningKeyConfigurationKey, coreSigningKey);
            builder.ConfigureTestServices(services =>
            {
                services.AddHttpClient(BrowserAuthOptions.HttpClientName)
                    .ConfigurePrimaryHttpMessageHandler(() => provider);

                services.RemoveAll<IUserInfoClient>();
                services.AddScoped<IUserInfoClient>(_ => new UserInfoClient(
                    new HttpClient(new UserInfoHandler()),
                    TimeSpan.FromSeconds(5)));

                services.RemoveAll<NixTokenValidator>();
                services.AddScoped(serviceProvider => new NixTokenValidator(
                    serviceProvider.GetRequiredService<IIdentityDirectory>(),
                    serviceProvider.GetRequiredService<SelfIssuedTokenService>(),
                    new HttpClient(new JwksHandler(jwksUri, jwks)),
                    TimeProvider.System));
            });
        }
    }

    private sealed class ProviderHandler(
        string issuer,
        string clientId,
        string subject,
        RSA key,
        string keyId) : HttpMessageHandler
    {
        public string Nonce { get; set; } = string.Empty;

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            if (request.Method == HttpMethod.Get
                && request.RequestUri?.AbsolutePath == "/.well-known/openid-configuration")
            {
                return Task.FromResult(Json(new
                {
                    issuer,
                    authorization_endpoint = $"{issuer}/authorize",
                    token_endpoint = $"{issuer}/token",
                }));
            }

            if (request.Method == HttpMethod.Post && request.RequestUri?.AbsolutePath == "/token")
            {
                Assert.False(string.IsNullOrWhiteSpace(Nonce));
                return Task.FromResult(Json(new
                {
                    access_token = SignedToken(includeNonce: false),
                    id_token = SignedToken(includeNonce: true),
                }));
            }

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
        }

        private string SignedToken(bool includeNonce)
        {
            var claims = new List<Claim> { new("sub", subject) };
            if (includeNonce)
            {
                claims.Add(new Claim("nonce", Nonce));
            }

            var descriptor = new SecurityTokenDescriptor
            {
                Issuer = issuer,
                Audience = clientId,
                Subject = new ClaimsIdentity(claims),
                Expires = DateTime.UtcNow.AddMinutes(5),
                SigningCredentials = new SigningCredentials(
                    new RsaSecurityKey(key) { KeyId = keyId },
                    SecurityAlgorithms.RsaSha256),
            };
            return new JwtSecurityTokenHandler().CreateEncodedJwt(descriptor);
        }

        private static HttpResponseMessage Json(object value) => new(HttpStatusCode.OK)
        {
            Content = new StringContent(JsonSerializer.Serialize(value), Encoding.UTF8, "application/json"),
        };
    }

    private sealed class UserInfoHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Assert.Equal("Bearer", request.Headers.Authorization?.Scheme);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    $"{{\"sub\":\"{Subject}\",\"name\":\"Browser Person\","
                    + "\"email\":\"browser@example.test\",\"email_verified\":true}",
                    Encoding.UTF8,
                    "application/json"),
            });
        }
    }

    private sealed class JwksHandler(string expectedUri, string jwks) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Assert.Equal(expectedUri, request.RequestUri?.AbsoluteUri);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(jwks, Encoding.UTF8, "application/json"),
            });
        }
    }
}
