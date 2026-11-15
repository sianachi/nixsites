using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;

namespace Nix.Domain.Identity;

/// <summary>What a one-time account link is for. Both are consumed the same way.</summary>
public enum LocalLinkPurpose
{
    /// <summary>First-time setup of a person an admin added.</summary>
    Setup,

    /// <summary>Choosing a new password or passkey after a loss.</summary>
    Reset,
}

/// <summary>Mints and hashes the secret in an account link. Only the hash is stored.</summary>
public static class LocalLinkToken
{
    /// <summary>How long a link works.</summary>
    public static readonly TimeSpan Lifetime = TimeSpan.FromHours(1);

    /// <summary>Mints a random token and the lowercase SHA-256 stored in its place.</summary>
    public static MintedLocalLinkToken Mint()
    {
        var token = Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));
        return new MintedLocalLinkToken(token, Hash(token));
    }

    /// <summary>Hashes a presented token for the exact lookup.</summary>
    public static string Hash(string token)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(token);
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
    }
}

/// <summary>A new link token and the only value persisted from it.</summary>
/// <param name="Token">The secret placed in the link, shown once.</param>
/// <param name="Hash">The SHA-256 lookup stored by Core.</param>
public sealed record MintedLocalLinkToken(string Token, string Hash);

/// <summary>The one rule for what counts as a sign-in email address.</summary>
public static class LocalAccountEmail
{
    /// <summary>Normalizes and sanity-checks an address: one '@', text either side, no spaces. No verification is attempted.</summary>
    public static bool TryNormalize(string? value, out string normalized)
    {
        normalized = string.Empty;
        if (!EmailAddressNormalizer.TryNormalize(value, out var candidate)
            || candidate.Length < 3
            || candidate.Any(char.IsWhiteSpace)
            || candidate.IndexOf('@', StringComparison.Ordinal) is not (> 0 and var at)
            || at != candidate.LastIndexOf('@')
            || at == candidate.Length - 1)
        {
            return false;
        }

        normalized = candidate;
        return true;
    }
}
