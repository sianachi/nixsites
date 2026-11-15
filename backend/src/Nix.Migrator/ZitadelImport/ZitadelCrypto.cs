using System.Security.Cryptography;
using System.Text;

namespace Nix.Migrator.ZitadelImport;

/// <summary>
/// Zitadel's at-rest encryption: AES-CFB with the 16-byte IV in front of the ciphertext. Its key set lives in
/// <c>system.encryption_keys</c>, each key itself encrypted with the install's masterkey and stored as
/// URL-safe base64.
/// </summary>
internal static class ZitadelCrypto
{
    private const int IvBytes = 16;

    /// <summary>Decrypts <c>IV || ciphertext</c> with a 16, 24 or 32 byte key.</summary>
    public static byte[] Decrypt(ReadOnlySpan<byte> data, ReadOnlySpan<byte> key)
    {
        if (data.Length < IvBytes)
        {
            throw new CryptographicException("Ciphertext is shorter than its IV.");
        }

        using var aes = Aes.Create();
        aes.Key = key.ToArray();
        return aes.DecryptCfb(data[IvBytes..], data[..IvBytes], PaddingMode.None, feedbackSizeInBits: 128);
    }

    /// <summary>Unwraps one row of <c>system.encryption_keys</c> with the masterkey.</summary>
    public static byte[] DecryptKey(string storedValue, string masterKey) =>
        Decrypt(Convert.FromBase64String(storedValue.Replace('-', '+').Replace('_', '/')), Encoding.UTF8.GetBytes(masterKey));

    /// <summary>
    /// Zitadel stores an authenticator secret as the base32 text an authenticator app takes; this returns the raw
    /// secret bytes Core keeps.
    /// </summary>
    public static byte[] OtpSecret(ReadOnlySpan<byte> encrypted, ReadOnlySpan<byte> key) =>
        Base32Decode(Encoding.ASCII.GetString(Decrypt(encrypted, key)));

    /// <summary>RFC 4648 base32, tolerant of case, padding and spaces.</summary>
    public static byte[] Base32Decode(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        const string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        var result = new List<byte>();
        int buffer = 0, bits = 0;
        foreach (var raw in text)
        {
            if (raw is '=' or ' ')
            {
                continue;
            }

            var value = alphabet.IndexOf(char.ToUpperInvariant(raw), StringComparison.Ordinal);
            if (value < 0)
            {
                throw new FormatException("Not base32.");
            }

            buffer = (buffer << 5) | value;
            bits += 5;
            if (bits >= 8)
            {
                bits -= 8;
                result.Add((byte)((buffer >> bits) & 0xff));
            }
        }

        return [.. result];
    }
}
