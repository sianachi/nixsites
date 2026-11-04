using System.Buffers.Binary;
using System.IO.Compression;
using System.Xml;

namespace Nix.Workers.Files;

/// <summary>Embedded cover art: ID3v2 APIC/PIC, FLAC PICTURE, MP4 covr and EPUB covers. A null cover means none was found.</summary>
public static partial class Thumbnails
{
    // A picture frame carries a small header in front of the image bytes.
    private const long MaxPictureFrame = MaxEmbeddedImageBytes + 4096;
    private const int MaxPictureFrames = 8;
    private const int MaxId3Frames = 4096;
    private const int MaxFlacBlocks = 1024;
    private const int MaxBoxDepth = 8;
    private const int MaxBoxesPerLevel = 10000;
    private const int MaxXmlBytes = 2 << 20;
    // The ZIP directory is checked against the end-of-directory record before ZipArchive parses it.
    private const uint MaxCentralDirectoryBytes = 1 << 20;
    private const int MaxCoverCandidates = 3;
    private const int EocdMinLength = 22;

    private static readonly XmlReaderSettings XmlSettings = new()
    {
        DtdProcessing = DtdProcessing.Prohibit,
        XmlResolver = null,
        MaxCharactersInDocument = MaxXmlBytes,
        MaxCharactersFromEntities = 1024,
        IgnoreComments = true,
        IgnoreProcessingInstructions = true,
    };

    private static readonly string[][] Mp4CoverPaths =
    [
        ["moov", "udta", "meta", "ilst", "covr", "data"],
        ["moov", "meta", "ilst", "covr", "data"],
    ];

    private static bool Syncsafe(ReadOnlySpan<byte> value, out long result)
    {
        result = 0;
        foreach (var c in value[..4])
        {
            if ((c & 0x80) != 0)
            {
                return false;
            }
            result = (result << 7) | c;
        }
        return true;
    }

    // The best APIC (v2.3, v2.4) or PIC (v2.2) frame, preferring the front cover. Whole-tag unsynchronisation is
    // skipped rather than rewritten, and so are compressed, encrypted or unsynchronised frames.
    private static ArraySegment<byte>? Id3Cover(Stream source, long size, CancellationToken cancellationToken)
    {
        var header = ReadRange(source, 0, 10, size, 10);
        byte version = header[3], flags = header[5];
        if (!header.AsSpan().StartsWith("ID3"u8) || version < 2 || version > 4)
        {
            throw new InvalidDataException("unsupported ID3 version");
        }
        if ((flags & 0x80) != 0)
        {
            throw new InvalidDataException("unsynchronised ID3 tag skipped");
        }
        if (!Syncsafe(header.AsSpan(6), out var tagSize))
        {
            throw new InvalidDataException("bad ID3 size");
        }
        var end = Math.Min(10 + tagSize, size);
        long position = 10;
        if (version >= 3 && (flags & 0x40) != 0)
        {
            var extended = ReadRange(source, position, 4, size, 4);
            long length;
            if (version == 3)
            {
                length = BinaryPrimitives.ReadUInt32BigEndian(extended) + 4L;
            }
            else if (!Syncsafe(extended, out length))
            {
                throw new InvalidDataException("bad ID3 extended header");
            }
            position += length;
        }
        int idLength = version == 2 ? 3 : 4, headerLength = version == 2 ? 6 : 10;
        ArraySegment<byte>? best = null;
        var pictures = 0;
        for (var n = 0; n < MaxId3Frames && position + headerLength <= end; n++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var frame = ReadRange(source, position, headerLength, size, headerLength);
            if (frame[0] == 0 || !ValidFrameId(frame.AsSpan(0, idLength)))
            {
                break; // padding, or not a frame
            }
            long frameSize;
            if (version == 2)
            {
                frameSize = (frame[3] << 16) | (frame[4] << 8) | frame[5];
            }
            else if (version == 3)
            {
                frameSize = BinaryPrimitives.ReadUInt32BigEndian(frame.AsSpan(4));
            }
            else if (!Syncsafe(frame.AsSpan(4), out frameSize))
            {
                throw new InvalidDataException("bad ID3 frame size");
            }
            var body = position + headerLength;
            if (frameSize > end - body)
            {
                break;
            }
            var isPicture = version == 2 ? frame.AsSpan(0, 3).SequenceEqual("PIC"u8) : frame.AsSpan(0, 4).SequenceEqual("APIC"u8);
            if (isPicture && frameSize is > 0 and <= MaxPictureFrame && pictures < MaxPictureFrames)
            {
                // v2.2 frames carry no flags (the Go port sliced past its 6-byte header here and panicked).
                var (skip, prefix) = version == 2 ? (false, 0L) : FrameFlags(version, frame[9]);
                if (!skip && prefix < frameSize)
                {
                    pictures++;
                    var data = ReadRange(source, body + prefix, frameSize - prefix, size, MaxPictureFrame);
                    if (ParseId3Picture(version, data) is var (picture, pictureType))
                    {
                        if (pictureType == 3)
                        {
                            return picture;
                        }
                        best ??= picture;
                    }
                }
            }
            position = body + frameSize;
        }
        return best;
    }

