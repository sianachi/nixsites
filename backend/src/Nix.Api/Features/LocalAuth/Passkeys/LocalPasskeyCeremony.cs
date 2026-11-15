using System.Formats.Cbor;
using System.Security.Cryptography;
using System.Text.Json;
using Fido2NetLib;
using Fido2NetLib.Objects;
using Fido2NetLib.Serialization;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;

namespace Nix.Features.LocalAuth;

/// <summary>What a passkey registration produced.</summary>
/// <param name="CredentialId">The credential id the authenticator made.</param>
/// <param name="PublicKey">The COSE public key.</param>
/// <param name="SignCount">The counter the authenticator started at.</param>
/// <param name="Aaguid">The authenticator model, when it says.</param>
/// <param name="Transports">How the authenticator can be reached.</param>
public sealed record LocalPasskeyRegistration(
    ReadOnlyMemory<byte> CredentialId,
    ReadOnlyMemory<byte> PublicKey,
    long SignCount,
    Guid? Aaguid,
    IReadOnlyList<string> Transports);

/// <summary>
/// The WebAuthn side of local sign-in: builds the options a browser needs and judges what it sends back.
/// The relying-party id and the one allowed origin come from <see cref="AuthSettings"/>; nothing here reads a request.
/// </summary>
public sealed class LocalPasskeyCeremony
{
    private readonly Fido2? _fido2;

    /// <summary>Builds the ceremony for a relying-party id and the public origin; either missing leaves it unavailable.</summary>
    public LocalPasskeyCeremony(AuthSettings settings)
        : this(settings?.PasskeyRpId, settings?.PublicOrigin)
    {
    }

    /// <summary>Builds the ceremony for an explicit relying-party id and origin.</summary>
    public LocalPasskeyCeremony(string? rpId, Uri? publicOrigin)
    {
        if (string.IsNullOrWhiteSpace(rpId) || publicOrigin is null)
        {
            return;
        }

        _fido2 = new Fido2(
            new Fido2Configuration
            {
                RPID = rpId,
                RPName = "Nix",
                // The public origin only: a passkey can never be used from another site, related origins included.
                Origins = new HashSet<string>(StringComparer.Ordinal) { publicOrigin.GetLeftPart(UriPartial.Authority) },
            },
            metadataService: null!);
    }

    /// <summary>Whether the install has a usable relying-party id and public origin.</summary>
    public bool IsAvailable => _fido2 is not null;

    /// <summary>Options to create a discoverable, user-verifying passkey.</summary>
    public CredentialCreateOptions CreationOptions(
        PrincipalId principal, string email, string displayName, IEnumerable<LocalPasskeyRecord> existing) =>
        Fido2.RequestNewCredential(new RequestNewCredentialParams
        {
            User = new Fido2User { Id = principal.Value.ToByteArray(), Name = email, DisplayName = displayName },
            ExcludeCredentials = [.. existing.Select(Describe)],
            AuthenticatorSelection = new AuthenticatorSelection
            {
                ResidentKey = ResidentKeyRequirement.Required,
                UserVerification = UserVerificationRequirement.Required,
            },
            AttestationPreference = AttestationConveyancePreference.None,
        });

    /// <summary>Options for a passkey sign-in: no allow list, because the person is not known yet.</summary>
    public AssertionOptions SignInOptions() =>
        Fido2.GetAssertionOptions(new GetAssertionOptionsParams { UserVerification = UserVerificationRequirement.Required });

    /// <summary>Options for the security-key second step: only that person's keys, presence is enough.</summary>
    public AssertionOptions SecurityKeyOptions(IEnumerable<LocalPasskeyRecord> keys) =>
        Fido2.GetAssertionOptions(new GetAssertionOptionsParams
        {
            AllowedCredentials = [.. keys.Select(Describe)],
            UserVerification = UserVerificationRequirement.Discouraged,
        });

