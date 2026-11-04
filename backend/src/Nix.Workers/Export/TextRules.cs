using System.Text;

namespace Nix.Workers.Export;

/// <summary>Text the document formats can carry, and the one-line titles they need.</summary>
public static class TextRules
{
    private static readonly string[] DocumentLinkSchemes = ["http", "https", "mailto", "nix"];

    /// <summary>Keeps a title to one safe line for a file name, a heading or an XML text node.</summary>
    public static (string Title, bool Lost) ProjectTitle(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        var output = new StringBuilder();
        var lost = false;
        var space = false;
        foreach (var rune in value.EnumerateRunes())
        {
            var c = rune.Value;
            if (c is '\n' or '\r' or '\t')
            {
                space = output.Length > 0;
                lost = true;
                continue;
            }
            if (!ValidXmlRune(c) || Rune.IsControl(rune))
            {
                lost = true;
                continue;
            }
            if (space && c != ' ')
            {
                output.Append(' ');
            }
            space = false;
            output.Append(rune.ToString());
        }
        var title = output.ToString().Trim();
        if (title.Length == 0)
        {
            title = "Untitled";
            lost = true;
        }
        return (title, lost);
    }

    public static string Sanitize(string value) => SanitizeDetailed(value).Text;

    /// <summary>Drops what no document format can carry: control characters and runes outside the XML text range. Line breaks and tabs stay.</summary>
    public static (string Text, bool Changed) SanitizeDetailed(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        var output = new StringBuilder(value.Length);
        var changed = false;
        for (var index = 0; index < value.Length;)
        {
            if (!Rune.TryGetRuneAt(value, index, out var rune))
            {
                // A lone surrogate is not XML text either.
                index++;
                changed = true;
                continue;
            }
            index += rune.Utf16SequenceLength;
            var c = rune.Value;
            if (c == '\r')
            {
                if (index < value.Length && value[index] == '\n')
                {
                    index++;
                }
                output.Append('\n');
                changed = true;
                continue;
            }
            if (c is '\n' or '\t')
            {
                output.Append((char)c);
                continue;
            }
            if (c >= 32 && ValidXmlRune(c) && !Rune.IsControl(rune))
            {
                output.Append(rune.ToString());
                continue;
            }
            changed = true;
        }
        return (output.ToString(), changed);
    }

    public static bool ValidXmlRune(int c) =>
        c is '\t' or '\n' or '\r'
        || (c >= 0x20 && c <= 0xd7ff)
        || (c >= 0xe000 && c <= 0xfffd)
        || (c >= 0x10000 && c <= 0x10ffff);

    /// <summary>Go's <c>html.EscapeString</c>: the five XML specials, apostrophe as <c>&amp;#39;</c> and quote as <c>&amp;#34;</c>.</summary>
    public static string EscapeXml(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        var output = new StringBuilder(value.Length);
        foreach (var c in value)
        {
            output.Append(c switch
            {
                '&' => "&amp;",
                '\'' => "&#39;",
                '<' => "&lt;",
                '>' => "&gt;",
                '"' => "&#34;",
                _ => c.ToString(),
            });
        }
        return output.ToString();
    }

    /// <summary>Whether a link may be written into a document: http, https, mailto or nix, bounded, no userinfo.</summary>
    public static bool SafeDocumentLink(string raw)
    {
        if (string.IsNullOrEmpty(raw) || raw.Length > 2048 || raw.IndexOfAny(['\r', '\n', '\0', '"', '\\']) >= 0)
        {
            return false;
        }
        var colon = raw.IndexOf(':', StringComparison.Ordinal);
        if (colon <= 0)
        {
            return false;
        }
        var scheme = raw[..colon];
        if (!DocumentLinkSchemes.Any(known => string.Equals(scheme, known, StringComparison.OrdinalIgnoreCase)))
        {
            return false;
        }
        // Go's url.Parse refused userinfo; a "//user@host" authority is the one shape that carries it.
        var rest = raw[(colon + 1)..];
        if (rest.StartsWith("//", StringComparison.Ordinal))
        {
            var authority = rest[2..];
            var end = authority.IndexOfAny(['/', '?', '#']);
            if (end >= 0)
            {
                authority = authority[..end];
            }
            if (authority.Contains('@', StringComparison.Ordinal))
            {
                return false;
            }
        }
        return true;
    }
}
