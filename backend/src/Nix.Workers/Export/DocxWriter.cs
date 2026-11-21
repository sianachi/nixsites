using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Xml;
using Nix.Workers.Archive;
using Nix.Workers.Render;

namespace Nix.Workers.Export;

/// <summary>
/// Writes a DOCX: WordprocessingML parts in a zip, one Title paragraph per note, lists as flat
/// numbered paragraphs, images as inline drawings. Every part that carries content is written with
/// <see cref="XmlWriter"/>, which does the escaping and keeps the namespaces straight.
/// </summary>
public static class DocxWriter
{
    private const string W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    private const string R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    private const string Wp = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
    private const string A = "http://schemas.openxmlformats.org/drawingml/2006/main";
    private const string Pic = "http://schemas.openxmlformats.org/drawingml/2006/picture";
    private const string PackageRelationships = "http://schemas.openxmlformats.org/package/2006/relationships";

    // The three parts with no content of their own are fixed documents.
    private const string ContentTypes = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Default Extension=\"png\" ContentType=\"image/png\"/><Default Extension=\"jpeg\" ContentType=\"image/jpeg\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/><Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/><Override PartName=\"/word/numbering.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml\"/></Types>";
    private const string RootRelationships = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>";
    private const string Styles = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/></w:style><w:style w:type=\"paragraph\" w:styleId=\"Title\"><w:name w:val=\"Title\"/><w:basedOn w:val=\"Normal\"/><w:rPr><w:b/><w:sz w:val=\"44\"/></w:rPr></w:style><w:style w:type=\"paragraph\" w:styleId=\"Heading1\"><w:name w:val=\"heading 1\"/><w:basedOn w:val=\"Normal\"/><w:rPr><w:b/><w:sz w:val=\"32\"/></w:rPr></w:style><w:style w:type=\"paragraph\" w:styleId=\"Heading2\"><w:name w:val=\"heading 2\"/><w:basedOn w:val=\"Normal\"/><w:rPr><w:b/><w:sz w:val=\"28\"/></w:rPr></w:style><w:style w:type=\"paragraph\" w:styleId=\"Heading3\"><w:name w:val=\"heading 3\"/><w:basedOn w:val=\"Normal\"/><w:rPr><w:b/><w:sz w:val=\"24\"/></w:rPr></w:style><w:style w:type=\"paragraph\" w:styleId=\"Quote\"><w:name w:val=\"Quote\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:ind w:left=\"360\"/></w:pPr></w:style><w:style w:type=\"paragraph\" w:styleId=\"Code\"><w:name w:val=\"Code\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:ind w:left=\"360\"/></w:pPr></w:style></w:styles>";
    private static readonly DateTimeOffset FixedEntryTime = new(1980, 1, 1, 0, 0, 0, TimeSpan.Zero);

    // Line breaks are written as they are, so a parsed document holds the text it was given.
    private static readonly XmlWriterSettings XmlSettings = new()
    {
        Async = true,
        Encoding = new UTF8Encoding(false),
        NewLineHandling = NewLineHandling.None,
        CloseOutput = false,
    };

    private sealed record Paragraph(string Style = "", int Numbering = 0, int Level = 0, bool PageBreakBefore = false);

    private readonly record struct InlineStyle(bool Bold, bool Italic, bool Strike, bool Code, bool Underline, bool Highlight)
    {
        public static InlineStyle Of(Run run) => new(run.Has("bold"), run.Has("italic"), run.Has("strike"), run.Has("code"), run.Has("underline"), run.Has("highlight"));

        public bool Any => Bold || Italic || Strike || Code || Underline || Highlight;
    }

    /// <summary>What one export accumulates across records: the image counter and the image relationships.</summary>
    private sealed class Images
    {
        public int Count { get; set; }

        public List<(string Id, string Target)> Relationships { get; } = [];

        /// <summary>The current record's image files, added to the archive once its XML is flushed.</summary>
        public List<(string Name, byte[] Data)> Pending { get; } = [];
    }

