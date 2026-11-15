using System.Formats.Cbor;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Fido2NetLib;
using Fido2NetLib.Objects;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Options;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Features.LocalAuth;

namespace Nix.Tests.Authentication;

/// <summary>
/// The passkey ceremony against a software authenticator: options shape, counter regression, origin and RP id
/// mismatch, and the last-sign-in-method rule.
/// </summary>
public sealed class LocalPasskeyTests
{
    private const string Origin = "https://nix.example";
    private const string RpId = "nix.example";
    private static readonly PrincipalId Person = PrincipalId.From(Guid.NewGuid());

    private static LocalPasskeyCeremony Ceremony(string rpId = RpId, string origin = Origin) => new(rpId, new Uri(origin));

    [Fact]
    public void Sign_in_options_demand_user_verification_and_name_no_credential()
    {
        var options = Ceremony().SignInOptions();

        Assert.Equal(RpId, options.RpId);
        Assert.Equal(UserVerificationRequirement.Required, options.UserVerification);
        Assert.True(options.AllowCredentials is null or { Count: 0 });
        Assert.True(options.Challenge.Length >= 16);
    }

    [Fact]
    public void Creation_options_ask_for_a_discoverable_verified_credential_and_exclude_existing_ones()
    {
        var existing = new[] { Stored(new byte[] { 9, 9, 9 }, LocalPasskeyKind.Passkey) };

        var options = Ceremony().CreationOptions(Person, "ada@example.com", "Ada", existing);

        Assert.Equal(RpId, options.Rp.Id);
        Assert.Equal(ResidentKeyRequirement.Required, options.AuthenticatorSelection!.ResidentKey);
        Assert.Equal(UserVerificationRequirement.Required, options.AuthenticatorSelection.UserVerification);
        Assert.Equal(AttestationConveyancePreference.None, options.Attestation);
        Assert.Equal(new byte[] { 9, 9, 9 }, Assert.Single(options.ExcludeCredentials).Id);
        Assert.Equal(Person.Value.ToByteArray(), options.User.Id);
    }

    [Fact]
    public void Security_key_options_list_only_the_given_keys_and_need_presence_only()
    {
        var options = Ceremony().SecurityKeyOptions([Stored(new byte[] { 1, 2 }, LocalPasskeyKind.SecurityKey)]);

        Assert.Equal(new byte[] { 1, 2 }, Assert.Single(options.AllowCredentials).Id);
        Assert.Equal(UserVerificationRequirement.Discouraged, options.UserVerification);
    }

    [Fact]
    public async Task A_new_credential_is_accepted_and_its_key_signs_a_later_assertion()
    {
        var ceremony = Ceremony();
        using var device = new SoftAuthenticator();
        var options = ceremony.CreationOptions(Person, "ada@example.com", "Ada", []);

        var made = await ceremony.VerifyRegistrationAsync(
            options, LocalPasskeyCeremony.ReadAttestation(device.Register(options))!, _ => Task.FromResult(true), TestContext.Current.CancellationToken);

        Assert.NotNull(made);
        Assert.Equal(device.CredentialId, made.CredentialId.ToArray());
        var signIn = ceremony.SignInOptions();
        var counter = await ceremony.VerifyAssertionAsync(
            signIn, LocalPasskeyCeremony.ReadAssertion(device.Assert(signIn.Challenge, 1))!, made.PublicKey, made.SignCount, TestContext.Current.CancellationToken);
        Assert.Equal(1, counter);
    }

    [Fact]
    public async Task A_credential_id_already_in_use_is_refused()
    {
        var ceremony = Ceremony();
        using var device = new SoftAuthenticator();
        var options = ceremony.CreationOptions(Person, "ada@example.com", "Ada", []);

        var made = await ceremony.VerifyRegistrationAsync(
            options, LocalPasskeyCeremony.ReadAttestation(device.Register(options))!, _ => Task.FromResult(false), TestContext.Current.CancellationToken);

        Assert.Null(made);
    }

