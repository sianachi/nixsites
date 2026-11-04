#pragma warning disable CA1819 // Justification: the encoded thumbnail is a DTO payload handed straight to the uploader.

using System.Xml;
using SkiaSharp;

namespace Nix.Workers.Files;

/// <summary>Where a thumbnail came from.</summary>
public enum ThumbnailKind
{
    Image,
    AudioCover,
    EpubCover,
}

/// <summary>Why <see cref="Thumbnails.Extract"/> refused, beyond the ordinary "nothing to show" (a null result).</summary>
public enum ThumbnailRefusal
{
    /// <summary>A parser hit something it did not expect; worth a log line, never file content.</summary>
    Fault,

    /// <summary>The source or something inside it exceeded a limit.</summary>
    TooLarge,
}

/// <summary>An encoded JPEG thumbnail whose longer side is at most <see cref="Thumbnails.MaxSide"/>.</summary>
public sealed record ThumbnailResult(byte[] Bytes, string MediaType, int Width, int Height, ThumbnailKind Kind);

/// <summary>The only exception <see cref="Thumbnails.Extract"/> throws for untrusted input.</summary>
public sealed class ThumbnailRefusedException : Exception
{
    public ThumbnailRefusedException()
    {
    }

    public ThumbnailRefusedException(string message)
        : base(message)
    {
    }

    public ThumbnailRefusedException(string message, Exception innerException)
        : base(message, innerException)
    {
    }

    public ThumbnailRefusedException(ThumbnailRefusal refusal, string message, Exception? innerException = null)
        : base(message, innerException) => Refusal = refusal;

    public ThumbnailRefusal Refusal { get; }
}

/// <summary>
/// Extracts a small preview image from an uploaded file (the port of the Go worker's thumbnail package).
/// The input is untrusted, so every parser is bounded in memory and in steps, and no declared size is
/// trusted before it is checked against a constant. The format is decided by sniffing the bytes; the
/// file name and declared media type only tell an EPUB from another ZIP.
/// Sources: PNG, JPEG (EXIF orientation honoured), GIF (first frame), still WebP and BMP; cover art from
/// MP3 (ID3v2.2-2.4), FLAC and MP4/M4A; EPUB covers. Deliberately none: AVIF/HEIC, Ogg cover art,
/// whole-tag-unsynchronised ID3 tags and PDF (first pages render in the browser).
/// </summary>
public static partial class Thumbnails
{
    /// <summary>The longest side of a produced thumbnail; smaller sources are never scaled up.</summary>
    public const int MaxSide = 480;

    public const int JpegQuality = 82;

    /// <summary>The largest width*height decoded, checked from the image header before any pixel buffer exists.</summary>
    public const long MaxSourcePixels = 40_000_000;

    public const int MaxEmbeddedImageBytes = 10 << 20;
    public const int MaxArchiveEntries = 5000;
    public const int MaxArchiveEntryBytes = 20 << 20;
    public const long MaxImageFileBytes = 64 << 20;

    /// <summary>
    /// How many thumbnails one process decodes at once. An image of up to 40 million pixels needs a few
    /// hundred megabytes to decode, and the job concurrency can be far higher than that is safe for.
    /// </summary>
    public const int MaxConcurrentThumbnails = 2;

    /// <summary>The ceiling Core accepts for a thumbnail object (FileEndpoints.MaximumThumbnailBytes must agree).</summary>
    public const int MaxThumbnailBytes = 2 << 20;

    /// <summary>Bounds one thumbnail from extraction to upload.</summary>
    public static readonly TimeSpan ThumbnailTimeout = TimeSpan.FromSeconds(20);

    private const string JpegMediaType = "image/jpeg";
    private const int SniffBytes = 32;

    private enum SourceFormat
    {
        None,
        Image,
        Mp3,
        Flac,
        Mp4,
        Zip,
    }

