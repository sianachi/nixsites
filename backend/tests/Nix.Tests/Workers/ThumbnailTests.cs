#pragma warning disable CA5394 // Justification: the randomness generates test inputs, not secrets; a seeded generator is the point, so a failure reproduces.

using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;
using Nix.Workers.Files;
using SkiaSharp;

namespace Nix.Tests.Workers;

/// <summary>The behaviours of the Go worker's thumbnail_test.go and the pure parts of fileinspect/thumbnails.go.</summary>
public sealed class ThumbnailTests
{
    private static readonly Dictionary<string, (byte[] Data, string File, string MediaType, ThumbnailKind Kind, int Width, int Height)> Successes = BuildSuccesses();

    public static TheoryData<string> SuccessCases() => [.. Successes.Keys];

    [Theory]
    [MemberData(nameof(SuccessCases))]
    public void Extract_succeeds(string name)
    {
        var (data, file, mediaType, kind, width, height) = Successes[name];

        var result = Extract(data, file, mediaType);

        Assert.NotNull(result);
        Assert.Equal((kind, width, height, "image/jpeg"), (result.Kind, result.Width, result.Height, result.MediaType));
        using var codec = SKCodec.Create(new MemoryStream(result.Bytes));
        Assert.Equal(SKEncodedImageFormat.Jpeg, codec.EncodedFormat);
        Assert.Equal((width, height), (codec.Info.Width, codec.Info.Height));
        Assert.Equal(result.Bytes, Extract(data, file, mediaType)!.Bytes); // deterministic
    }

    [Fact]
    public void Png_over_the_pixel_limit_is_refused_from_its_header()
    {
        // 10000x10000 with no pixel data: a decode would fail differently, so TooLarge proves the header limit.
        var ihdr = new byte[13];
        BinaryPrimitives.WriteUInt32BigEndian(ihdr, 10000);
        BinaryPrimitives.WriteUInt32BigEndian(ihdr.AsSpan(4), 10000);
        ihdr[8] = 8;
        ihdr[9] = 6;
        var huge = new List<byte> { 0x89, (byte)'P', (byte)'N', (byte)'G', 0x0d, 0x0a, 0x1a, 0x0a };
        FileInspectorTests.AppendPngChunk(huge, "IHDR", ihdr);

        AssertTooLarge([.. huge], "a.png");
    }

    [Fact]
    public void Epub_limits_are_refused_as_too_large()
    {
        var opf = OpfDoc("", """<item id="c" href="images/cover.png" media-type="image/png"/>""");

        AssertTooLarge(EpubWith(opf, null, Thumbnails.MaxArchiveEntries + 1), "b.epub");
        AssertTooLarge(EpubWith(opf, new() { ["OEBPS/images/cover.png"] = new byte[Thumbnails.MaxArchiveEntryBytes + 1] }, 0), "b.epub");
    }

    [Theory]
    [InlineData("epub href escaping the archive")]
    [InlineData("epub without a cover")]
    [InlineData("zip that is not declared an epub")]
    [InlineData("mp3 without art")]
    [InlineData("mp3 with unsynchronisation flag")]
    [InlineData("pdf")]
    [InlineData("avif")]
    [InlineData("ogg")]
    [InlineData("empty")]
    public void Extract_has_nothing_to_show(string name)
    {
        var noCover = EpubWith(OpfDoc("", """<item id="t" href="ch1.xhtml" media-type="application/xhtml+xml"/>"""), null, 0);
        var (data, file) = name switch
        {
            "epub href escaping the archive" => (EpubWith(OpfDoc("", """<item id="c" href="../../cover.png" media-type="image/png" properties="cover-image"/>"""), new() { ["cover.png"] = Png(5, 5) }, 0), "b.epub"),
            "epub without a cover" => (noCover, "b.epub"),
            "zip that is not declared an epub" => (noCover, "b.zip"),
            "mp3 without art" => (Id3V23(), "a.mp3"),
            "mp3 with unsynchronisation flag" => ([.. "ID3"u8, 3, 0, 0x80, 0, 0, 0, 0, 0], "a.mp3"),
            "pdf" => ("%PDF-1.7\n"u8.ToArray(), "a.pdf"),
            "avif" => ([0, 0, 0, 24, .. "ftypavif\0\0\0\0avifmif1"u8], "a.avif"),
            "ogg" => ([.. "OggS"u8, .. new byte[64]], "a.ogg"),
            _ => (Array.Empty<byte>(), "a.png"),
        };

        Assert.Null(Extract(data, file, ""));
    }

    [Fact]
    public void Extract_honours_cancellation()
    {
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        var data = Png(10, 10);

        Assert.Throws<OperationCanceledException>(() => Thumbnails.Extract(new MemoryStream(data), data.Length, "a.png", "", cancelled.Token));
    }

