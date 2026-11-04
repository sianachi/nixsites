using Nix.Workers.Archive;
using Nix.Workers.Render;
using SkiaSharp;

namespace Nix.Workers.Export;

/// <summary>Fetches and validates the rasters a tree's image and diagram blocks name.</summary>
public static class ImageFiles
{
    private const int MaxImageBytes = 10 << 20;
    private const long MaxPixels = 40_000_000;

    /// <summary>
    /// Loads the raster for every image block that names a file item (and every captured diagram),
    /// within a bounded per-record resource set, and points the block's source at the raster. A
    /// block whose raster is unavailable keeps its description and records a loss.
    /// </summary>
    public static async Task<IList<ExportImage>> LoadAsync(IList<Block> blocks, ImageLoader? load, IList<string> losses, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(losses);
        load ??= (_, _) => throw new InvalidOperationException("image loader unavailable");
        var images = new List<ExportImage>();
        var remaining = 32L << 20;
        var candidates = new List<Block>();
        RenderTree.Walk(blocks, block =>
        {
            var file = block.Kind == "code" ? block.RenderFile : block.File;
            if ((block.Kind == "image" || block.Kind == "code") && !string.IsNullOrEmpty(file))
            {
                candidates.Add(block);
            }
        });
        foreach (var block in candidates)
        {
            var diagram = block.Kind == "code";
            var file = diagram ? block.RenderFile! : block.File!;
            if (images.Count >= 64 || remaining <= 0)
            {
                throw new StreamLimitException();
            }
            ExportImage? raster = null;
            try
            {
                var data = await load(file, cancellationToken).ConfigureAwait(false);
                if (data.Length > remaining)
                {
                    throw new StreamLimitException();
                }
                var width = 0;
                if (diagram)
                {
                    (data, width) = Diagrams.Rasterize(data);
                }
                raster = Validated(data);
                raster.Width = diagram ? width : block.Width;
            }
            catch (StreamLimitException)
            {
                throw;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
#pragma warning disable CA1031 // Justification: an unavailable or malformed raster is a recorded loss, never a failed export.
            catch (Exception)
            {
                raster = null;
            }
#pragma warning restore CA1031
            if (raster is null)
            {
                Projection.AppendLoss(losses, diagram
                    ? "A diagram that could not be drawn was represented by its code."
                    : "An unavailable or unsupported image was represented by its description.");
                block.Src = string.Empty;
                continue;
            }
            if (raster.Data.Length > remaining)
            {
                throw new StreamLimitException();
            }
            remaining -= raster.Data.Length;
            raster.Source = $"https://nix.invalid/export-image/{images.Count}/resource";
            block.Src = raster.Source;
            images.Add(raster);
        }
        return images;
    }

    /// <summary>Decodes the raster fully before any document library sees it; WebP is normalised to PNG.</summary>
    public static ExportImage Validated(byte[] data)
    {
        ArgumentNullException.ThrowIfNull(data);
        if (data.Length == 0 || data.Length > MaxImageBytes)
        {
            throw new InvalidDataException("image byte limit exceeded");
        }
        using var codec = SKCodec.Create(new MemoryStream(data));
        var info = codec.Info;
        if (info.Width <= 0 || info.Height <= 0 || (long)info.Width * info.Height > MaxPixels)
        {
            throw new InvalidDataException("invalid or oversized raster image");
        }
        var format = codec.EncodedFormat switch
        {
            SKEncodedImageFormat.Png => "png",
            SKEncodedImageFormat.Jpeg => "jpeg",
            SKEncodedImageFormat.Webp => "webp",
            _ => throw new InvalidDataException("unsupported image format"),
        };
        using var bitmap = SKBitmap.Decode(codec) ?? throw new InvalidDataException("invalid or oversized raster image");
        if (format == "webp")
        {
            using var encoded = bitmap.Encode(SKEncodedImageFormat.Png, 100) ?? throw new InvalidDataException("image encode failed");
            if (encoded.Size > MaxImageBytes)
            {
                throw new StreamLimitException();
            }
            data = encoded.ToArray();
            format = "png";
        }
        return new ExportImage { Data = data, Format = format, PixelWidth = info.Width, PixelHeight = info.Height };
    }

    /// <summary>The drawn size in points: pixels at 0.75 pt each (or the saved width), fitted to the box.</summary>
    public static (double Width, double Height) Size(ExportImage raster, double maxWidth, double maxHeight)
    {
        ArgumentNullException.ThrowIfNull(raster);
        var width = raster.PixelWidth * 0.75;
        if (raster.Width > 0)
        {
            width = raster.Width * 0.75;
        }
        width = Math.Min(width, maxWidth);
        var height = width * raster.PixelHeight / raster.PixelWidth;
        if (height > maxHeight)
        {
            width *= maxHeight / height;
            height = maxHeight;
        }
        return (width, height);
    }
}
