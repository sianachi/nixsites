using System.Buffers.Binary;
using System.Globalization;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Nix.Workers.Archive;
using Nix.Workers.Import;

namespace Nix.Tests.Workers;

/// <summary>Inputs for the import planner tests, built the way the Go importplan tests built them.</summary>
internal static class ImportFixtures
{
    public const string Root = "11111111-1111-4111-8111-111111111111";
    public const string Child = "22222222-2222-4222-8222-222222222222";
    public const string Workspace = "33333333-3333-4333-8333-333333333333";
    public const string Other = "44444444-4444-4444-8444-444444444444";

    public static ImportPlanLimits Limits { get; } = new(100L << 20, 16L << 20, 8L << 20, 8L << 20, 200, 32, 5);

    public static string RepoRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "Nix.slnx")))
        {
            directory = directory.Parent;
        }
        return directory!.FullName;
    }

    public static string TempPath(string name)
    {
        var directory = Path.Combine(Path.GetTempPath(), "nix-import-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return Path.Combine(directory, name);
    }

    public static ImportSource FileSource(string path, string format, string title = "Imported", string? fileName = null, string mediaType = "application/octet-stream")
    {
        var body = File.ReadAllBytes(path);
        return new ImportSource(path, format, title, fileName ?? Path.GetFileName(path), mediaType, body.Length, Convert.ToHexStringLower(SHA256.HashData(body)));
    }

    public static ImportSource Source(string name, string format, byte[] body)
    {
        var path = TempPath(name);
        File.WriteAllBytes(path, body);
        return FileSource(path, format);
    }

    public static ImportSource Zip(string name, string format, params (string Name, byte[] Body)[] entries)
    {
        using var buffer = new MemoryStream();
        using (var archive = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (entryName, body) in entries)
            {
                using var stream = archive.CreateEntry(entryName, CompressionLevel.Optimal).Open();
                stream.Write(body);
            }
        }
        return Source(name, format, buffer.ToArray());
    }

    public static byte[] Utf8(string value) => Encoding.UTF8.GetBytes(value);

    private static readonly JsonSerializerOptions CamelCase = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public static byte[] Json(object? value) => JsonSerializer.SerializeToUtf8Bytes(value, CamelCase);

    public static Dictionary<string, object?> ManifestItem(string id, string? parent, string seq, string title, string type) =>
        new() { ["id"] = id, ["parentId"] = parent, ["seq"] = seq, ["title"] = title, ["type"] = type };

    public static Dictionary<string, object?> Manifest(int formatVersion, object?[] items, object? rootEffectiveSchema = null, object?[]? files = null, object?[]? omitted = null, object?[]? loss = null, object? profile = null, int schemaVersion = 3)
    {
        var manifest = new Dictionary<string, object?>
        {
            ["format"] = "nix-archive",
            ["formatVersion"] = formatVersion,
            ["schemaVersion"] = schemaVersion,
            ["exportedAt"] = "2026-09-01T12:00:00Z",
            ["root"] = Root,
            ["rootEffectiveSchema"] = rootEffectiveSchema,
            ["includesDeleted"] = false,
            ["items"] = items,
            ["omitted"] = omitted ?? [],
            ["loss"] = loss ?? [],
        };
        if (files is not null)
        {
            manifest["files"] = files;
        }
        if (profile is not null)
        {
            manifest["profile"] = profile;
        }
        return manifest;
    }

    public static Dictionary<string, object?> Bundle(string id, string? parent, string seq, string title, string type, object? body, object? views = null, object? schema = null, object? properties = null, string state = "active") => new()
    {
        ["id"] = id,
        ["parentId"] = parent,
        ["workspaceId"] = Workspace,
        ["type"] = type,
        ["title"] = title,
        ["seq"] = seq,
        ["lifecycleState"] = state,
        ["createdAt"] = "2026-09-01T12:00:00Z",
        ["updatedAt"] = "2026-09-01T12:00:00Z",
        ["properties"] = properties ?? new Dictionary<string, object?>(),
        ["schema"] = schema,
        ["views"] = views,
        ["viewRows"] = Array.Empty<object>(),
        ["viewRowsTruncated"] = false,
        ["body"] = body,
    };

    public static object NoteBody(int schemaVersion = 3) => new { schemaVersion, prosemirror = new { type = "doc", content = Array.Empty<object>() } };

    public static JsonElement Element(string json) => JsonElement.Parse(json);

    public static FileVersionEntry PdfDescriptor(string itemId, int version, bool current, byte[] body) =>
        new(itemId, version, current, "report.pdf", "application/pdf", body.Length, Convert.ToHexStringLower(SHA256.HashData(body)), true, null, null);

    public static ImportSource NixV2Archive(bool twoVersions, out List<FileVersionEntry> descriptors)
    {
        var first = Utf8("%PDF-1.5\nfirst version");
        var second = Utf8("%PDF-1.5\ncurrent version");
        descriptors = [PdfDescriptor(Child, 1, !twoVersions, first)];
        if (twoVersions)
        {
            descriptors.Add(PdfDescriptor(Child, 2, true, second));
        }
        var manifest = Manifest(2, [ManifestItem(Root, null, "1", "Root", "note"), ManifestItem(Child, Root, "2", "Report", "file")], files: [.. descriptors]);
        var entries = new List<(string, byte[])>
        {
            ("manifest.json", Json(manifest)),
            ("items/" + Root + ".json", Json(Bundle(Root, null, "1", "Root", "note", NoteBody()))),
            ("items/" + Child + ".json", Json(Bundle(Child, Root, "2", "Report", "file", null))),
        };
        byte[][] bodies = twoVersions ? [first, second] : [first];
        for (var index = 0; index < descriptors.Count; index++)
        {
            entries.Add(($"files/{Child}/{descriptors[index].Version}.bin", bodies[index]));
        }
        return Zip("files.nix", "nix", [.. entries]);
    }

    public static ImportSource NixV2TemplateArchive(out FileVersionEntry descriptor)
    {
        var data = Utf8("%PDF-1.5\nportable template file");
        descriptor = PdfDescriptor(Child, 1, true, data);
        var profile = new Dictionary<string, object?>
        {
            ["kind"] = "template",
            ["version"] = 1,
            ["key"] = "team.project",
            ["name"] = "Project",
            ["description"] = "Portable template",
            ["includeBody"] = true,
            ["includeChildren"] = true,
            ["initialization"] = new
            {
                version = 1,
                inputs = new[] { new { key = "project_name", label = "Project name", type = "text", required = true } },
                rules = new[] { new { sourceId = Root, propertyKey = "name", kind = "input", inputKey = "project_name" } },
                references = new[] { new { sourceItemId = Other, policy = "omit" } },
            },
        };
        var manifest = Manifest(2, [ManifestItem(Root, null, "1", "Project", "note"), ManifestItem(Child, Root, "2", "Report", "file")], files: [descriptor], profile: profile);
        var body = Element("""{"schemaVersion":3,"prosemirror":{"type":"doc","content":[{"type":"image","attrs":{"src":"","fileItemId":"22222222-2222-4222-8222-222222222222","alt":"Report"}}]}}""");
        return Zip(
            "template.nix",
            "nix",
            ("manifest.json", Json(manifest)),
            ("items/" + Root + ".json", Json(Bundle(Root, null, "1", "Project", "note", body))),
            ("items/" + Child + ".json", Json(Bundle(Child, Root, "2", "Report", "file", null))),
            ($"files/{Child}/1.bin", data));
    }

    public static Dictionary<string, object?> TemplateProfile(bool includeBody, bool includeChildren) => new()
    {
        ["kind"] = "template",
        ["version"] = 1,
        ["key"] = "team.project",
        ["name"] = "Project",
        ["description"] = "Reusable project",
        ["includeBody"] = includeBody,
        ["includeChildren"] = includeChildren,
    };

    /// <summary>Go's templateArchiveSource: a root note (min int64 seq) and optionally a canvas child (max int64 seq).</summary>
    public static ImportSource TemplateArchive(object? profile, bool includeChild, bool includeRootBody, object?[]? omitted = null, object?[]? loss = null, IDictionary<string, object?>? rootExtra = null)
    {
        const string minSeq = "-9223372036854775808";
        const string maxSeq = "9223372036854775807";
        var items = new List<object?> { ManifestItem(Root, null, minSeq, "Project", "note") };
        if (includeChild)
        {
            items.Add(ManifestItem(Child, Root, maxSeq, "Sketch", "canvas"));
        }
        var manifest = Manifest(1, [.. items], rootEffectiveSchema: new { properties = Array.Empty<object>(), declared = Array.Empty<object>(), inherit = true }, omitted: omitted, loss: loss);
        manifest["profile"] = profile;
        var rootViews = Element("""{"default":"view","views":[{"id":"view","name":"List","kind":"list","columns":[],"groupBy":null,"groupOrder":[],"dateProperty":null,"sortBy":null,"sortDescending":false,"mode":null,"coverProperty":null,"endDateProperty":null,"cardSize":null}]}""");
        var root = Bundle(Root, null, minSeq, "Project", "note", includeRootBody ? NoteBody() : null, rootViews, properties: new { status = "open" });
        foreach (var (key, value) in rootExtra ?? new Dictionary<string, object?>())
        {
            root[key] = value;
        }
        var entries = new List<(string, byte[])> { ("manifest.json", Json(manifest)), ("items/" + Root + ".json", Json(root)) };
        if (includeChild)
        {
            var childBody = new { schemaVersion = 1, canvas = new { version = 1, elements = Array.Empty<object>() } };
            entries.Add(("items/" + Child + ".json", Json(Bundle(Child, Root, maxSeq, "Sketch", "canvas", childBody, properties: new { status = "open" }))));
        }
        return Zip("project.nix", "nix", [.. entries]);
    }

    /// <summary>A PNG with a valid IHDR and an empty IDAT, as Go's docxPNG.</summary>
    public static byte[] Png(uint width, uint height)
    {
        var body = new List<byte> { 137, 80, 78, 71, 13, 10, 26, 10 };
        var ihdr = new byte[13]; // byte[]: the IHDR chunk data
        BinaryPrimitives.WriteUInt32BigEndian(ihdr, width);
        BinaryPrimitives.WriteUInt32BigEndian(ihdr.AsSpan(4), height);
        ihdr[8] = 8;
        ihdr[9] = 6;
        AppendChunk(body, "IHDR", ihdr);
        AppendChunk(body, "IDAT", []);
        return [.. body];
    }

    private static void AppendChunk(List<byte> target, string kind, byte[] data)
    {
        var chunk = new byte[12 + data.Length]; // byte[]: one PNG chunk
        BinaryPrimitives.WriteUInt32BigEndian(chunk, (uint)data.Length);
        Encoding.ASCII.GetBytes(kind).CopyTo(chunk, 4);
        data.CopyTo(chunk, 8);
        BinaryPrimitives.WriteUInt32BigEndian(chunk.AsSpan(8 + data.Length), Crc(chunk.AsSpan(4, 4 + data.Length)));
        target.AddRange(chunk);
    }

    private static uint Crc(ReadOnlySpan<byte> body)
    {
        var crc = 0xFFFFFFFFu;
        foreach (var value in body)
        {
            crc ^= value;
            for (var bit = 0; bit < 8; bit++)
            {
                crc = (crc & 1) != 0 ? 0xEDB88320 ^ (crc >> 1) : crc >> 1;
            }
        }
        return ~crc;
    }

    /// <summary>A minimal PDF, one Helvetica text line per page (empty text makes a page with no text).</summary>
    public static byte[] Pdf(params string[] pages)
    {
        var objects = new List<string> { "<< /Type /Catalog /Pages 2 0 R >>", string.Empty, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" };
        var kids = new List<string>();
        foreach (var text in pages)
        {
            var content = text.Length == 0 ? string.Empty : $"BT /F1 12 Tf 72 720 Td ({text}) Tj ET";
            objects.Add($"<< /Length {content.Length} >>\nstream\n{content}\nendstream");
            objects.Add($"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {objects.Count} 0 R >>");
            kids.Add($"{objects.Count} 0 R");
        }
        objects[1] = $"<< /Type /Pages /Kids [{string.Join(' ', kids)}] /Count {pages.Length} >>";
        var output = new StringBuilder("%PDF-1.4\n");
        var offsets = new List<int>();
        for (var index = 0; index < objects.Count; index++)
        {
            offsets.Add(output.Length);
            output.Append(CultureInfo.InvariantCulture, $"{index + 1} 0 obj\n{objects[index]}\nendobj\n");
        }
        var xref = output.Length;
        output.Append(CultureInfo.InvariantCulture, $"xref\n0 {objects.Count + 1}\n0000000000 65535 f \n");
        foreach (var offset in offsets)
        {
            output.Append(CultureInfo.InvariantCulture, $"{offset:D10} 00000 n \n");
        }
        output.Append(CultureInfo.InvariantCulture, $"trailer\n<< /Size {objects.Count + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n");
        return Encoding.ASCII.GetBytes(output.ToString());
    }

    /// <summary>A one-page PDF whose content stream is Flate-compressed and padded with <paramref name="padding"/> spaces.</summary>
    public static byte[] FlatePdf(string text, int padding)
    {
        using var compressed = new MemoryStream();
        using (var zlib = new ZLibStream(compressed, CompressionLevel.SmallestSize, leaveOpen: true))
        {
            zlib.Write(Encoding.ASCII.GetBytes($"BT /F1 12 Tf 72 720 Td ({text}) Tj ET\n"));
            var spaces = new byte[1 << 20];
            spaces.AsSpan().Fill((byte)' ');
            for (var left = padding; left > 0; left -= spaces.Length)
            {
                zlib.Write(spaces, 0, Math.Min(left, spaces.Length));
            }
        }
        var stream = compressed.ToArray();
        string[] objects =
        [
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
        ];
        using var output = new MemoryStream();
        void Ascii(string value) => output.Write(Encoding.ASCII.GetBytes(value));
        var offsets = new List<long>();
        Ascii("%PDF-1.4\n");
        foreach (var body in objects)
        {
            offsets.Add(output.Length);
            Ascii(string.Create(CultureInfo.InvariantCulture, $"{offsets.Count} 0 obj\n{body}\nendobj\n"));
        }
        offsets.Add(output.Length);
        Ascii(string.Create(CultureInfo.InvariantCulture, $"5 0 obj\n<< /Length {stream.Length} /Filter /FlateDecode >>\nstream\n"));
        output.Write(stream);
        Ascii("\nendstream\nendobj\n");
        var xref = output.Length;
        Ascii("xref\n0 6\n0000000000 65535 f \n");
        foreach (var offset in offsets)
        {
            Ascii(string.Create(CultureInfo.InvariantCulture, $"{offset:D10} 00000 n \n"));
        }
        Ascii(string.Create(CultureInfo.InvariantCulture, $"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"));
        return output.ToArray();
    }
}
