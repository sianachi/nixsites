using System.Buffers.Text;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.DataProtection;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;

namespace Nix.Features.BrowserAuth;

/// <summary>Hands a completed sign-in from the system sheet to the app's web view exactly once.</summary>
public sealed class NativeHandoffCoordinator(INativeHandoffs handoffs, IDataProtectionProvider dataProtection, TimeProvider clock)
{
    /// <summary>The app's callback URL; a server constant, never taken from the client.</summary>
    internal const string RedirectBase = "app.nix.shell://auth";

    /// <summary>
    /// The callback, naming this server (RFC 9207): an app that started sign-in on another server, which
    /// redirected the browser here, must not hand that server this code.
    /// </summary>
    internal static string CallbackUrl(string code, Uri? publicOrigin) =>
        RedirectBase + "?code=" + code + "&iss=" + Uri.EscapeDataString(publicOrigin?.GetLeftPart(UriPartial.Authority) ?? string.Empty);

    internal static readonly TimeSpan Lifetime = TimeSpan.FromSeconds(60);
    private const string Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    private readonly IDataProtector _protector = dataProtection.CreateProtector("Nix.Bff.NativeHandoff.v1");

    /// <summary>A SHA-256 challenge: exactly 43 base64url characters, unpadded.</summary>
    public static bool IsChallenge(string? value) => IsBase64Url(value, 43, 43);

    /// <summary>A PKCE-style verifier: 43 to 128 base64url characters.</summary>
    public static bool IsVerifier(string? value) => IsBase64Url(value, 43, 128);

    /// <summary>Stores the finished session behind a fresh one-time code; null when the table or this account's live quota is full.</summary>
    public async ValueTask<string?> CreateAsync(BrowserLoginCompletion completion, string challenge, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(completion);
        if (!IsChallenge(challenge))
        {
            throw new ArgumentException("Not a native challenge.", nameof(challenge));
        }

        var code = Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));
        var payload = _protector.Protect(
            completion.CookieToken + "\n" + completion.ExpiresAt.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture));
        return await handoffs.CreateAsync(BrowserSessionSecret.Hash(code), completion.Principal.Id.Value, challenge, payload, clock.GetUtcNow() + Lifetime, cancellationToken)
            .ConfigureAwait(false)
            ? code
            : null;
    }

    /// <summary>
    /// Consumes the code, then checks expiry and the verifier. The code is burned even when the verifier is
    /// wrong, so a guesser gets one try per code.
    /// </summary>
    public async ValueTask<(string CookieToken, DateTimeOffset ExpiresAt)?> RedeemAsync(
        string? code, string? verifier, CancellationToken cancellationToken)
    {
        if (!IsBase64Url(code, 43, 43) || !IsVerifier(verifier))
        {
            return null;
        }

        var row = await handoffs.ConsumeAsync(BrowserSessionSecret.Hash(code!), cancellationToken).ConfigureAwait(false);
        if (row is null || row.ExpiresAt <= clock.GetUtcNow())
        {
            return null;
        }

        var expected = Encoding.ASCII.GetBytes(row.Challenge);
        var actual = Encoding.ASCII.GetBytes(Base64Url.EncodeToString(SHA256.HashData(Encoding.ASCII.GetBytes(verifier!))));
        if (!CryptographicOperations.FixedTimeEquals(expected, actual))
        {
            return null;
        }

        try
        {
            var parts = _protector.Unprotect(row.Payload).Split('\n');
            return parts.Length == 2 && long.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var seconds)
                ? (parts[0], DateTimeOffset.FromUnixTimeSeconds(seconds))
                : null;
        }
        catch (CryptographicException)
        {
            return null;
        }
    }

    private static bool IsBase64Url(string? value, int min, int max) => value is not null
        && value.Length >= min && value.Length <= max
        && value.AsSpan().IndexOfAnyExcept(Alphabet.AsSpan()) < 0;
}

/// <summary>The one-time redemption body.</summary>
public sealed record NativeRedeemRequest(string? Code, string? Verifier);