    private static bool ValidFrameId(ReadOnlySpan<byte> id)
    {
        foreach (var c in id)
        {
            if (c is not (>= (byte)'A' and <= (byte)'Z') and not (>= (byte)'0' and <= (byte)'9'))
            {
                return false;
            }
        }
        return true;
    }

    // Whether a frame must be skipped and how many bytes of optional prefix (group id, data length indicator) precede its payload.
    private static (bool Skip, long Prefix) FrameFlags(byte version, byte format)
    {
        if (version == 3)
        {
            return (format & 0xc0) != 0 ? (true, 0) : (false, (format & 0x20) != 0 ? 1 : 0);
        }
        if ((format & 0x0e) != 0)
        {
            return (true, 0); // compressed, encrypted or unsynchronised
        }
        return (false, ((format & 0x40) != 0 ? 1 : 0) + ((format & 0x01) != 0 ? 4 : 0));
    }

    // Splits an APIC or PIC body into image bytes and picture type.
    private static (ArraySegment<byte> Image, byte PictureType)? ParseId3Picture(byte version, byte[] b)
    {
        if (b.Length < 2)
        {
            return null;
        }
        var encoding = b[0];
        var p = 1;
        if (version == 2)
        {
            p += 3; // three-character image format
        }
        else
        {
            var i = b.AsSpan(p).IndexOf((byte)0);
            if (i < 0)
            {
                return null;
            }
            p += i + 1;
        }
        if (p >= b.Length)
        {
            return null;
        }
        var pictureType = b[p];
        p++;
        if (encoding is 0 or 3)
        {
            var i = b.AsSpan(p).IndexOf((byte)0);
            if (i < 0)
            {
                return null;
            }
            p += i + 1;
        }
        else if (encoding is 1 or 2)
        {
            var found = false;
            for (var i = p; i + 1 < b.Length; i += 2)
            {
                if (b[i] == 0 && b[i + 1] == 0)
                {
                    p = i + 2;
                    found = true;
                    break;
                }
            }
            if (!found)
            {
                return null;
            }
        }
        else
        {
            return null;
        }
        if (p >= b.Length || b.Length - p > MaxEmbeddedImageBytes)
        {
            return null;
        }
        return (new ArraySegment<byte>(b, p, b.Length - p), pictureType);
    }

    // The first PICTURE metadata block, preferring picture type 3 (front cover).
    private static ArraySegment<byte>? FlacCover(Stream source, long size, CancellationToken cancellationToken)
    {
        long position = 4;
        ArraySegment<byte>? best = null;
        for (var n = 0; n < MaxFlacBlocks && position + 4 <= size; n++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var header = ReadRange(source, position, 4, size, 4);
            bool last = (header[0] & 0x80) != 0;
            var kind = header[0] & 0x7f;
            long length = (header[1] << 16) | (header[2] << 8) | header[3];
            var body = position + 4;
            if (length > size - body)
            {
                throw new InvalidDataException("FLAC block past end");
            }
            if (kind == 6 && length <= MaxPictureFrame && ParseFlacPicture(ReadRange(source, body, length, size, MaxPictureFrame)) is var (picture, pictureType))
            {
                if (pictureType == 3)
                {
                    return picture;
                }
                best ??= picture;
            }
            if (last)
            {
                break;
            }
            position = body + length;
        }
        return best;
    }