    [Fact]
    public void Exif_orientation_rotates_the_thumbnail()
    {
        // An Exif APP1 segment declaring orientation 6 (rotate 90 clockwise), inserted after SOI.
        var source = Jpeg(200, 100);
        byte[] tiff = [(byte)'M', (byte)'M', 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0];
        byte[] segment = [.. "Exif\0\0"u8, .. tiff];
        byte[] data = [.. source[..2], 0xff, 0xe1, (byte)((segment.Length + 2) >> 8), (byte)(segment.Length + 2), .. segment, .. source[2..]];

        var result = Extract(data, "a.jpg", "");

        Assert.NotNull(result);
        Assert.Equal((100, 200), (result.Width, result.Height));
    }

    // Truncated and corrupted copies of every fixture, and random bytes behind each magic prefix, come back as
    // null or a TooLarge refusal: never a parser fault, never another exception, never a side over MaxSide.
    [Fact]
    public void Malformed_input_never_throws_anything_but_the_typed_refusal()
    {
        var cover = Png(30, 20);
        var fixtures = new Dictionary<string, byte[]>
        {
            ["a.png"] = Png(50, 50),
            ["a.jpg"] = Jpeg(50, 50),
            ["a.gif"] = Gif(50, 50),
            ["a.mp3"] = Id3V23(Apic(cover, 3)),
            ["a.flac"] = FlacWith(cover, 3),
            ["a.m4a"] = M4AWith(cover),
            ["b.epub"] = EpubWith(OpfDoc("", """<item id="c" href="images/cover.png" media-type="image/png" properties="cover-image"/>"""), null, 0),
        };
        var random = new Random(1);
        foreach (var (name, data) in fixtures)
        {
            for (var cut = 0; cut < data.Length; cut += Math.Max(1, data.Length / 16))
            {
                AssertNoFault(name, data[..cut]);
            }
            for (var i = 0; i < 25; i++)
            {
                var mutated = data.ToArray();
                for (var j = 0; j < 1 + random.Next(4); j++)
                {
                    mutated[random.Next(mutated.Length)] = (byte)random.Next(256);
                }
                AssertNoFault(name, mutated);
            }
        }
        var prefixes = new Dictionary<string, byte[]>
        {
            ["a.png"] = [0x89, (byte)'P', (byte)'N', (byte)'G', 0x0d, 0x0a, 0x1a, 0x0a],
            ["a.jpg"] = [0xff, 0xd8, 0xff, 0xe1],
            ["a.gif"] = "GIF89a"u8.ToArray(),
            ["a.webp"] = "RIFF\u0010\0\0\0WEBPVP8 "u8.ToArray(),
            ["a.bmp"] = "BM"u8.ToArray(),
            ["a.mp3"] = "ID3\u0003\0\0\0\0\u0001\0APIC"u8.ToArray(),
            ["a.flac"] = [.. "fLaC"u8, 0, 0, 0, 0x22],
            ["a.m4a"] = "\0\0\0\u0018ftypM4A "u8.ToArray(),
            ["b.epub"] = "PK\u0003\u0004"u8.ToArray(),
        };
        foreach (var (name, prefix) in prefixes)
        {
            for (var i = 0; i < 40; i++)
            {
                var tail = new byte[random.Next(300)];
                random.NextBytes(tail);
                AssertNoFault(name, [.. prefix, .. tail]);
            }
        }
    }

    [Theory]
    [InlineData("a.png", "image/png", true)]
    [InlineData("a.jpg", "image/jpeg", true)]
    [InlineData("a.webp", "image/webp", true)]
    [InlineData("a.gif", "image/gif", true)]
    [InlineData("a.mp3", "audio/mpeg", true)]
    [InlineData("a.flac", "audio/flac", true)]
    [InlineData("a.m4a", "audio/mp4", true)]
    [InlineData("Book.EPUB", "application/zip", true)]
    [InlineData("a.zip", "application/zip", false)]
    [InlineData("a.bmp", "application/octet-stream", true)]
    [InlineData("a.mp3", "application/octet-stream", true)]
    [InlineData("a.bin", "application/octet-stream", false)]
    [InlineData("a.pdf", "application/pdf", false)]
    [InlineData("a.txt", "text/plain", false)]
    [InlineData("a.avif", "image/avif", false)]
    public void Only_candidates_cost_decode_work(string fileName, string mediaType, bool candidate)
    {
        Assert.Equal(candidate, Thumbnails.IsCandidate(fileName, mediaType));
    }

