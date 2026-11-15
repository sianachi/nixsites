using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Nix.Features.LocalAuth;

/// <summary>RFC 6238 time-based codes (SHA-1, 6 digits, 30 s), hand-rolled over HMACSHA1 so no library is needed.</summary>
public static class LocalTotp
{
    /// <summary>Seconds one code stays current.</summary>
    public const int PeriodSeconds = 30;

    /// <summary>Digits in a code.</summary>
    public const int Digits = 6;

    private const int SecretBytes = 20;
    private const string Base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    /// <summary>A fresh 160-bit secret, the size RFC 4226 recommends for SHA-1.</summary>
    public static byte[] NewSecret() => RandomNumberGenerator.GetBytes(SecretBytes);

    /// <summary>The time step a moment falls in.</summary>
    public static long StepAt(DateTimeOffset moment) => moment.ToUnixTimeSeconds() / PeriodSeconds;

    /// <summary>The code for one step.</summary>
    public static string Code(ReadOnlySpan<byte> secret, long step)
    {
        Span<byte> counter = stackalloc byte[8];
        BinaryPrimitives.WriteInt64BigEndian(counter, step);
        Span<byte> mac = stackalloc byte[HMACSHA1.HashSizeInBytes];
        // SHA-1 is what RFC 6238 and every authenticator app use; this is a MAC, not a collision-resistant hash.
#pragma warning disable CA5350
        _ = HMACSHA1.HashData(secret, counter, mac);
#pragma warning restore CA5350
        var offset = mac[^1] & 0x0F;
        var binary = BinaryPrimitives.ReadInt32BigEndian(mac[offset..]) & 0x7FFFFFFF;
        return (binary % 1_000_000).ToString("D6", CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// The step whose code equals <paramref name="code"/>, looking one step either side of the current one, or
    /// null. All three codes are always compared, in constant time, so the answer does not leak which one was close.
    /// </summary>
    public static long? Match(ReadOnlySpan<byte> secret, string? code, DateTimeOffset now)
    {
        var typed = code?.Replace(" ", string.Empty, StringComparison.Ordinal);
        if (typed is not { Length: Digits } || !typed.All(char.IsAsciiDigit))
        {
            return null;
        }

        var typedBytes = Encoding.ASCII.GetBytes(typed);
        var current = StepAt(now);
        long? found = null;
        for (var step = current - 1; step <= current + 1; step++)
        {
            if (CryptographicOperations.FixedTimeEquals(typedBytes, Encoding.ASCII.GetBytes(Code(secret, step))))
            {
                found = step;
            }
        }

        return found;
    }

    /// <summary>The secret as unpadded RFC 4648 base32, the form authenticator apps take.</summary>
    public static string ToBase32(ReadOnlySpan<byte> bytes)
    {
        var text = new StringBuilder((bytes.Length * 8 / 5) + 1);
        int buffer = 0, bits = 0;
        foreach (var b in bytes)
        {
            buffer = (buffer << 8) | b;
            bits += 8;
            while (bits >= 5)
            {
                text.Append(Base32Alphabet[(buffer >> (bits - 5)) & 31]);
                bits -= 5;
            }

            buffer &= (1 << bits) - 1;
        }

        if (bits > 0)
        {
            text.Append(Base32Alphabet[(buffer << (5 - bits)) & 31]);
        }

        return text.ToString();
    }

    /// <summary>The otpauth:// link an authenticator app scans, with the issuer "Nix".</summary>
    public static string OtpAuthLink(string email, ReadOnlySpan<byte> secret) =>
        string.Create(
            CultureInfo.InvariantCulture,
            $"otpauth://totp/Nix:{Uri.EscapeDataString(email)}?secret={ToBase32(secret)}&issuer=Nix&algorithm=SHA1&digits={Digits}&period={PeriodSeconds}");
}
