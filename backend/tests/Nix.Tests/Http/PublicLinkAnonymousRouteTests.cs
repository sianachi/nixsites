using System.Net;
using Nix.Tests.Harness;

namespace Nix.Tests.Http;

/// <summary>
/// The anonymous public-link routes sit outside <c>/api/v1</c>, so they answer without a tenant or a
/// token. With the install flag off, the default, every one of them is a plain dead link.
/// </summary>
public sealed class PublicLinkAnonymousRouteTests(ContractHostFactory factory)
    : IClassFixture<ContractHostFactory>
{
    [Theory]
    [InlineData("/public/v1/links/some-token")]
    [InlineData("/public/v1/links/some-token/files/00000000-0000-4000-8000-000000000001")]
    public async Task An_anonymous_link_route_is_a_dead_link_when_public_links_are_off(string path)
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        using var client = factory.CreateClient();

        using var response = await client.GetAsync(new Uri(path, UriKind.Relative), cancellationToken);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }
}
