#pragma warning disable CA1819 // Justification: the font libraries take the TTF bytes whole.
using System.Reflection;
using System.Resources;
using SkiaSharp;
using Svg.Skia.TypefaceProviders;

namespace Nix.Workers.Export;

/// <summary>The Go fonts embedded in this assembly: the only glyphs the PDF and diagram renderers use.</summary>
public static class GoFonts
{
    public const string Family = "Go";
    public const string MonoFamily = "GoMono";

    private static readonly Lazy<byte[]> RegularBytes = new(() => Read("Go-Regular.ttf"));
    private static readonly Lazy<byte[]> BoldBytes = new(() => Read("Go-Bold.ttf"));
    private static readonly Lazy<byte[]> ItalicBytes = new(() => Read("Go-Italic.ttf"));
    private static readonly Lazy<byte[]> BoldItalicBytes = new(() => Read("Go-Bold-Italic.ttf"));
    private static readonly Lazy<byte[]> MonoBytes = new(() => Read("Go-Mono.ttf"));
    private static readonly Lazy<SKTypeface> RegularTypeface = new(() => SKTypeface.FromStream(new MemoryStream(Regular)));
    private static readonly Lazy<SKFont> RegularFont = new(() => new SKFont(Typeface));
    private static readonly Lazy<CustomTypefaceProvider> Provider = new(() =>
    {
        // One face for every diagram label, as the Go worker replaced every family with "Go".
        var provider = new CustomTypefaceProvider(new MemoryStream(Regular), 0) { FamilyName = Family };
        provider.FamilyAliases.Add(MonoFamily);
        return provider;
    });

    public static byte[] Regular => RegularBytes.Value; // byte[]: font bytes the PDF and Skia libraries take whole

    public static byte[] Bold => BoldBytes.Value; // byte[]: font bytes the PDF and Skia libraries take whole

    public static byte[] Italic => ItalicBytes.Value; // byte[]: font bytes the PDF and Skia libraries take whole

    public static byte[] BoldItalic => BoldItalicBytes.Value; // byte[]: font bytes the PDF and Skia libraries take whole

    public static byte[] Mono => MonoBytes.Value; // byte[]: font bytes the PDF and Skia libraries take whole

    /// <summary>Go Regular as a Skia typeface, for glyph-coverage checks.</summary>
    public static SKTypeface Typeface => RegularTypeface.Value;

    /// <summary>The diagram renderer's font source.</summary>
    public static ITypefaceProvider TypefaceProvider => Provider.Value;

    /// <summary>Whether Go Regular has a glyph for the rune; the PDF substitutes "?" otherwise, as the Go worker did.</summary>
    public static bool HasGlyph(int rune) => RegularFont.Value.GetGlyph(rune) != 0;

    private static byte[] Read(string name)
    {
        using var stream = typeof(GoFonts).Assembly.GetManifestResourceStream($"Nix.Workers.Fonts.{name}")
            ?? throw new MissingManifestResourceException($"font {name} is not embedded");
        using var buffer = new MemoryStream();
        stream.CopyTo(buffer);
        return buffer.ToArray();
    }
}
