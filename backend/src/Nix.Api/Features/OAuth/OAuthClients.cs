// Public only so the unit tests can reach them; callers are Core's own endpoints, which pass non-null values and plain strings.
#pragma warning disable CA1034, CA1054, CA1062
using System.Buffers.Text;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Options;
using Nix.Authentication;
using Nix.Domain.Identity;

namespace Nix.Features.OAuth;

/// <summary>
/// Stateless dynamic client registration: a client identifier is the client's name and redirect URIs, protected
/// with the key ring Core already holds, so Core stores nothing about a client until a person approves one.
/// </summary>
public sealed class OAuthClients(IDataProtectionProvider dataProtection)
{
    /// <summary>Most redirect URIs one client may register.</summary>
    public const int MaxRedirectUris = 5;

    /// <summary>Longest client name kept.</summary>
    public const int MaxNameLength = 64;

    /// <summary>Longest single redirect URI.</summary>
    public const int MaxRedirectLength = 512;

    /// <summary>Longest total of all redirect URIs, which keeps the identifier within <see cref="MaxClientIdLength"/>.</summary>
    public const int MaxRedirectTotal = 1024;

    /// <summary>Longest client identifier accepted.</summary>
    public const int MaxClientIdLength = 2048;

    private readonly IDataProtector _protector = dataProtection.CreateProtector("Nix.OAuth.Client.v1");

    /// <summary>A registered client.</summary>
    /// <param name="Name">The registered name.</param>
    /// <param name="RedirectUris">The registered redirect URIs.</param>
    public sealed record Client(string Name, IReadOnlyList<string> RedirectUris);

    // Invisible, unassigned and direction-changing characters: a name shown to a person must read as what it is.
    private static readonly UnicodeCategory[] HiddenCategories =
    [
        UnicodeCategory.Control, UnicodeCategory.Format, UnicodeCategory.Surrogate, UnicodeCategory.PrivateUse,
        UnicodeCategory.OtherNotAssigned, UnicodeCategory.LineSeparator, UnicodeCategory.ParagraphSeparator,
    ];

    /// <summary>
    /// The name NFKC-normalised, without hidden characters, with whitespace collapsed and its length bounded;
    /// null when nothing is left or the name presents itself as Nix ("Nix", or "Nix" followed by a non-letter).
    /// </summary>
    public static string? CleanName(string? value)
    {
        // Lone surrogates (Cs) decode to U+FFFD and go with it; Normalize would throw on them.
        var valid = string.Concat((value ?? string.Empty).EnumerateRunes().Where(static r => r != Rune.ReplacementChar).Select(static r => r.ToString()));
        var visible = string.Concat(valid.Normalize(NormalizationForm.FormKC).EnumerateRunes()
            .Where(static r => !HiddenCategories.Contains(Rune.GetUnicodeCategory(r)))
            .Select(static r => Rune.IsWhiteSpace(r) ? " " : r.ToString()));
        var name = Cut(string.Join(' ', visible.Split(' ', StringSplitOptions.RemoveEmptyEntries)), MaxNameLength);

        var claimsNix = name.StartsWith("Nix", StringComparison.OrdinalIgnoreCase) && (name.Length == 3 || !char.IsLetter(name[3]));
        return name.Length == 0 || claimsNix ? null : name;
    }

    /// <summary>The token name a connector's access token gets: the client, where it returns to, and a marker.</summary>
    public static string ConnectorTokenName(string clientName, string redirectHost)
    {
        const string Via = " via ", Marker = " (connector)";
        const int MinClientName = 16;
        var room = PersonalAccessToken.MaximumNameLength - Via.Length - Marker.Length;

        // A very long host keeps its end, where the registrable domain is.
        if (redirectHost.Length > room - MinClientName)
        {
            redirectHost = "\u2026" + redirectHost[^(room - MinClientName - 1)..];
        }

        return Cut(clientName, room - redirectHost.Length) + Via + redirectHost + Marker;
    }

