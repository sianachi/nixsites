using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
using Nix.Authentication;
using Nix.Features.OAuth;

namespace Nix.Tests.Features.OAuth;

public sealed class OAuthClientsTests
{
    private static OAuthClients Clients() => new(new EphemeralDataProtectionProvider());

    [Fact]
    public void A_client_identifier_round_trips_and_a_forged_or_foreign_one_is_unknown()
    {
        var clients = Clients();
        var id = clients.Issue(new OAuthClients.Client("ChatGPT", ["https://a.test/cb", "http://127.0.0.1:9/cb"]));

        var read = clients.Read(id);
        Assert.NotNull(read);
        Assert.Equal("ChatGPT", read.Name);
        Assert.Equal(["https://a.test/cb", "http://127.0.0.1:9/cb"], read.RedirectUris);

        Assert.Null(clients.Read(id[..^2] + "AA"));
        Assert.Null(clients.Read("not-a-client"));
        Assert.Null(clients.Read(string.Empty));
        Assert.Null(clients.Read(new string('A', OAuthClients.MaxClientIdLength + 1)));
        Assert.Null(Clients().Read(id));
    }

    [Fact]
    public void The_largest_registration_stays_within_the_identifier_bound()
    {
        var uris = Enumerable.Range(0, OAuthClients.MaxRedirectUris).Select(i => "https://a.test/" + new string('x', 190) + i).ToArray();
        var id = Clients().Issue(new OAuthClients.Client(new string('n', OAuthClients.MaxNameLength), uris));
        Assert.True(id.Length <= OAuthClients.MaxClientIdLength, id.Length.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    [Theory]
    [InlineData("https://connector.test/cb", true)]
    [InlineData("https://connector.test/cb?x=1", true)]
    [InlineData("http://localhost:3000/cb", true)]
    [InlineData("http://127.0.0.1/cb", true)]
    [InlineData("http://[::1]:8080/cb", true)]
    [InlineData("http://connector.test/cb", false)]
    [InlineData("https://connector.test/cb#frag", false)]
    [InlineData("https://user:pw@connector.test/cb", false)]
    [InlineData("custom://cb", false)]
    [InlineData("https://evil.test/cb\njavascript://claude.ai/%0Aalert(1)", false)]
    [InlineData("https://evil.test/cb zz", false)]
    [InlineData("https://\u0441laude.ai/cb", false)]
    [InlineData("/relative", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void Redirect_uris_are_https_or_loopback_without_fragments(string? value, bool expected) =>
        Assert.Equal(expected, OAuthClients.IsRedirectUri(value));

    [Fact]
    public void A_signed_identifier_holding_an_unsafe_redirect_is_unknown()
    {
        var clients = Clients();
        Assert.Null(clients.Read(clients.Issue(new OAuthClients.Client("X", ["https://a.test/cb", "javascript://a.test/%0Aalert(1)"]))));
    }

    [Theory]
    [InlineData("https://app.test/cb", "app.test")]
    [InlineData("https://xn--laude-6xa.ai:8443/cb", "xn--laude-6xa.ai:8443")]
    [InlineData("http://[::1]:8080/cb", "[::1]:8080")]
    public void The_redirect_host_is_shown_in_ascii_with_any_port(string redirect, string expected) =>
        Assert.Equal(expected, OAuthClients.RedirectHost(redirect));

    [Theory]
    [InlineData("abc.def~ghi_jkl-mnoPQRSTUVWXYZ0123456789abcdefg", true)]
    [InlineData("tooshort", false)]
    [InlineData("abc+def/ghijklmnopqrstuvwxyzabcdefghijklmnopqrst", false)]
    public void A_verifier_follows_rfc_7636(string value, bool expected) =>
        Assert.Equal(expected, OAuthClients.IsVerifier(value));

    [Fact]
    public void Client_names_lose_control_characters_and_are_bounded()
    {
        Assert.Equal("Chat GPT", OAuthClients.CleanName(" Chat\u0007 GPT "));
        Assert.Null(OAuthClients.CleanName("\n\t"));
        Assert.Null(OAuthClients.CleanName(null));
        Assert.Equal(OAuthClients.MaxNameLength, OAuthClients.CleanName(new string('a', 500))!.Length);
    }

    [Theory]
    [InlineData("Evil\u202Egnp.exe", "Evilgnp.exe")] // bidi override (Cf)
    [InlineData("Ch\u200Bat\u2060GPT\uFEFF", "ChatGPT")] // zero-width and BOM (Cf)
    [InlineData("A\u2028B\u2029C", "ABC")] // line and paragraph separators
    [InlineData("App\uE000x", "Appx")] // private use (Co)
    [InlineData("App\u0378", "App")] // unassigned (Cn)
    [InlineData("\uFF23\uFF4C\uFF41\uFF55\uFF44\uFF45", "Claude")] // NFKC folds fullwidth letters
    [InlineData("  My \u00A0\u3000  App  ", "My App")] // whitespace collapses
    [InlineData("Robot \U0001F916", "Robot \U0001F916")] // a valid pair survives
    [InlineData("Nixie", "Nixie")]
    [InlineData("Phoenix", "Phoenix")]
    public void Client_names_drop_hidden_characters_and_normalise(string raw, string expected) =>
        Assert.Equal(expected, OAuthClients.CleanName(raw));

    [Theory]
    [InlineData("Nix")]
    [InlineData("nix")]
    [InlineData("Nix Settings")]
    [InlineData("NIX-helper")]
    [InlineData("Nix2")]
    [InlineData("\uFF2E\uFF49\uFF58")] // fullwidth, folded by NFKC
    [InlineData("N\u200Bix Settings")] // a hidden character does not split the word
    [InlineData("\u202E\u2066")] // nothing visible
    public void Names_that_present_the_client_as_nix_or_show_nothing_are_refused(string raw) =>
        Assert.Null(OAuthClients.CleanName(raw));

    [Fact]
    public void A_lone_surrogate_is_dropped_rather_than_breaking_normalisation() =>
        Assert.Equal("Appx", OAuthClients.CleanName("App" + '\uD800' + "x" + '\uDC00'));

    [Fact]
    public void Truncation_never_splits_a_surrogate_pair()
    {
        var name = OAuthClients.CleanName(new string('a', OAuthClients.MaxNameLength - 1) + "\U0001F916");
        Assert.Equal(new string('a', OAuthClients.MaxNameLength - 1), name);
    }

    [Fact]
    public void A_signed_identifier_with_an_old_unsafe_name_is_cleaned_or_refused()
    {
        var clients = Clients();
        Assert.Equal("Evilgnp", clients.Read(clients.Issue(new OAuthClients.Client("Evil\u202Egnp", ["https://a.test/cb"])))!.Name);
        Assert.Null(clients.Read(clients.Issue(new OAuthClients.Client("Nix Settings", ["https://a.test/cb"]))));
    }

    [Fact]
    public void Connector_token_names_carry_the_redirect_host_and_fit_the_token_name_limit()
    {
        Assert.Equal("ChatGPT via app.test (connector)", OAuthClients.ConnectorTokenName("ChatGPT", "app.test"));

        var midHost = new string('h', 37) + ".example.test";
        var longName = OAuthClients.ConnectorTokenName(new string('n', OAuthClients.MaxNameLength), midHost);
        Assert.Equal(Nix.Domain.Identity.PersonalAccessToken.MaximumNameLength, longName.Length);
        Assert.Equal(new string('n', 33) + " via " + midHost + " (connector)", longName);

        var host = new string('h', 240) + ".example.test";
        var longHost = OAuthClients.ConnectorTokenName("ChatGPT", host);
        Assert.True(longHost.Length <= Nix.Domain.Identity.PersonalAccessToken.MaximumNameLength);
        Assert.StartsWith("ChatGPT via \u2026", longHost, StringComparison.Ordinal);
        Assert.EndsWith(".example.test (connector)", longHost, StringComparison.Ordinal);
    }

    [Fact]
    public void Pkce_accepts_only_the_verifier_that_hashes_to_the_challenge()
    {
        var verifier = Base64UrlTextEncoder.Encode(RandomNumberGenerator.GetBytes(48));
        var challenge = Base64UrlTextEncoder.Encode(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));

        Assert.True(OAuthClients.VerifierMatches(verifier, challenge));
        Assert.False(OAuthClients.VerifierMatches(verifier + "a", challenge));
        Assert.False(OAuthClients.VerifierMatches(challenge, challenge));
    }

    [Theory]
    [InlineData("https://nix.test/mcp", true)]
    [InlineData("https://nix.test/mcp/", true)]
    [InlineData("https://nix.test/other", false)]
    [InlineData("https://evil.test/mcp", false)]
    public void A_resource_must_name_the_mcp_url(string resource, bool expected) =>
        Assert.Equal(expected, OAuthSettings.IsResource(resource, "https://nix.test/mcp"));

    [Theory]
    [InlineData("https://nix.test/mcp", "https://nix.test", true)]
    [InlineData("", "https://nix.test", false)]
    [InlineData("https://nix.test/mcp", "", false)]
    public void Everything_is_off_unless_the_mcp_url_and_the_public_origin_are_both_set(string mcp, string origin, bool expected)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Nix:Mcp:PublicUrl"] = mcp }).Build();
        var browser = Options.Create(new BrowserAuthOptions { PublicOrigin = origin });

        Assert.Equal(expected, OAuthSettings.TryGet(configuration, browser, out var publicOrigin, out _));
        Assert.Equal(expected ? "https://nix.test" : string.Empty, publicOrigin);
    }
}
