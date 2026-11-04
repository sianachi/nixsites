using System.Globalization;
using System.IO.Compression;
using System.Text;
using Nix.Workers.Archive;
using Nix.Workers.Render;

namespace Nix.Workers.Export;

/// <summary>
/// Writes a DOCX by hand, as the Go worker did: WordprocessingML parts in a zip, one Title
/// paragraph per note, lists as flat numbered paragraphs, images as inline drawings. The XML is
/// byte-identical to the Go output so the parity goldens compare entry by entry.
/// </summary>
public static class DocxWriter
{
    private const string ContentTypes = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Default Extension=\"png\" ContentType=\"image/png\"/><Default Extension=\"jpeg\" ContentType=\"image/jpeg\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/><Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/><Override PartName=\"/word/numbering.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml\"/></Types>";
    private const string RootRelationships = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>";
    private const string DocumentRelationships = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering\" Target=\"numbering.xml\"/></Relationships>";
    private const string Styles = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/></w:style><w:style w:type=\"paragraph\" w:styleId=\"Title\"><w:name w:val=\"Title\"/><w:basedOn w:val=\"Normal\"/><w:rPr><w:b/><w:sz w:val=\"44\"/></w:rPr></w:style><w:style w:type=\"paragraph\" w:styleId=\"Heading1\"><w:name w:val=\"heading 1\"/><w:basedOn w:val=\"Normal\"/><w:rPr><w:b/><w:sz w:val=\"32\"/></w:rPr></w:style><w:style w:type=\"paragraph\" w:styleId=\"Heading2\"><w:name w:val=\"heading 2\"/><w:basedOn w:val=\"Normal\"/><w:rPr><w:b/><w:sz w:val=\"28\"/></w:rPr></w:style><w:style w:type=\"paragraph\" w:styleId=\"Heading3\"><w:name w:val=\"heading 3\"/><w:basedOn w:val=\"Normal\"/><w:rPr><w:b/><w:sz w:val=\"24\"/></w:rPr></w:style><w:style w:type=\"paragraph\" w:styleId=\"Quote\"><w:name w:val=\"Quote\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:ind w:left=\"360\"/></w:pPr></w:style><w:style w:type=\"paragraph\" w:styleId=\"Code\"><w:name w:val=\"Code\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:ind w:left=\"360\"/></w:pPr></w:style></w:styles>";
    private const string DocumentOpen = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><w:body>";
    private static readonly DateTimeOffset FixedEntryTime = new(1980, 1, 1, 0, 0, 0, TimeSpan.Zero);

    private sealed record Paragraph(string Style = "", int Numbering = 0, int Level = 0, bool PageBreakBefore = false);

    private readonly record struct InlineStyle(bool Bold, bool Italic, bool Strike, bool Code, bool Underline, bool Highlight)
    {
        public static InlineStyle Of(Run run) => new(run.Has("bold"), run.Has("italic"), run.Has("strike"), run.Has("code"), run.Has("underline"), run.Has("highlight"));

        public bool Any => Bold || Italic || Strike || Code || Underline || Highlight;
    }

