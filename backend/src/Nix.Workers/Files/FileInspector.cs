using System.Buffers.Binary;
using System.Text;
using System.Text.Unicode;

namespace Nix.Workers.Files;

/// <summary>What the header of an upload proves about it. Width and height are set only when they are sane.</summary>
public sealed record FileMetadata(string MediaType, bool Previewable, int? Width, int? Height)
{
    /// <summary>An animated raster (APNG, animated WebP or AVIF sequence, any GIF); never previewable.</summary>
    public bool Animated { get; init; }

    /// <summary>The signature matched but the structure did not.</summary>
    public bool Malformed { get; init; }
}

/// <summary>
/// Header-only sniffing of uploaded bytes (the port of the Go worker's fileinspect). Magic numbers
/// only: the declared type and the extension are claims, the bytes are the evidence. Only raster
/// images with bounded, well-formed dimensions and no animation, and bounded PDFs, are previewable.
/// </summary>
public static class FileInspector
{
    /// <summary>The most leading bytes <see cref="InspectHeader"/> needs.</summary>
    public const int HeaderLimit = 64 * 1024;

    private const long PreviewBytes = 10 * 1024 * 1024;
    private const long PreviewPixels = 40_000_000;
    private const ulong MaxImageSide = 100_000;
    private const int MaxBoxDepth = 8;
    private const string OctetStream = "application/octet-stream";

    private static ReadOnlySpan<byte> PngSignature => [137, 80, 78, 71, 13, 10, 26, 10];
    private static ReadOnlySpan<byte> EbmlSignature => [0x1a, 0x45, 0xdf, 0xa3];

    private sealed record ImageFacts(int? Width, int? Height, bool Animated, bool PreviewSafe, bool Malformed);

    private static readonly ImageFacts Broken = new(null, null, false, false, true);

    public static FileMetadata InspectHeader(ReadOnlySpan<byte> header, long totalBytes)
    {
        ImageFacts? image = null;
        string mediaType;
        var previewable = false;
        if (header.StartsWith(PngSignature))
        {
            mediaType = "image/png";
            image = Png(header, totalBytes);
        }
        else if (header.Length >= 2 && header[0] == 0xff && header[1] == 0xd8)
        {
            mediaType = "image/jpeg";
            image = Jpeg(header, totalBytes);
        }
        else if (header.Length >= 12 && Is(header, 0, "RIFF") && Is(header, 8, "WEBP"))
        {
            mediaType = "image/webp";
            image = WebP(header, totalBytes);
        }
        else if (LooksLikeAvif(header))
        {
            mediaType = "image/avif";
            image = Avif(header, totalBytes);
        }
        else if (header.Length >= 6 && (Is(header, 0, "GIF87a") || Is(header, 0, "GIF89a")))
        {
            mediaType = "image/gif";
            var (width, height) = header.Length >= 10
                ? Dimensions(BinaryPrimitives.ReadUInt16LittleEndian(header[6..]), BinaryPrimitives.ReadUInt16LittleEndian(header[8..]))
                : (null, null);
            image = new ImageFacts(width, height, true, false, width is null || height is null);
        }
        else if (VideoMediaType(header) is { } video)
        {
            // Only the true type is recorded; sites publish a video by this type and nothing else.
            mediaType = video;
        }
        else if (AudioMediaType(header) is { } audio)
        {
            // Audio is never previewable in the pixel-bounded sense; the server serves a vetted audio type on its own rule.
            mediaType = audio;
        }
        else if (Is(header, 0, "%PDF-"))
        {
            mediaType = "application/pdf";
            previewable = totalBytes is >= 0 and <= PreviewBytes;
        }
        else if (header.Length >= 4 && Is(header, 0, "PK\u0003\u0004"))
        {
            mediaType = ZipMediaType(header);
        }
        else if (LooksLikeSvg(header))
        {
            mediaType = "image/svg+xml";
        }
        else if (LooksLikeText(header))
        {
            mediaType = "text/plain";
        }
        else
        {
            mediaType = OctetStream;
        }

        if (image is null)
        {
            return new FileMetadata(mediaType, previewable, null, null);
        }
        if (image.PreviewSafe && image.Width is { } w && image.Height is { } h)
        {
            var pixels = (long)w * h;
            previewable = !image.Animated && totalBytes is >= 0 and <= PreviewBytes && pixels is > 0 and <= PreviewPixels;
        }
        return new FileMetadata(mediaType, previewable, image.Width, image.Height) { Animated = image.Animated, Malformed = image.Malformed };
    }

