using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Features.Search;
using Nix.Features.Tokens;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The suggestion routes through the real pipeline: the <c>/api/v1</c> route family's unit of
/// work, the personal-access-token scope ceiling, the request body bound and the problem mapping.
/// </summary>
/// <remarks>
/// <para>
/// The persistence suite (<see cref="SearchSuggestionAuthorizationTests"/>) proves what the
/// statements return. This one proves what only the pipeline decides: that a POST which reads is
/// classified as a read, so a read-only token may call it and a write-only token may not; that an
/// oversized passage is refused with its stable code and a 400; that the largest legitimate
/// request is accepted; that mention lookups spend their own rate-limit window rather than the one
/// writes share; and that the richer hit reaches the wire with the field names the client parses.
/// The 413 itself cannot be provoked here - the in-memory TestServer never enforces a body bound -
/// so <c>EndpointHardeningTests</c> proves the route declares its bound and that the worst-case
/// legitimate body fits under it.
/// </para>
/// </remarks>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class SearchSuggestionHttpTests : IAsyncLifetime
{
    private const int SuggestionsPerMinute = 3;

    private readonly NixPostgresFixture _fixture;
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;

    public SearchSuggestionHttpTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        string signingKey;
        using (var key = ECDsa.Create(ECCurve.NamedCurves.nistP256))
        {
            signingKey = key.ExportECPrivateKeyPem();
        }

        _factory = new ConfiguredApplicationFactory(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Nix"] = _fixture.ApplicationConnectionString,
            [InternalBoundaryMiddleware.SecretConfigurationKey] = "search-suggestion-http-internal-secret",
            [SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.search-suggestion-http.test",
            [SelfIssuedTokenService.AudienceConfigurationKey] = "nix",
            [SelfIssuedTokenService.KeyIdConfigurationKey] = "search-suggestion-http-key",
            [SelfIssuedTokenService.SigningKeyConfigurationKey] = signingKey,
            ["Nix:Collaboration:BaseUrl"] = "http://127.0.0.1:8100",
            ["Nix:ObjectStorage:Endpoint"] = "http://127.0.0.1:7070",
            ["Nix:ObjectStorage:Region"] = "us-east-1",
            ["Nix:ObjectStorage:Bucket"] = "nix-objects",
            ["Nix:ObjectStorage:AccessKey"] = "suggest-access",
            ["Nix:ObjectStorage:SecretKey"] = "suggest-secret",

            // Small enough that one test can exhaust it; the other tests make at most one lookup.
            ["Nix:RateLimits:SuggestionsPerMinute"] = SuggestionsPerMinute.ToString(CultureInfo.InvariantCulture),
        });
        _client = _factory.CreateClient();
    }

    public async ValueTask DisposeAsync()
    {
        _client.Dispose();
        await _factory.DisposeAsync();
    }

    [Fact]
    public async Task A_read_only_token_may_match_mentions_and_gets_the_richer_hit()
    {
        var token = await AccessTokenAsync("suggest-read", AccessTokenScopes.Read);
        var title = await SeededTitleAsync();

        using var response = await SendAsync(
            HttpMethod.Post,
            "/api/v1/search/mentions",
            token,
            new { text = $"Before we start: {title}.", workspaceId = M0SchemaSeed.Alpha.WorkspaceId });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
        var mention = Assert.Single(body.RootElement.GetProperty("mentions").EnumerateArray());
        var item = mention.GetProperty("item");
        Assert.Equal(M0SchemaSeed.Alpha.ItemId, item.GetProperty("id").GetGuid());
        Assert.Equal(JsonValueKind.Null, item.GetProperty("parentId").ValueKind);
        Assert.Equal(JsonValueKind.String, item.GetProperty("updatedAt").ValueKind);
        Assert.Equal(title, mention.GetProperty("phrase").GetString());
        Assert.False(body.RootElement.GetProperty("truncated").GetBoolean());
    }

    [Fact]
    public async Task A_write_only_token_may_not_match_mentions()
    {
        // Scopes are independent: an ingest token that may write must not be able to read titles
        // back through a route that only happens to be a POST.
        var token = await AccessTokenAsync("suggest-write", AccessTokenScopes.Write);

        using var response = await SendAsync(
            HttpMethod.Post,
            "/api/v1/search/mentions",
            token,
            new { text = "Anything at all", workspaceId = M0SchemaSeed.Alpha.WorkspaceId });

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task An_oversized_passage_is_a_400_with_its_stable_code()
    {
        var token = await AccessTokenAsync("suggest-oversize", AccessTokenScopes.Read);

        using var response = await SendAsync(
            HttpMethod.Post,
            "/api/v1/search/mentions",
            token,
            new
            {
                text = new string('a', FindMentionsHandler.MaximumTextLength + 1),
                workspaceId = M0SchemaSeed.Alpha.WorkspaceId,
            });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("search.mention_text_too_long", await HttpProblem.CodeAsync(response));
    }

    [Fact]
    public async Task The_longest_legitimate_request_fits_under_the_body_limit()
    {
        var token = await AccessTokenAsync("suggest-largest", AccessTokenScopes.Read);

        // Every character of the longest passage escaped as \uXXXX by the serialiser, plus the
        // most exclusions: the request a well-behaved client can send at worst must be accepted.
        var exclusions = Enumerable.Range(0, FindMentionsHandler.MaximumExclusions).Select(_ => Guid.NewGuid()).ToArray();
        using var response = await SendAsync(
            HttpMethod.Post,
            "/api/v1/search/mentions",
            token,
            new
            {
                text = new string('<', FindMentionsHandler.MaximumTextLength),
                workspaceId = M0SchemaSeed.Alpha.WorkspaceId,
                excludeIds = exclusions,
            });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task A_request_naming_no_workspace_is_a_400_with_its_stable_code()
    {
        var token = await AccessTokenAsync("suggest-no-workspace", AccessTokenScopes.Read);

        using var response = await SendAsync(HttpMethod.Post, "/api/v1/search/mentions", token, new { text = "Project Atlas" });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("search.mention_workspace_required", await HttpProblem.CodeAsync(response));
    }

    [Fact]
    public async Task Too_many_exclusions_are_a_400_with_their_stable_code()
    {
        var token = await AccessTokenAsync("suggest-exclusions", AccessTokenScopes.Read);
        var exclusions = Enumerable.Range(0, FindMentionsHandler.MaximumExclusions + 1).Select(_ => Guid.NewGuid()).ToArray();

        using var response = await SendAsync(
            HttpMethod.Post,
            "/api/v1/search/mentions",
            token,
            new { text = "Project Atlas", workspaceId = M0SchemaSeed.Alpha.WorkspaceId, excludeIds = exclusions });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("search.too_many_mention_exclusions", await HttpProblem.CodeAsync(response));
    }

    [Fact]
    public async Task Mention_lookups_meet_their_own_limit_with_a_429_and_leave_writes_alone()
    {
        var reader = await AccessTokenAsync("suggest-burst", AccessTokenScopes.Read);
        var writer = await AccessTokenAsync("suggest-burst-write", AccessTokenScopes.Write);
        var lookup = new { text = "Project Atlas", workspaceId = M0SchemaSeed.Alpha.WorkspaceId };

        for (var attempt = 0; attempt < SuggestionsPerMinute; attempt++)
        {
            using var allowed = await SendAsync(HttpMethod.Post, "/api/v1/search/mentions", reader, lookup);
            Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
        }

        using var refused = await SendAsync(HttpMethod.Post, "/api/v1/search/mentions", reader, lookup);
        Assert.Equal(HttpStatusCode.TooManyRequests, refused.StatusCode);
        Assert.Equal("request.rate_limited", await HttpProblem.CodeAsync(refused));
        Assert.True(refused.Headers.RetryAfter?.Delta > TimeSpan.Zero);

        // Same address, same minute: a burst of suggestions must not cost the person their saves.
        using var write = await SendAsync(
            HttpMethod.Post,
            $"/api/v1/workspaces/{M0SchemaSeed.Alpha.WorkspaceId:D}/items",
            writer,
            new { type = "note", title = "Written after the burst", parentId = (Guid?)null });
        Assert.Equal(HttpStatusCode.Created, write.StatusCode);
    }

    [Fact]
    public async Task A_missing_text_finds_nothing_rather_than_failing()
    {
        var token = await AccessTokenAsync("suggest-empty", AccessTokenScopes.Read);

        using var response = await SendAsync(
            HttpMethod.Post,
            "/api/v1/search/mentions",
            token,
            new { workspaceId = M0SchemaSeed.Alpha.WorkspaceId });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
        Assert.Empty(body.RootElement.GetProperty("mentions").EnumerateArray());
    }

    [Fact]
    public async Task Related_items_of_an_unknown_item_are_a_404_with_the_items_code()
    {
        var token = await AccessTokenAsync("suggest-related", AccessTokenScopes.Read);

        using var response = await SendAsync(
            HttpMethod.Get,
            $"/api/v1/items/{Guid.NewGuid():D}/related",
            token);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("items.not_found", await HttpProblem.CodeAsync(response));
    }

    [Fact]
    public async Task Related_items_of_a_readable_item_answer_with_the_published_shape()
    {
        var token = await AccessTokenAsync("suggest-related-shape", AccessTokenScopes.Read);

        using var response = await SendAsync(
            HttpMethod.Get,
            $"/api/v1/items/{M0SchemaSeed.Alpha.ItemId:D}/related?limit=500",
            token);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));

        // The seeded item links only to itself, which is never its own co-citation.
        Assert.Empty(body.RootElement.GetProperty("related").EnumerateArray());
        Assert.Equal(GetRelatedItemsHandler.MaximumLimit, body.RootElement.GetProperty("limit").GetInt32());
        Assert.False(body.RootElement.GetProperty("truncated").GetBoolean());
    }

    private async Task<string> SeededTitleAsync()
    {
        // The shared seed leaves its item unnamed; give it a title a passage can mention.
        const string title = "Quarterly Planning";
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $"UPDATE item SET properties = '{{\"title\": \"{title}\"}}'::jsonb "
                + $"WHERE id = '{M0SchemaSeed.Alpha.ItemId:D}'::uuid");
        }

        return title;
    }

    private async Task<string> AccessTokenAsync(string name, string scope)
    {
        await using var work = await _fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation);
        var result = await work.Resolve<NixDispatcher>().SendAsync<CreateAccessToken, IssuedAccessToken>(
            new CreateAccessToken(name, [scope], 1),
            Cancellation);
        Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : string.Empty);
        await work.CommitAsync(Cancellation);
        using var exchange = await _client.PostAsJsonAsync(
            "/public/v1/auth/token",
            new { token = result.Value.Secret },
            Cancellation);
        exchange.EnsureSuccessStatusCode();
        using var body = JsonDocument.Parse(await exchange.Content.ReadAsStringAsync(Cancellation));
        return body.RootElement.GetProperty("accessToken").GetString()!;
    }

    private async Task<HttpResponseMessage> SendAsync(
        HttpMethod method,
        string path,
        string bearer,
        object? body = null)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        return await _client.SendAsync(request, Cancellation);
    }

    private sealed class ConfiguredApplicationFactory(Dictionary<string, string?> settings)
        : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
        {
            foreach (var (key, value) in settings)
            {
                builder.UseSetting(key, value);
            }
        }
    }
}
