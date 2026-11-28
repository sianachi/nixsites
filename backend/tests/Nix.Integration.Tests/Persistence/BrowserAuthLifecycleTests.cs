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
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class BrowserAuthLifecycleTests : IAsyncLifetime
{
    private const string Issuer = "https://issuer.alpha.test";
    private const string ClientId = "nix-browser-test";
    private const string Subject = "browser-user-without-azp";
    private const string PublicOrigin = "https://nix.browser.test";
    private const string IssuerParameter = "&iss=https%3A%2F%2Fnix.browser.test";
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
        Assert.EndsWith(IssuerParameter, location, StringComparison.Ordinal);
        var code = location["app.nix.shell://auth?code=".Length..^IssuerParameter.Length];
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
        Assert.Equal(HttpStatusCode.TooManyRequests, refused.StatusCode);
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

    // ---- OAuth sign-in for remote MCP -------------------------------------------------------------------------

    private const string Redirect = "https://connector.test/callback";

    private async Task<string> SignInAsync()
    {
        var login = await _client.GetAsync(new Uri("/auth/login?returnTo=%2F", UriKind.Relative), Cancellation);
        var query = QueryHelpers.ParseQuery(login.Headers.Location!.Query);
        _provider.Nonce = query["nonce"].ToString();
        var callback = await _client.GetAsync(
            new Uri($"/auth/callback?code=provider-code&state={Uri.EscapeDataString(query["state"].ToString())}", UriKind.Relative),
            Cancellation);
        Assert.Equal(HttpStatusCode.Redirect, callback.StatusCode);
        var restored = await _client.GetAsync(new Uri("/auth/session", UriKind.Relative), Cancellation);
        using var session = JsonDocument.Parse(await restored.Content.ReadAsStringAsync(Cancellation));
        return session.RootElement.GetProperty("accessToken").GetString()!;
    }

    private static readonly string[] UnsafeRedirects = ["http://connector.test/cb", "https://connector.test/cb#frag", "custom://cb", "https://evil.test/cb\njavascript://claude.ai/%0Aalert(1)"];
    private static readonly string[] ReadWrite = ["read", "write"];
    private static readonly string[] AllScopes = ["read", "write", "admin"];

    private async Task<HttpResponseMessage> PostAsync(string path, string? bearer, object body)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, path);
        request.Content = body is Dictionary<string, string> form ? new FormUrlEncodedContent(form) : JsonContent.Create(body);
        if (bearer is not null)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        }

        return await _client.SendAsync(request, Cancellation);
    }

    private async Task<string> RegisterAsync(string redirect = Redirect)
    {
        var response = await PostAsync("/api/v1/oauth/register", null, (new { client_name = "ChatGPT", redirect_uris = new[] { redirect } }));
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
        return body.RootElement.GetProperty("client_id").GetString()!;
    }

    private Task<HttpResponseMessage> ConsentAsync(string bearer, string clientId, string challenge, string decision = "approve", string redirect = Redirect, string? resource = null) =>
        PostAsync("/api/v1/oauth/consent", bearer, (new
        {
            clientId,
            redirectUri = redirect,
            codeChallenge = challenge,
            codeChallengeMethod = "S256",
            state = "xyz",
            resource,
            decision,
            token = new { scopes = ReadWrite },
        }));

    private async Task<string> ApproveAsync(string bearer, string clientId, string challenge)
    {
        var response = await ConsentAsync(bearer, clientId, challenge);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
        var target = new Uri(body.RootElement.GetProperty("redirectTo").GetString()!);
        Assert.StartsWith(Redirect, target.OriginalString, StringComparison.Ordinal);
        var query = QueryHelpers.ParseQuery(target.Query);
        Assert.Equal("xyz", query["state"]);
        Assert.Equal(PublicOrigin, query["iss"]);
        return query["code"].ToString();
    }

    private Task<HttpResponseMessage> OAuthTokenAsync(string code, string clientId, string verifier, string redirect = Redirect, string? resource = null)
    {
        var form = new Dictionary<string, string>
        {
            ["grant_type"] = "authorization_code",
            ["code"] = code,
            ["client_id"] = clientId,
            ["redirect_uri"] = redirect,
            ["code_verifier"] = verifier,
        };
        if (resource is not null)
        {
            form["resource"] = resource;
        }

        return PostAsync("/api/v1/oauth/token", null, form);
    }

    private static async Task<string?> OAuthErrorAsync(HttpResponseMessage response)
    {
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
        return body.RootElement.GetProperty("error").GetString();
    }

    [Fact]
    public async Task Discovery_documents_name_this_install()
    {
        using var resource = JsonDocument.Parse(await _client.GetStringAsync(new Uri("/.well-known/oauth-protected-resource/mcp", UriKind.Relative), Cancellation));
        Assert.Equal(PublicOrigin + "/mcp", resource.RootElement.GetProperty("resource").GetString());
        Assert.Equal(PublicOrigin, resource.RootElement.GetProperty("authorization_servers")[0].GetString());

        using var server = JsonDocument.Parse(await _client.GetStringAsync(new Uri("/.well-known/oauth-authorization-server", UriKind.Relative), Cancellation));
        Assert.Equal(PublicOrigin + "/oauth/authorize", server.RootElement.GetProperty("authorization_endpoint").GetString());
        Assert.Equal(PublicOrigin + "/api/v1/oauth/token", server.RootElement.GetProperty("token_endpoint").GetString());
        Assert.Equal("S256", server.RootElement.GetProperty("code_challenge_methods_supported")[0].GetString());
        Assert.Equal(PublicOrigin, server.RootElement.GetProperty("issuer").GetString());
        Assert.True(server.RootElement.GetProperty("authorization_response_iss_parameter_supported").GetBoolean());
    }

    [Theory]
    [InlineData("Nix")]
    [InlineData("Nix Settings")]
    [InlineData("\u202E\u200B")]
    public async Task Registration_refuses_names_that_pose_as_nix_or_show_nothing(string name)
    {
        var response = await PostAsync("/api/v1/oauth/register", null, (new { client_name = name, redirect_uris = new[] { Redirect } }));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("invalid_client_metadata", await OAuthErrorAsync(response));
    }

    [Fact]
    public async Task Registration_refuses_unsafe_redirect_uris()
    {
        foreach (var redirect in UnsafeRedirects)
        {
            var response = await PostAsync("/api/v1/oauth/register", null, (new { client_name = "X", redirect_uris = new[] { redirect } }));
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Equal("invalid_redirect_uri", await OAuthErrorAsync(response));
        }

        Assert.NotEmpty(await RegisterAsync("http://127.0.0.1:8080/cb"));
    }

    [Fact]
    public async Task A_person_approves_a_client_and_it_redeems_the_code_once_for_a_working_token()
    {
        await SqlAsync("UPDATE tenant SET mcp_enabled = true");
        var bearer = await SignInAsync();
        var clientId = await RegisterAsync();
        // RFC 7636 allows '.' and '~' in a verifier; the MCP SDK's generator uses them.
        var verifier = "ab.cd~" + NewVerifier();

        var preview = await PostAsync("/api/v1/oauth/consent/preview", bearer, (new
        {
            clientId,
            redirectUri = Redirect,
            codeChallenge = Challenge(verifier),
            codeChallengeMethod = "S256",
            resource = PublicOrigin + "/mcp",
        }));
        Assert.Equal(HttpStatusCode.OK, preview.StatusCode);
        using (var shown = JsonDocument.Parse(await preview.Content.ReadAsStringAsync(Cancellation)))
        {
            Assert.Equal("ChatGPT", shown.RootElement.GetProperty("clientName").GetString());
            Assert.Equal("connector.test", shown.RootElement.GetProperty("redirectHost").GetString());
        }

        var code = await ApproveAsync(bearer, clientId, Challenge(verifier));
        Assert.Equal(0L, await CountAsync("SELECT count(*) FROM personal_access_token WHERE name = 'ChatGPT via connector.test (connector)'"));
        Assert.Equal(0L, await CountAsync($"SELECT count(*) FROM oauth_authorization_code WHERE code_hash = '{code}'"));

        var redeemed = await OAuthTokenAsync(code, clientId, verifier, resource: PublicOrigin + "/mcp");
        Assert.Equal(HttpStatusCode.OK, redeemed.StatusCode);
        Assert.Equal("no-store", redeemed.Headers.CacheControl?.ToString());
        using var token = JsonDocument.Parse(await redeemed.Content.ReadAsStringAsync(Cancellation));
        var secret = token.RootElement.GetProperty("access_token").GetString()!;
        Assert.StartsWith("nixpat_", secret, StringComparison.Ordinal);
        Assert.Equal("Bearer", token.RootElement.GetProperty("token_type").GetString());
        Assert.Equal(90 * 86400, token.RootElement.GetProperty("expires_in").GetInt64());
        Assert.Equal(1L, await CountAsync("SELECT count(*) FROM personal_access_token WHERE name = 'ChatGPT via connector.test (connector)'"));

        // The token is an ordinary personal access token: it buys a session that reads workspaces.
        var exchanged = await PostAsync("/public/v1/auth/token", null, (new { token = secret }));
        exchanged.EnsureSuccessStatusCode();
        using var session = JsonDocument.Parse(await exchanged.Content.ReadAsStringAsync(Cancellation));
        using var list = new HttpRequestMessage(HttpMethod.Get, "/api/v1/workspaces");
        list.Headers.Authorization = new AuthenticationHeaderValue("Bearer", session.RootElement.GetProperty("accessToken").GetString());
        Assert.Equal(HttpStatusCode.OK, (await _client.SendAsync(list, Cancellation)).StatusCode);

        // A second redemption of the same code finds nothing.
        var again = await OAuthTokenAsync(code, clientId, verifier);
        Assert.Equal(HttpStatusCode.BadRequest, again.StatusCode);
        Assert.Equal("invalid_grant", await OAuthErrorAsync(again));
    }

    [Fact]
    public async Task A_wrong_verifier_a_wrong_redirect_or_an_expired_code_is_refused_and_leaves_no_token()
    {
        await SqlAsync("UPDATE tenant SET mcp_enabled = true");
        var bearer = await SignInAsync();
        var clientId = await RegisterAsync();
        var verifier = NewVerifier();

        var wrongVerifier = await OAuthTokenAsync(await ApproveAsync(bearer, clientId, Challenge(verifier)), clientId, NewVerifier());
        Assert.Equal("invalid_grant", await OAuthErrorAsync(wrongVerifier));

        var wrongRedirect = await OAuthTokenAsync(await ApproveAsync(bearer, clientId, Challenge(verifier)), clientId, verifier, redirect: "https://other.test/cb");
        Assert.Equal("invalid_grant", await OAuthErrorAsync(wrongRedirect));

        var expired = await ApproveAsync(bearer, clientId, Challenge(verifier));
        await SqlAsync("UPDATE oauth_authorization_code SET expires_at = now() - interval '1 second'");
        Assert.Equal("invalid_grant", await OAuthErrorAsync(await OAuthTokenAsync(expired, clientId, verifier)));

        var wrongResource = await OAuthTokenAsync(await ApproveAsync(bearer, clientId, Challenge(verifier)), clientId, verifier, resource: "https://elsewhere.test/mcp");
        Assert.Equal("invalid_target", await OAuthErrorAsync(wrongResource));

        Assert.Equal(0L, await CountAsync("SELECT count(*) FROM personal_access_token WHERE name = 'ChatGPT via connector.test (connector)'"));
    }

    [Fact]
    public async Task Consent_refuses_unregistered_redirects_unknown_clients_and_returns_access_denied_on_deny()
    {
        await SqlAsync("UPDATE tenant SET mcp_enabled = true");
        var bearer = await SignInAsync();
        var clientId = await RegisterAsync();
        var challenge = Challenge(NewVerifier());

        var elsewhere = await ConsentAsync(bearer, clientId, challenge, redirect: "https://evil.test/cb");
        Assert.Equal(HttpStatusCode.BadRequest, elsewhere.StatusCode);
        var unknown = await ConsentAsync(bearer, "not-a-client", challenge);
        Assert.Equal(HttpStatusCode.BadRequest, unknown.StatusCode);

        var denied = await ConsentAsync(bearer, clientId, challenge, decision: "deny");
        using var body = JsonDocument.Parse(await denied.Content.ReadAsStringAsync(Cancellation));
        Assert.Equal(Redirect + "?error=access_denied&state=xyz" + IssuerParameter, body.RootElement.GetProperty("redirectTo").GetString());
        Assert.Equal(0L, await CountAsync("SELECT count(*) FROM oauth_authorization_code"));
    }

    private const string ConnectorTokens = "FROM personal_access_token WHERE name = 'ChatGPT via connector.test (connector)'";

    private async Task<string> ConnectAsync(string bearer, string clientId)
    {
        var verifier = NewVerifier();
        var redeemed = await OAuthTokenAsync(await ApproveAsync(bearer, clientId, Challenge(verifier)), clientId, verifier);
        Assert.Equal(HttpStatusCode.OK, redeemed.StatusCode);
        using var token = JsonDocument.Parse(await redeemed.Content.ReadAsStringAsync(Cancellation));
        return token.RootElement.GetProperty("access_token").GetString()!;
    }

    [Fact]
    public async Task Reconnecting_keeps_the_three_newest_connector_tokens_and_revokes_the_oldest()
    {
        await SqlAsync("UPDATE tenant SET mcp_enabled = true");
        var bearer = await SignInAsync();
        var clientId = await RegisterAsync();

        var first = await ConnectAsync(bearer, clientId);
        for (var i = 0; i < 3; i++)
        {
            await ConnectAsync(bearer, clientId);
        }

        Assert.Equal(4L, await CountAsync("SELECT count(*) " + ConnectorTokens));
        Assert.Equal(3L, await CountAsync("SELECT count(*) " + ConnectorTokens + " AND revoked_at IS NULL"));
        var exchanged = await PostAsync("/public/v1/auth/token", null, (new { token = first }));
        Assert.Equal(HttpStatusCode.Unauthorized, exchanged.StatusCode);
    }

    [Fact]
    public async Task Approval_is_refused_at_the_token_cap_unless_reconnecting_frees_a_slot()
    {
        await SqlAsync("UPDATE tenant SET mcp_enabled = true");
        var bearer = await SignInAsync();
        var clientId = await RegisterAsync();
        for (var i = 0; i < 3; i++)
        {
            await ConnectAsync(bearer, clientId);
        }

        // Fill the person to the cap of 25 live tokens.
        await SqlAsync(
            """
            INSERT INTO personal_access_token (token_id, tenant_id, principal_id, name, lookup, secret_hash, scopes, created_at, expires_at)
            SELECT gen_random_uuid(), owner.tenant_id, owner.principal_id, 'filler ' || g, 'filler' || g, decode('0304', 'hex'), ARRAY['read']::text[], now(), now() + interval '30 days'
              FROM (SELECT tenant_id, principal_id FROM personal_access_token WHERE name LIKE 'ChatGPT via %' LIMIT 1) owner,
                   generate_series(1, 22) g
            """);

        // The same connector reconnecting retires its oldest token, so it still fits.
        await ConnectAsync(bearer, clientId);

        // Another connector would need a 26th: refused before any code exists.
        var codes = await CountAsync("SELECT count(*) FROM oauth_authorization_code");
        var other = await RegisterAsync("https://other.test/cb");
        var refused = await ConsentAsync(bearer, other, Challenge(NewVerifier()), redirect: "https://other.test/cb");
        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        using var problem = JsonDocument.Parse(await refused.Content.ReadAsStringAsync(Cancellation));
        Assert.Equal("tokens.limit_reached", problem.RootElement.GetProperty("code").GetString());
        Assert.Contains("Settings > Access tokens", problem.RootElement.GetProperty("detail").GetString(), StringComparison.Ordinal);
        Assert.Equal(codes, await CountAsync("SELECT count(*) FROM oauth_authorization_code"));
    }

    [Fact]
    public async Task A_personal_access_token_cannot_approve_a_client()
    {
        await SqlAsync("UPDATE tenant SET mcp_enabled = true");
        var bearer = await SignInAsync();
        var created = await PostAsync("/api/v1/me/tokens", bearer, (new { name = "automation", scopes = AllScopes, expiresInDays = 7 }));
        created.EnsureSuccessStatusCode();
        using var minted = JsonDocument.Parse(await created.Content.ReadAsStringAsync(Cancellation));
        var exchanged = await PostAsync("/public/v1/auth/token", null, (new { token = minted.RootElement.GetProperty("token").GetString() }));
        using var session = JsonDocument.Parse(await exchanged.Content.ReadAsStringAsync(Cancellation));

        var response = await ConsentAsync(session.RootElement.GetProperty("accessToken").GetString()!, await RegisterAsync(), Challenge(NewVerifier()));
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal(0L, await CountAsync("SELECT count(*) FROM oauth_authorization_code"));
    }

    [Fact]
    public async Task Consent_is_refused_when_the_organisation_turned_mcp_off()
    {
        await SqlAsync("UPDATE tenant SET mcp_enabled = false");
        var response = await ConsentAsync(await SignInAsync(), await RegisterAsync(), Challenge(NewVerifier()));
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
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
        return callback.Headers.Location!.OriginalString["app.nix.shell://auth?code=".Length..^IssuerParameter.Length];
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
            builder.UseSetting("Nix:Mcp:PublicUrl", PublicOrigin + "/mcp");
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
