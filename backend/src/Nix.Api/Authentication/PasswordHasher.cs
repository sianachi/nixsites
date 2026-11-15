using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Konscious.Security.Cryptography;

namespace Nix.Authentication;

/// <summary>The outcome of checking a password against a stored hash.</summary>
/// <param name="Ok">Whether the password matches.</param>
/// <param name="NeedsRehash">Whether the stored hash is not Argon2id at today's cost and should be replaced.</param>
public readonly record struct PasswordCheck(bool Ok, bool NeedsRehash);

/// <summary>
/// Hashes new passwords with Argon2id and verifies the formats a Zitadel database holds (bcrypt, argon2,
/// pbkdf2), so imported people sign in with the password they already have and are rehashed on the way.
/// </summary>
public sealed class PasswordHasher
{
    /// <summary>Fewest characters in a password.</summary>
    public const int MinimumLength = 10;

    /// <summary>Most characters in a password; bounds the work an unauthenticated request can demand.</summary>
    public const int MaximumLength = 256;

    // OWASP's second Argon2id recommendation: 19 MiB, 2 passes, one lane.
    private const int MemoryKibibytes = 19456;
    private const int Iterations = 2;
    private const int Parallelism = 1;
    private const int SaltBytes = 16;
    private const int HashBytes = 32;

    private readonly System.Collections.Concurrent.ConcurrentDictionary<int, string> _bcryptDummies = new();
    private readonly Lazy<string> _dummy = new(() => new PasswordHasher().Hash(Guid.NewGuid().ToString("N")));

    /// <summary>Applies the length rule. There are no composition rules and no outside lookups.</summary>
    public static bool IsAcceptable(string? password) =>
        password is { Length: >= MinimumLength and <= MaximumLength };

    /// <summary>Hashes a password into an Argon2id PHC string.</summary>
    public string Hash(string password)
    {
        ArgumentNullException.ThrowIfNull(password);
        var salt = RandomNumberGenerator.GetBytes(SaltBytes);
        var hash = Derive(new Argon2id(Encoding.UTF8.GetBytes(password)), salt, MemoryKibibytes, Iterations, Parallelism, HashBytes);
        return string.Create(
            CultureInfo.InvariantCulture,
            $"$argon2id$v=19$m={MemoryKibibytes},t={Iterations},p={Parallelism}${Convert.ToBase64String(salt).TrimEnd('=')}${Convert.ToBase64String(hash).TrimEnd('=')}");
    }

    /// <summary>Checks a password against a stored hash of any supported format. Never throws on a malformed hash.</summary>
    public PasswordCheck Verify(string password, string? stored)
    {
        ArgumentNullException.ThrowIfNull(password);
        if (string.IsNullOrEmpty(stored) || password.Length > MaximumLength)
        {
            return default;
        }

        try
        {
            var parts = stored.Split('$');
            if (parts.Length < 2 || parts[0].Length != 0)
            {
                return default;
            }

            var scheme = parts[1];
            if (scheme is "2a" or "2b" or "2y" or "2x")
            {
                return new PasswordCheck(BCrypt.Net.BCrypt.Verify(password, stored), true);
            }

            if (scheme.StartsWith("argon2", StringComparison.Ordinal))
            {
                return VerifyArgon2(password, scheme, parts);
            }

            if (scheme.StartsWith("pbkdf2-", StringComparison.Ordinal))
            {
                return new PasswordCheck(VerifyPbkdf2(password, scheme, parts), true);
            }
        }
        catch (Exception exception) when (exception is FormatException or ArgumentException or CryptographicException or OverflowException
                or BCrypt.Net.SaltParseException or BCrypt.Net.HashInformationException or KeyNotFoundException or IndexOutOfRangeException)
        {
            // A hash that cannot be read is a wrong password, not a server error.
        }

        return default;
    }