    private static ImageFacts Png(ReadOnlySpan<byte> header, long totalBytes)
    {
        if (header.Length < 33 || totalBytes < 33)
        {
            return Broken;
        }
        if (BinaryPrimitives.ReadUInt32BigEndian(header[8..]) != 13 || !Is(header, 12, "IHDR") || !ValidPngCrc(header[12..29], header[29..33]))
        {
            return Broken;
        }
        var (width, height) = Dimensions(BinaryPrimitives.ReadUInt32BigEndian(header[16..]), BinaryPrimitives.ReadUInt32BigEndian(header[20..]));
        if (width is null || height is null || !ValidPngHeader(header[24], header[25], header[26], header[27], header[28]))
        {
            return Broken;
        }

        var animated = false;
        var offset = 33;
        for (var chunks = 0; chunks < 1024; chunks++)
        {
            if (offset + 8 > header.Length)
            {
                return new(width, height, animated, false, totalBytes <= header.Length);
            }
            ulong length = BinaryPrimitives.ReadUInt32BigEndian(header[offset..]);
            var chunkEnd = (ulong)offset + 12 + length;
            if (chunkEnd > (ulong)totalBytes)
            {
                return new(width, height, animated, false, true);
            }
            if (Is(header, offset + 4, "IDAT"))
            {
                return new(width, height, animated, true, false);
            }
            if (Is(header, offset + 4, "IEND"))
            {
                return new(width, height, animated, false, true);
            }
            if (chunkEnd > (ulong)header.Length)
            {
                return new(width, height, animated, false, false);
            }
            var dataEnd = offset + 8 + (int)length;
            if (!ValidPngCrc(header[(offset + 4)..dataEnd], header[dataEnd..(dataEnd + 4)]))
            {
                return new(width, height, animated, false, true);
            }
            if (Is(header, offset + 4, "acTL"))
            {
                if (length != 8)
                {
                    return new(width, height, false, false, true);
                }
                animated = true;
            }
            offset = (int)chunkEnd;
        }
        return new(width, height, animated, false, true);
    }

    private static bool ValidPngHeader(byte bitDepth, byte colorType, byte compression, byte filter, byte interlace) =>
        compression == 0 && filter == 0 && interlace <= 1 && colorType switch
        {
            0 => bitDepth is 1 or 2 or 4 or 8 or 16,
            2 or 4 or 6 => bitDepth is 8 or 16,
            3 => bitDepth is 1 or 2 or 4 or 8,
            _ => false,
        };

    private static bool ValidPngCrc(ReadOnlySpan<byte> body, ReadOnlySpan<byte> expected) =>
        expected.Length == 4 && Crc32(body) == BinaryPrimitives.ReadUInt32BigEndian(expected);