    [Fact]
    public void A_staged_file_yields_its_thumbnail()
    {
        var path = Path.GetTempFileName();
        try
        {
            var data = Png(1000, 500);
            File.WriteAllBytes(path, data);

            var result = Thumbnails.FromStagedFile(path, data.Length, "a.png", "image/png", TestContext.Current.CancellationToken);

            Assert.NotNull(result);
            Assert.Equal((480, 240), (result.Width, result.Height));
            Assert.InRange(result.Bytes.Length, 1, Thumbnails.MaxThumbnailBytes);
        }
        finally
        {
            File.Delete(path);
        }
    }

    private static ThumbnailResult? Extract(byte[] data, string file, string mediaType) =>
        Thumbnails.Extract(new MemoryStream(data), data.Length, file, mediaType, TestContext.Current.CancellationToken);

    private static void AssertTooLarge(byte[] data, string file)
    {
        var refusal = Assert.Throws<ThumbnailRefusedException>(() => Extract(data, file, ""));
        Assert.Equal(ThumbnailRefusal.TooLarge, refusal.Refusal);
    }

    private static void AssertNoFault(string name, byte[] data)
    {
        try
        {
            if (Extract(data, name, "") is { } result)
            {
                Assert.InRange(result.Width, 1, Thumbnails.MaxSide);
                Assert.InRange(result.Height, 1, Thumbnails.MaxSide);
            }
        }
        catch (ThumbnailRefusedException refusal) when (refusal.Refusal == ThumbnailRefusal.TooLarge)
        {
        }
    }

    private static Dictionary<string, (byte[], string, string, ThumbnailKind, int, int)> BuildSuccesses()
    {
        var cover = Png(30, 20);
        return new()
        {
            ["png small not enlarged"] = (Png(100, 50), "a.png", "", ThumbnailKind.Image, 100, 50),
            ["png scaled"] = (Png(1000, 500), "a.png", "", ThumbnailKind.Image, 480, 240),
            ["jpeg tall scaled"] = (Jpeg(300, 960), "a.jpg", "image/jpeg", ThumbnailKind.Image, 150, 480),
            ["gif"] = (Gif(64, 64), "a.gif", "", ThumbnailKind.Image, 64, 64),
            ["declared type is ignored"] = (Png(10, 10), "a.txt", "text/plain", ThumbnailKind.Image, 10, 10),
            ["mp3 apic"] = (Id3V23(Apic(cover, 3)), "a.mp3", "", ThumbnailKind.AudioCover, 30, 20),
            ["mp3 prefers front cover"] = (Id3V23(Apic(Png(8, 8), 0), Apic(cover, 3)), "a.mp3", "", ThumbnailKind.AudioCover, 30, 20),
            ["flac picture"] = (FlacWith(cover, 3), "a.flac", "", ThumbnailKind.AudioCover, 30, 20),
            ["m4a covr"] = (M4AWith(cover), "a.m4a", "", ThumbnailKind.AudioCover, 30, 20),
            ["epub3 cover-image property"] = (EpubWith(OpfDoc("", """<item id="x" href="images/cover.png" media-type="image/png" properties="cover-image"/>"""), null, 0), "b.epub", "", ThumbnailKind.EpubCover, 40, 60),
            ["epub2 meta cover"] = (EpubWith(OpfDoc("""<meta name="cover" content="pic"/>""", """<item id="pic" href="images/cover.png" media-type="image/png"/>"""), null, 0), "b.epub", "", ThumbnailKind.EpubCover, 40, 60),
            ["epub id contains cover"] = (EpubWith(OpfDoc("", """<item id="my-cover" href="images/cover.png" media-type="image/png"/>"""), null, 0), "b.epub", "", ThumbnailKind.EpubCover, 40, 60),
            ["epub by media type only"] = (EpubWith(OpfDoc("", """<item id="c" href="images/cover.png" media-type="image/png"/>"""), null, 0), "book", "application/epub+zip", ThumbnailKind.EpubCover, 40, 60),
        };
    }

    private static SKBitmap Gradient(int width, int height)
    {
        var bitmap = new SKBitmap(width, height);
        for (var y = 0; y < height; y++)
        {
            for (var x = 0; x < width; x++)
            {
                bitmap.SetPixel(x, y, new SKColor((byte)(x * 255 / width), (byte)(y * 255 / height), 90));
            }
        }
        return bitmap;
    }

    private static byte[] Png(int width, int height)
    {
        using var bitmap = Gradient(width, height);
        using var data = bitmap.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }

    private static byte[] Jpeg(int width, int height)
    {
        using var bitmap = Gradient(width, height);
        using var data = bitmap.Encode(SKEncodedImageFormat.Jpeg, 75);
        return data.ToArray();
    }