    private static (ArraySegment<byte> Image, uint PictureType)? ParseFlacPicture(byte[] b)
    {
        var p = 0;
        bool Next(out uint value)
        {
            value = 0;
            if (b.Length - p < 4)
            {
                return false;
            }
            value = BinaryPrimitives.ReadUInt32BigEndian(b.AsSpan(p));
            p += 4;
            return true;
        }
        bool SkipString()
        {
            if (!Next(out var length) || length > (uint)(b.Length - p))
            {
                return false;
            }
            p += (int)length;
            return true;
        }
        // Picture type, media type, description, then width, height, depth and colours.
        if (!Next(out var pictureType) || !SkipString() || !SkipString() || b.Length - p < 16)
        {
            return null;
        }
        p += 16;
        if (!Next(out var n) || n == 0 || n > MaxEmbeddedImageBytes || n > (uint)(b.Length - p))
        {
            return null;
        }
        return (new ArraySegment<byte>(b, p, (int)n), pictureType);
    }

    // moov/udta/meta/ilst/covr/data (and the same without udta, which some writers use), depth- and count-bounded.
    private static ArraySegment<byte>? Mp4Cover(Stream source, long size, CancellationToken cancellationToken)
    {
        foreach (var path in Mp4CoverPaths)
        {
            if (FindBox(source, 0, size, size, path, 0, cancellationToken) is { } image)
            {
                return image;
            }
        }
        return null;
    }

    private static byte[]? FindBox(Stream source, long start, long end, long size, ReadOnlySpan<string> path, int depth, CancellationToken cancellationToken)
    {
        if (depth > MaxBoxDepth)
        {
            throw new InvalidDataException("boxes nested too deeply");
        }
        var position = start;
        for (var n = 0; n < MaxBoxesPerLevel && position + 8 <= end; n++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var header = ReadRange(source, position, 8, size, 8);
            ulong boxSize = BinaryPrimitives.ReadUInt32BigEndian(header);
            var kind = System.Text.Encoding.Latin1.GetString(header, 4, 4);
            long headerLength = 8;
            if (boxSize == 1)
            {
                boxSize = BinaryPrimitives.ReadUInt64BigEndian(ReadRange(source, position + 8, 8, size, 8));
                headerLength = 16;
            }
            else if (boxSize == 0)
            {
                boxSize = (ulong)(end - position);
            }
            if (boxSize < (ulong)headerLength || boxSize > (ulong)(end - position))
            {
                throw new InvalidDataException("box size out of range");
            }
            var boxEnd = position + (long)boxSize;
            if (kind == path[0])
            {
                var body = position + headerLength;
                if (path.Length == 1)
                {
                    // A data box: 4 bytes of type and flags, 4 reserved, then the payload.
                    var payload = boxEnd - (body + 8);
                    if (payload is > 0 and <= MaxEmbeddedImageBytes)
                    {
                        var image = ReadRange(source, body + 8, payload, size, MaxEmbeddedImageBytes);
                        if (image.AsSpan().StartsWith((ReadOnlySpan<byte>)[0xff, 0xd8]) || image.AsSpan().StartsWith((ReadOnlySpan<byte>)[0x89, 0x50, 0x4e, 0x47]))
                        {
                            return image;
                        }
                    }
                }
                else
                {
                    if (kind == "meta")
                    {
                        body += 4; // meta is a full box
                    }
                    if (FindBox(source, body, boxEnd, size, path[1..], depth + 1, cancellationToken) is { } image)
                    {
                        return image;
                    }
                }
            }
            position = boxEnd;
        }
        return null;
    }

    // Validates the end-of-central-directory record before ZipArchive goes near the archive: entry count,
    // directory size, and that the directory ends exactly where the record begins. ZIP64 and archives with data in front are refused.
    private static void CheckZipDirectory(Stream source, long size)
    {
        var tailLength = Math.Min(size, EocdMinLength + 0xffff);
        var tail = ReadRange(source, size - tailLength, tailLength, size, EocdMinLength + 0xffff);
        for (var i = tail.Length - EocdMinLength; i >= 0; i--)
        {
            if (BinaryPrimitives.ReadUInt32LittleEndian(tail.AsSpan(i)) != 0x06054b50)
            {
                continue;
            }
            int commentLength = BinaryPrimitives.ReadUInt16LittleEndian(tail.AsSpan(i + 20));
            if (i + EocdMinLength + commentLength != tail.Length)
            {
                continue;
            }
            var entries = BinaryPrimitives.ReadUInt16LittleEndian(tail.AsSpan(i + 10));
            var directorySize = BinaryPrimitives.ReadUInt32LittleEndian(tail.AsSpan(i + 12));
            var directoryOffset = BinaryPrimitives.ReadUInt32LittleEndian(tail.AsSpan(i + 16));
            if (entries == 0xffff || directorySize == 0xffffffff || directoryOffset == 0xffffffff || entries > MaxArchiveEntries || directorySize > MaxCentralDirectoryBytes)
            {
                throw TooLarge("archive directory");
            }
            if ((long)directoryOffset + directorySize != size - tail.Length + i)
            {
                throw new InvalidDataException("unusual ZIP layout");
            }
            return;
        }
        throw new InvalidDataException("no ZIP directory");
    }

