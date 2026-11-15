using Microsoft.Extensions.Options;
using Nix.Authentication;
using Nix.Domain.Identity;

namespace Nix.Tests.Authentication;

/// <summary>Mode resolution (decision 1), startup validation, and the small local-account value rules.</summary>
public sealed class LocalAuthSettingsTests
{
    private static AuthSettings Settings(string mode = "", string authority = "", string origin = "https://nix.example", string rpId = "") =>
        new(
            Options.Create(new LocalAuthOptions { Mode = mode, Passkeys = new LocalPasskeyOptions { RpId = rpId } }),
            Options.Create(new BrowserAuthOptions { Authority = authority, PublicOrigin = origin }));

    [Theory]
    [InlineData("", "", AuthMode.Local)]
    [InlineData("", "https://idp.example", AuthMode.Oidc)]
    [InlineData("local", "https://idp.example", AuthMode.Local)]
    [InlineData("OIDC", "https://idp.example", AuthMode.Oidc)]
    [InlineData("local", "", AuthMode.Local)]
    public void The_mode_is_explicit_or_follows_the_authority(string mode, string authority, AuthMode expected) =>
        Assert.Equal(expected, Settings(mode, authority).Mode);

    [Fact]
    public void The_passkey_rp_id_defaults_to_the_public_host_and_a_different_one_needs_related_origins()
    {
        var plain = Settings();
        Assert.Equal("nix.example", plain.PasskeyRpId);
        Assert.False(plain.NeedsRelatedOrigins);

        var migrated = Settings(rpId: "auth.old.example");
        Assert.Equal("auth.old.example", migrated.PasskeyRpId);
        Assert.True(migrated.NeedsRelatedOrigins);
    }

    [Theory]
    [InlineData("sideways", "", "", false)]
    [InlineData("oidc", "", "", false)]
    [InlineData("oidc", "https://idp.example", "", true)]
    [InlineData("", "", "short", false)]
    [InlineData("", "", "long-enough-code", true)]
    [InlineData("", "", "", true)]
    public void Startup_validation_refuses_what_could_never_work(string mode, string authority, string setupCode, bool valid)
    {
        var validator = new LocalAuthOptionsValidator(Options.Create(new BrowserAuthOptions { Authority = authority }));

        var result = validator.Validate(null, new LocalAuthOptions { Mode = mode, SetupCode = setupCode });

        Assert.Equal(valid, result.Succeeded);
    }

    [Theory]
    [InlineData("https://nix.example")]
    [InlineData("nix.example:443")]
    [InlineData("a b")]
    public void A_rp_id_must_be_a_bare_host(string rpId)
    {
        var validator = new LocalAuthOptionsValidator(Options.Create(new BrowserAuthOptions()));

        Assert.False(validator.Validate(null, new LocalAuthOptions { Passkeys = new LocalPasskeyOptions { RpId = rpId } }).Succeeded);
    }

    [Theory]
    [InlineData("  Ada@Example.COM ", "ada@example.com")]
    [InlineData("a@b", "a@b")]
    public void Emails_are_trimmed_and_lowercased(string raw, string expected)
    {
        Assert.True(LocalAccountEmail.TryNormalize(raw, out var normalized));
        Assert.Equal(expected, normalized);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("no-at-sign")]
    [InlineData("@leading")]
    [InlineData("trailing@")]
    [InlineData("two@@signs")]
    [InlineData("a b@c")]
    public void Malformed_emails_are_refused(string? raw) => Assert.False(LocalAccountEmail.TryNormalize(raw, out _));

    [Fact]
    public void A_link_token_is_stored_only_as_its_hash()
    {
        var minted = LocalLinkToken.Mint();

        Assert.Equal(minted.Hash, LocalLinkToken.Hash(minted.Token));
        Assert.Matches("^[0-9a-f]{64}$", minted.Hash);
        Assert.NotEqual(minted.Token, LocalLinkToken.Mint().Token);
    }
}
