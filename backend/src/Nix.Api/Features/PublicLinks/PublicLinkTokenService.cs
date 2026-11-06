using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.WebUtilities;
using Nix.Features.Views;

namespace Nix.Features.PublicLinks;

/// <summary>What a public link token carries; the signature is what makes it trustworthy.</summary>
public sealed record PublicLinkTokenPayload(Guid TenantId, Guid LinkId, Guid PrincipalId, string Nonce);

/// <summary>
/// [SEC] Signs and verifies public link tokens. It reuses the public form HMAC shape and the same
/// signing key (<see cref="PublicFormTokenService.SigningKeyConfiguration"/>, one secret to deploy),
/// with a domain tag in the MAC input so a form token never verifies as a link token or the reverse.
/// </summary>
#pragma warning disable CA1812 // Constructed by ASP.NET Core dependency injection.
public sealed class PublicLinkTokenService
{
    private const string Domain = "nix-public-link-v1.";
    private readonly byte[]? _key;

    /// <summary>Reads the signing key; an absent or short key leaves the service unconfigured.</summary>
    public PublicLinkTokenService(IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        var configured = configuration[PublicFormTokenService.SigningKeyConfiguration];
        _key = string.IsNullOrWhiteSpace(configured) ? null : Encoding.UTF8.GetBytes(configured);
    }

    /// <summary>Whether links can be minted and verified on this host.</summary>
    public bool IsConfigured => _key is { Length: >= 32 };

    /// <summary>Mints the token for a link.</summary>
    public string Create(PublicLinkTokenPayload payload)
    {
        ArgumentNullException.ThrowIfNull(payload);
        if (!IsConfigured)
        {
            throw new InvalidOperationException(
                $"{PublicFormTokenService.SigningKeyConfiguration} must contain at least 32 bytes before public links can be created.");
        }

        var encoded = WebEncoders.Base64UrlEncode(JsonSerializer.SerializeToUtf8Bytes(payload));
        return $"{encoded}.{WebEncoders.Base64UrlEncode(Sign(encoded))}";
    }

    /// <summary>Verifies the signature and shape; says nothing about whether the link is still live.</summary>
    public bool TryRead(string? token, out PublicLinkTokenPayload payload)
    {
        payload = default!;
        if (!IsConfigured || string.IsNullOrWhiteSpace(token) || token.Length > 1024)
        {
            return false;
        }

        var separator = token.IndexOf('.', StringComparison.Ordinal);
        if (separator <= 0 || separator == token.Length - 1)
        {
            return false;
        }

        try
        {
            var encoded = token[..separator];
            var supplied = WebEncoders.Base64UrlDecode(token[(separator + 1)..]);
            if (!CryptographicOperations.FixedTimeEquals(supplied, Sign(encoded)))
            {
                return false;
            }

            payload = JsonSerializer.Deserialize<PublicLinkTokenPayload>(WebEncoders.Base64UrlDecode(encoded))!;
            return payload is not null
                && payload.TenantId != Guid.Empty
                && payload.LinkId != Guid.Empty
                && payload.PrincipalId != Guid.Empty
                && !string.IsNullOrWhiteSpace(payload.Nonce);
        }
        catch (FormatException)
        {
            return false;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private byte[] Sign(string encoded) => HMACSHA256.HashData(_key!, Encoding.ASCII.GetBytes(Domain + encoded));
}
#pragma warning restore CA1812
