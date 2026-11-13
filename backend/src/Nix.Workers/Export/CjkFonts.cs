using SkiaSharp;

namespace Nix.Workers.Export;

/// <summary>
/// Noto Sans SC and Noto Sans KR (SIL OFL 1.1, fonts/OFL.txt): the PDF fallback for the Chinese,
/// Japanese and Korean text the Go fonts lack. scripts/fetch-pdf-fonts.sh puts them in fonts/ beside
/// the app; when they are missing, that text is replaced with "?" and reported as a loss, as before.
/// </summary>
public static class CjkFonts
{
    // SC first: it covers Chinese and Japanese kana and kanji; KR adds Hangul.
    private static readonly Lazy<Face[]> Faces = new(() =>
    [
        .. new[] { ("NotoSansSC", "NotoSansSC-Regular.ttf"), ("NotoSansKR", "NotoSansKR-Regular.ttf") }
            .Select(entry => (entry.Item1, Path: Path.Combine(AppContext.BaseDirectory, "fonts", entry.Item2)))
            .Where(entry => File.Exists(entry.Path))
            .Select(entry => new Face(entry.Item1, entry.Path)),
    ]);

    /// <summary>Whether the family is a fallback font that is present.</summary>
    public static bool Has(string family) => Find(family) is not null;

    /// <summary>The fallback font's bytes for PdfSharp, or null when the family is not a present fallback.</summary>
    public static byte[]? Bytes(string family) => Find(family)?.Bytes.Value;

    /// <summary>The first present fallback family with a glyph for the rune, or null.</summary>
    public static string? FamilyFor(int rune) => Faces.Value.FirstOrDefault(face => face.Font.Value.GetGlyph(rune) != 0)?.Family;

    private static Face? Find(string family) => Faces.Value.FirstOrDefault(face => string.Equals(face.Family, family, StringComparison.OrdinalIgnoreCase));

    private sealed class Face(string family, string path)
    {
        public string Family { get; } = family;

        // Coverage checks map the file; the bytes (about 10 MB for SC) are read only when a PDF embeds the font.
        public Lazy<SKFont> Font { get; } = new(() => new SKFont(SKTypeface.FromFile(path)));

        public Lazy<byte[]> Bytes { get; } = new(() => File.ReadAllBytes(path)); // byte[]: PdfSharp takes font bytes whole
    }
}
