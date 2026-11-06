using System.Net;
using System.Text;
using Microsoft.Extensions.Configuration;
using Nix.Features.Exports;

namespace Nix.Tests.Features;

/// <summary>Naming the exported revision never replaces a name a person already gave it.</summary>
public sealed class ExportRevisionNamerTests
{
    private static readonly Guid ItemId = Guid.Parse("0a000000-0000-4000-8000-000000000001");

    [Fact]
    public async Task A_revision_that_already_has_a_name_is_left_alone()
    {
        using var collab = new Collab("""{"versions":[{"seq":7,"name":"Signed off by Ada"}]}""");

        var named = await Namer(collab).EnsureNamedAsync(ItemId, 7, "Exported to PDF", "caller-token", TestContext.Current.CancellationToken);

        Assert.True(named);
        Assert.Empty(collab.Posts);
    }

    [Fact]
    public async Task An_unnamed_revision_is_named_with_the_callers_bearer()
    {
        using var collab = new Collab("""{"versions":[{"seq":3,"name":"Earlier"}]}""");

        var named = await Namer(collab).EnsureNamedAsync(ItemId, 7, "Exported to PDF", "caller-token", TestContext.Current.CancellationToken);

        Assert.True(named);
        Assert.Equal(["""{"seq":7,"name":"Exported to PDF"}"""], collab.Posts);
        Assert.Equal("Bearer caller-token", collab.Authorization);
    }

    [Fact]
    public async Task A_refusal_from_collab_is_reported_not_swallowed()
    {
        using var collab = new Collab("""{"versions":[]}""", postStatus: HttpStatusCode.NotFound);

        Assert.False(await Namer(collab).EnsureNamedAsync(ItemId, 7, "Exported to PDF", "caller-token", TestContext.Current.CancellationToken));
    }

    private static ExportRevisionNamer Namer(HttpMessageHandler handler)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Nix:Collaboration:BaseUrl"] = "http://localhost:8100",
        }).Build();
#pragma warning disable CA2000 // Justification: the client lives as long as the test and shares the scripted handler, which the test disposes.
        return new ExportRevisionNamer(new HttpClient(handler, disposeHandler: false), configuration);
#pragma warning restore CA2000
    }

    private sealed class Collab(string versions, HttpStatusCode postStatus = HttpStatusCode.Created) : HttpMessageHandler
    {
        public List<string> Posts { get; } = [];

        public string? Authorization { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Assert.Equal($"/documents/{ItemId:D}/versions", request.RequestUri!.AbsolutePath);
            Authorization = request.Headers.Authorization!.ToString();
            if (request.Method == HttpMethod.Post)
            {
                Posts.Add(await request.Content!.ReadAsStringAsync(cancellationToken));
                return new HttpResponseMessage(postStatus);
            }
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(versions, Encoding.UTF8, "application/json") };
        }
    }
}
