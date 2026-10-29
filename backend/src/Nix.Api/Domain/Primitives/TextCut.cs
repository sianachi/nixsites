namespace Nix.Domain.Primitives;

/// <summary>Truncation that never leaves half of a UTF-16 surrogate pair.</summary>
public static class TextCut
{
    /// <summary>The text cut to at most <paramref name="max"/> UTF-16 units, backing off a split pair.</summary>
    public static string Cut(string text, int max)
    {
        ArgumentNullException.ThrowIfNull(text);
        if (text.Length <= max)
        {
            return text;
        }

        return text[..(max > 0 && char.IsHighSurrogate(text[max - 1]) ? max - 1 : max)];
    }
}
