using System.Text.Json;

namespace Nix.Migrator.ZitadelImport;

/// <summary>One row of Zitadel's event store.</summary>
internal sealed record ZitadelEvent(string AggregateId, string Type, DateTimeOffset CreatedAt, JsonElement Payload);

/// <summary>A human user as Zitadel's projections hold them.</summary>
internal sealed record ZitadelUser(string Id, short State, string Email, bool EmailVerified, string DisplayName);

/// <summary>A WebAuthn credential rebuilt from Zitadel's token events.</summary>
internal sealed record ZitadelWebAuthn(
    string TokenId, bool SecurityKey, byte[] CredentialId, byte[] PublicKey, long SignCount,
    Guid? Aaguid, string Name, DateTimeOffset CreatedAt);

/// <summary>What the event stream says one user can sign in with.</summary>
internal sealed class ZitadelCredentials
{
    /// <summary>The stored password hash, or null.</summary>
    public string? PasswordHash { get; set; }

    /// <summary>When the hash was last set.</summary>
    public DateTimeOffset? PasswordSetAt { get; set; }

    /// <summary>The verified authenticator secret, still encrypted: algorithm key id and ciphertext.</summary>
    public (string KeyId, byte[] Crypted)? Otp { get; set; }

    /// <summary>
    /// Whether the authenticator was verified (an added-but-unverified one is not carried). True with a null
    /// <see cref="Otp"/> means the person has one whose secret could not be read.
    /// </summary>
    public bool OtpVerified { get; set; }

    /// <summary>Live WebAuthn credentials by Zitadel token id.</summary>
    public Dictionary<string, ZitadelWebAuthn> WebAuthn { get; } = [];

    /// <summary>Live WebAuthn credentials whose key could not be read from the event; the import must not go on without them.</summary>
    public HashSet<string> UnreadableWebAuthn { get; } = new(StringComparer.Ordinal);

    /// <summary>Whether SMS codes were set up.</summary>
    public bool Sms { get; set; }

    /// <summary>Whether email codes were set up as a second step.</summary>
    public bool EmailCodes { get; set; }

    /// <summary>Whether an outside login is linked.</summary>
    public bool OutsideLogin { get; set; }
}