    public static async Task WriteAsync(Stream output, IAsyncEnumerable<ExportRecord> records, StreamLimits limits, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(output);
        ArgumentNullException.ThrowIfNull(records);
        ArgumentNullException.ThrowIfNull(limits);
        using var limited = new LimitedStream(output, limits.MaxBytes);
        using var archive = new ZipArchive(limited, ZipArchiveMode.Create, leaveOpen: true);
        foreach (var (name, body) in new[] { ("[Content_Types].xml", ContentTypes), ("_rels/.rels", RootRelationships), ("word/styles.xml", Styles), ("word/numbering.xml", NumberingXml()) })
        {
            await Entry(archive, name, body, limits, cancellationToken).ConfigureAwait(false);
        }
        var documentPath = Nix.Workers.Transfer.WorkSpool.Create(null, "nix-export-");
        var document = new FileStream(documentPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None, 64 * 1024, FileOptions.DeleteOnClose | FileOptions.Asynchronous);
        await using (document.ConfigureAwait(false))
        {
            var writer = new StreamWriter(document, new UTF8Encoding(false), 64 * 1024, leaveOpen: true);
            await using (writer.ConfigureAwait(false))
            {
                var state = new RelationshipState();
                var count = 0;
                await writer.WriteAsync(DocumentOpen).ConfigureAwait(false);
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
                    await WriteRecordAsync(writer, archive, record, count, state, cancellationToken).ConfigureAwait(false);
                    await writer.FlushAsync(cancellationToken).ConfigureAwait(false);
                    if (document.Length > limits.MaxBytes)
                    {
                        throw new StreamLimitException();
                    }
                }
                if (count == 0)
                {
                    throw new ArchiveFormatException("cannot export an empty DOCX");
                }
                await writer.WriteAsync("<w:sectPr/></w:body></w:document>").ConfigureAwait(false);
                await writer.FlushAsync(cancellationToken).ConfigureAwait(false);
                document.Position = 0;
                await AddEntryAsync(archive, "word/document.xml", document, cancellationToken).ConfigureAwait(false);
                await Entry(archive, "word/_rels/document.xml.rels", state.Relationships.Append("</Relationships>").ToString(), limits, cancellationToken).ConfigureAwait(false);
            }
        }
    }

    private sealed class RelationshipState
    {
        public int ImageId { get; set; }

        public StringBuilder Relationships { get; } = new(DocumentRelationships[..^"</Relationships>".Length]);
    }

    private static async Task WriteRecordAsync(StreamWriter writer, ZipArchive archive, ExportRecord record, int count, RelationshipState state, CancellationToken cancellationToken)
    {
        var media = new List<(string Name, byte[] Data)>();
        var (title, _) = TextRules.ProjectTitle(record.Title);
        await WriteParagraphAsync(writer, [new Run { Text = title }], new Paragraph("Title", PageBreakBefore: count > 1)).ConfigureAwait(false);
        await WriteBlocksAsync(writer, record, record.Blocks, new Paragraph(), async (raster, alt) =>
        {
            state.ImageId++;
            var name = $"media/image{Invariant(state.ImageId)}.{raster.Format}";
            var rel = $"rImage{Invariant(state.ImageId)}";
            state.Relationships.Append("<Relationship Id=\"").Append(rel).Append("\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"").Append(name).Append("\"/>");
            media.Add((name, raster.Data));
            await WriteImageAsync(writer, raster, alt, rel, state.ImageId).ConfigureAwait(false);
        }).ConfigureAwait(false);
        foreach (var (name, data) in media)
        {
            await AddEntryAsync(archive, "word/" + name, new MemoryStream(data, writable: false), cancellationToken).ConfigureAwait(false);
        }
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

    private static async Task Entry(ZipArchive archive, string name, string text, StreamLimits limits, CancellationToken cancellationToken)
    {
        var body = Encoding.UTF8.GetBytes(text);
        if (body.Length > limits.MaxLine)
        {
            throw new StreamLimitException();
        }
        await ArchiveWriter.WriteEntryAsync(archive, name, body, cancellationToken).ConfigureAwait(false);
    }

    public static string NumberingXml()
    {
        var output = new StringBuilder("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:numbering xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">");
        for (var abstractId = 1; abstractId <= 2; abstractId++)
        {
            output.Append("<w:abstractNum w:abstractNumId=\"").Append(Invariant(abstractId)).Append("\"><w:multiLevelType w:val=\"multilevel\"/>");
            for (var level = 0; level <= 8; level++)
            {
                var format = abstractId == 2 ? "decimal" : "bullet";
                var marker = abstractId == 2 ? "%" + Invariant(level + 1) + "." : "-";
                output.Append("<w:lvl w:ilvl=\"").Append(Invariant(level)).Append("\"><w:start w:val=\"1\"/><w:numFmt w:val=\"").Append(format).Append("\"/><w:lvlText w:val=\"").Append(marker).Append("\"/><w:pPr><w:ind w:left=\"").Append(Invariant((level + 1) * 360)).Append("\" w:hanging=\"260\"/></w:pPr></w:lvl>");
            }
            output.Append("</w:abstractNum>");
        }
        output.Append("<w:num w:numId=\"1\"><w:abstractNumId w:val=\"1\"/></w:num><w:num w:numId=\"2\"><w:abstractNumId w:val=\"2\"/></w:num></w:numbering>");
        return output.ToString();
    }

    private static async Task WriteParagraphAsync(TextWriter output, IList<Run> runs, Paragraph options)
    {
        await output.WriteAsync("<w:p>").ConfigureAwait(false);
        if (options.Style.Length > 0 || options.Numbering != 0 || options.PageBreakBefore)
        {
            await output.WriteAsync("<w:pPr>").ConfigureAwait(false);
            if (options.Style.Length > 0)
            {
                await output.WriteAsync("<w:pStyle w:val=\"" + TextRules.EscapeXml(options.Style) + "\"/>").ConfigureAwait(false);
            }
            if (options.Numbering != 0)
            {
                var level = Math.Min(Math.Max(options.Level, 0), 8);
                await output.WriteAsync("<w:numPr><w:ilvl w:val=\"" + Invariant(level) + "\"/><w:numId w:val=\"" + Invariant(options.Numbering) + "\"/></w:numPr>").ConfigureAwait(false);
            }
            if (options.PageBreakBefore)
            {
                await output.WriteAsync("<w:pageBreakBefore/>").ConfigureAwait(false);
            }
            await output.WriteAsync("</w:pPr>").ConfigureAwait(false);
        }
        await WriteRunsAsync(output, runs).ConfigureAwait(false);
        await output.WriteAsync("</w:p>").ConfigureAwait(false);
    }

    private static async Task WriteRunAsync(TextWriter output, string value, InlineStyle style)
    {
        value = TextRules.Sanitize(value);
        if (value.Length == 0)
        {
            return;
        }
        await output.WriteAsync("<w:r>").ConfigureAwait(false);
        if (style.Any)
        {
            var properties = new StringBuilder("<w:rPr>");
            if (style.Bold)
            {
                properties.Append("<w:b/>");
            }
            if (style.Italic)
            {
                properties.Append("<w:i/>");
            }
            if (style.Strike)
            {
                properties.Append("<w:strike/>");
            }
            if (style.Underline)
            {
                properties.Append("<w:u w:val=\"single\"/>");
            }
            if (style.Highlight)
            {
                properties.Append("<w:highlight w:val=\"yellow\"/>");
            }
            if (style.Code)
            {
                properties.Append("<w:shd w:val=\"clear\" w:fill=\"EDEDED\"/>");
            }
            await output.WriteAsync(properties.Append("</w:rPr>").ToString()).ConfigureAwait(false);
        }
        await output.WriteAsync("<w:t xml:space=\"preserve\">" + TextRules.EscapeXml(value) + "</w:t></w:r>").ConfigureAwait(false);
    }

    private static async Task WriteLinkAsync(TextWriter output, string label, string target, InlineStyle style)
    {
        if (!TextRules.SafeDocumentLink(target))
        {
            await WriteRunAsync(output, label, style).ConfigureAwait(false);
            return;
        }
        var instruction = TextRules.EscapeXml(" HYPERLINK \"" + target + "\" ");
        await output.WriteAsync("<w:fldSimple w:instr=\"" + instruction + "\">").ConfigureAwait(false);
        await WriteRunAsync(output, label, style).ConfigureAwait(false);
        await output.WriteAsync("</w:fldSimple>").ConfigureAwait(false);
    }

    private static async Task WriteImageAsync(TextWriter output, ExportImage raster, string alt, string rel, int id)
    {
        var (width, height) = ImageFiles.Size(raster, 468, 648);
        var cx = (long)(width * 12700);
        var cy = (long)(height * 12700);
        var n = Invariant(id);
        await output.WriteAsync(
            "<w:p><w:r><w:drawing><wp:inline><wp:extent cx=\"" + Invariant(cx) + "\" cy=\"" + Invariant(cy) + "\"/><wp:docPr id=\"" + n + "\" name=\"Image " + n + "\" descr=\"" + TextRules.EscapeXml(alt) + "\"/><a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><pic:pic><pic:nvPicPr><pic:cNvPr id=\"" + n + "\" name=\"Image " + n + "\"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed=\"" + rel + "\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"" + Invariant(cx) + "\" cy=\"" + Invariant(cy) + "\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>").ConfigureAwait(false);
    }

    private static async Task WriteRunsAsync(TextWriter output, IList<Run> runs)
    {
        foreach (var run in runs)
        {
            if (run.Text == "\n")
            {
                await output.WriteAsync("<w:r><w:br/></w:r>").ConfigureAwait(false);
                continue;
            }
            if (!string.IsNullOrEmpty(run.Href))
            {
                await WriteLinkAsync(output, run.Text, run.Href, InlineStyle.Of(run)).ConfigureAwait(false);
                continue;
            }
            await WriteRunAsync(output, run.Text, InlineStyle.Of(run)).ConfigureAwait(false);
        }
    }

    // Walks a render tree. `inherited` carries list numbering and depth into nested blocks: OOXML
    // lists are flat paragraphs with a level, so the nesting is a number here rather than a structure.
    // One small method per kind: CA2000's flow analysis blows up on a single big async switch.
    private static async Task WriteBlocksAsync(TextWriter output, ExportRecord record, IList<Block> blocks, Paragraph inherited, Func<ExportImage, string, Task> embed)
    {
        foreach (var block in blocks)
        {
            await WriteBlockAsync(output, record, block, inherited, embed).ConfigureAwait(false);
        }
    }

    private static async Task WriteBlockAsync(TextWriter output, ExportRecord record, Block block, Paragraph inherited, Func<ExportImage, string, Task> embed)
    {
        switch (block.Kind)
        {
            case "heading":
                await WriteParagraphAsync(output, block.RunsOrEmpty, inherited with { Style = "Heading" + Invariant(Math.Min(Math.Max(block.Level, 1), 3)) }).ConfigureAwait(false);
                break;
            case "quote":
            case "callout":
                await WriteQuoteAsync(output, record, block, inherited, embed).ConfigureAwait(false);
                break;
            case "code":
                await WriteCodeAsync(output, record, block, inherited, embed).ConfigureAwait(false);
                break;
            case "rule":
                await WriteParagraphAsync(output, [], new Paragraph()).ConfigureAwait(false);
                break;
            case "pageBreak":
                await output.WriteAsync("<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>").ConfigureAwait(false);
                break;
            case "image":
                if (record.Image(block.Src) is { } raster)
                {
                    await embed(raster, block.Alt ?? string.Empty).ConfigureAwait(false);
                    break;
                }
                await WriteParagraphAsync(output, [new Run { Text = "Image: " + (block.Alt ?? string.Empty), Href = block.Src }], inherited).ConfigureAwait(false);
                break;
            case "list":
                await WriteListAsync(output, record, block, inherited, embed).ConfigureAwait(false);
                break;
            case "table":
                await WriteTableAsync(output, block.RowsOrEmpty).ConfigureAwait(false);
                break;
            case "details":
                await WriteParagraphAsync(output, block.SummaryOrEmpty, new Paragraph("Heading3")).ConfigureAwait(false);
                await WriteBlocksAsync(output, record, block.BlocksOrEmpty, inherited, embed).ConfigureAwait(false);
                break;
            default: // paragraph, and any kind this build does not know but whose runs it can keep.
                await WriteParagraphAsync(output, block.RunsOrEmpty, inherited).ConfigureAwait(false);
                break;
        }
    }

    private static async Task WriteQuoteAsync(TextWriter output, ExportRecord record, Block block, Paragraph inherited, Func<ExportImage, string, Task> embed)
    {
        var paragraph = inherited with { Style = "Quote" };
        if (block.Kind == "callout" && !string.IsNullOrEmpty(block.Tone))
        {
            await WriteParagraphAsync(output, [new Run { Text = block.Tone, Styles = ["bold"] }], paragraph).ConfigureAwait(false);
        }
        await WriteBlocksAsync(output, record, block.BlocksOrEmpty, paragraph, embed).ConfigureAwait(false);
    }

    private static async Task WriteCodeAsync(TextWriter output, ExportRecord record, Block block, Paragraph inherited, Func<ExportImage, string, Task> embed)
    {
        if (record.Image(block.Src) is { } diagram)
        {
            await embed(diagram, "Diagram").ConfigureAwait(false);
            return;
        }
        var paragraph = inherited with { Style = "Code" };
        foreach (var line in (block.Text ?? string.Empty).Split('\n'))
        {
            await WriteParagraphAsync(output, [new Run { Text = line }], paragraph).ConfigureAwait(false);
        }
    }

    private static async Task WriteListAsync(TextWriter output, ExportRecord record, Block block, Paragraph inherited, Func<ExportImage, string, Task> embed)
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
            await WriteBlocksAsync(output, record, itemBlocks, new Paragraph(Numbering: numbering, Level: level), embed).ConfigureAwait(false);
        }
    }

    private static async Task WriteTableAsync(TextWriter output, IList<Row> rows)
    {
        await output.WriteAsync("<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/></w:tblPr>").ConfigureAwait(false);
        foreach (var row in rows)
        {
            await output.WriteAsync("<w:tr>").ConfigureAwait(false);
            foreach (var cell in row.Cells)
            {
                await output.WriteAsync("<w:tc>").ConfigureAwait(false);
                IList<Run> runs = row.Header
                    ? [.. cell.Select(run => new Run { Text = run.Text, Href = run.Href, Styles = [.. run.Styles ?? [], "bold"] })]
                    : cell;
                await WriteParagraphAsync(output, runs, new Paragraph()).ConfigureAwait(false);
                await output.WriteAsync("</w:tc>").ConfigureAwait(false);
            }
            await output.WriteAsync("</w:tr>").ConfigureAwait(false);
        }
        await output.WriteAsync("</w:tbl>").ConfigureAwait(false);
    }

    private static string Invariant(long value) => value.ToString(CultureInfo.InvariantCulture);
}