    /// <summary>
    /// Whether the extractor can produce anything for this inspected media type and extension, so PDFs,
    /// text and unknown binaries cost no decode work.
    /// </summary>
    public static bool IsCandidate(string fileName, string mediaType)
    {
        ArgumentNullException.ThrowIfNull(fileName);
        var extension = Path.GetExtension(fileName);
        return mediaType switch
        {
            "image/png" or "image/jpeg" or "image/webp" or "image/gif" or "audio/mpeg" or "audio/flac" or "audio/mp4" => true,
            "application/zip" => extension.Equals(".epub", StringComparison.OrdinalIgnoreCase),
            // The header inspector does not recognise BMP or MP3 without an ID3 tag.
            "application/octet-stream" => extension.Equals(".bmp", StringComparison.OrdinalIgnoreCase) || extension.Equals(".mp3", StringComparison.OrdinalIgnoreCase),
            _ => false,
        };
    }

    /// <summary>
    /// The thumbnail for a file already staged on local disk by the inspection pass (its size was checked
    /// while copying, so nothing is fetched twice), or null when there is none or it is over
    /// <see cref="MaxThumbnailBytes"/>. Throws what <see cref="Extract"/> throws, and IO errors opening the file.
    /// </summary>
    public static ThumbnailResult? FromStagedFile(string path, long byteLength, string fileName, string mediaType, CancellationToken cancellationToken)
    {
        using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, FileOptions.RandomAccess);
        var result = Extract(file, byteLength, fileName, mediaType, cancellationToken);
        return result is null || result.Bytes.Length == 0 || result.Bytes.Length > MaxThumbnailBytes ? null : result;
    }

    /// <summary>
    /// Reads at most the bytes it needs from <paramref name="source"/> (seekable, exactly
    /// <paramref name="size"/> bytes long) and returns a JPEG thumbnail whose longer side is at most
    /// <see cref="MaxSide"/>, or null when the file has nothing to show or could not be parsed. Throws only
    /// <see cref="OperationCanceledException"/> and <see cref="ThumbnailRefusedException"/>.
    /// </summary>
    public static ThumbnailResult? Extract(Stream source, long size, string fileName, string mediaType, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(source);
        if (!source.CanSeek || !source.CanRead)
        {
            throw new ArgumentException("The source must be readable and seekable.", nameof(source));
        }
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            if (size <= 0 || source.Length != size)
            {
                return null;
            }
            var head = ReadRange(source, 0, Math.Min(size, SniffBytes), size, SniffBytes);
            return Sniff(head, fileName ?? string.Empty, mediaType ?? string.Empty) switch
            {
                SourceFormat.Image => Render(ReadRange(source, 0, size <= MaxImageFileBytes ? size : throw TooLarge("image file"), size, MaxImageFileBytes), ThumbnailKind.Image, cancellationToken),
                SourceFormat.Mp3 => AudioCover(Id3Cover(source, size, cancellationToken), cancellationToken),
                SourceFormat.Flac => AudioCover(FlacCover(source, size, cancellationToken), cancellationToken),
                SourceFormat.Mp4 => AudioCover(Mp4Cover(source, size, cancellationToken), cancellationToken),
                SourceFormat.Zip => EpubCover(source, size, cancellationToken),
                _ => null,
            };
        }
        catch (ThumbnailRefusedException)
        {
            throw;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception) when (cancellationToken.IsCancellationRequested)
        {
            cancellationToken.ThrowIfCancellationRequested();
            throw;
        }
        catch (Exception error) when (error is InvalidDataException or IOException or XmlException)
        {
            return null;
        }
#pragma warning disable CA1031 // Justification: a decoder fault on crafted input must not take down the worker; it becomes a typed refusal.
        catch (Exception error)
        {
            throw new ThumbnailRefusedException(ThumbnailRefusal.Fault, $"thumbnail: parser fault ({error.GetType().Name})", error);
        }
