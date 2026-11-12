using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc.Testing;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Features.Tokens;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Runs the pet's structure-rule fixture
/// (<c>packages/structure-spec/fixtures/rule-parity.json</c>) against Core's real HTTP schema and
/// view endpoints: <c>PUT /api/v1/items/{id}/schema</c> and <c>PUT /api/v1/items/{id}/views</c>.
/// </summary>
/// <remarks>
/// <para>
/// Deliberately over HTTP rather than by calling <c>PropertySchemaRules.Refuse</c> or
/// <c>SetContainerViewsHandler.Validate</c> directly from a unit test: the request contracts that
/// carry a fixture case onto those rules (<c>SetSchemaRequest</c>, <c>PropertyDefinitionRequest</c>,
/// <c>SetViewsRequest</c>, <c>ViewRequest</c>, and the mapping between them and the domain) are
/// internal to <c>Nix.Api</c>, and this repository has an explicit, documented decision against
/// opening internals to test projects with <c>InternalsVisibleTo</c> (see the CA1515 justification
/// in <c>Nix.Api.csproj</c>). Driving the real endpoint exercises the same mapping and the same
/// rules without reaching around that boundary.
/// </para>
/// <para>
/// A case whose verdict disagrees with what Core actually does is not fixed here: this test
/// reports the disagreement (case id, expected verdict, observed status) and leaves both the
/// fixture and Core alone. Divergence is a finding for whoever owns the side that drifted, not
/// something a parity test should paper over.
/// </para>
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class StructureRuleParityHttpTests : IAsyncLifetime
{
    private readonly NixPostgresFixture _fixture;
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;

    public StructureRuleParityHttpTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static IReadOnlyList<RuleParityCase> Cases => CasesLazy.Value;

    private static readonly Lazy<List<RuleParityCase>> CasesLazy = new(LoadCases);

    /// <summary>One xunit theory row per fixture case id.</summary>
    public static TheoryData<string> CaseIds
    {
        get
        {
            var data = new TheoryData<string>();
            foreach (var ruleCase in Cases)
            {
                data.Add(ruleCase.Id);
            }

            return data;
        }
    }

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
            [SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.structure-rule-parity.test",
            [SelfIssuedTokenService.AudienceConfigurationKey] = "nix",
            [SelfIssuedTokenService.KeyIdConfigurationKey] = "structure-rule-parity-key",
            [SelfIssuedTokenService.SigningKeyConfigurationKey] = signingKey,
        });
        _client = _factory.CreateClient();
    }

    public async ValueTask DisposeAsync()
    {
        _client.Dispose();
        await _factory.DisposeAsync();
    }

    [Theory]
    [MemberData(nameof(CaseIds))]
    public async Task Each_fixture_case_matches_Cores_verdict(string caseId)
    {
        var ruleCase = Cases.Single(candidate => candidate.Id == caseId);
        var token = await AccessTokenAsync($"rule-parity-{caseId}");
        var itemId = await CreateScratchItemAsync(token);

        using (var schemaResponse = await SendRawAsync(
            HttpMethod.Put, $"/api/v1/items/{itemId}/schema", token, ruleCase.SchemaJson))
        {
            var expectedOk = ruleCase.ExpectSchema == "ok";
            var observedOk = schemaResponse.StatusCode == HttpStatusCode.OK;
            Assert.True(
                expectedOk == observedOk,
                $"case '{caseId}': schema expected '{ruleCase.ExpectSchema}', Core answered "
                + $"{(int)schemaResponse.StatusCode} {schemaResponse.StatusCode}.");
            if (!expectedOk)
            {
                Assert.Equal(HttpStatusCode.UnprocessableEntity, schemaResponse.StatusCode);
            }
        }

        if (ruleCase.ViewsScope != "parity")
        {
            // Client-only: the fixture's expected views verdict depends on the effective schema at
            // the destination (for example, a board grouped by a property that turns out not to be
            // a select), which Core's write-time view validation does not check - it is checked
            // when views are read back, not when they are stored. Asserting it here would fail
            // against a Core answer that is correct for what the write path actually validates.
            return;
        }

        using (var viewsResponse = await SendRawAsync(
            HttpMethod.Put, $"/api/v1/items/{itemId}/views", token, ruleCase.ViewsJson))
        {
            var expectedOk = ruleCase.ExpectViews == "ok";
            var observedOk = viewsResponse.StatusCode == HttpStatusCode.OK;
            Assert.True(
                expectedOk == observedOk,
                $"case '{caseId}': views expected '{ruleCase.ExpectViews}', Core answered "
                + $"{(int)viewsResponse.StatusCode} {viewsResponse.StatusCode}.");
            if (!expectedOk)
            {
                Assert.Equal(HttpStatusCode.UnprocessableEntity, viewsResponse.StatusCode);
            }
        }
    }

    [Fact]
    public async Task Item_listing_reports_the_default_view_kind()
    {
        var token = await AccessTokenAsync("item-default-view-kind");
        var itemId = await CreateScratchItemAsync(token);
        var viewsPath = $"/api/v1/items/{itemId}/views";
        var listPath = $"/api/v1/workspaces/{M0SchemaSeed.Alpha.WorkspaceId:D}/items?parentId={M0SchemaSeed.Alpha.ItemId:D}";
        var views = new[]
        {
            new { id = "all", name = "All", kind = "list" },
            new { id = "cards", name = "Cards", kind = "gallery" },
        };

        using var saved = await SendAsync(HttpMethod.Put, viewsPath, token, new { views, @default = "cards" });
        saved.EnsureSuccessStatusCode();
        Assert.Equal("gallery", await ReadListedKindAsync());

        using var changed = await SendAsync(HttpMethod.Put, viewsPath, token, new { views, @default = "document" });
        changed.EnsureSuccessStatusCode();
        Assert.Null(await ReadListedKindAsync());

        async Task<string?> ReadListedKindAsync()
        {
            using var listed = await SendAsync(HttpMethod.Get, listPath, token);
            listed.EnsureSuccessStatusCode();
            using var body = JsonDocument.Parse(await listed.Content.ReadAsStringAsync(Cancellation));
            return body.RootElement.GetProperty("items").EnumerateArray()
                .Single(item => item.GetProperty("id").GetString() == itemId)
                .GetProperty("defaultViewKind").GetString();
        }
    }

    private async Task<string> CreateScratchItemAsync(string bearer)
    {
        using var created = await SendAsync(
            HttpMethod.Post,
            $"/api/v1/workspaces/{M0SchemaSeed.Alpha.WorkspaceId:D}/items",
            bearer,
            new { type = "note", title = "Rule parity scratch", parentId = M0SchemaSeed.Alpha.ItemId });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        using var body = JsonDocument.Parse(await created.Content.ReadAsStringAsync(Cancellation));
        return body.RootElement.GetProperty("id").GetString()!;
    }

    private async Task<string> AccessTokenAsync(string name)
    {
        await using var work = await _fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation);
        var result = await work.Resolve<NixDispatcher>().SendAsync<CreateAccessToken, IssuedAccessToken>(
            new CreateAccessToken(name, [AccessTokenScopes.Read, AccessTokenScopes.Write], 1),
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

    /// <summary>
    /// Sends a fixture case's body verbatim rather than round-tripping it through an anonymous
    /// object: the fixture is already shaped exactly like the wire contract
    /// (<c>SetSchemaRequest</c> / <c>SetViewsRequest</c>), and re-serializing it through a mapped
    /// C# type is the very shortcut this test exists to avoid.
    /// </summary>
    private async Task<HttpResponseMessage> SendRawAsync(
        HttpMethod method,
        string path,
        string bearer,
        string jsonBody)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        request.Content = new StringContent(jsonBody, Encoding.UTF8, "application/json");
        return await _client.SendAsync(request, Cancellation);
    }

    private sealed record RuleParityCase(
        string Id,
        string SchemaJson,
        string ViewsJson,
        string ViewsScope,
        string ExpectSchema,
        string ExpectViews);

    private static List<RuleParityCase> LoadCases()
    {
        var path = FixturePath();
        var json = File.ReadAllText(path);
        var root = JsonNode.Parse(json) as JsonObject
            ?? throw new InvalidOperationException($"{path} did not parse as a JSON object.");
        var cases = (JsonArray)root["cases"]!;

        var result = new List<RuleParityCase>(cases.Count);
        foreach (var node in cases)
        {
            var ruleCase = (JsonObject)node!;
            var expect = (JsonObject)ruleCase["expect"]!;

            // The fixture's "default" is always null today (no case names which view opens), and
            // its schema/views/expect shapes are read as-is: the schema object goes straight onto
            // the wire, and the views array is wrapped with "default" the way SetViewsRequest
            // expects.
            var viewsBody = new JsonObject
            {
                ["views"] = ruleCase["views"]!.DeepClone(),
                ["default"] = ruleCase["default"]?.DeepClone(),
            };

            result.Add(new RuleParityCase(
                (string)ruleCase["id"]!,
                ruleCase["schema"]!.ToJsonString(),
                viewsBody.ToJsonString(),
                (string)ruleCase["viewsScope"]!,
                (string)expect["schema"]!,
                (string)expect["views"]!));
        }

        return result;
    }

    /// <summary>
    /// The fixture is copied beside the test assembly so this test always consumes the exact
    /// committed file, independent of target framework, build configuration, or test runner cwd.
    /// </summary>
    private static string FixturePath()
    {
        var fixture = Path.Combine(AppContext.BaseDirectory, "Fixtures", "rule-parity.json");
        return File.Exists(fixture)
            ? fixture
            : throw new InvalidOperationException($"No rule parity fixture was copied to {fixture}.");
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
