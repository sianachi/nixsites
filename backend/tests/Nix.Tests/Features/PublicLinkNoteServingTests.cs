using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Features.PublicLinks.Notes;

namespace Nix.Tests.Features;

/// <summary>The token binding and the short servable-id cache of a public note link.</summary>
public sealed class PublicLinkNoteServingTests
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Fact]
    public void Only_the_renderers_own_file_routes_get_the_token()
    {
        const string html =
            """<a href="https://attacker.example/x?t=__TOKEN__">x</a><img src="/public/v1/links/__TOKEN__/files/abc">""";

        var bound = PublicNoteServing.BindToken(html, "tok/en");

        Assert.Contains("https://attacker.example/x?t=__TOKEN__", bound, StringComparison.Ordinal);
        Assert.Contains("src=\"/public/v1/links/tok%2Fen/files/abc\"", bound, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_second_file_request_reuses_the_render_but_a_new_link_renders_again()
    {
        var reader = new CountingReader(Guid.NewGuid());
        var link = Link();

        var first = await PublicNoteServing.ServableIdsAsync(reader, link, Cancellation);
        var second = await PublicNoteServing.ServableIdsAsync(reader, link, Cancellation);
        await PublicNoteServing.ServableIdsAsync(reader, Link(), Cancellation);

        Assert.Equal(first, second);
        Assert.Equal(2, reader.Renders);
    }

    private static ResolvedPublicLink Link() => new(
        Guid.NewGuid(), TenantId.From(Guid.NewGuid()), WorkspaceId.Create(), ItemId.From(Guid.NewGuid()), null, Guid.NewGuid());

    private sealed class CountingReader(Guid file) : IPublicNoteReader
    {
        public int Renders { get; private set; }

        public ValueTask<PublicNoteRender?> RenderAsync(ResolvedPublicLink link, CancellationToken cancellationToken)
        {
            Renders++;
            return ValueTask.FromResult<PublicNoteRender?>(new PublicNoteRender("t", "<p/>", [file], []));
        }
    }
}
