using System.Text;
using System.Text.Json;
using Nix.Workers.Import;
using static Nix.Tests.Workers.ImportFixtures;

namespace Nix.Tests.Workers;

/// <summary>The Go importplan parse_test, nix_v2_test and fuzz properties, against the .NET port.</summary>
public sealed class ImportPlanTests
{
    private static CancellationToken Token => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Text_import_normalizes_utf8_and_retains_the_txt_original()
    {
        var source = Source("notes.txt", "txt", [0xef, 0xbb, 0xbf, .. Utf8("one\r\ntwo\rthree")]);

        var plan = await ImportPlanner.ParseAsync(source, Limits, Token);

        Assert.Equal("txt", plan.Format);
        Assert.Equal(2, plan.Items.Count);
        Assert.Equal("one\ntwo\nthree", plan.Items[0].Body!.Text);
        Assert.Equal("source", plan.Items[1].File!.SourceKind);
        Assert.Equal(source.Sha256, plan.Items[1].File!.Sha256);
    }

    [Fact]
    public async Task Markdown_import_does_not_create_an_original_file_item()
    {
        var plan = await ImportPlanner.ParseAsync(Source("notes.markdown", "markdown", Utf8("# Heading\n")), Limits, Token);

        Assert.Single(plan.Items);
        Assert.Equal("markdown", plan.Items[0].Body!.Encoding);
    }

    [Theory]
    [InlineData(new byte[] { (byte)'a', 0, (byte)'b' })]
    [InlineData(new byte[] { (byte)'a', 0x1b, (byte)'b' })]
    [InlineData(new byte[] { (byte)'a', 0x7f, (byte)'b' })]
    [InlineData(new byte[] { 0xff, 0xfe })]
    [InlineData(new byte[] { 0xef, 0xbb, 0xbf, 0xc3 })]
    public async Task Text_import_rejects_binary_and_invalid_utf8(byte[] body)
    {
        var error = await Assert.ThrowsAsync<ImportPlanException>(() => ImportPlanner.ParseAsync(Source("bad.txt", "txt", body), Limits, Token));
        Assert.Equal(ImportPlanException.SourceInvalid, error.Code);
    }

    [Fact]
    public async Task Text_over_the_body_limit_is_refused()
    {
        var limits = Limits with { MaxBodyBytes = 4 };
        await Assert.ThrowsAsync<ImportPlanException>(() => ImportPlanner.ParseAsync(Source("long.txt", "txt", Utf8("hello")), limits, Token));
    }

    [Fact]
    public async Task Unsupported_formats_carry_their_code()
    {
        var error = await Assert.ThrowsAsync<ImportPlanException>(() => ImportPlanner.ParseAsync(Source("x.rtf", "rtf", Utf8("x")), Limits, Token));
        Assert.Equal(ImportPlanException.FormatUnsupported, error.Code);
    }

    [Fact]
    public async Task Docx_import_preserves_rich_blocks_and_extracts_images()
    {
        const string document = """
            <?xml version="1.0" encoding="UTF-8"?>
            <w:document xmlns:w="w" xmlns:r="r" xmlns:a="a"><w:body>
              <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Roadmap</w:t></w:r></w:p>
              <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr><w:hyperlink r:id="link"><w:r><w:t>Read</w:t></w:r></w:hyperlink></w:p>
              <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
              <w:p><w:r><w:drawing><a:blip r:embed="image"/></w:drawing></w:r></w:p>
            </w:body></w:document>
            """;
        const string rels = """<Relationships><Relationship Id="link" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.test/docs" TargetMode="External"/><Relationship Id="image" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/picture.png"/></Relationships>""";
        const string numbering = """<w:numbering xmlns:w="w"><w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="7"><w:abstractNumId w:val="3"/></w:num></w:numbering>""";
        var source = Zip(
            "document.docx",
            "docx",
            ("word/document.xml", Utf8(document)),
            ("word/_rels/document.xml.rels", Utf8(rels)),
            ("word/numbering.xml", Utf8(numbering)),
            ("word/styles.xml", Utf8("""<w:styles xmlns:w="w"/>""")),
            ("word/header1.xml", Utf8("""<w:hdr xmlns:w="w"/>""")),
            ("word/media/picture.png", Png(640, 480)));

        var plan = await ImportPlanner.ParseAsync(source, Limits, Token);

        Assert.Equal(3, plan.Items.Count);
        Assert.True(plan.Items[2].File!.Previewable);
        Assert.Equal("word/media/picture.png", plan.Items[2].File!.AssetPath);
        Assert.Equal("nix-render", plan.Items[0].Body!.Encoding);
        var encoded = plan.Items[0].Body!.Render!.Value.GetRawText();
        Nix.Workers.Render.RenderTree.Decode(Encoding.UTF8.GetBytes(encoded));
        foreach (var expected in (string[])["\"kind\":\"heading\"", "\"ordered\":true", "\"kind\":\"table\"", "\"src\":\"nix-file:asset-0001\"", "\"href\":\"https://example.test/docs\""])
        {
            Assert.Contains(expected, encoded, StringComparison.Ordinal);
        }
        Assert.NotEmpty(plan.Loss);
        Assert.NotEmpty(plan.Omissions);

        using var asset = AssetReader.Open(source, "word/media/picture.png", Limits);
        using var copy = new MemoryStream();
        await asset.Body.CopyToAsync(copy, Token);
        Assert.Equal(Png(640, 480), copy.ToArray());
        Assert.Equal(copy.Length, asset.Size);
    }

