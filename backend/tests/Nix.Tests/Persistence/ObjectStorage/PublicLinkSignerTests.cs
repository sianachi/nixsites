using System.Web;
using Nix.Persistence.ObjectStorage;
using Nix.Tests.Support;

namespace Nix.Tests.Persistence.ObjectStorage;

public sealed class PublicLinkSignerTests
{
    private static readonly DateTimeOffset Instant = new(2026, 8, 31, 20, 15, 0, TimeSpan.Zero);

    [Fact]
    public void A_public_link_capability_lives_sixty_seconds_and_is_never_cached()
    {
        var capability = Signer(300).GetForPublicLink("files/a/b", "report.pdf", "application/pdf");

        Assert.Contains("X-Amz-Expires=60", capability.Url.Query, StringComparison.Ordinal);
        Assert.Equal(Instant.AddSeconds(60), capability.ExpiresAt);
        Assert.Equal("no-store", HttpUtility.ParseQueryString(capability.Url.Query)["response-cache-control"]);
    }

    [Fact]
    public void A_shorter_global_lifetime_still_wins()
    {
        var capability = Signer(30).GetForPublicLink("files/a/b", "report.pdf", "application/pdf");

        Assert.Contains("X-Amz-Expires=30", capability.Url.Query, StringComparison.Ordinal);
    }

    [Fact]
    public void Private_downloads_keep_the_global_lifetime()
    {
        var capability = Signer(300).GetForBrowser("files/a/b", "report.pdf", "application/pdf", inline: true);

        Assert.Contains("X-Amz-Expires=300", capability.Url.Query, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("application/pdf", true)]
    [InlineData("image/png", true)]
    [InlineData("image/jpeg", true)]
    [InlineData("image/webp", true)]
    [InlineData("image/avif", true)]
    [InlineData("image/svg+xml", false)]
    [InlineData("text/html", false)]
    [InlineData("application/xhtml+xml", false)]
    [InlineData("image/gif", false)]
    [InlineData("application/octet-stream", false)]
    [InlineData("application/pdf; charset=utf-8", false)]
    [InlineData("IMAGE/PNG", true)]
    public void Only_the_narrow_list_is_served_inline_and_everything_else_downloads(string mediaType, bool inline)
    {
        var query = HttpUtility.ParseQueryString(
            Signer(300).GetForPublicLink("files/a/b", "name.bin", mediaType).Url.Query);

        Assert.StartsWith(inline ? "inline;" : "attachment;", query["response-content-disposition"], StringComparison.Ordinal);
        Assert.Equal(inline ? mediaType : "application/octet-stream", query["response-content-type"]);
        Assert.Equal(inline, S3CapabilitySigner.ServesInlineOnPublicLink(mediaType));
    }

    private static S3CapabilitySigner Signer(int capabilitySeconds) =>
        new(
            new ObjectStorageOptions
            {
                Endpoint = new Uri("https://objects.test/api"),
                Region = "eu-west-2",
                Bucket = "nix-objects",
                AccessKey = "access",
                SecretKey = "secret",
                CapabilitySeconds = capabilitySeconds,
            },
            new FixedTimeProvider(Instant));
}
