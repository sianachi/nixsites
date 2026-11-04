#pragma warning disable CA5394 // Justification: the randomness generates test inputs, not secrets; a seeded generator is the point, so a failure reproduces.

using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;
using Nix.Workers.Files;

namespace Nix.Tests.Workers;

/// <summary>The behaviours of the Go worker's fileinspect/inspect_test.go, case for case.</summary>
public sealed class FileInspectorTests
{
    private const long PreviewBytes = 10 * 1024 * 1024;

    [Fact]
    public void Only_bounded_non_animated_raster_images_are_previewable()
    {
        var png = PngHeader(2000, 1000, animated: false);

        var metadata = FileInspector.InspectHeader(png, 4 * 1024 * 1024);
        Assert.Equal(new FileMetadata("image/png", true, 2000, 1000), metadata);

        var animated = FileInspector.InspectHeader(PngHeader(2000, 1000, animated: true), 4 * 1024 * 1024);
        Assert.False(animated.Previewable);
        Assert.True(animated.Animated);

        Assert.False(FileInspector.InspectHeader(png, PreviewBytes + 1).Previewable);
    }

    [Fact]
    public void Bounded_pdfs_are_previewable()
    {
        var pdf = "%PDF-1.7\n"u8.ToArray();

        Assert.Equal(new FileMetadata("application/pdf", true, null, null), FileInspector.InspectHeader(pdf, PreviewBytes));
        Assert.Equal(new FileMetadata("application/pdf", false, null, null), FileInspector.InspectHeader(pdf, PreviewBytes + 1));
    }