    private static ImageFacts Jpeg(ReadOnlySpan<byte> header, long totalBytes)
    {
        var offset = 2;
        for (var segments = 0; segments < 4096; segments++)
        {
            if (offset >= header.Length)
            {
                return new(null, null, false, false, totalBytes <= header.Length);
            }
            if (header[offset] != 0xff)
            {
                return Broken;
            }
            while (offset < header.Length && header[offset] == 0xff)
            {
                offset++;
            }
            if (offset >= header.Length)
            {
                return new(null, null, false, false, totalBytes <= header.Length);
            }
            var marker = header[offset];
            offset++;
            if (marker is 0xd9 or 0xda)
            {
                return Broken;
            }
            if (marker is 0xd8 or 0x01 or >= 0xd0 and <= 0xd7)
            {
                continue;
            }
            if (offset + 2 > header.Length)
            {
                return new(null, null, false, false, totalBytes <= header.Length);
            }
            int length = BinaryPrimitives.ReadUInt16BigEndian(header[offset..]);
            if (length < 2 || offset + length > totalBytes)
            {
                return Broken;
            }
            if (offset + length > header.Length)
            {
                return new(null, null, false, false, false);
            }
            if (marker is >= 0xc0 and <= 0xcf and not 0xc4 and not 0xc8 and not 0xcc)
            {
                if (length < 8)
                {
                    return Broken;
                }
                int components = header[offset + 7];
                if (components == 0 || length != 8 + 3 * components)
                {
                    return Broken;
                }
                var (width, height) = Dimensions(BinaryPrimitives.ReadUInt16BigEndian(header[(offset + 5)..]), BinaryPrimitives.ReadUInt16BigEndian(header[(offset + 3)..]));
                return width is null || height is null ? Broken : new(width, height, false, true, false);
            }
            offset += length;
        }
        return Broken;
    }