#pragma warning restore CA1031
    }

    private static ThumbnailResult? AudioCover(ArraySegment<byte>? cover, CancellationToken cancellationToken)
    {
        if (cover is not { } image)
        {
            return null;
        }
        cancellationToken.ThrowIfCancellationRequested();
        return Render(image, ThumbnailKind.AudioCover, cancellationToken);
    }

    private static SourceFormat Sniff(ReadOnlySpan<byte> head, string fileName, string mediaType)
    {
        if (head.StartsWith((ReadOnlySpan<byte>)[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) || head.StartsWith((ReadOnlySpan<byte>)[0xff, 0xd8, 0xff])
            || head.StartsWith("GIF87a"u8) || head.StartsWith("GIF89a"u8) || (head.Length >= 12 && head.StartsWith("RIFF"u8) && head[8..12].SequenceEqual("WEBP"u8))
            || head.StartsWith("BM"u8))
        {
            return SourceFormat.Image;
        }
        if (head.StartsWith("ID3"u8))
        {
            return SourceFormat.Mp3;
        }
        if (head.StartsWith("fLaC"u8))
        {
            return SourceFormat.Flac;
        }
        if (head.Length >= 12 && head[4..8].SequenceEqual("ftyp"u8))
        {
            var brand = head[8..12];
            return brand.SequenceEqual("avif"u8) || brand.SequenceEqual("avis"u8) || brand.SequenceEqual("heic"u8) || brand.SequenceEqual("heix"u8)
                || brand.SequenceEqual("heim"u8) || brand.SequenceEqual("heis"u8) || brand.SequenceEqual("hevc"u8) || brand.SequenceEqual("hevx"u8)
                || brand.SequenceEqual("mif1"u8) || brand.SequenceEqual("msf1"u8)
                ? SourceFormat.None
                : SourceFormat.Mp4;
        }
        if (head.StartsWith("PK\u0003\u0004"u8))
        {
            var declared = mediaType.Split(';', 2)[0].Trim();
            if (Path.GetExtension(fileName).Equals(".epub", StringComparison.OrdinalIgnoreCase) || declared.Equals("application/epub+zip", StringComparison.OrdinalIgnoreCase))
            {
                return SourceFormat.Zip;
            }
        }
        return SourceFormat.None;
    }

    private static ThumbnailRefusedException TooLarge(string what) => new(ThumbnailRefusal.TooLarge, $"thumbnail: {what} exceeds limits");

    // Reads exactly n bytes at off, refusing anything outside [0,size] or above limit, so a declared length can never drive an allocation on its own.
    private static byte[] ReadRange(Stream source, long off, long n, long size, long limit)
    {
        if (off < 0 || n < 0 || off > size || n > size - off)
        {
            throw new InvalidDataException("range outside file");
        }
        if (n > limit)
        {
            throw new InvalidDataException("range over limit");
        }
        var buffer = new byte[n]; // byte[]: SKCodec and the tag parsers take whole buffers; n is bounded by limit above
        source.Position = off;
        source.ReadExactly(buffer);
        return buffer;
    }

    // Decodes data (header pixel limit first), scales it into MaxSide on white, applies the JPEG EXIF orientation and encodes a JPEG.
    private static ThumbnailResult Render(ArraySegment<byte> data, ThumbnailKind kind, CancellationToken cancellationToken)
    {
        if (data.Count == 0)
        {
            throw new InvalidDataException("empty image");
        }
        // Skia needs more than the header to open a codec, so the declared size is checked from the header alone first, as Go's DecodeConfig did.
        var declared = FileInspector.InspectHeader(data.AsSpan(0, Math.Min(data.Count, FileInspector.HeaderLimit)), data.Count);
        if ((long?)declared.Width * declared.Height > MaxSourcePixels)
        {
            throw TooLarge("image");
        }
        using var codec = SKCodec.Create(new MemoryStream(data.Array!, data.Offset, data.Count, writable: false), out var opened);
        if (opened != SKCodecResult.Success)
        {
            throw new InvalidDataException("image header");
        }
        // The decoders the Go worker registered, and no more: an embedded cover in another format is no thumbnail.
        if (codec.EncodedFormat is not (SKEncodedImageFormat.Png or SKEncodedImageFormat.Jpeg or SKEncodedImageFormat.Gif or SKEncodedImageFormat.Bmp or SKEncodedImageFormat.Webp))
        {
            throw new InvalidDataException("unsupported image format");
        }
        if (codec.EncodedFormat == SKEncodedImageFormat.Webp && codec.FrameCount > 1)
        {
            throw new InvalidDataException("animated WebP");
        }
        int width = codec.Info.Width, height = codec.Info.Height;
        if (width <= 0 || height <= 0)
        {
            throw new InvalidDataException("image has no area");
        }
        if ((long)width * height > MaxSourcePixels)
        {
            throw TooLarge("image");
        }
        cancellationToken.ThrowIfCancellationRequested();
        using var source = new SKBitmap(new SKImageInfo(width, height, SKImageInfo.PlatformColorType, SKAlphaType.Premul));
        // A truncated or corrupt image is refused rather than drawn half grey (Skia would accept incomplete input).
        if (source.GetPixels() == IntPtr.Zero || codec.GetPixels(source.Info, source.GetPixels()) != SKCodecResult.Success)
        {
            throw new InvalidDataException("image decode");
        }
        source.SetImmutable();
        cancellationToken.ThrowIfCancellationRequested();

        long scaledWidth = width, scaledHeight = height;
        var longer = Math.Max(scaledWidth, scaledHeight);
        if (longer > MaxSide)
        {
            scaledWidth = Math.Max(1, width * (long)MaxSide / longer);
            scaledHeight = Math.Max(1, height * (long)MaxSide / longer);
        }
        // Go read EXIF only from JPEG; SKCodec also reports PNG/WebP EXIF, which is ignored for parity.
        var origin = codec.EncodedFormat == SKEncodedImageFormat.Jpeg ? codec.EncodedOrigin : SKEncodedOrigin.TopLeft;
        var swap = origin >= SKEncodedOrigin.LeftTop;
        int outWidth = (int)(swap ? scaledHeight : scaledWidth), outHeight = (int)(swap ? scaledWidth : scaledHeight);

        using var image = SKImage.FromBitmap(source);
        using var target = new SKBitmap(new SKImageInfo(outWidth, outHeight, SKColorType.Rgba8888, SKAlphaType.Premul));
        using (var canvas = new SKCanvas(target))
        {
            canvas.Clear(SKColors.White);
            canvas.SetMatrix(Orientation(origin, scaledWidth, scaledHeight));
            canvas.DrawImage(image, SKRect.Create(scaledWidth, scaledHeight), new SKSamplingOptions(SKFilterMode.Linear, SKMipmapMode.Linear), null);
        }
        using var encoded = target.Encode(SKEncodedImageFormat.Jpeg, JpegQuality) ?? throw new InvalidOperationException("thumbnail: encode");
        return new ThumbnailResult(encoded.ToArray(), JpegMediaType, outWidth, outHeight, kind);
    }

    // Maps the upright w*h thumbnail onto the oriented canvas, the same pixel mapping as EXIF orientations 2-8.
    private static SKMatrix Orientation(SKEncodedOrigin origin, float w, float h) => origin switch
    {
        SKEncodedOrigin.TopRight => new SKMatrix(-1, 0, w, 0, 1, 0, 0, 0, 1),
        SKEncodedOrigin.BottomRight => new SKMatrix(-1, 0, w, 0, -1, h, 0, 0, 1),
        SKEncodedOrigin.BottomLeft => new SKMatrix(1, 0, 0, 0, -1, h, 0, 0, 1),
        SKEncodedOrigin.LeftTop => new SKMatrix(0, 1, 0, 1, 0, 0, 0, 0, 1),
        SKEncodedOrigin.RightTop => new SKMatrix(0, -1, h, 1, 0, 0, 0, 0, 1),
        SKEncodedOrigin.RightBottom => new SKMatrix(0, -1, h, -1, 0, w, 0, 0, 1),
        SKEncodedOrigin.LeftBottom => new SKMatrix(0, 1, 0, -1, 0, w, 0, 0, 1),
        _ => SKMatrix.Identity,
    };
}