    [Fact]
    public async Task Docx_rejects_entities_compression_bombs_and_deep_xml()
    {
        var entity = Zip("entity.docx", "docx", ("word/document.xml", Utf8("""<!DOCTYPE x [<!ENTITY e "bad">]><document/>""")));
        await Assert.ThrowsAsync<ImportPlanException>(() => ImportPlanner.ParseAsync(entity, Limits, Token));

        var bomb = Zip("bomb.docx", "docx", ("word/document.xml", Utf8(new string('a', 128 * 1024))));
        var bombError = await Assert.ThrowsAsync<ImportPlanException>(() => ImportPlanner.ParseAsync(bomb, Limits, Token));
        Assert.Contains("compression ratio", bombError.Message, StringComparison.Ordinal);

        var deepXml = string.Concat(Enumerable.Repeat("<w:x>", 40)) + string.Concat(Enumerable.Repeat("</w:x>", 40));
        var deep = Zip("deep.docx", "docx", ("word/document.xml", Utf8(deepXml)));
        var deepError = await Assert.ThrowsAsync<ImportPlanException>(() => ImportPlanner.ParseAsync(deep, Limits, Token));
        Assert.Contains("structure", deepError.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("<w:document><w:p>text</w:p></w:document>", false)]
    [InlineData("<?xml version=\"1.0\" encoding=\"UTF-16\"?><w:document/>", true)]
    [InlineData("<?php echo 1 ?><w:document/>", true)]
    [InlineData("<x><y></x>", true)]
    [InlineData("<x>&e;</x>", true)]
    [InlineData("<x><!ENTITY e \"bad\"></x>", true)]
    public async Task Docx_xml_fails_closed(string document, bool rejected)
    {
        var source = Zip("x.docx", "docx", ("word/document.xml", Utf8(document)));
        if (rejected)
        {
            await Assert.ThrowsAsync<ImportPlanException>(() => ImportPlanner.ParseAsync(source, Limits, Token));
        }
        else
        {
            Assert.Equal(2, (await ImportPlanner.ParseAsync(source, Limits, Token)).Items.Count);
        }
    }

    [Theory]
    [InlineData("docx", new byte[] { (byte)'n', (byte)'o', (byte)'t' })]
    [InlineData("nix", new byte[] { (byte)'P', (byte)'K', 3, 4 })]
    [InlineData("nix", new byte[] { })]
    public async Task Garbage_archives_fail_closed(string format, byte[] body)
    {
        var source = Source("input." + format, format, body);
        await Assert.ThrowsAsync<ImportPlanException>(() => ImportPlanner.ParseAsync(source, Limits, Token));
        if (format == "nix")
        {
            await Assert.ThrowsAsync<ImportPlanException>(() => TemplatePlanner.ParseAsync(source, Limits, Token));
        }
    }

    [Fact]
    public async Task Archive_members_outside_the_tree_are_refused()
    {
        var source = Zip("x.docx", "docx", ("../word/document.xml", Utf8("<x/>")));
        var error = await Assert.ThrowsAsync<ImportPlanException>(() => ImportPlanner.ParseAsync(source, Limits, Token));
        Assert.Contains("unsafe or encrypted", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Nix_import_preserves_tree_envelopes_and_bodies()
    {
        var definitions = new object[] { new { key = "area", label = "Area", type = "select", options = new[] { "Core", "Workers" }, required = false } };
        var views = Element("""{"default":"catalog","views":[{"id":"catalog","name":"Catalog","kind":"list","columns":["title","area"],"sortBy":"title"},{"id":"areas","name":"By area","kind":"board","groupBy":"area","groupOrder":["Core","Workers"]}]}""");
        var manifest = Manifest(1, [ManifestItem(Root, null, "1024", "Root", "note"), ManifestItem(Child, Root, "2048", "Child", "note")], rootEffectiveSchema: new { properties = definitions, declared = definitions, inherit = true }, omitted: [new Dictionary<string, object?> { ["id"] = null, ["parentId"] = Root, ["reason"] = "limit-reached", ["detail"] = "One child was omitted." }]);
        var childProperties = Element("""{"title":"Child","area":"Core","source_path":"backend/src/Nix.Api/Program.cs"}""");
        var source = Zip(
            "workspace.nix",
            "nix",
            ("manifest.json", Json(manifest)),
            ("items/" + Root + ".json", Json(Bundle(Root, null, "1024", "Root", "note", NoteBody(), views, properties: new { title = "Root" }))),
            ("items/" + Child + ".json", Json(Bundle(Child, Root, "2048", "Child", "note", NoteBody(), properties: childProperties, state: "deleted"))));

        var plan = await ImportPlanner.ParseAsync(source, Limits, Token);

        Assert.Equal(2, plan.Items.Count);
        Assert.Equal(Root, plan.Items[1].ParentSourceId);
        Assert.Equal("deleted", plan.Items[1].FinalLifecycleState);
        Assert.Equal("archive", plan.Items[0].Body!.Encoding);
        Assert.Single(plan.Omissions);
        var schema = plan.Items[0].Schema!.Value;
        Assert.False(schema.GetProperty("inherit").GetBoolean());
        var property = Assert.Single(schema.GetProperty("properties").EnumerateArray().ToList());
        Assert.Equal("area", property.GetProperty("key").GetString());
        Assert.Equal(["Core", "Workers"], property.GetProperty("options").EnumerateArray().Select(option => option.GetString()));
        Assert.Equal(views.GetRawText(), plan.Items[0].Views!.Value.GetRawText());
        Assert.Equal(childProperties.GetRawText(), plan.Items[1].Properties!.Value.GetRawText());
    }

    [Theory]
    [InlineData(7, true)]
    [InlineData(1, true)]
    [InlineData(0, false)]
    [InlineData(8, false)]
    public async Task Nix_manifest_accepts_current_schema_and_rejects_unsupported_versions(int schemaVersion, bool accepted)
    {
        var source = Zip(
            "s.nix",
            "nix",
            ("manifest.json", Json(Manifest(1, [ManifestItem(Root, null, "1", "Root", "note")], schemaVersion: schemaVersion))),
            ("items/" + Root + ".json", Json(Bundle(Root, null, "1", "Root", "note", null))));
        if (accepted)
        {
            await ImportPlanner.ParseAsync(source, Limits, Token);
            return;
        }
        var error = await Assert.ThrowsAsync<ImportPlanException>(() => ImportPlanner.ParseAsync(source, Limits, Token));
        Assert.Contains("editor schema", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Nix_import_rejects_a_child_before_its_parent()
    {
        var manifest = Manifest(1, [ManifestItem(Child, Root, "1", "Child", "note"), ManifestItem(Root, null, "1", "Root", "note")]);
        var source = Zip(
            "bad.nix",
            "nix",
            ("manifest.json", Json(manifest)),
            ("items/" + Child + ".json", Json(Bundle(Child, Root, "1", "Child", "note", null))),
            ("items/" + Root + ".json", Json(Bundle(Root, null, "1", "Root", "note", null))));

        await Assert.ThrowsAsync<ImportPlanException>(() => ImportPlanner.ParseAsync(source, Limits, Token));
    }

    [Fact]
    public async Task Nix_import_rejects_unknown_members_and_unlisted_entries()
    {
        var bundle = Bundle(Root, null, "1", "Root", "note", null);
        bundle["surprise"] = true;
        var unknown = Zip("u.nix", "nix", ("manifest.json", Json(Manifest(1, [ManifestItem(Root, null, "1", "Root", "note")]))), ("items/" + Root + ".json", Json(bundle)));
        await Assert.ThrowsAsync<ImportPlanException>(() => ImportPlanner.ParseAsync(unknown, Limits, Token));

        var extra = Zip(
            "e.nix",
            "nix",
            ("manifest.json", Json(Manifest(1, [ManifestItem(Root, null, "1", "Root", "note")]))),
            ("items/" + Root + ".json", Json(Bundle(Root, null, "1", "Root", "note", null))),
            ("notes.txt", Utf8("hidden")));
        var error = await Assert.ThrowsAsync<ImportPlanException>(() => ImportPlanner.ParseAsync(extra, Limits, Token));
        Assert.Contains("unlisted or missing", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Plan_encoding_is_deterministic_and_checksum_protected()
    {
        var plan = new ImportPlan
        {
            Version = 1,
            Format = "txt",
            Title = "A",
            SourceSha256 = new string('a', 64),
            Items = [new ImportItem { SourceId = "root", Order = 0, Title = "A", ItemType = "note", FinalLifecycleState = "active", Body = new ImportBody { Encoding = "plain_text", Text = "hello" } }],
        };
        var (first, digest) = ImportPlanner.Encode(plan, 1 << 20);
        var (second, secondDigest) = ImportPlanner.Encode(plan, 1 << 20);
        Assert.Equal(first, second);
        Assert.Equal(digest, secondDigest);

        var mismatch = Assert.Throws<ImportPlanException>(() => ImportPlanner.Decode(first, new string('0', 64), Limits));
        Assert.Equal(ImportPlanException.PlanInvalid, mismatch.Code);
        Assert.Equal("hello", ImportPlanner.Decode(first, digest, Limits).Items[0].Body!.Text);
        Assert.Throws<ImportPlanException>(() => ImportPlanner.Encode(plan, 10));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Nix_import_carries_note_comments_and_still_imports_without_them(bool withComments)
    {
        var bundle = Bundle(Root, null, "1024", "Root", "note", NoteBody(), properties: new { title = "Root" });
        if (withComments)
        {
            bundle["comments"] = Element("""[{"id":"t","quote":"the plan","resolved":true,"comments":[{"author":"Ada","body":"Why?","createdAt":"2026-10-29T10:00:00Z"}]}]""");
        }
        var source = Zip("c.nix", "nix", ("manifest.json", Json(Manifest(1, [ManifestItem(Root, null, "1024", "Root", "note")]))), ("items/" + Root + ".json", Json(bundle)));

        var plan = await ImportPlanner.ParseAsync(source, Limits, Token);

        if (withComments)
        {
            Assert.Contains("\"author\":\"Ada\"", plan.Items[0].Comments!.Value.GetRawText(), StringComparison.Ordinal);
        }
        else
        {
            Assert.Null(plan.Items[0].Comments);
        }
    }

    [Fact]
    public async Task Shared_typescript_v2_archive_fixture_imports()
    {
        var source = FileSource(Path.Combine(RepoRoot(), "fixtures", "nix-archive-v2-file.nix"), "nix", "Report", "report.nix", "application/x-nix-template");

        var plan = await ImportPlanner.ParseAsync(source, Limits, Token);

        var item = Assert.Single(plan.Items);
        Assert.Equal("file", item.ItemType);
        Assert.Equal(2, plan.FileVersions!.Count);
        Assert.Equal(2, plan.FileVersions[1].Version);
        Assert.True(plan.FileVersions[1].Current);
    }

    [Fact]
    public async Task Nix_archive_files_stream_declared_version_entries()
    {
        using var files = NixArchiveFiles.Open(Path.Combine(RepoRoot(), "fixtures", "nix-archive-v2-file.nix"), Limits);
        string[] expected = ["%PDF-1.5\nold version", "%PDF-1.5\ncurrent version"];
        for (var version = 1; version <= 2; version++)
        {
            await using var stream = files.OpenVersion(Root, version, expected[version - 1].Length);
            using var reader = new StreamReader(stream);
            Assert.Equal(expected[version - 1], await reader.ReadToEndAsync(Token));
        }
        Assert.Throws<ImportPlanException>(() => files.OpenVersion(Root, 3, 1));
        Assert.Throws<ImportPlanException>(() => files.OpenVersion(Root, 1, 5));
        Assert.Throws<ImportPlanException>(() => files.OpenVersion("../x", 1, 1));
    }

    [Fact]
    public async Task Nix_v2_file_history_is_verified_and_preserved_in_the_plan()
    {
        var source = NixV2Archive(twoVersions: true, out var descriptors);

        var plan = await ImportPlanner.ParseAsync(source, Limits, Token);

        Assert.Equal(2, plan.Items.Count);
        Assert.Equal(2, plan.FileVersions!.Count);
        Assert.False(plan.FileVersions[0].Current);
        Assert.True(plan.FileVersions[1].Current);
        var (body, digest) = ImportPlanner.Encode(plan, Limits.MaxPlanBytes);
        var decoded = ImportPlanner.Decode(body, digest, Limits);
        Assert.Equal(descriptors.Count, decoded.FileVersions!.Count);
        Assert.Equal(descriptors[1].Sha256, decoded.FileVersions[1].Sha256);
    }

    public static TheoryData<string> HostileFileCases() => ["digest", "mime", "traversal"];

    [Theory]
    [MemberData(nameof(HostileFileCases))]
    public async Task Nix_v2_rejects_untrusted_file_metadata_and_archive_members(string scenario)
    {
        var bytes = Utf8("%PDF-1.5\nfirst");
        var descriptor = PdfDescriptor(Child, 1, true, bytes);
        var entryName = $"files/{Child}/1.bin";
        string wantError;
        switch (scenario)
        {
            case "digest":
                descriptor = descriptor with { Sha256 = new string('a', 64) };
                wantError = "SHA-256";
                break;
            case "mime":
                bytes = Utf8(new string('x', (int)descriptor.ByteLength));
                descriptor = descriptor with { Sha256 = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes)) };
                wantError = "inspected file metadata";
                break;
            default:
                entryName = "files/../outside/1.bin";
                bytes = Utf8("%PDF-1.5\n");
                wantError = "unsafe or encrypted";
                break;
        }
        var manifest = Manifest(2, [ManifestItem(Root, null, "1", "Root", "note"), ManifestItem(Child, Root, "2", "Report", "file")], files: [descriptor]);
        var source = Zip(
            "hostile.nix",
            "nix",
            ("manifest.json", Json(manifest)),
            ("items/" + Root + ".json", Json(Bundle(Root, null, "1", "Root", "note", NoteBody()))),
            ("items/" + Child + ".json", Json(Bundle(Child, Root, "2", "Report", "file", null))),
            (entryName, bytes));

        var error = await Assert.ThrowsAsync<ImportPlanException>(() => ImportPlanner.ParseAsync(source, Limits, Token));
        Assert.Contains(wantError, error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Native_chat_view_and_message_fields_survive_preview_and_commit()
    {
        var definitions = Element("""[{"key":"chat_role","label":"Role","type":"select","options":["user","assistant","system"],"required":true},{"key":"chat_text","label":"Text","type":"text","required":true},{"key":"chat_created_at","label":"Created","type":"date","required":true},{"key":"chat_author","label":"Author","type":"text","required":false}]""");
        var views = Element("""{"default":"conversation","views":[{"id":"conversation","name":"Chat","kind":"chat","sortBy":"chat_created_at"}]}""");
        var properties = Element("""{"chat_role":"assistant","chat_text":"Saved insight","chat_created_at":"2026-10-15T12:00:00Z","chat_author":"Pet"}""");
        var schema = new { properties = definitions, declared = definitions, inherit = false };
        var source = Zip(
            "conversation.nix",
            "nix",
            ("manifest.json", Json(Manifest(1, [ManifestItem(Root, null, "1", "Conversation", "note"), ManifestItem(Child, Root, "2", "Saved message", "note")], rootEffectiveSchema: schema, schemaVersion: 7))),
            ("items/" + Root + ".json", Json(Bundle(Root, null, "1", "Conversation", "note", null, views, schema))),
            ("items/" + Child + ".json", Json(Bundle(Child, Root, "2", "Saved message", "note", null, properties: properties))));

        var plan = await ImportPlanner.ParseAsync(source, Limits, Token);
        var (body, digest) = ImportPlanner.Encode(plan, Limits.MaxPlanBytes);
        var committed = ImportPlanner.Decode(body, digest, Limits);

        foreach (var result in (ImportPlan[])[plan, committed])
        {
            Assert.True(JsonElement.DeepEquals(views, result.Items[0].Views!.Value));
            Assert.True(JsonElement.DeepEquals(properties, result.Items[1].Properties!.Value));
            Assert.True(JsonElement.DeepEquals(definitions, result.Items[0].Schema!.Value.GetProperty("properties")));
        }
    }

    [Fact]
    public async Task Cancellation_stops_a_parse()
    {
        using var cancelled = new CancellationTokenSource();
        await cancelled.CancelAsync();
        var source = NixV2Archive(twoVersions: false, out _);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => ImportPlanner.ParseAsync(source, Limits, cancelled.Token));
    }

    [Fact]
    public async Task Pdf_text_keeps_page_structure()
    {
        var source = Source("doc.pdf", "pdf", Pdf("Hello page one", "Second page"));

        var plan = await ImportPlanner.ParseAsync(source, Limits, Token);

        Assert.Equal("pdf", plan.Format);
        Assert.Equal(2, plan.Items.Count);
        Assert.Equal("application/pdf", plan.Items[1].File!.MediaType);
        Assert.Single(plan.Loss);
        var text = plan.Items[0].Body!.Text!;
        Assert.Equal("plain_text", plan.Items[0].Body!.Encoding);
        Assert.Matches(@"^Hello page one\s*\[Page break\]\s*Second page\s*\[Page break\]$", text);
    }

    [Fact]
    public async Task Pdf_without_text_or_signature_is_refused()
    {
        var empty = await Assert.ThrowsAsync<ImportPlanException>(() => ImportPlanner.ParseAsync(Source("empty.pdf", "pdf", Pdf(string.Empty)), Limits, Token));
        Assert.Equal(ImportPlanException.OcrUnavailable, empty.Code);

        var unsigned = await Assert.ThrowsAsync<ImportPlanException>(() => ImportPlanner.ParseAsync(Source("x.pdf", "pdf", Utf8("hello")), Limits, Token));
        Assert.Equal(ImportPlanException.SourceInvalid, unsigned.Code);

        var limits = Limits with { MaxBodyBytes = 8 };
        await Assert.ThrowsAsync<ImportPlanException>(() => ImportPlanner.ParseAsync(Source("big.pdf", "pdf", Pdf("Hello page one")), limits, Token));
    }

    [Fact]
    public async Task Pdf_flate_streams_inflate_only_within_the_budget()
    {
        var plan = await ImportPlanner.ParseAsync(Source("flate.pdf", "pdf", FlatePdf("Hello flate", 0)), Limits, Token);
        Assert.Contains("Hello flate", plan.Items[0].Body!.Text!, StringComparison.Ordinal);

        // 64 MiB of spaces deflates to ~64 KiB and would inflate in memory; the budget is 16 x 1 MiB.
        var bomb = Source("bomb.pdf", "pdf", FlatePdf("Hello flate", 64 << 20));
        var refused = await Assert.ThrowsAsync<ImportPlanException>(() => ImportPlanner.ParseAsync(bomb, Limits with { MaxBodyBytes = 1 << 20 }, Token));
        Assert.Contains("expand", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Zip_directory_records_are_counted_before_the_archive_loads_them()
    {
        // The end record declares one entry, so ZipArchive alone would read all 400 records and only then fail on the count.
        using var records = new MemoryStream();
        using var writer = new BinaryWriter(records, Encoding.ASCII, leaveOpen: true);
        for (var index = 0; index < 400; index++)
        {
            writer.Write(0x02014b50u);
            writer.Write(new byte[24]);
            writer.Write((ushort)1);
            writer.Write(new byte[16]);
            writer.Write((byte)'a');
        }
        writer.Write(0x06054b50u);
        writer.Write(new byte[6]);
        writer.Write((ushort)1);
        writer.Write((uint)(records.Length - 4 - 6 - 2));
        writer.Write(0u);
        writer.Write((ushort)0);

        var refused = await Assert.ThrowsAsync<ImportPlanException>(() => ImportPlanner.ParseAsync(Source("many.docx", "docx", records.ToArray()), Limits, Token));
        Assert.Equal("archive contains too many entries", refused.Message);
    }
}