    public static async Task WriteAsync(Stream output, IAsyncEnumerable<ExportRecord> records, StreamLimits limits, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(output);
        ArgumentNullException.ThrowIfNull(records);
        ArgumentNullException.ThrowIfNull(limits);
        using var limited = new LimitedStream(output, limits.MaxBytes);
        using var archive = new ZipArchive(limited, ZipArchiveMode.Create, leaveOpen: true);
        foreach (var (name, body) in new[] { ("[Content_Types].xml", Encoding.UTF8.GetBytes(ContentTypes)), ("_rels/.rels", Encoding.UTF8.GetBytes(RootRelationships)), ("word/styles.xml", Encoding.UTF8.GetBytes(Styles)), ("word/numbering.xml", Part(WriteNumbering)) })
        {
            await Entry(archive, name, body, limits, cancellationToken).ConfigureAwait(false);
        }
        var documentPath = Nix.Workers.Transfer.WorkSpool.Create(null, "nix-export-");
        var document = new FileStream(documentPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None, 64 * 1024, FileOptions.DeleteOnClose | FileOptions.Asynchronous);
        await using (document.ConfigureAwait(false))
        {
            var images = new Images();
            var xml = XmlWriter.Create(document, XmlSettings);
            await using (xml.ConfigureAwait(false))
            {
                var count = 0;
                OpenDocument(xml);
                await foreach (var record in records.WithCancellation(cancellationToken).ConfigureAwait(false))
                {
                    if (string.IsNullOrEmpty(record.Title))
                    {
                        throw new ArchiveFormatException("export record title is required");
                    }
                    count++;
                    if (count > limits.MaxRecords)
                    {
                        throw new StreamLimitException();
                    }
                    WriteRecord(xml, record, count, images);
                    await xml.FlushAsync().ConfigureAwait(false);
                    foreach (var (name, data) in images.Pending)
                    {
                        await AddEntryAsync(archive, "word/" + name, new MemoryStream(data, writable: false), cancellationToken).ConfigureAwait(false);
                    }
                    images.Pending.Clear();
                    if (document.Length > limits.MaxBytes)
                    {
                        throw new StreamLimitException();
                    }
                }
                if (count == 0)
                {
                    throw new ArchiveFormatException("cannot export an empty DOCX");
                }
                CloseDocument(xml);
                await xml.FlushAsync().ConfigureAwait(false);
            }
            document.Position = 0;
            await AddEntryAsync(archive, "word/document.xml", document, cancellationToken).ConfigureAwait(false);
            await Entry(archive, "word/_rels/document.xml.rels", Part(part => WriteRelationships(part, images.Relationships)), limits, cancellationToken).ConfigureAwait(false);
        }
    }

    // The XML is written into the writer's buffer and flushed to the spool file once per record.
    private static void OpenDocument(XmlWriter xml)
    {
        xml.WriteStartDocument(standalone: true);
        xml.WriteStartElement("w", "document", W);
        xml.WriteAttributeString("xmlns", "w", null, W);
        xml.WriteAttributeString("xmlns", "r", null, R);
        xml.WriteAttributeString("xmlns", "wp", null, Wp);
        xml.WriteAttributeString("xmlns", "a", null, A);
        xml.WriteAttributeString("xmlns", "pic", null, Pic);
        xml.WriteStartElement("w", "body", W);
    }

    private static void CloseDocument(XmlWriter xml)
    {
        Empty(xml, "sectPr");
        xml.WriteEndDocument();
    }

    private static void WriteRecord(XmlWriter xml, ExportRecord record, int count, Images images)
    {
        var (title, _) = TextRules.ProjectTitle(record.Title);
        WriteParagraph(xml, [new Run { Text = title }], new Paragraph("Title", PageBreakBefore: count > 1));
        WriteBlocks(xml, record, record.Blocks, new Paragraph(), (raster, alt) =>
        {
            images.Count++;
            var name = $"media/image{Invariant(images.Count)}.{raster.Format}";
            var relationship = $"rImage{Invariant(images.Count)}";
            images.Relationships.Add((relationship, name));
            images.Pending.Add((name, raster.Data));
            WriteImage(xml, raster, alt, relationship, images.Count);
        });
    }