    private sealed record OpfItem(string Id, string Href, string MediaType, string Properties);

    // The cover by the three discovery rules in order: an EPUB 3 manifest item with the cover-image property,
    // an EPUB 2 meta name="cover" resolved through the manifest, then a manifest image whose id or href mentions "cover".
    private static ThumbnailResult? EpubCover(Stream source, long size, CancellationToken cancellationToken)
    {
        CheckZipDirectory(source, size);
        using var archive = new ZipArchive(source, ZipArchiveMode.Read, leaveOpen: true);
        if (archive.Entries.Count > MaxArchiveEntries)
        {
            throw TooLarge("archive");
        }
        var files = new Dictionary<string, ZipArchiveEntry>(archive.Entries.Count, StringComparer.Ordinal);
        foreach (var entry in archive.Entries)
        {
            files.TryAdd(entry.FullName, entry);
        }
        cancellationToken.ThrowIfCancellationRequested();

        var opfPath = Clean(RootfilePath(ReadEntry(files.GetValueOrDefault("META-INF/container.xml"), MaxXmlBytes)));
        var (meta, items) = ParsePackage(ReadEntry(files.GetValueOrDefault(opfPath), MaxXmlBytes));
        var directory = Dir(opfPath);
        foreach (var item in CoverCandidates(meta, items))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (ResolveHref(directory, item.Href) is not { } name)
            {
                continue;
            }
            try
            {
                return Render(ReadEntry(files.GetValueOrDefault(name), MaxArchiveEntryBytes), ThumbnailKind.EpubCover, cancellationToken);
            }
            catch (Exception error) when (error is InvalidDataException or IOException)
            {
                // Try the next candidate; limits and cancellation propagate.
            }
        }
        return null;
    }

    // One archive entry, read up to its declared size (itself under limit); an entry longer than it declares is refused.
    private static ArraySegment<byte> ReadEntry(ZipArchiveEntry? entry, long limit)
    {
        if (entry is null)
        {
            throw new InvalidDataException("entry missing");
        }
        if (entry.Length > limit)
        {
            throw TooLarge("archive entry");
        }
        using var stream = entry.Open();
        var buffer = new byte[entry.Length + 1]; // byte[]: SKCodec and XmlReader read whole buffers; bounded by limit above
        var read = stream.ReadAtLeast(buffer, buffer.Length, throwOnEndOfStream: false);
        if (read == buffer.Length)
        {
            throw new InvalidDataException("entry longer than declared");
        }
        return new ArraySegment<byte>(buffer, 0, read);
    }

    private static XmlReader OpenXml(ArraySegment<byte> data) =>
        XmlReader.Create(new MemoryStream(data.Array!, data.Offset, data.Count, writable: false), XmlSettings);

    private static string RootfilePath(ArraySegment<byte> container)
    {
        using var reader = OpenXml(container);
        while (reader.Read())
        {
            if (reader.NodeType == XmlNodeType.Element && reader.LocalName == "rootfile")
            {
                while (reader.MoveToNextAttribute())
                {
                    if (reader.LocalName == "full-path" && reader.Value.Length > 0)
                    {
                        return reader.Value;
                    }
                }
            }
        }
        throw new InvalidDataException("container.xml: no rootfile");
    }

    // package > metadata > meta and package > manifest > item, matched by local name as Go's decoder did.
    private static (List<(string Name, string Content)> Meta, List<OpfItem> Items) ParsePackage(ArraySegment<byte> data)
    {
        var meta = new List<(string, string)>();
        var items = new List<OpfItem>();
        using var reader = OpenXml(data);
        var section = string.Empty;
        while (reader.Read())
        {
            if (reader.NodeType != XmlNodeType.Element)
            {
                continue;
            }
            if (reader.Depth == 1)
            {
                section = reader.LocalName;
            }
            else if (reader.Depth == 2 && section == "metadata" && reader.LocalName == "meta")
            {
                meta.Add((Attribute(reader, "name"), Attribute(reader, "content")));
            }
            else if (reader.Depth == 2 && section == "manifest" && reader.LocalName == "item")
            {
                items.Add(new OpfItem(Attribute(reader, "id"), Attribute(reader, "href"), Attribute(reader, "media-type"), Attribute(reader, "properties")));
            }
        }
        return (meta, items);
    }

    private static string Attribute(XmlReader reader, string localName)
    {
        var value = string.Empty;
        while (reader.MoveToNextAttribute())
        {
            if (reader.LocalName == localName)
            {
                value = reader.Value;
            }
        }
        reader.MoveToElement();
        return value;
    }

    private static List<OpfItem> CoverCandidates(List<(string Name, string Content)> meta, List<OpfItem> items)
    {
        var byId = new Dictionary<string, OpfItem>(StringComparer.Ordinal);
        foreach (var item in items)
        {
            byId.TryAdd(item.Id, item);
        }
        var result = new List<OpfItem>();
        void Add(OpfItem item)
        {
            if (result.Count < MaxCoverCandidates && item.Href.Length > 0 && (item.MediaType.Length == 0 || item.MediaType.StartsWith("image/", StringComparison.OrdinalIgnoreCase)))
            {
                result.Add(item);
            }
        }
        foreach (var item in items)
        {
            foreach (var property in item.Properties.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries))
            {
                if (property == "cover-image")
                {
                    Add(item);
                }
            }
        }
        foreach (var (name, content) in meta)
        {
            if (name == "cover" && byId.TryGetValue(content, out var item))
            {
                Add(item);
            }
        }
        foreach (var item in items)
        {
            if (item.MediaType.StartsWith("image/", StringComparison.OrdinalIgnoreCase)
                && (item.Id.Contains("cover", StringComparison.OrdinalIgnoreCase) || item.Href.Contains("cover", StringComparison.OrdinalIgnoreCase)))
            {
                Add(item);
            }
        }
        return result;
    }

    // Resolves a manifest href against the OPF directory; rejects anything absolute, with a scheme, or climbing out of the archive.
    private static string? ResolveHref(string directory, string href)
    {
        var cut = href.AsSpan().IndexOfAny('#', '?');
        if (cut >= 0)
        {
            href = href[..cut];
        }
        for (var i = href.IndexOf('%', StringComparison.Ordinal); i >= 0; i = href.IndexOf('%', i + 1))
        {
            if (i + 2 >= href.Length || !char.IsAsciiHexDigit(href[i + 1]) || !char.IsAsciiHexDigit(href[i + 2]))
            {
                return null; // Go's url.PathUnescape refuses a bad escape
            }
        }
        href = Uri.UnescapeDataString(href);
        if (href.Length == 0 || href.Contains('\0', StringComparison.Ordinal) || href.Contains('\\', StringComparison.Ordinal) || href.StartsWith('/') || href.Contains(':', StringComparison.Ordinal))
        {
            return null;
        }
        var name = Clean(directory + "/" + href);
        return name == ".." || name.StartsWith("../", StringComparison.Ordinal) || name.StartsWith('/') ? null : name;
    }

    // Go's path.Clean: lexical, slash-separated.
    private static string Clean(string path)
    {
        var rooted = path.StartsWith('/');
        var parts = new List<string>();
        foreach (var part in path.Split('/'))
        {
            if (part.Length == 0 || part == ".")
            {
                continue;
            }
            if (part == "..")
            {
                if (parts.Count > 0 && parts[^1] != "..")
                {
                    parts.RemoveAt(parts.Count - 1);
                }
                else if (!rooted)
                {
                    parts.Add(part);
                }
                continue;
            }
            parts.Add(part);
        }
        var joined = string.Join('/', parts);
        return rooted ? "/" + joined : joined.Length == 0 ? "." : joined;
    }

    // Go's path.Dir.
    private static string Dir(string path)
    {
        var slash = path.LastIndexOf('/');
        return Clean(slash < 0 ? string.Empty : path[..(slash + 1)]);
    }
}