    [Fact]
    public async Task A_registration_made_for_another_origin_is_refused()
    {
        var ceremony = Ceremony();
        using var device = new SoftAuthenticator(origin: "https://evil.example");
        var options = ceremony.CreationOptions(Person, "ada@example.com", "Ada", []);

        var made = await ceremony.VerifyRegistrationAsync(
            options, LocalPasskeyCeremony.ReadAttestation(device.Register(options))!, _ => Task.FromResult(true), TestContext.Current.CancellationToken);

        Assert.Null(made);
    }

    [Theory]
    [InlineData(5L, 6u, true)]
    [InlineData(5L, 5u, false)]
    [InlineData(5L, 3u, false)]
    [InlineData(5L, 0u, false)]
    [InlineData(0L, 0u, true)]
    [InlineData(0L, 4u, true)]
    public async Task The_signature_counter_must_move_forward_once_it_has_moved(long stored, uint presented, bool accepted)
    {
        var ceremony = Ceremony();
        using var device = new SoftAuthenticator();
        var options = ceremony.SignInOptions();

        var result = await ceremony.VerifyAssertionAsync(
            options, LocalPasskeyCeremony.ReadAssertion(device.Assert(options.Challenge, presented))!, device.PublicKeyCose, stored, TestContext.Current.CancellationToken);

        Assert.Equal(accepted, result is not null);
        Assert.True(result is null || result == presented);
    }

