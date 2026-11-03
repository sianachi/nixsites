using System.Net;
using System.Text;
using Microsoft.Extensions.Options;
using Nix.Authentication;
using Nix.Domain.Identity;

namespace Nix.Tests.Authentication;

public sealed class BrowserAuthBoundaryTests
{
    [Fact]
    public void Opaque_session_secrets_are_prefixed_random_and_only_hashes_are_stored()
    {
        var first = BrowserSessionSecret.Mint();
        var second = BrowserSessionSecret.Mint();

        Assert.StartsWith(BrowserSessionSecret.Prefix, first.Token, StringComparison.Ordinal);
        Assert.NotEqual(first.Token, second.Token);
        Assert.NotEqual(first.Hash, second.Hash);
        Assert.Equal(64, first.Hash.Length);
        Assert.Equal(first.Hash, BrowserSessionSecret.Hash(first.Token));
        Assert.Matches("^[0-9a-f]{64}$", first.Hash);
        Assert.DoesNotContain(first.Token, first.Hash, StringComparison.Ordinal);
    }

    [Fact]
    public void A_browser_session_lasts_thirty_days_unless_configured_shorter()
    {
        Assert.Equal(30 * 24, new BrowserAuthOptions().SessionHours);
        Assert.Equal(30 * 24, BrowserAuthOptions.MaxSessionHours);
    }

    [Theory]
    [InlineData("https://nix.example.test", true)]
    [InlineData("http://localhost:5173", true)]
    [InlineData("http://127.0.0.1:5173", true)]
    [InlineData("http://nix.localhost", true)]
    [InlineData("http://nixlocalhost", false)]
    [InlineData("http://nix.example.test", false)]
    [InlineData("https://user@example.test", false)]
    [InlineData("https://nix.example.test/path", false)]
    [InlineData("https://nix.example.test?query=1", false)]
    public void Browser_origins_are_https_except_for_explicit_loopback_development(
        string origin,
        bool expected)
    {
        var options = new BrowserAuthOptions
        {
            Authority = "https://issuer.example.test",
            ClientId = "client",
            PublicOrigin = origin,
        };

        Assert.Equal(expected, options.IsConfigured);
    }

    [Theory]
    [InlineData("https://issuer.example.test/ui/console/users/me", true)]
    [InlineData("http://localhost:8300/ui/console/users/me", true)]
    [InlineData("https://issuer.example.test/account?tab=security", true)]
    [InlineData("", false)]
    [InlineData("/ui/console/users/me", false)]
    [InlineData("http://issuer.example.test/ui/console/users/me", false)]
    [InlineData("https://user@issuer.example.test/ui/console", false)]
    [InlineData("https://issuer.example.test/ui/console#me", false)]
    [InlineData("javascript:alert(1)", false)]
    public void Account_pages_are_absolute_https_except_for_explicit_loopback_development(
        string account,
        bool expected)
    {
        var options = new BrowserAuthOptions { AccountPage = account };

        Assert.Equal(expected, options.TryAccountPage(out _));
    }

    [Fact]
    public async Task Exact_same_origin_discovery_is_accepted_and_cached()
    {
        using var handler = new ResponseHandler(_ => Json("""
            {
              "issuer":"https://issuer.example.test",
              "authorization_endpoint":"https://issuer.example.test/authorize",
              "token_endpoint":"https://issuer.example.test/oauth/token"
            }
            """));
        using var client = new HttpClient(handler);
        using var metadata = new OidcMetadataClient(
            new StaticClientFactory(client),
            Options.Create(TestOptions()));

        var first = await metadata.GetAsync(TestContext.Current.CancellationToken);
        var second = await metadata.GetAsync(TestContext.Current.CancellationToken);

        Assert.Equal("https://issuer.example.test/authorize", first.AuthorizationEndpoint.AbsoluteUri);
        Assert.Same(first, second);
        Assert.Equal(1, handler.Requests);
    }

    [Theory]
    [InlineData("https://other.example.test/authorize", "https://issuer.example.test/token")]
    [InlineData("https://issuer.example.test/authorize", "https://issuer.example.test:444/token")]
    [InlineData("https://user@issuer.example.test/authorize", "https://issuer.example.test/token")]
    [InlineData("https://issuer.example.test/authorize#fragment", "https://issuer.example.test/token")]
    public async Task Cross_origin_credentials_fragments_and_ports_are_refused(
        string authorizationEndpoint,
        string tokenEndpoint)
    {
        using var handler = new ResponseHandler(_ => Json($$"""
            {
              "issuer":"https://issuer.example.test",
              "authorization_endpoint":"{{authorizationEndpoint}}",
              "token_endpoint":"{{tokenEndpoint}}"
            }
            """));
        using var client = new HttpClient(handler);
        using var metadata = new OidcMetadataClient(
            new StaticClientFactory(client),
            Options.Create(TestOptions()));

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => metadata.GetAsync(TestContext.Current.CancellationToken).AsTask());
    }

    [Fact]
    public async Task Oversized_discovery_is_refused_before_json_parsing()
    {
        var oversized = new string('x', (32 * 1024) + 1);
        using var handler = new ResponseHandler(_ => Json(oversized));
        using var client = new HttpClient(handler);
        using var metadata = new OidcMetadataClient(
            new StaticClientFactory(client),
            Options.Create(TestOptions()));

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => metadata.GetAsync(TestContext.Current.CancellationToken).AsTask());
    }

    private static BrowserAuthOptions TestOptions() => new()
    {
        Authority = "https://issuer.example.test",
        ClientId = "client",
        PublicOrigin = "https://nix.example.test",
    };

    private static HttpResponseMessage Json(string payload) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(payload, Encoding.UTF8, "application/json"),
    };

    private sealed class StaticClientFactory(HttpClient client) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => client;
    }

    private sealed class ResponseHandler(Func<HttpRequestMessage, HttpResponseMessage> response)
        : HttpMessageHandler
    {
        public int Requests { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Requests++;
            return Task.FromResult(response(request));
        }
    }
}