    /// <summary>Spends the time of one real verification, so an unknown email answers as slowly as a known one.</summary>
    /// <param name="password">The password that was sent.</param>
    /// <param name="bcryptCost">Above zero, spend the time of a carried-over bcrypt hash of that cost instead.</param>
    public void VerifyDummy(string password, int bcryptCost = 0) => _ = Verify(
        password,
        bcryptCost > 0
            ? _bcryptDummies.GetOrAdd(Math.Clamp(bcryptCost, 4, 16), static cost => BCrypt.Net.BCrypt.HashPassword(Guid.NewGuid().ToString("N"), cost))
            : _dummy.Value);

    private static PasswordCheck VerifyArgon2(string password, string scheme, string[] parts)
    {
        // $argon2id$v=19$m=..,t=..,p=..$salt$hash ; the version segment is optional in older encodings.
        var offset = parts.Length == 6 ? 3 : 2;
        if (parts.Length is not (5 or 6))
        {
            return default;
        }

        var cost = parts[offset].Split(',').Select(static part => part.Split('=')).ToDictionary(static pair => pair[0], static pair => int.Parse(pair[1], CultureInfo.InvariantCulture));
        var salt = FromBase64(parts[offset + 1]);
        var expected = FromBase64(parts[offset + 2]);
        RequireUsable(expected);
        int memory = cost["m"], iterations = cost["t"], lanes = cost["p"];
        var secret = Encoding.UTF8.GetBytes(password);
        Argon2 algorithm = scheme switch
        {
            "argon2id" => new Argon2id(secret),
            "argon2i" => new Argon2i(secret),
            "argon2d" => new Argon2d(secret),
            _ => throw new FormatException("Unknown argon2 variant."),
        };
        var actual = Derive(algorithm, salt, memory, iterations, lanes, expected.Length);
        var ok = CryptographicOperations.FixedTimeEquals(actual, expected);
        var current = scheme == "argon2id" && memory >= MemoryKibibytes && iterations >= Iterations && lanes >= Parallelism && expected.Length >= HashBytes;
        return new PasswordCheck(ok, !current);
    }

    private static bool VerifyPbkdf2(string password, string scheme, string[] parts)
    {
        // $pbkdf2-sha256$<rounds>$salt$hash, or the parameterised $pbkdf2-sha256$i=<rounds>[,l=<bytes>]$salt$hash.
        if (parts.Length != 5)
        {
            return false;
        }

        var algorithm = scheme["pbkdf2-".Length..] switch
        {
            "sha1" => HashAlgorithmName.SHA1,
            "sha256" => HashAlgorithmName.SHA256,
            "sha512" => HashAlgorithmName.SHA512,
            _ => throw new FormatException("Unknown pbkdf2 digest."),
        };
        var rounds = parts[2].Split(',')[0] is var first && first.StartsWith("i=", StringComparison.Ordinal)
            ? int.Parse(first[2..], CultureInfo.InvariantCulture)
            : int.Parse(parts[2], CultureInfo.InvariantCulture);
        var salt = FromBase64(parts[3]);
        var expected = FromBase64(parts[4]);
        RequireUsable(expected);
        var actual = Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(password), salt, rounds, algorithm, expected.Length);
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }

    // An empty digest would equal the empty derivation of any password.
    private static void RequireUsable(byte[] expected)
    {
        if (expected.Length < 16)
        {
            throw new FormatException("The stored hash is too short to check against.");
        }
    }

    private static byte[] Derive(Argon2 algorithm, byte[] salt, int memory, int iterations, int lanes, int length)
    {
        using (algorithm)
        {
            algorithm.Salt = salt;
            algorithm.MemorySize = memory;
            algorithm.Iterations = iterations;
            algorithm.DegreeOfParallelism = lanes;
            return algorithm.GetBytes(length);
        }
    }

    // Accepts standard base64 without padding (PHC), and the '.'-for-'+' variant passlib and Zitadel's pbkdf2 use.
    private static byte[] FromBase64(string value)
    {
        var normalized = value.Replace('.', '+').Replace('-', '+').Replace('_', '/').TrimEnd('=');
        return Convert.FromBase64String(normalized.PadRight(normalized.Length + ((4 - (normalized.Length % 4)) % 4), '='));
    }
}