    [Theory]
    [InlineData("<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"><script/></svg>", "image/svg+xml")]
    [InlineData("GIF89a\u0001\u0000\u0001\u0000", "image/gif")]
    [InlineData("<html><script>alert(1)</script></html>", "text/plain")]
    [InlineData("MZ\u0000\u0000\u0001", "application/octet-stream")]
    public void Active_and_vector_formats_stay_download_only(string body, string mediaType)
    {
        var bytes = Encoding.Latin1.GetBytes(body);

        var metadata = FileInspector.InspectHeader(bytes, bytes.Length);

        Assert.Equal(mediaType, metadata.MediaType);
        Assert.False(metadata.Previewable);
    }

    [Fact]
    public void Malformed_image_dimensions_never_enable_preview()
    {
        byte[] png = [137, 80, 78, 71, 13, 10, 26, 10, .. new byte[16]];

        var metadata = FileInspector.InspectHeader(png, png.Length);

        Assert.Equal("image/png", metadata.MediaType);
        Assert.False(metadata.Previewable);
        Assert.True(metadata.Malformed);
    }

    [Fact]
    public void Image_signatures_without_valid_structure_never_enable_preview()
    {
        var fakePng = new byte[45];
        new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }.CopyTo(fakePng, 0);
        BinaryPrimitives.WriteUInt32BigEndian(fakePng.AsSpan(16), 640);
        BinaryPrimitives.WriteUInt32BigEndian(fakePng.AsSpan(20), 480);
        byte[] fakeJpeg = [0xff, 0xd8, 0xff, 0xc0, 0, 7, 8, 1, 0, 1, 0];

        foreach (var body in new[] { fakePng, fakeJpeg })
        {
            var metadata = FileInspector.InspectHeader(body, body.Length);
            Assert.False(metadata.Previewable);
            Assert.True(metadata.Malformed);
        }
    }

    // The Go fuzz test's invariants over its seeds and seeded mutations: never throws, never reports a side outside (0, 100000].
    [Fact]
    public void Inspect_header_never_throws_or_exceeds_image_bounds()
    {
        var random = new Random(1);
        byte[][] seeds =
        [
            [137, 80, 78, 71, 13, 10, 26, 10],
            "RIFF\0\0\0\0WEBPVP8X"u8.ToArray(),
            "<svg>"u8.ToArray(),
            PngHeader(2000, 1000, animated: true),
            [0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0xff, 0xff, 0xff, 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
            [0, 0, 0, 24, .. "ftypavif\0\0\0\0avifmif1"u8, 0, 0, 0, 8, .. "meta"u8, 0, 0, 0, 8, .. "mdat"u8],
        ];
        foreach (var seed in seeds)
        {
            for (var i = 0; i < 200; i++)
            {
                var mutated = seed.ToArray();
                for (var j = 0; j < 1 + random.Next(4); j++)
                {
                    mutated[random.Next(mutated.Length)] = (byte)random.Next(256);
                }
                long[] totals = [mutated.Length, random.Next(-1, 1 << 20), long.MaxValue, -1];
                foreach (var total in totals)
                {
                    var metadata = FileInspector.InspectHeader(mutated, total);
                    Assert.True(metadata.Width is null or (> 0 and <= 100_000), $"width {metadata.Width}");
                    Assert.True(metadata.Height is null or (> 0 and <= 100_000), $"height {metadata.Height}");
                }
            }
        }
    }

    [Fact]
    public void Webm_is_audio_only_when_its_tracks_are_audio_only()
    {
        byte[] ebml = [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84];
        byte[] recording = [.. ebml, .. Encoding.Latin1.GetBytes("webm\u0018S\u0080g\u0086A_OPUS")];
        Assert.Equal(new FileMetadata("audio/webm", false, null, null), FileInspector.InspectHeader(recording, 1024));

        byte[] video = [.. recording, .. Encoding.Latin1.GetBytes("\u0086V_VP9")];
        Assert.Equal(new FileMetadata("video/webm", false, null, null), FileInspector.InspectHeader(video, 1024));

        byte[] matroska = [.. ebml, .. Encoding.Latin1.GetBytes("matroska\u0086A_OPUS")];
        Assert.Equal("application/octet-stream", FileInspector.InspectHeader(matroska, 1024).MediaType);
    }

    [Theory]
    [InlineData("isom", "video/mp4")]
    [InlineData("mp42", "video/mp4")]
    [InlineData("M4A ", "audio/mp4")]
    [InlineData("qt  ", "application/octet-stream")]
    public void Mp4_is_a_video_unless_it_is_audio_or_another_container(string brand, string mediaType)
    {
        byte[] box = [0, 0, 0, 24, .. "ftyp"u8, .. Encoding.Latin1.GetBytes(brand + "\0\0\u0002\0isomiso2")];

        Assert.Equal(mediaType, FileInspector.InspectHeader(box, 1024).MediaType);
    }

    [Theory]
    [InlineData("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "[Content_Types].xml", "_rels/.rels", "word/document.xml")]
    [InlineData("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "[Content_Types].xml", "xl/workbook.xml")]
    [InlineData("application/vnd.openxmlformats-officedocument.presentationml.presentation", "[Content_Types].xml", "ppt/presentation.xml")]
    [InlineData("application/zip", "a.txt", "b/c.txt")]
    [InlineData("application/zip", "[Content_Types].xml")]
    public void Zip_containers_are_named_by_their_ooxml_parts(string mediaType, params string[] names)
    {
        ArgumentNullException.ThrowIfNull(names);
        using var buffer = new MemoryStream();
        using (var zip = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var name in names)
            {
                using var entry = zip.CreateEntry(name).Open();
                entry.WriteByte((byte)'x');
            }
        }
        var data = buffer.ToArray();

        Assert.Equal(mediaType, FileInspector.InspectHeader(data, data.Length).MediaType);
    }

    [Fact]
    public void Header_limit_matches_the_go_worker()
    {
        Assert.Equal(64 * 1024, FileInspector.HeaderLimit);
    }

    private static byte[] PngHeader(uint width, uint height, bool animated)
    {
        var body = new List<byte> { 137, 80, 78, 71, 13, 10, 26, 10 };
        var ihdr = new byte[13];
        BinaryPrimitives.WriteUInt32BigEndian(ihdr, width);
        BinaryPrimitives.WriteUInt32BigEndian(ihdr.AsSpan(4), height);
        ihdr[8] = 8;
        ihdr[9] = 6;
        AppendPngChunk(body, "IHDR", ihdr);
        if (animated)
        {
            var control = new byte[8];
            BinaryPrimitives.WriteUInt32BigEndian(control, 2);
            BinaryPrimitives.WriteUInt32BigEndian(control.AsSpan(4), 1);
            AppendPngChunk(body, "acTL", control);
        }
        AppendPngChunk(body, "IDAT", []);
        return [.. body];
    }

    internal static void AppendPngChunk(List<byte> target, string kind, byte[] data)
    {
        var chunk = new byte[12 + data.Length];
        BinaryPrimitives.WriteUInt32BigEndian(chunk, (uint)data.Length);
        Encoding.ASCII.GetBytes(kind).CopyTo(chunk, 4);
        data.CopyTo(chunk, 8);
        BinaryPrimitives.WriteUInt32BigEndian(chunk.AsSpan(8 + data.Length), Crc32(chunk.AsSpan(4, 4 + data.Length)));
        target.AddRange(chunk);
    }

    internal static uint Crc32(ReadOnlySpan<byte> data)
    {
        var crc = 0xffffffffu;
        foreach (var value in data)
        {
            crc ^= value;
            for (var k = 0; k < 8; k++)
            {
                crc = (crc & 1) != 0 ? 0xedb88320 ^ (crc >> 1) : crc >> 1;
            }
        }
        return ~crc;
    }
}