    // Shortens without splitting a surrogate pair.
    private static string Cut(string value, int length) =>
        value.Length <= length ? value : value[..(char.IsHighSurrogate(value[length - 1]) ? length - 1 : length)].TrimEnd();

    /// <summary>An https URI, or an http one on a loopback host, with no fragment and no credentials.</summary>
    public static bool IsRedirectUri(string? value)
    {
        // Printable ASCII only: a raw newline or other character would pass Uri parsing and survive into the signed blob.
        if (string.IsNullOrEmpty(value) || value.Length > MaxRedirectLength || value.Contains('#', StringComparison.Ordinal)
            || value.Any(static c => c is < '\u0021' or > '\u007E')
            || !Uri.TryCreate(value, UriKind.Absolute, out var uri) || !string.IsNullOrEmpty(uri.UserInfo))
        {
            return false;
        }

        return uri.Scheme == Uri.UriSchemeHttps
            || (uri.Scheme == Uri.UriSchemeHttp && uri.Host is "localhost" or "127.0.0.1" or "[::1]");
    }

    /// <summary>An RFC 7636 code verifier: 43 to 128 unreserved characters.</summary>
    public static bool IsVerifier(string? value) =>
        value is { Length: >= 43 and <= 128 } && value.All(static c => char.IsAsciiLetterOrDigit(c) || c is '-' or '.' or '_' or '~');

    /// <summary>The punycode host (and a non-default port) a redirect URI sends the browser to, so a look-alike domain cannot read as another.</summary>
    public static string RedirectHost(string redirectUri)
    {
        var uri = new Uri(redirectUri);
        var host = uri.HostNameType == UriHostNameType.IPv6 ? "[" + uri.IdnHost + "]" : uri.IdnHost;
        return uri.IsDefaultPort ? host : host + ":" + uri.Port.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    /// <summary>Whether the verifier hashes to the stored S256 challenge.</summary>
    public static bool VerifierMatches(string verifier, string challenge) =>
        CryptographicOperations.FixedTimeEquals(
            Encoding.ASCII.GetBytes(challenge),
            Encoding.ASCII.GetBytes(Base64Url.EncodeToString(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)))));

    /// <summary>Signs a client into an identifier. The caller has already validated the name and URIs.</summary>
    public string Issue(Client client) => _protector.Protect(client.Name + "\n" + string.Join('\n', client.RedirectUris));

    /// <summary>The client an identifier names, or null when it was not issued here.</summary>
    public Client? Read(string? clientId)
    {
        if (string.IsNullOrEmpty(clientId) || clientId.Length > MaxClientIdLength)
        {
            return null;
        }

        try
        {
            var parts = _protector.Unprotect(clientId).Split('\n');
            // The name rule is re-applied, so an identifier signed under an older rule cannot bypass it.
            return parts.Length >= 2 && parts[1..].All(IsRedirectUri) && CleanName(parts[0]) is { } name ? new Client(name, parts[1..]) : null;
        }
        catch (CryptographicException)
        {
            return null;
        }
    }
}

/// <summary>Where remote MCP is advertised: the public origin and the MCP URL it serves.</summary>
public static class OAuthSettings
{
    /// <summary>False when remote MCP is off, which makes every OAuth route answer 404.</summary>
    public static bool TryGet(IConfiguration configuration, IOptions<BrowserAuthOptions> browser, out string origin, out string mcpUrl)
    {
        origin = mcpUrl = string.Empty;
        if (!Uri.TryCreate(configuration["Nix:Mcp:PublicUrl"], UriKind.Absolute, out var mcp) || !browser.Value.TryPublicOrigin(out var publicOrigin))
        {
            return false;
        }

        origin = publicOrigin.GetLeftPart(UriPartial.Authority);
        mcpUrl = mcp.ToString();
        return true;
    }

    /// <summary>Whether a client-sent resource names this install's MCP URL.</summary>
    public static bool IsResource(string resource, string mcpUrl) =>
        string.Equals(resource.TrimEnd('/'), mcpUrl.TrimEnd('/'), StringComparison.Ordinal);
}
