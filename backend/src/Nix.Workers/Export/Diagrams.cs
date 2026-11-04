using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using SkiaSharp;
using Svg.Skia;

namespace Nix.Workers.Export;

/// <summary>
/// A diagram is the SVG the author's browser captured from a Mermaid code block. PDF and DOCX take
/// rasters only, so it is drawn here with Skia: no browser, no system fonts, nothing in the SVG
/// runs. Every family the diagram names is replaced by the Go fonts the PDF renderer embeds.
/// </summary>
public static partial class Diagrams
{
    private const string DiagramFamily = "Go";

    // 40 MP is the 10 MP declared-size bound drawn at twice its size: 160 MB of RGBA at most.
    private const long MaxPixels = 40_000_000;

    /// <summary>Draws an SVG as a PNG at twice its pixel size, so it stays sharp on a printed page; returns the size it was drawn for, zero when unknown.</summary>
    public static (byte[] Png, int Width) Rasterize(byte[] svg)
    {
        ArgumentNullException.ThrowIfNull(svg);
        var text = FontFamily().Replace(Encoding.UTF8.GetString(svg), match =>
        {
            var separator = match.Value.IndexOfAny([':', '=']);
            var rest = match.Value[(separator + 1)..].TrimStart();
            var quote = rest.Length > 0 && rest[0] is '"' or '\'' ? rest[0].ToString() : string.Empty;
            return match.Value[..(separator + 1)] + quote + DiagramFamily + quote;
        });
        var width = 0;
        var height = 0;
        if (SvgSize().Match(text) is { Success: true } size)
        {
            width = Atoi(size.Groups[1].Value);
            height = Atoi(size.Groups[2].Value);
            if (width <= 0 || height <= 0 || (long)width * height > 10_000_000)
            {
                width = height = 0;
            }
        }
        // The SVG is user content parsed inside Core: Svg.Custom fetches href'd images and elements
        // (http and file) by default, which is SSRF and a local file read. These are process-wide statics.
        Svg.SvgDocument.ResolveExternalImages = Svg.ExternalType.None;
        Svg.SvgDocument.ResolveExternalElements = Svg.ExternalType.None;
        Svg.SvgDocument.ResolveExternalXmlEntites = Svg.ExternalType.None;
        Svg.SvgDocument.DisableDtdProcessing = true;
        using var document = new SKSvg();
        document.Settings.TypefaceProviders = [GoFonts.TypefaceProvider];
        using var picture = document.FromSvg(text) ?? throw new InvalidDataException("empty diagram");
        var bounds = picture.CullRect;
        var pixelWidth = width > 0 ? width * 2L : (long)Math.Ceiling(bounds.Width);
        var pixelHeight = height > 0 ? height * 2L : (long)Math.Ceiling(bounds.Height);
        if (pixelWidth <= 0 || pixelHeight <= 0)
        {
            throw new InvalidDataException("empty diagram");
        }
        // The declared-size check above falls back to the drawing's bounds, so the canvas is capped here too.
        if (pixelWidth > MaxPixels || pixelHeight > MaxPixels || pixelWidth * pixelHeight > MaxPixels)
        {
            throw new InvalidDataException("diagram is too large to draw");
        }
        var scaleX = width > 0 ? 2f : 1f;
        var scaleY = height > 0 ? 2f : 1f;
        using var bitmap = new SKBitmap((int)pixelWidth, (int)pixelHeight, SKColorType.Rgba8888, SKAlphaType.Premul);
        using (var canvas = new SKCanvas(bitmap))
        {
            canvas.Clear(SKColors.Transparent);
            canvas.Scale(scaleX, scaleY);
            canvas.DrawPicture(picture);
        }
        using var image = SKImage.FromBitmap(bitmap);
        using var encoded = image.Encode(SKEncodedImageFormat.Png, 100) ?? throw new InvalidDataException("empty diagram");
        return (encoded.ToArray(), width);
    }

    private static int Atoi(string digits)
    {
        var value = 0;
        foreach (var digit in digits)
        {
            if (value > 1_000_000)
            {
                return 0;
            }
            value = value * 10 + (digit - '0');
        }
        return value;
    }

    [GeneratedRegex("font-family\\s*[:=]\\s*(\"[^\"]*\"|'[^']*'|[^;}\"'>]*)")]
    private static partial Regex FontFamily();

    [GeneratedRegex("<svg[^>]*\\swidth=\"(\\d+)\"[^>]*\\sheight=\"(\\d+)\"")]
    private static partial Regex SvgSize();

    internal static string Invariant(int value) => value.ToString(CultureInfo.InvariantCulture);
}