    // Skia cannot encode GIF, so this writes one: a 256-entry palette and LZW literal codes, with a clear
    // code every 200 codes so the code width stays at 9 bits.
    private static byte[] Gif(int width, int height)
    {
        var output = new List<byte>();
        output.AddRange("GIF89a"u8.ToArray());
        AddLe16(output, width);
        AddLe16(output, height);
        output.AddRange([0xf7, 0, 0]);
        for (var i = 0; i < 256; i++)
        {
            output.AddRange([(byte)i, (byte)(255 - i), 90]);
        }
        output.Add(0x2c);
        AddLe16(output, 0);
        AddLe16(output, 0);
        AddLe16(output, width);
        AddLe16(output, height);
        output.Add(0);
        output.Add(8);
        var packed = new List<byte>();
        int bitBuffer = 0, bitCount = 0;
        void Emit(int code)
        {
            bitBuffer |= code << bitCount;
            bitCount += 9;
            while (bitCount >= 8)
            {
                packed.Add((byte)bitBuffer);
                bitBuffer >>= 8;
                bitCount -= 8;
            }
        }
        Emit(256);
        var run = 0;
        for (var y = 0; y < height; y++)
        {
            for (var x = 0; x < width; x++)
            {
                Emit(x * 255 / width);
                if (++run == 200)
                {
                    Emit(256);
                    run = 0;
                }
            }
        }
        Emit(257);
        if (bitCount > 0)
        {
            packed.Add((byte)bitBuffer);
        }
        foreach (var chunk in packed.Chunk(255))
        {
            output.Add((byte)chunk.Length);
            output.AddRange(chunk);
        }
        output.AddRange([0, 0x3b]);
        return [.. output];
    }

    private static void AddLe16(List<byte> output, int value)
    {
        output.Add((byte)value);
        output.Add((byte)(value >> 8));
    }

    private static byte[] Be32(int value)
    {
        var bytes = new byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(bytes, (uint)value);
        return bytes;
    }

    private static byte[] Syncsafe32(int value) => [(byte)((value >> 21) & 0x7f), (byte)((value >> 14) & 0x7f), (byte)((value >> 7) & 0x7f), (byte)(value & 0x7f)];

    private static byte[] Id3V23(params byte[][] frames)
    {
        byte[] body = [.. frames.SelectMany(frame => frame)];
        return [.. "ID3\u0003\0\0"u8, .. Syncsafe32(body.Length), .. body];
    }

    private static byte[] Apic(byte[] image, byte pictureType)
    {
        byte[] body = [0, .. "image/png\0"u8, pictureType, .. "cover\0"u8, .. image];
        return [.. "APIC"u8, .. Be32(body.Length), 0, 0, .. body];
    }

    private static byte[] FlacWith(byte[] image, int pictureType)
    {
        byte[] picture = [.. Be32(pictureType), .. Be32(9), .. "image/png"u8, .. Be32(0), .. new byte[16], .. Be32(image.Length), .. image];
        // An empty STREAMINFO stand-in (not last), then the PICTURE block marked last.
        return [.. "fLaC"u8, 0, 0, 0, 4, 0, 0, 0, 0, 0x80 | 6, (byte)(picture.Length >> 16), (byte)(picture.Length >> 8), (byte)picture.Length, .. picture];
    }

    private static byte[] Box(string kind, params byte[][] payload)
    {
        byte[] body = [.. payload.SelectMany(part => part)];
        return [.. Be32(8 + body.Length), .. Encoding.ASCII.GetBytes(kind), .. body];
    }

    private static byte[] M4AWith(byte[] image)
    {
        var data = Box("data", [0, 0, 0, 14, 0, 0, 0, 0], image);
        var meta = Box("meta", [0, 0, 0, 0], Box("ilst", Box("covr", data)));
        return [.. Box("ftyp", "M4A \0\0\0\0M4A "u8.ToArray()), .. Box("moov", Box("udta", meta))];
    }

    private static byte[] EpubWith(string opf, Dictionary<string, byte[]>? extra, int entries)
    {
        var files = new Dictionary<string, byte[]>
        {
            ["META-INF/container.xml"] = """<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"""u8.ToArray(),
            ["OEBPS/content.opf"] = Encoding.UTF8.GetBytes(opf),
            ["OEBPS/images/cover.png"] = Png(40, 60),
        };
        foreach (var (name, data) in extra ?? [])
        {
            files[name] = data;
        }
        using var buffer = new MemoryStream();
        using (var zip = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (name, data) in files)
            {
                using var entry = zip.CreateEntry(name).Open();
                entry.Write(data);
            }
            for (var i = 0; i < entries; i++)
            {
                zip.CreateEntry($"pad/{i}");
            }
        }
        return buffer.ToArray();
    }

    private static string OpfDoc(string meta, string items) =>
        $"""<package xmlns="http://www.idpf.org/2007/opf"><metadata>{meta}</metadata><manifest>{items}</manifest></package>""";
}