    [Fact]
    public async Task An_assertion_from_another_origin_is_refused()
    {
        var ceremony = Ceremony();
        using var device = new SoftAuthenticator(origin: "https://evil.example");
        var options = ceremony.SignInOptions();

        Assert.Null(await ceremony.VerifyAssertionAsync(
            options, LocalPasskeyCeremony.ReadAssertion(device.Assert(options.Challenge, 1))!, device.PublicKeyCose, 0, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task An_assertion_bound_to_another_rp_id_is_refused()
    {
        var ceremony = Ceremony();
        using var device = new SoftAuthenticator(rpId: "auth.other.example");
        var options = ceremony.SignInOptions();

        Assert.Null(await ceremony.VerifyAssertionAsync(
            options, LocalPasskeyCeremony.ReadAssertion(device.Assert(options.Challenge, 1))!, device.PublicKeyCose, 0, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task An_assertion_for_a_different_challenge_is_refused()
    {
        var ceremony = Ceremony();
        using var device = new SoftAuthenticator();
        var options = ceremony.SignInOptions();

        Assert.Null(await ceremony.VerifyAssertionAsync(
            options, LocalPasskeyCeremony.ReadAssertion(device.Assert(new byte[32], 1))!, device.PublicKeyCose, 0, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task An_assertion_signed_by_another_key_is_refused()
    {
        var ceremony = Ceremony();
        using var device = new SoftAuthenticator();
        using var stranger = new SoftAuthenticator();
        var options = ceremony.SignInOptions();

        Assert.Null(await ceremony.VerifyAssertionAsync(
            options, LocalPasskeyCeremony.ReadAssertion(device.Assert(options.Challenge, 1))!, stranger.PublicKeyCose, 0, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task A_sign_in_without_user_verification_is_refused_but_a_security_key_second_step_does_not_need_it()
    {
        var ceremony = Ceremony();
        using var device = new SoftAuthenticator();
        var signIn = ceremony.SignInOptions();
        var keys = ceremony.SecurityKeyOptions([Stored(device.CredentialId, LocalPasskeyKind.SecurityKey)]);

        Assert.Null(await ceremony.VerifyAssertionAsync(
            signIn, LocalPasskeyCeremony.ReadAssertion(device.Assert(signIn.Challenge, 1, verified: false))!, device.PublicKeyCose, 0, TestContext.Current.CancellationToken));
        Assert.Equal(1, await ceremony.VerifyAssertionAsync(
            keys, LocalPasskeyCeremony.ReadAssertion(device.Assert(keys.Challenge, 1, verified: false))!, device.PublicKeyCose, 0, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Garbage_where_a_credential_should_be_is_not_a_credential()
    {
        Assert.Null(LocalPasskeyCeremony.ReadAssertion(JsonElement.Parse("[1,2]")));
        Assert.Null(LocalPasskeyCeremony.ReadAttestation(JsonElement.Parse("\"x\"")));
        await Task.CompletedTask;
    }

    [Fact]
    public void A_ceremony_without_a_public_origin_is_unavailable()
    {
        Assert.False(new LocalPasskeyCeremony(null, null).IsAvailable);
        Assert.True(Ceremony().IsAvailable);
    }

    [Fact]
    public void Challenge_ids_derived_from_a_key_are_stable_and_separate_by_purpose()
    {
        Assert.Equal(LocalPasskeyCeremony.DeterministicId("a", "k"), LocalPasskeyCeremony.DeterministicId("a", "k"));
        Assert.NotEqual(LocalPasskeyCeremony.DeterministicId("a", "k"), LocalPasskeyCeremony.DeterministicId("b", "k"));
        Assert.NotEqual(LocalPasskeyCeremony.DeterministicId("a", "k"), LocalPasskeyCeremony.DeterministicId("a", "j"));
    }

    [Theory]
    [InlineData(false, true, false, true)]
    [InlineData(false, true, true, false)]
    [InlineData(true, true, false, false)]
    [InlineData(false, false, false, false)]
    public void The_last_sign_in_method_cannot_be_removed(bool hasPassword, bool targetIsPasskey, bool otherPasskeyExists, bool refused)
    {
        var target = Stored([1], targetIsPasskey ? LocalPasskeyKind.Passkey : LocalPasskeyKind.SecurityKey);
        var all = new List<LocalPasskeyRecord> { target };
        if (otherPasskeyExists)
        {
            all.Add(Stored([2], LocalPasskeyKind.Passkey));
        }

        Assert.Equal(refused, LocalPasskeyRules.RemovalLeavesNoSignIn(hasPassword, all, target));
    }

    [Fact]
    public void A_security_key_never_counts_as_another_way_in()
    {
        var target = Stored([1], LocalPasskeyKind.Passkey);

        Assert.True(LocalPasskeyRules.RemovalLeavesNoSignIn(false, [target, Stored([2], LocalPasskeyKind.SecurityKey)], target));
    }

    [Theory]
    [InlineData(null, true, "Passkey")]
    [InlineData("  My phone ", true, "My phone")]
    [InlineData("", false, "")]
    [InlineData("   ", false, "")]
    [InlineData("bad\nname", false, "bad\nname")]
    public void Names_are_trimmed_defaulted_and_bounded(string? raw, bool ok, string expected)
    {
        Assert.Equal(ok, LocalPasskeyRules.TryName(raw, out var name));
        Assert.Equal(expected, name);
        Assert.False(LocalPasskeyRules.TryName(new string('x', LocalPasskeyRules.MaxName + 1), out _));
    }

    [Fact]
    public async Task A_security_key_is_a_second_step_only_for_people_who_hold_one()
    {
        var method = new LocalSecurityKeySecondStep();

        Assert.Equal(LocalSecondStepMethods.SecurityKey, method.Method);
        Assert.True(await method.IsEnrolledAsync(Account(securityKeys: 1), TestContext.Current.CancellationToken));
        Assert.False(await method.IsEnrolledAsync(Account(securityKeys: 0), TestContext.Current.CancellationToken));
    }

    [Fact]
    public void Related_origins_are_listed_only_when_the_rp_id_is_not_the_public_host()
    {
        static AuthSettings Settings(string rpId) => new(
            Options.Create(new LocalAuthOptions { Passkeys = new LocalPasskeyOptions { RpId = rpId } }),
            Options.Create(new BrowserAuthOptions { PublicOrigin = "https://nix.example" }));

        Assert.Equal("""{"origins":["https://nix.example"]}""", LocalPasskeyRules.RelatedOriginsJson(Settings("auth.old.example")));
        Assert.Null(LocalPasskeyRules.RelatedOriginsJson(Settings(string.Empty)));
    }

    private static LocalAccountRecord Account(int securityKeys) =>
        new(Person, Nix.Domain.Tenancy.TenantId.From(Guid.NewGuid()), "ada@example.com", "Ada", PrincipalStatus.Active, null, null, null, false, 0, securityKeys);

    private static LocalPasskeyRecord Stored(byte[] id, LocalPasskeyKind kind) =>
        new(Guid.NewGuid(), id, new byte[] { 0 }, 0, null, [], RpId, kind, "key", DateTimeOffset.UnixEpoch, null);

    /// <summary>A P-256 authenticator that builds the same bytes a browser would hand back.</summary>
    private sealed class SoftAuthenticator(string rpId = RpId, string origin = Origin) : IDisposable
    {
        private readonly ECDsa _key = ECDsa.Create(ECCurve.NamedCurves.nistP256);

        public byte[] CredentialId { get; } = RandomNumberGenerator.GetBytes(32);

        public byte[] PublicKeyCose
        {
            get
            {
                var p = _key.ExportParameters(false);
                var w = new CborWriter(CborConformanceMode.Ctap2Canonical);
                w.WriteStartMap(5);
                w.WriteInt32(1);
                w.WriteInt32(2);
                w.WriteInt32(3);
                w.WriteInt32(-7);
                w.WriteInt32(-1);
                w.WriteInt32(1);
                w.WriteInt32(-2);
                w.WriteByteString(p.Q.X!);
                w.WriteInt32(-3);
                w.WriteByteString(p.Q.Y!);
                w.WriteEndMap();
                return w.Encode();
            }
        }

        public JsonElement Register(CredentialCreateOptions options)
        {
            var authData = AuthData(flags: 0x45, counter: 0).Concat(new byte[16])
                .Concat(new[] { (byte)(CredentialId.Length >> 8), (byte)CredentialId.Length })
                .Concat(CredentialId).Concat(PublicKeyCose).ToArray();
            var attestation = new CborWriter(CborConformanceMode.Ctap2Canonical);
            attestation.WriteStartMap(3);
            attestation.WriteTextString("fmt");
            attestation.WriteTextString("none");
            attestation.WriteTextString("attStmt");
            attestation.WriteStartMap(0);
            attestation.WriteEndMap();
            attestation.WriteTextString("authData");
            attestation.WriteByteString(authData);
            attestation.WriteEndMap();
            return Credential("attestationObject", B64(attestation.Encode()), ClientData("webauthn.create", options.Challenge), null);
        }

        public JsonElement Assert(byte[] challenge, uint counter, bool verified = true)
        {
            var authData = AuthData(flags: (byte)(verified ? 0x05 : 0x01), counter);
            var clientData = ClientData("webauthn.get", challenge);
            var signature = _key.SignData(
                authData.Concat(SHA256.HashData(clientData)).ToArray(), HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);
            return Credential("authenticatorData", B64(authData), clientData, B64(signature));
        }

        public void Dispose() => _key.Dispose();

        private byte[] AuthData(byte flags, uint counter) =>
            SHA256.HashData(Encoding.UTF8.GetBytes(rpId))
                .Concat(new[] { flags, (byte)(counter >> 24), (byte)(counter >> 16), (byte)(counter >> 8), (byte)counter }).ToArray();

        private byte[] ClientData(string type, byte[] challenge) =>
            Encoding.UTF8.GetBytes($$"""{"type":"{{type}}","challenge":"{{B64(challenge)}}","origin":"{{origin}}","crossOrigin":false}""");

        private static string B64(byte[] bytes) => WebEncoders.Base64UrlEncode(bytes);

        private JsonElement Credential(string dataName, string data, byte[] clientData, string? signature)
        {
            var response = new StringBuilder()
                .Append(CultureInfo.InvariantCulture, $"\"{dataName}\":\"{data}\",\"clientDataJSON\":\"{B64(clientData)}\"");
            if (signature is not null)
            {
                response.Append(CultureInfo.InvariantCulture, $",\"signature\":\"{signature}\"");
            }

            var id = B64(CredentialId);
            return JsonElement.Parse(
                $"{{\"id\":\"{id}\",\"rawId\":\"{id}\",\"type\":\"public-key\",\"response\":{{{response}}}}}");
        }
    }
}
