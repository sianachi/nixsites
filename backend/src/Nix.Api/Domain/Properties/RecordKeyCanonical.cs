using System.Text;

namespace Nix.Domain.Properties;

/// <summary>
/// The canonical form of a value that identifies a record, and the bounds that keep it indexable.
/// </summary>
/// <remarks>
/// Url lowercases scheme and host and drops the default port and the fragment; path, query and
/// trailing slash stay exactly as given, so removing tracking parameters is the caller's job. Text
/// is trimmed and case-sensitive. The canonical value is what is stored in the property, so a
/// property read and a key lookup always agree.
/// </remarks>
public static class RecordKeyCanonical
{
    /// <summary>The most characters a key may hold.</summary>
    public const int MaximumCharacters = 2048;

    /// <summary>The most UTF-8 bytes a key may hold; keeps a btree entry under Postgres' tuple limit.</summary>
    public const int MaximumBytes = 2400;

    /// <summary>Canonicalises a value for a unique field of the given type.</summary>
    /// <param name="type">Text or url.</param>
    /// <param name="value">The value as written.</param>
    /// <param name="refusal">Why the value cannot be a key, when it cannot.</param>
    /// <returns>The canonical value ("" when the value is blank, meaning no key), or null on refusal.</returns>
    public static string? Canonicalize(PropertyType type, string value, out string? refusal)
    {
        ArgumentNullException.ThrowIfNull(value);
        refusal = null;
        var trimmed = value.Trim();
        var canonical = type == PropertyType.Url && trimmed.Length > 0 ? CanonicalUrl(trimmed) : trimmed;
        if (canonical is null)
        {
            refusal = "must be an http or https address.";
            return null;
        }

        if (canonical.Length > MaximumCharacters || Encoding.UTF8.GetByteCount(canonical) > MaximumBytes)
        {
            refusal = $"is too long to identify a record (at most {MaximumCharacters} characters and {MaximumBytes} bytes).";
            return null;
        }

        return canonical;
    }

    /// <summary>The canonical form of an absolute http or https address, or null when it is not one.</summary>
    /// <param name="text">A trimmed address.</param>
    /// <returns>The canonical address, or null.</returns>
    [System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1055:URI-like return values should not be strings", Justification = "The canonical text is the stored value; a Uri would re-normalise the path and query that must stay exact.")]
    [System.Diagnostics.CodeAnalysis.SuppressMessage("Globalization", "CA1308:Normalize strings to uppercase", Justification = "The canonical URL form is lower-case scheme and host.")]
    public static string? CanonicalUrl(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        var schemeEnd = text.IndexOf("://", StringComparison.Ordinal);
        if (schemeEnd <= 0
            || !Uri.TryCreate(text, UriKind.Absolute, out var parsed)
            || (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps))
        {
            return null;
        }

        var scheme = text[..schemeEnd].ToLowerInvariant();
        var rest = text[(schemeEnd + 3)..];
        var fragment = rest.IndexOf('#', StringComparison.Ordinal);
        if (fragment >= 0)
        {
            rest = rest[..fragment];
        }

        var boundary = rest.IndexOfAny(['/', '?']);
        var authority = boundary < 0 ? rest : rest[..boundary];
        var tail = boundary < 0 ? string.Empty : rest[boundary..];
        var at = authority.LastIndexOf('@');
        var userInfo = at < 0 ? string.Empty : authority[..(at + 1)];
        var hostPort = authority[(at + 1)..];
        var colon = hostPort.LastIndexOf(':');
        var host = hostPort;
        var port = string.Empty;
        if (colon >= 0 && colon > hostPort.LastIndexOf(']'))
        {
            host = hostPort[..colon];
            port = hostPort[(colon + 1)..];
        }

        if (host.Length == 0)
        {
            return null;
        }

        var defaultPort = scheme == "https" ? "443" : "80";
        var keepPort = port.Length > 0 && port != defaultPort;
        return $"{scheme}://{userInfo}{host.ToLowerInvariant()}{(keepPort ? ":" + port : string.Empty)}{tail}";
    }
}
