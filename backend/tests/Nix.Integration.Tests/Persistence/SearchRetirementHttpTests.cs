using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.Search;

namespace Nix.Integration.Tests.Persistence;

/// <summary>The retired indexer cannot read projections or enqueue rebuild work.</summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class SearchRetirementHttpTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private const string InternalSecret = "search-retirement-http-secret";
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        _factory = new ConfiguredApplicationFactory(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Nix"] = fixture.ApplicationConnectionString,
            [InternalBoundaryMiddleware.SecretConfigurationKey] = InternalSecret,
            ["Nix:Search:OpenSearchEnabled"] = "true",
            ["Nix:Search:OpenSearchUrl"] = "https://retired-search.example.test/",
        });
        _client = _factory.CreateClient();
    }

    public async ValueTask DisposeAsync()
    {
        _client.Dispose();
        await _factory.DisposeAsync();
    }

    [Fact]
    public void Legacy_configuration_keeps_the_authoritative_Postgres_search_provider()
    {
        using var scope = _factory.Services.CreateScope();
        Assert.IsType<ItemSearch>(scope.ServiceProvider.GetRequiredService<IItemSearch>());
    }

    [Theory]
    [InlineData("GET", "/internal/worker-dispatch/index/items/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222")]
    [InlineData("GET", "/internal/worker-dispatch/index/items/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/body")]
    [InlineData("GET", "/internal/worker-dispatch/index/status")]
    [InlineData("POST", "/internal/worker-dispatch/index/rebuild")]
    public async Task Retired_routes_return_not_found_even_with_the_internal_secret(string method, string path)
    {
        using var request = new HttpRequestMessage(new HttpMethod(method), path);
        request.Headers.TryAddWithoutValidation(InternalBoundaryMiddleware.SecretHeaderName, InternalSecret);
        if (method == "POST")
        {
            request.Content = JsonContent.Create(new { limit = 1 });
        }

        using var response = await _client.SendAsync(request, Cancellation);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
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