    /// <summary>Checks a new credential against the options that were issued; null when it does not hold up.</summary>
    public async Task<LocalPasskeyRegistration?> VerifyRegistrationAsync(
        CredentialCreateOptions options,
        AuthenticatorAttestationRawResponse response,
        Func<byte[], Task<bool>> isUnused,
        CancellationToken cancellationToken)
    {
        try
        {
            var made = await Fido2.MakeNewCredentialAsync(
                new MakeNewCredentialParams
                {
                    AttestationResponse = response,
                    OriginalOptions = options,
                    IsCredentialIdUniqueToUserCallback = (args, _) => isUnused(args.CredentialId),
                },
                cancellationToken).ConfigureAwait(false);
            return new LocalPasskeyRegistration(
                made.Id,
                made.PublicKey,
                made.SignCount,
                made.AaGuid == Guid.Empty ? null : made.AaGuid,
                [.. (made.Transports ?? []).Select(static t => JsonNamingPolicy.KebabCaseLower.ConvertName(t.ToString()))]);
        }
        catch (Exception exception) when (IsVerificationFailure(exception))
        {
            return null;
        }
    }

    /// <summary>
    /// Checks an assertion and the signature counter. Returns the new counter, or null when the signature,
    /// origin, relying-party id or user-verification flag is wrong, or the counter went backwards.
    /// </summary>
    public async Task<long?> VerifyAssertionAsync(
        AssertionOptions options,
        AuthenticatorAssertionRawResponse response,
        ReadOnlyMemory<byte> publicKey,
        long storedSignCount,
        CancellationToken cancellationToken)
    {
        try
        {
            var result = await Fido2.MakeAssertionAsync(
                new MakeAssertionParams
                {
                    AssertionResponse = response,
                    OriginalOptions = options,
                    StoredPublicKey = publicKey.ToArray(),
                    StoredSignatureCounter = (uint)Math.Clamp(storedSignCount, 0, uint.MaxValue),
                    // The credential id was already looked up in our own table, which ties it to one person, and a
                    // key imported from another provider carries that provider's user handle, not ours.
                    IsUserHandleOwnerOfCredentialIdCallback = static (_, _) => Task.FromResult(true),
                },
                cancellationToken).ConfigureAwait(false);
            // A clone of the authenticator shows up as a counter that does not move forward. Zero stays legal
            // for authenticators that do not count.
            return storedSignCount != 0 && result.SignCount <= storedSignCount ? null : result.SignCount;
        }
        catch (Exception exception) when (IsVerificationFailure(exception))
        {
            return null;
        }
    }

    /// <summary>Reads the browser's JSON into the library's attestation type; null when it is not one.</summary>
    public static AuthenticatorAttestationRawResponse? ReadAttestation(JsonElement element) =>
        Read<AuthenticatorAttestationRawResponse>(element);

    /// <summary>Reads the browser's JSON into the library's assertion type; null when it is not one.</summary>
    public static AuthenticatorAssertionRawResponse? ReadAssertion(JsonElement element) =>
        Read<AuthenticatorAssertionRawResponse>(element);

    /// <summary>A stable challenge id for a ceremony that has no id in its request: one pending ceremony per key.</summary>
    public static Guid DeterministicId(string purpose, string key) =>
        new(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(purpose + ":" + key)).AsSpan(0, 16));

    private Fido2 Fido2 => _fido2 ?? throw new InvalidOperationException("Passkeys need a public origin and a relying-party id.");

    private static PublicKeyCredentialDescriptor Describe(LocalPasskeyRecord key) =>
        new(PublicKeyCredentialType.PublicKey, key.CredentialId.ToArray(), [.. key.Transports.Select(ParseTransport).OfType<AuthenticatorTransport>()]);

    private static AuthenticatorTransport? ParseTransport(string value) =>
        Enum.TryParse<AuthenticatorTransport>(value.Replace("-", string.Empty, StringComparison.Ordinal), ignoreCase: true, out var transport) ? transport : null;

    // The library's own context lacks the attestation type, so fall back to its attribute-driven converters.
    private static readonly JsonSerializerOptions FidoJson = new()
    {
        TypeInfoResolver = System.Text.Json.Serialization.Metadata.JsonTypeInfoResolver.Combine(
            FidoModelSerializerContext.Default,
            new System.Text.Json.Serialization.Metadata.DefaultJsonTypeInfoResolver()),
    };

    private static T? Read<T>(JsonElement element)
        where T : class
    {
        try
        {
            return element.ValueKind == JsonValueKind.Object ? element.Deserialize<T>(FidoJson) : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    // Malformed input surfaces as one of these from the library, the CBOR reader or the crypto layer.
    private static bool IsVerificationFailure(Exception exception) =>
        exception is Fido2VerificationException or FormatException or ArgumentException or CryptographicException
            or CborContentException or InvalidOperationException or KeyNotFoundException or JsonException;
}