    private static ImageFacts WebP(ReadOnlySpan<byte> header, long totalBytes)
    {
        if (header.Length < 20 || totalBytes < 20 || (ulong)BinaryPrimitives.ReadUInt32LittleEndian(header[4..]) + 8 != (ulong)totalBytes)
        {
            return Broken;
        }
        ulong chunkSize = BinaryPrimitives.ReadUInt32LittleEndian(header[16..]);
        if (20 + chunkSize > (ulong)totalBytes)
        {
            return Broken;
        }
        int? width;
        int? height;
        var animated = false;
        if (Is(header, 12, "VP8X"))
        {
            if (chunkSize != 10 || header.Length < 30)
            {
                return Broken;
            }
            var flags = header[20];
            if ((flags & 0xc1) != 0 || header[21] != 0 || header[22] != 0 || header[23] != 0)
            {
                return Broken;
            }
            (width, height) = Dimensions(1 + Little24(header[24..]), 1 + Little24(header[27..]));
            animated = (flags & 0x02) != 0;
        }
        else if (Is(header, 12, "VP8 "))
        {
            if (chunkSize < 10 || header.Length < 30 || (header[20] & 1) != 0 || header[23] != 0x9d || header[24] != 0x01 || header[25] != 0x2a)
            {
                return Broken;
            }
            (width, height) = Dimensions(
                (ulong)(BinaryPrimitives.ReadUInt16LittleEndian(header[26..]) & 0x3fff),
                (ulong)(BinaryPrimitives.ReadUInt16LittleEndian(header[28..]) & 0x3fff));
        }
        else if (Is(header, 12, "VP8L"))
        {
            if (chunkSize < 5 || header.Length < 25 || header[20] != 0x2f)
            {
                return Broken;
            }
            var bits = BinaryPrimitives.ReadUInt32LittleEndian(header[21..]);
            (width, height) = Dimensions((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
        }
        else
        {
            return Broken;
        }
        return width is null || height is null ? new(null, null, animated, false, true) : new(width, height, animated, true, false);
    }

    private static ulong Little24(ReadOnlySpan<byte> value) => value[0] | ((ulong)value[1] << 8) | ((ulong)value[2] << 16);

    private static bool LooksLikeAvif(ReadOnlySpan<byte> header)
    {
        if (header.Length < 16)
        {
            return false;
        }
        var (size, headerSize, ok) = BoxSize(header, 0, header.Length);
        return ok && size >= (ulong)(headerSize + 8) && size <= (ulong)header.Length && Is(header, 4, "ftyp") && AvifBrands(header[headerSize..(int)size]) != 0;
    }

    private static ImageFacts Avif(ReadOnlySpan<byte> header, long totalBytes)
    {
        if (totalBytes < 16)
        {
            return Broken;
        }
        var (ftypSize, ftypHeader, ok) = BoxSize(header, 0, totalBytes);
        if (!ok || ftypSize > (ulong)header.Length || ftypSize < (ulong)(ftypHeader + 8) || !Is(header, 4, "ftyp"))
        {
            return Broken;
        }
        var brands = AvifBrands(header[ftypHeader..(int)ftypSize]);
        if (brands == 0)
        {
            return Broken;
        }
        var animated = (brands & 2) != 0;

        bool hasMeta = false, hasMedia = false;
        int? width = null, height = null;
        var offset = (int)ftypSize;
        for (var boxes = 0; offset + 8 <= header.Length && boxes < 4096; boxes++)
        {
            var (size, boxHeader, valid) = BoxSize(header, offset, totalBytes);
            if (!valid)
            {
                return new(null, null, animated, false, true);
            }
            if (Is(header, offset + 4, "mdat"))
            {
                hasMedia = true;
            }
            if (Is(header, offset + 4, "meta"))
            {
                hasMeta = true;
                if (size <= (ulong)(header.Length - offset) && size >= (ulong)(boxHeader + 4))
                {
                    (width, height) = FindIspe(header[(offset + boxHeader + 4)..(offset + (int)size)], 0, false);
                }
            }
            if (width is not null && height is not null && hasMedia)
            {
                break;
            }
            if (size > (ulong)(header.Length - offset))
            {
                break;
            }
            offset += (int)size;
        }
        return !hasMeta || !hasMedia || width is null || height is null
            ? new(width, height, animated, false, false)
            : new(width, height, animated, true, false);
    }

    private static int AvifBrands(ReadOnlySpan<byte> body)
    {
        if (body.Length < 8 || (body.Length - 8) % 4 != 0)
        {
            return 0;
        }
        var result = 0;
        for (var offset = 0; offset + 4 <= body.Length; offset += 4)
        {
            if (offset == 4)
            {
                continue; // minor version
            }
            if (Is(body, offset, "avif"))
            {
                result |= 1;
            }
            else if (Is(body, offset, "avis"))
            {
                result |= 2;
            }
        }
        return result;
    }

    private static (int? Width, int? Height) FindIspe(ReadOnlySpan<byte> body, int depth, bool insideProperties)
    {
        if (depth > MaxBoxDepth)
        {
            return (null, null);
        }
        var offset = 0;
        for (var boxes = 0; offset + 8 <= body.Length && boxes < 4096; boxes++)
        {
            var (size, headerSize, ok) = BoxSize(body, offset, body.Length);
            if (!ok || size > (ulong)(body.Length - offset))
            {
                return (null, null);
            }
            var content = body[(offset + headerSize)..(offset + (int)size)];
            if (Is(body, offset + 4, "ispe") && insideProperties && content.Length >= 12)
            {
                return Dimensions(BinaryPrimitives.ReadUInt32BigEndian(content[4..]), BinaryPrimitives.ReadUInt32BigEndian(content[8..]));
            }
            var kind = Encoding.Latin1.GetString(body.Slice(offset + 4, 4));
            if (kind is "iprp" or "ipco" or "moov" or "trak" or "mdia" or "minf" or "stbl")
            {
                var found = FindIspe(content, depth + 1, insideProperties || kind == "ipco");
                if (found.Width is not null)
                {
                    return found;
                }
            }
            offset += (int)size;
        }
        return (null, null);
    }

    private static (ulong Size, int HeaderSize, bool Ok) BoxSize(ReadOnlySpan<byte> body, int offset, long totalBytes)
    {
        if (offset < 0 || offset + 8 > body.Length || totalBytes < offset + 8)
        {
            return (0, 0, false);
        }
        ulong size = BinaryPrimitives.ReadUInt32BigEndian(body[offset..]);
        var headerSize = 8;
        if (size == 1)
        {
            if (offset + 16 > body.Length || totalBytes < offset + 16)
            {
                return (0, 0, false);
            }
            size = BinaryPrimitives.ReadUInt64BigEndian(body[(offset + 8)..]);
            headerSize = 16;
        }
        else if (size == 0)
        {
            size = (ulong)(totalBytes - offset);
        }
        return (size, headerSize, size >= (ulong)headerSize && size <= (ulong)(totalBytes - offset));
    }

    private static (int? Width, int? Height) Dimensions(ulong width, ulong height) =>
        width == 0 || height == 0 || width > MaxImageSide || height > MaxImageSide ? (null, null) : ((int)width, (int)height);

    private static bool LooksLikeSvg(ReadOnlySpan<byte> header)
    {
        var trimmed = TrimAsciiSpace(header);
        if (trimmed.StartsWith("\uFEFF"u8))
        {
            trimmed = TrimAsciiSpace(trimmed[3..]);
        }
        var window = trimmed[..Math.Min(trimmed.Length, 512)];
        return StartsWithIgnoreCase(window, "<svg"u8) || (StartsWithIgnoreCase(window, "<?xml"u8) && ContainsIgnoreCase(window, "<svg"u8));
    }

    // shortcut: ASCII whitespace only where Go's bytes.TrimSpace also trims Unicode spaces; upgrade if an SVG with a leading U+0085/U+00A0 must be recognised.
    private static ReadOnlySpan<byte> TrimAsciiSpace(ReadOnlySpan<byte> value) => value.Trim(" \t\n\r\v\f"u8);

    private static bool StartsWithIgnoreCase(ReadOnlySpan<byte> value, ReadOnlySpan<byte> prefix) =>
        value.Length >= prefix.Length && Ascii.EqualsIgnoreCase(value[..prefix.Length], prefix);

    private static bool ContainsIgnoreCase(ReadOnlySpan<byte> value, ReadOnlySpan<byte> needle)
    {
        for (var i = 0; i + needle.Length <= value.Length; i++)
        {
            if (StartsWithIgnoreCase(value[i..], needle))
            {
                return true;
            }
        }
        return false;
    }

    private static bool LooksLikeText(ReadOnlySpan<byte> header)
    {
        if (!Utf8.IsValid(header))
        {
            return false;
        }
        foreach (var value in header)
        {
            if (value == 0x7f || (value < 0x20 && value != '\t' && value != '\n' && value != '\r'))
            {
                return false;
            }
        }
        return true;
    }

    // An OOXML package's first entry is [Content_Types].xml (the name sits at offset 30), followed by word/,
    // xl/ or ppt/ parts. A package whose parts start past the header window falls back to application/zip.
    private static string ZipMediaType(ReadOnlySpan<byte> header)
    {
        const string ooxml = "application/vnd.openxmlformats-officedocument.";
        if (header.Length >= 49 && Is(header, 30, "[Content_Types].xml"))
        {
            var rest = header[49..];
            if (rest.IndexOf("word/"u8) >= 0)
            {
                return ooxml + "wordprocessingml.document";
            }
            if (rest.IndexOf("xl/"u8) >= 0)
            {
                return ooxml + "spreadsheetml.sheet";
            }
            if (rest.IndexOf("ppt/"u8) >= 0)
            {
                return ooxml + "presentationml.presentation";
            }
        }
        return "application/zip";
    }

    // Ogg is claimed only when the first packet is an audio codec's (the container also carries Theora video);
    // WebM only when the track list at the front names an audio codec and no video codec.
    private static string? AudioMediaType(ReadOnlySpan<byte> header)
    {
        if (Is(header, 0, "ID3"))
        {
            return "audio/mpeg";
        }
        if (header.Length >= 3 && header[0] == 0xff && (header[1] & 0xe0) == 0xe0)
        {
            // Frame sync. Layer 00 under a 12-bit sync is ADTS AAC; version 01, layer 00 otherwise and bitrate index 15 are reserved.
            int version = (header[1] >> 3) & 0x3, layer = (header[1] >> 1) & 0x3;
            return version == 1 ? null
                : layer == 0 && (header[1] & 0xf0) == 0xf0 ? "audio/aac"
                : layer == 0 || header[2] >> 4 == 0xf ? null
                : "audio/mpeg";
        }
        if (header.Length >= 12 && Is(header, 0, "RIFF") && Is(header, 8, "WAVE"))
        {
            return "audio/wav";
        }
        if (Is(header, 0, "fLaC"))
        {
            return "audio/flac";
        }
        if (Is(header, 0, "OggS"))
        {
            var first = header[..Math.Min(header.Length, 128)];
            return first.IndexOf("OpusHead"u8) >= 0 || first.IndexOf("\u0001vorbis"u8) >= 0 || first.IndexOf("\u007fFLAC"u8) >= 0 ? "audio/ogg" : null;
        }
        if (header.Length >= 12 && Is(header, 4, "ftyp"))
        {
            return Is(header, 8, "M4A ") || Is(header, 8, "M4B ") || Is(header, 8, "M4P ") ? "audio/mp4" : null;
        }
        if (IsWebM(header))
        {
            // Whole codec identifiers, and only where the track list sits: two stray bytes of compressed audio spell "V_" often enough.
            var tracks = header[..Math.Min(header.Length, 4096)];
            return (tracks.IndexOf("A_OPUS"u8) >= 0 || tracks.IndexOf("A_VORBIS"u8) >= 0) && !HasVideoTrack(tracks) ? "audio/webm" : null;
        }
        return null;
    }

    // MP4 and WebM video only: other containers (QuickTime, Matroska, 3GP) are not published by sites.
    private static string? VideoMediaType(ReadOnlySpan<byte> header)
    {
        if (header.Length >= 12 && Is(header, 4, "ftyp"))
        {
            return Encoding.Latin1.GetString(header.Slice(8, 4)) is "isom" or "iso2" or "iso4" or "iso5" or "iso6" or "mp41" or "mp42" or "avc1" or "dash" or "M4V " or "M4VH" or "M4VP"
                ? "video/mp4"
                : null;
        }
        return IsWebM(header) && HasVideoTrack(header[..Math.Min(header.Length, 4096)]) ? "video/webm" : null;
    }

    private static bool IsWebM(ReadOnlySpan<byte> header) =>
        header.StartsWith(EbmlSignature) && header[..Math.Min(header.Length, 64)].IndexOf("webm"u8) >= 0;

    private static bool HasVideoTrack(ReadOnlySpan<byte> tracks) =>
        tracks.IndexOf("V_VP8"u8) >= 0 || tracks.IndexOf("V_VP9"u8) >= 0 || tracks.IndexOf("V_AV1"u8) >= 0;

    private static bool Is(ReadOnlySpan<byte> data, int offset, string ascii)
    {
        if (offset < 0 || offset + ascii.Length > data.Length)
        {
            return false;
        }
        for (var i = 0; i < ascii.Length; i++)
        {
            if (data[offset + i] != ascii[i])
            {
                return false;
            }
        }
        return true;
    }

    private static readonly uint[] CrcTable = BuildCrcTable();

    // CRC-32 (IEEE), as PNG chunks use; System.IO.Hashing is not referenced here.
    private static uint Crc32(ReadOnlySpan<byte> data)
    {
        var table = CrcTable;
        var crc = 0xffffffffu;
        foreach (var value in data)
        {
            crc = table[(crc ^ value) & 0xff] ^ (crc >> 8);
        }
        return ~crc;
    }

    private static uint[] BuildCrcTable()
    {
        var table = new uint[256];
        for (var n = 0u; n < 256; n++)
        {
            var c = n;
            for (var k = 0; k < 8; k++)
            {
                c = (c & 1) != 0 ? 0xedb88320 ^ (c >> 1) : c >> 1;
            }
            table[n] = c;
        }
        return table;
    }
}