    // Own method per zip entry: CA2000's disposal dataflow is quadratic in the size of the method it analyses.
    private static async Task AddEntryAsync(ZipArchive archive, string name, Stream source, CancellationToken cancellationToken)
    {
        var entry = archive.CreateEntry(name, CompressionLevel.Optimal);
        entry.LastWriteTime = FixedEntryTime;
        var target = await entry.OpenAsync(cancellationToken).ConfigureAwait(false);
        await using (target.ConfigureAwait(false))
        {
            await source.CopyToAsync(target, cancellationToken).ConfigureAwait(false);
        }
    }

    private static async Task Entry(ZipArchive archive, string name, byte[] body, StreamLimits limits, CancellationToken cancellationToken)
    {
        if (body.Length > limits.MaxLine)
        {
            throw new StreamLimitException();
        }
        await ArchiveWriter.WriteEntryAsync(archive, name, body, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>A small part written whole into memory.</summary>
    private static byte[] Part(Action<XmlWriter> write)
    {
        using var buffer = new MemoryStream();
        using (var xml = XmlWriter.Create(buffer, new XmlWriterSettings { Encoding = new UTF8Encoding(false), NewLineHandling = NewLineHandling.None }))
        {
            xml.WriteStartDocument(standalone: true);
            write(xml);
            xml.WriteEndDocument();
        }
        return buffer.ToArray();
    }

    private static void WriteRelationships(XmlWriter xml, List<(string Id, string Target)> images)
    {
        xml.WriteStartElement("Relationships", PackageRelationships);
        foreach (var (id, kind, target) in (IEnumerable<(string, string, string)>)[("rId1", "styles", "styles.xml"), ("rId2", "numbering", "numbering.xml"), .. images.Select(image => (image.Id, "image", image.Target))])
        {
            xml.WriteStartElement("Relationship", PackageRelationships);
            xml.WriteAttributeString("Id", id);
            xml.WriteAttributeString("Type", R + "/" + kind);
            xml.WriteAttributeString("Target", target);
            xml.WriteEndElement();
        }
        xml.WriteEndElement();
    }

    private static void WriteNumbering(XmlWriter xml)
    {
        xml.WriteStartElement("w", "numbering", W);
        for (var abstractId = 1; abstractId <= 2; abstractId++)
        {
            xml.WriteStartElement("w", "abstractNum", W);
            xml.WriteAttributeString("w", "abstractNumId", W, Invariant(abstractId));
            Value(xml, "multiLevelType", "multilevel");
            for (var level = 0; level <= 8; level++)
            {
                xml.WriteStartElement("w", "lvl", W);
                xml.WriteAttributeString("w", "ilvl", W, Invariant(level));
                Value(xml, "start", "1");
                Value(xml, "numFmt", abstractId == 2 ? "decimal" : "bullet");
                Value(xml, "lvlText", abstractId == 2 ? "%" + Invariant(level + 1) + "." : "-");
                xml.WriteStartElement("w", "pPr", W);
                xml.WriteStartElement("w", "ind", W);
                xml.WriteAttributeString("w", "left", W, Invariant((level + 1) * 360));
                xml.WriteAttributeString("w", "hanging", W, "260");
                xml.WriteEndElement();
                xml.WriteEndElement();
                xml.WriteEndElement();
            }
            xml.WriteEndElement();
        }
        for (var id = 1; id <= 2; id++)
        {
            xml.WriteStartElement("w", "num", W);
            xml.WriteAttributeString("w", "numId", W, Invariant(id));
            Value(xml, "abstractNumId", Invariant(id));
            xml.WriteEndElement();
        }
        xml.WriteEndElement();
    }

    /// <summary>An empty WordprocessingML element.</summary>
    private static void Empty(XmlWriter xml, string name)
    {
        xml.WriteStartElement("w", name, W);
        xml.WriteEndElement();
    }

    /// <summary>A WordprocessingML element whose one attribute is <c>w:val</c>.</summary>
    private static void Value(XmlWriter xml, string name, string value)
    {
        xml.WriteStartElement("w", name, W);
        xml.WriteAttributeString("w", "val", W, value);
        xml.WriteEndElement();
    }

    private static void WriteParagraph(XmlWriter xml, IList<Run> runs, Paragraph options)
    {
        xml.WriteStartElement("w", "p", W);
        if (options.Style.Length > 0 || options.Numbering != 0 || options.PageBreakBefore)
        {
            xml.WriteStartElement("w", "pPr", W);
            if (options.Style.Length > 0)
            {
                Value(xml, "pStyle", options.Style);
            }
            if (options.Numbering != 0)
            {
                xml.WriteStartElement("w", "numPr", W);
                Value(xml, "ilvl", Invariant(Math.Min(Math.Max(options.Level, 0), 8)));
                Value(xml, "numId", Invariant(options.Numbering));
                xml.WriteEndElement();
            }
            if (options.PageBreakBefore)
            {
                Empty(xml, "pageBreakBefore");
            }
            xml.WriteEndElement();
        }
        WriteRuns(xml, runs);
        xml.WriteEndElement();
    }

    private static void WriteRun(XmlWriter xml, string value, InlineStyle style)
    {
        value = TextRules.Sanitize(value);
        if (value.Length == 0)
        {
            return;
        }
        xml.WriteStartElement("w", "r", W);
        if (style.Any)
        {
            xml.WriteStartElement("w", "rPr", W);
            if (style.Bold)
            {
                Empty(xml, "b");
            }
            if (style.Italic)
            {
                Empty(xml, "i");
            }
            if (style.Strike)
            {
                Empty(xml, "strike");
            }
            if (style.Underline)
            {
                Value(xml, "u", "single");
            }
            if (style.Highlight)
            {
                Value(xml, "highlight", "yellow");
            }
            if (style.Code)
            {
                xml.WriteStartElement("w", "shd", W);
                xml.WriteAttributeString("w", "val", W, "clear");
                xml.WriteAttributeString("w", "fill", W, "EDEDED");
                xml.WriteEndElement();
            }
            xml.WriteEndElement();
        }
        xml.WriteStartElement("w", "t", W);
        xml.WriteAttributeString("xml", "space", null, "preserve");
        xml.WriteString(value);
        xml.WriteEndElement();
        xml.WriteEndElement();
    }

    private static void WriteLink(XmlWriter xml, string label, string target, InlineStyle style)
    {
        if (!TextRules.SafeDocumentLink(target))
        {
            WriteRun(xml, label, style);
            return;
        }
        xml.WriteStartElement("w", "fldSimple", W);
        xml.WriteAttributeString("w", "instr", W, TextRules.Sanitize(" HYPERLINK \"" + target + "\" "));
        WriteRun(xml, label, style);
        xml.WriteEndElement();
    }

    private static void WriteImage(XmlWriter xml, ExportImage raster, string alt, string relationship, int id)
    {
        var (width, height) = ImageFiles.Size(raster, 468, 648);
        var cx = Invariant((long)(width * 12700));
        var cy = Invariant((long)(height * 12700));
        var n = Invariant(id);
        xml.WriteStartElement("w", "p", W);
        xml.WriteStartElement("w", "r", W);
        xml.WriteStartElement("w", "drawing", W);
        xml.WriteStartElement("wp", "inline", Wp);
        xml.WriteStartElement("wp", "extent", Wp);
        xml.WriteAttributeString("cx", cx);
        xml.WriteAttributeString("cy", cy);
        xml.WriteEndElement();
        xml.WriteStartElement("wp", "docPr", Wp);
        xml.WriteAttributeString("id", n);
        xml.WriteAttributeString("name", "Image " + n);
        xml.WriteAttributeString("descr", TextRules.Sanitize(alt));
        xml.WriteEndElement();
        xml.WriteStartElement("a", "graphic", A);
        xml.WriteStartElement("a", "graphicData", A);
        xml.WriteAttributeString("uri", Pic);
        xml.WriteStartElement("pic", "pic", Pic);
        xml.WriteStartElement("pic", "nvPicPr", Pic);
        xml.WriteStartElement("pic", "cNvPr", Pic);
        xml.WriteAttributeString("id", n);
        xml.WriteAttributeString("name", "Image " + n);
        xml.WriteEndElement();
        xml.WriteStartElement("pic", "cNvPicPr", Pic);
        xml.WriteEndElement();
        xml.WriteEndElement();
        xml.WriteStartElement("pic", "blipFill", Pic);
        xml.WriteStartElement("a", "blip", A);
        xml.WriteAttributeString("r", "embed", R, relationship);
        xml.WriteEndElement();
        xml.WriteStartElement("a", "stretch", A);
        xml.WriteStartElement("a", "fillRect", A);
        xml.WriteEndElement();
        xml.WriteEndElement();
        xml.WriteEndElement();
        xml.WriteStartElement("pic", "spPr", Pic);
        xml.WriteStartElement("a", "xfrm", A);
        xml.WriteStartElement("a", "off", A);
        xml.WriteAttributeString("x", "0");
        xml.WriteAttributeString("y", "0");
        xml.WriteEndElement();
        xml.WriteStartElement("a", "ext", A);
        xml.WriteAttributeString("cx", cx);
        xml.WriteAttributeString("cy", cy);
        xml.WriteEndElement();
        xml.WriteEndElement();
        xml.WriteStartElement("a", "prstGeom", A);
        xml.WriteAttributeString("prst", "rect");
        xml.WriteStartElement("a", "avLst", A);
        xml.WriteEndElement();
        xml.WriteEndElement();
        xml.WriteEndElement();
        xml.WriteEndElement(); // pic:pic
        xml.WriteEndElement(); // a:graphicData
        xml.WriteEndElement(); // a:graphic
        xml.WriteEndElement(); // wp:inline
        xml.WriteEndElement(); // w:drawing
        xml.WriteEndElement(); // w:r
        xml.WriteEndElement(); // w:p
    }

    private static void WriteRuns(XmlWriter xml, IList<Run> runs)
    {
        foreach (var run in runs)
        {
            if (run.Text == "\n")
            {
                xml.WriteStartElement("w", "r", W);
                Empty(xml, "br");
                xml.WriteEndElement();
                continue;
            }
            if (!string.IsNullOrEmpty(run.Href))
            {
                WriteLink(xml, run.Text, run.Href, InlineStyle.Of(run));
                continue;
            }
            WriteRun(xml, run.Text, InlineStyle.Of(run));
        }
    }

    // Walks a render tree. `inherited` carries list numbering and depth into nested blocks: OOXML
    // lists are flat paragraphs with a level, so the nesting is a number here rather than a structure.
    private static void WriteBlocks(XmlWriter xml, ExportRecord record, IList<Block> blocks, Paragraph inherited, Action<ExportImage, string> embed)
    {
        foreach (var block in blocks)
        {
            WriteBlock(xml, record, block, inherited, embed);
        }
    }

    private static void WriteBlock(XmlWriter xml, ExportRecord record, Block block, Paragraph inherited, Action<ExportImage, string> embed)
    {
        switch (block.Kind)
        {
            case "heading":
                WriteParagraph(xml, block.RunsOrEmpty, inherited with { Style = "Heading" + Invariant(Math.Min(Math.Max(block.Level, 1), 3)) });
                break;
            case "quote":
            case "callout":
                var quote = inherited with { Style = "Quote" };
                if (block.Kind == "callout" && !string.IsNullOrEmpty(block.Tone))
                {
                    WriteParagraph(xml, [new Run { Text = block.Tone, Styles = ["bold"] }], quote);
                }
                WriteBlocks(xml, record, block.BlocksOrEmpty, quote, embed);
                break;
            case "code":
                if (record.Image(block.Src) is { } diagram)
                {
                    embed(diagram, "Diagram");
                    break;
                }
                foreach (var line in (block.Text ?? string.Empty).Split('\n'))
                {
                    WriteParagraph(xml, [new Run { Text = line }], inherited with { Style = "Code" });
                }
                break;
            case "rule":
                WriteParagraph(xml, [], new Paragraph());
                break;
            case "pageBreak":
                xml.WriteStartElement("w", "p", W);
                xml.WriteStartElement("w", "r", W);
                xml.WriteStartElement("w", "br", W);
                xml.WriteAttributeString("w", "type", W, "page");
                xml.WriteEndElement();
                xml.WriteEndElement();
                xml.WriteEndElement();
                break;
            case "image":
                if (record.Image(block.Src) is { } raster)
                {
                    embed(raster, block.Alt ?? string.Empty);
                    break;
                }
                WriteParagraph(xml, [new Run { Text = "Image: " + (block.Alt ?? string.Empty), Href = block.Src }], inherited);
                break;
            case "list":
                WriteList(xml, record, block, inherited, embed);
                break;
            case "table":
                WriteTable(xml, block.RowsOrEmpty);
                break;
            case "details":
                WriteParagraph(xml, block.SummaryOrEmpty, new Paragraph("Heading3"));
                WriteBlocks(xml, record, block.BlocksOrEmpty, inherited, embed);
                break;
            default: // paragraph, and any kind this build does not know but whose runs it can keep.
                WriteParagraph(xml, block.RunsOrEmpty, inherited);
                break;
        }
    }

    private static void WriteList(XmlWriter xml, ExportRecord record, Block block, Paragraph inherited, Action<ExportImage, string> embed)
    {
        var numbering = block.Ordered ? 2 : 1;
        var level = inherited.Numbering != 0 ? inherited.Level + 1 : 0;
        foreach (var item in block.ItemsOrEmpty)
        {
            var itemBlocks = item.Blocks;
            if (item.Checked is { } check && itemBlocks.Count > 0 && itemBlocks[0].Kind == "paragraph")
            {
                var first = itemBlocks[0];
                var marked = new Block { Kind = first.Kind, Level = first.Level, Align = first.Align, Runs = [new Run { Text = check ? "☑ " : "☐ " }, .. first.RunsOrEmpty] };
                itemBlocks = [marked, .. itemBlocks.Skip(1)];
            }
            WriteBlocks(xml, record, itemBlocks, new Paragraph(Numbering: numbering, Level: level), embed);
        }
    }

    private static void WriteTable(XmlWriter xml, IList<Row> rows)
    {
        xml.WriteStartElement("w", "tbl", W);
        xml.WriteStartElement("w", "tblPr", W);
        xml.WriteStartElement("w", "tblW", W);
        xml.WriteAttributeString("w", "w", W, "0");
        xml.WriteAttributeString("w", "type", W, "auto");
        xml.WriteEndElement();
        xml.WriteEndElement();
        foreach (var row in rows)
        {
            xml.WriteStartElement("w", "tr", W);
            foreach (var cell in row.Cells)
            {
                xml.WriteStartElement("w", "tc", W);
                IList<Run> runs = row.Header
                    ? [.. cell.Select(run => new Run { Text = run.Text, Href = run.Href, Styles = [.. run.Styles ?? [], "bold"] })]
                    : cell;
                WriteParagraph(xml, runs, new Paragraph());
                xml.WriteEndElement();
            }
            xml.WriteEndElement();
        }
        xml.WriteEndElement();
    }

    private static string Invariant(long value) => value.ToString(CultureInfo.InvariantCulture);
}
