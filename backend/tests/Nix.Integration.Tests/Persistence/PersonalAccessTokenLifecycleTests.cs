using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Features.Tokens;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The whole credential's life, over real HTTP against a real database: minted, exchanged,
/// authenticating requests, refused by scope, and ended by revocation while an exchanged session
/// is still inside its lifetime.
/// </summary>
/// <remarks>
/// <para>
/// This suite hosts the actual <c>Program</c>, so every request crosses the same pipeline
/// production requests cross: forwarded headers, rate limiting, the unit-of-work middleware, the
/// self-issuer branch of token validation, the per-request row re-check, and row-level security
/// under the published session. It is the proof that revocation does not wait for a JWT to
/// expire - which is the property the ten-minute lifetime leans on.
/// </para>
/// <para>
/// No external issuer is involved anywhere: the personal access token is created through the use
/// case and the session it buys is signed by Core itself. That is exactly the deployment story,
/// and it is why this test can exist without a Zitadel container.
/// </para>
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class PersonalAccessTokenLifecycleTests : IAsyncLifetime
{
    private const string InternalSecret = "lifecycle-internal-secret-value";

    private readonly NixPostgresFixture _fixture;
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;

    public PersonalAccessTokenLifecycleTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);

        string signingKeyPem;
        using (var key = ECDsa.Create(ECCurve.NamedCurves.nistP256))
        {
            signingKeyPem = key.ExportECPrivateKeyPem();
        }

        _factory = new ConfiguredApplicationFactory(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Nix"] = _fixture.ApplicationConnectionString,
            ["Nix:InternalSecret"] = InternalSecret,
            [SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.nix.test",
            [SelfIssuedTokenService.AudienceConfigurationKey] = "nix",
            [SelfIssuedTokenService.KeyIdConfigurationKey] = "lifecycle-test-key",
            [SelfIssuedTokenService.SigningKeyConfigurationKey] = signingKeyPem,
        });
        _client = _factory.CreateClient();
    }

    public async ValueTask DisposeAsync()
    {
        _client.Dispose();
        await _factory.DisposeAsync();
    }

    [Fact]
    public async Task A_token_buys_a_session_and_revocation_ends_it_inside_the_session_s_lifetime()
    {
        var minted = await MintAsync("lifecycle", [AccessTokenScopes.Read], days: 30);

        var jwt = await ExchangeAsync(minted.Secret);

        var admitted = await GetAsync("/api/v1/me", jwt);
        Assert.Equal(HttpStatusCode.OK, admitted.StatusCode);

        await RevokeAsync(minted.Row.Id);

        // The JWT in hand is minutes from being minted and cryptographically as valid as ever.
        // The refusal below is the row re-check working, which is the entire design.
        var refused = await GetAsync("/api/v1/me", jwt);
        Assert.Equal(HttpStatusCode.Unauthorized, refused.StatusCode);
        Assert.Equal(
            AuthenticationRefusalCodes.TokenRevoked,
            await ProblemCodeAsync(refused));
    }

    [Fact]
    public async Task A_read_scoped_session_reads_but_cannot_write()
    {
        var minted = await MintAsync("read-only", [AccessTokenScopes.Read], days: 30);
        var jwt = await ExchangeAsync(minted.Secret);

        var read = await GetAsync(
            $"/api/v1/workspaces/{M0SchemaSeed.Alpha.WorkspaceId:D}/items",
            jwt);
        Assert.Equal(HttpStatusCode.OK, read.StatusCode);

        using var create = new HttpRequestMessage(
            HttpMethod.Post,
            $"/api/v1/workspaces/{M0SchemaSeed.Alpha.WorkspaceId:D}/items")
        {
            Content = JsonContent.Create(new { type = "note", title = "refused" }),
        };
        create.Headers.Authorization = new AuthenticationHeaderValue("Bearer", jwt);
        var write = await _client.SendAsync(create, Cancellation);

        Assert.Equal(HttpStatusCode.Forbidden, write.StatusCode);
        Assert.Equal(
            AuthenticationRefusalCodes.InsufficientScope,
            await ProblemCodeAsync(write));
    }

    [Fact]
    public async Task No_scope_lets_a_session_manage_tokens()
    {
        var minted = await MintAsync(
            "fully-scoped",
            [AccessTokenScopes.Read, AccessTokenScopes.Write, AccessTokenScopes.Admin],
            days: 30);
        var jwt = await ExchangeAsync(minted.Secret);

        var refused = await GetAsync("/api/v1/me/tokens", jwt);

        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Equal(
            AuthenticationRefusalCodes.InsufficientScope,
            await ProblemCodeAsync(refused));
    }

    [Fact]
    public async Task A_wrong_secret_is_one_uniform_refusal()
    {
        var minted = await MintAsync("guessed-at", [AccessTokenScopes.Read], days: 30);

        // Same lookup half, different secret half: the closest guess an attacker can make.
        var forged = minted.Secret[..^4] + (minted.Secret.EndsWith("aaaa", StringComparison.Ordinal)
            ? "bbbb"
            : "aaaa");

        var response = await _client.PostAsJsonAsync(
            "/public/v1/auth/token",
            new { token = forged },
            Cancellation);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal(
            AuthenticationRefusalCodes.Unauthenticated,
            await ProblemCodeAsync(response));
    }

    [Fact]
    public async Task A_revoked_token_cannot_buy_a_new_session_and_is_told_so()
    {
        var minted = await MintAsync("ended", [AccessTokenScopes.Read], days: 30);
        await RevokeAsync(minted.Row.Id);

        var response = await _client.PostAsJsonAsync(
            "/public/v1/auth/token",
            new { token = minted.Secret },
            Cancellation);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal(
            AuthenticationRefusalCodes.TokenRevoked,
            await ProblemCodeAsync(response));
    }

    [Fact]
    public async Task A_token_that_expires_ends_its_exchanged_session_too()
    {
        var minted = await MintAsync("expiring", [AccessTokenScopes.Read], days: 30);
        var jwt = await ExchangeAsync(minted.Secret);

        // Move the row's chosen expiry into the past, as time passing would. The JWT is still
        // valid; the row is not; the row wins.
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $"UPDATE personal_access_token SET expires_at = now() - interval '1 minute' "
                + $"WHERE token_id = '{minted.Row.Id.Value:D}'::uuid;");
        }

        var refused = await GetAsync("/api/v1/me", jwt);

        Assert.Equal(HttpStatusCode.Unauthorized, refused.StatusCode);
        Assert.Equal(
            AuthenticationRefusalCodes.TokenExpired,
            await ProblemCodeAsync(refused));
    }

    [Fact]
    public async Task The_exchanged_session_acts_as_the_issuing_principal_and_nobody_else()
    {
        var minted = await MintAsync("identity", [AccessTokenScopes.Read], days: 30);
        var jwt = await ExchangeAsync(minted.Secret);

        var me = await GetAsync("/api/v1/me", jwt);
        Assert.Equal(HttpStatusCode.OK, me.StatusCode);

        using var document = JsonDocument.Parse(await me.Content.ReadAsStringAsync(Cancellation));
        Assert.Equal(
            M0SchemaSeed.Alpha.PrincipalId.ToString("D"),
            document.RootElement.GetProperty("id").GetString());
    }

    [Fact]
    public async Task A_read_scoped_session_cannot_have_the_collaboration_service_write_its_body()
    {
        // The blocker the security review found: collab writes bodies on the strength of
        // GetItemAuthorization.CanWrite and never re-asks Core, so the scope ceiling has to reach
        // that answer. Both tokens act as the same editor principal; only the scope differs.
        var readOnly = await MintAsync("read-agent", [AccessTokenScopes.Read], days: 30);
        var writer = await MintAsync("write-agent", [AccessTokenScopes.Read, AccessTokenScopes.Write], days: 30);

        var readOnlyAnswer = await AuthorizeAsync(readOnly.Secret, M0SchemaSeed.Alpha.ItemId);
        var writerAnswer = await AuthorizeAsync(writer.Secret, M0SchemaSeed.Alpha.ItemId);

        // Both may open the item; only the write-scoped token may write it, even though the
        // principal behind both is an editor of the workspace.
        Assert.True(readOnlyAnswer.GetProperty("canRead").GetBoolean());
        Assert.False(readOnlyAnswer.GetProperty("canWrite").GetBoolean());
        Assert.True(writerAnswer.GetProperty("canRead").GetBoolean());
        Assert.True(writerAnswer.GetProperty("canWrite").GetBoolean());
    }

    private async Task<JsonElement> AuthorizeAsync(string secret, Guid itemId)
    {
        var jwt = await ExchangeAsync(secret);
        using var request = new HttpRequestMessage(HttpMethod.Get, $"/internal/authz/items/{itemId:D}");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", jwt);
        request.Headers.Add("x-nix-internal-secret", InternalSecret);

        var response = await _client.SendAsync(request, Cancellation);
        var body = await response.Content.ReadAsStringAsync(Cancellation);
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"authz answered {(int)response.StatusCode}: {body}");
        return JsonDocument.Parse(body).RootElement.Clone();
    }

    private async Task<IssuedAccessToken> MintAsync(string name, IReadOnlyList<string> scopes, int days)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .SendAsync<CreateAccessToken, IssuedAccessToken>(
                    new CreateAccessToken(name, scopes, days),
                    Cancellation);

            Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : string.Empty);
            await work.CommitAsync(Cancellation);
            return result.Value;
        }
    }

    private async Task RevokeAsync(PersonalAccessTokenId id)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .SendAsync<RevokeAccessToken, bool>(new RevokeAccessToken(id), Cancellation);

            Assert.True(result.IsSuccess);
            await work.CommitAsync(Cancellation);
        }
    }

    private async Task<string> ExchangeAsync(string secret)
    {
        var response = await _client.PostAsJsonAsync(
            "/public/v1/auth/token",
            new { token = secret },
            Cancellation);

        // The body rides the failure message because a bare status tells nobody why.
        var body = await response.Content.ReadAsStringAsync(Cancellation);
        Assert.True(
            response.StatusCode == HttpStatusCode.OK,
            $"Exchange answered {(int)response.StatusCode}: {body}");

        using var document = JsonDocument.Parse(body);
        var jwt = document.RootElement.GetProperty("accessToken").GetString();
        Assert.False(string.IsNullOrEmpty(jwt));
        return jwt;
    }

    private async Task<HttpResponseMessage> GetAsync(string path, string jwt)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", jwt);
        return await _client.SendAsync(request, Cancellation);
    }

    private static async Task<string?> ProblemCodeAsync(HttpResponseMessage response)
    {
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
        return document.RootElement.TryGetProperty("code", out var code) ? code.GetString() : null;
    }

    /// <summary>
    /// The real application with the container's connection string and a fresh signing key. A
    /// subclass rather than <c>WithWebHostBuilder</c> because the latter mints a second factory
    /// and leaves the first for the finalizer. <c>UseSetting</c> rather than an in-memory source,
    /// because settings flow into the minimal-hosting builder's initial configuration - present
    /// before <c>Program</c> reads the connection string - while a source added through
    /// <c>ConfigureAppConfiguration</c> lands after those reads have already answered.
    /// </summary>
}
