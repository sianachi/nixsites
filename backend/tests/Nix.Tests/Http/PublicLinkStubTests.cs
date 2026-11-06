using System.Net;
using Nix.Tests.Harness;

namespace Nix.Tests.Http;

/// <summary>
/// The anonymous public-link routes answer without a tenant or a token: they sit outside
/// <c>/api/v1</c>, so the unit of work never runs for them (the public form precedent). Until
/// their lanes land they answer a coded 501.
/// </summary>
public sealed class PublicLinkStubTests(ContractHostFactory factory)
    : IClassFixture<ContractHostFactory>
{
    [Theory]
    [InlineData("/public/v1/links/some-token")]
    [InlineData("/public/v1/links/some-token/files/00000000-0000-4000-8000-000000000001")]
    public async Task An_anonymous_link_route_answers_501_without_credentials(string path)
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        using var client = factory.CreateClient();

        using var response = await client.GetAsync(new Uri(path, UriKind.Relative), cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);

        Assert.Equal(HttpStatusCode.NotImplemented, response.StatusCode);
        Assert.Contains("public_links.not_implemented", body, StringComparison.Ordinal);
    }
}
