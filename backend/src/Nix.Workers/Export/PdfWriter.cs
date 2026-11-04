using System.Globalization;
using System.Text;
using Nix.Workers.Archive;
using Nix.Workers.Render;
using PdfSharp.Drawing;
using PdfSharp.Fonts;
using PdfSharp.Pdf;
using PdfSharp.Pdf.IO;

namespace Nix.Workers.Export;

/// <summary>
/// Draws records as a PDF with the same layout rules the Go worker's fpdf renderer used: A4 or
/// Letter, 50 pt margins, Go fonts at the same sizes and 1.45 line height, a page number footer,
/// at most 1000 pages. The library differs, so bytes differ; the text, its order and the page
/// count are what parity compares.
/// </summary>
public static class PdfWriter
{
    private const double Margin = 50.0;
    private const int MaximumPages = 1000;

    private static readonly Lazy<bool> FontsRegistered = new(() =>
    {
        GlobalFontSettings.FontResolver ??= new GoFontResolver();
        return true;
    });

    /// <summary>Replaces every rune Go Regular has no glyph for with "?", keeping line breaks and tabs.</summary>
    public static string PdfText(string value)
    {
        var sanitized = TextRules.Sanitize(value);
        var output = new StringBuilder(sanitized.Length);
        foreach (var rune in sanitized.EnumerateRunes())
        {
            output.Append(rune.Value is '\n' or '\t' || GoFonts.HasGlyph(rune.Value) ? rune.ToString() : "?");
        }
        return output.ToString();
    }

    public static async Task WriteAsync(Stream output, IAsyncEnumerable<ExportRecord> records, StreamLimits limits, string pageSize, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(output);
        ArgumentNullException.ThrowIfNull(records);
        ArgumentNullException.ThrowIfNull(limits);
        _ = FontsRegistered.Value;
        using var document = new PdfDocument();
        document.Info.CreationDate = DateTime.UnixEpoch;
        document.Info.ModificationDate = DateTime.UnixEpoch;
        var page = new Page(document, pageSize == "letter" ? PdfSharp.PageSize.Letter : PdfSharp.PageSize.A4);
        // The PDF library retains pages and rasters until it writes; bound cumulative input too.
        var count = 0;
        var remaining = Math.Min(limits.MaxBytes, 32L << 20);
        await foreach (var record in records.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            count++;
            if (count > limits.MaxRecords)
            {
                throw new StreamLimitException();
            }
            if (string.IsNullOrEmpty(record.Title))
            {
                throw new ArchiveFormatException("export record title is required");
            }
            remaining -= record.Title.Length;
            RenderTree.Walk(record.Blocks, block => remaining -= RenderTree.Plain(block.Runs).Length + (block.Text?.Length ?? 0));
            foreach (var raster in record.Images)
            {
                remaining -= raster.Data.Length;
            }
            if (remaining < 0)
            {
                throw new StreamLimitException();
            }
            page.AddPage();
            var (title, _) = TextRules.ProjectTitle(record.Title);
            page.Title(PdfText(title));
            page.Blocks(record, record.Blocks, 0, count);
        }
        if (count == 0)
        {
            throw new ArchiveFormatException("cannot export an empty PDF");
        }
        page.Finish();
        using var buffer = new MemoryStream();
        await document.SaveAsync(buffer, closeStream: false).ConfigureAwait(false);
        if (buffer.Length > limits.MaxBytes)
        {
            throw new StreamLimitException();
        }
        buffer.Position = 0;
        await buffer.CopyToAsync(output, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>The cursor-driven page layout, the shape fpdf gave the Go renderer.</summary>
    private sealed class Page(PdfDocument document, PdfSharp.PageSize size)
    {
        private PdfPage? current;
        private XGraphics? graphics;
        private double y;
        private double x;

        private double Width => current!.Width.Point;

        private double Height => current!.Height.Point;

        private double ContentWidth => Width - 2 * Margin;

        private double Bottom => Height - Margin;

        public void AddPage()
        {
            if (document.PageCount >= MaximumPages)
            {
                throw new StreamLimitException();
            }
            graphics?.Dispose();
            current = document.AddPage();
            current.Size = size;
            graphics = XGraphics.FromPdfPage(current);
            y = Margin;
            x = Margin;
            // Footer: the page number, centred, 32 pt from the bottom in 9 pt grey, as fpdf drew it.
            var footer = new XFont(GoFonts.Family, 9);
            graphics.DrawString(document.PageCount.ToString(CultureInfo.InvariantCulture), footer, new XSolidBrush(XColor.FromArgb(100, 100, 100)),
                new XRect(Margin, Height - 32, ContentWidth, 12), XStringFormats.Center);
        }

        public void Finish() => graphics?.Dispose();

        private void Space(double height)
        {
            if (y + height > Bottom)
            {
                AddPage();
            }
        }

        public void Title(string text)
        {
            var font = new XFont(GoFonts.Family, 24, XFontStyleEx.Bold);
            foreach (var line in Wrap(text, font, ContentWidth))
            {
                Space(30);
                graphics!.DrawString(line, font, new XSolidBrush(XColor.FromArgb(25, 25, 25)), new XPoint(Margin, y + 30 * 0.78));
                y += 30;
            }
            y += 12;
        }

        public void Blocks(ExportRecord record, IList<Block> blocks, double indent, int recordIndex)
        {
            var index = 0;
            foreach (var block in blocks)
            {
                switch (block.Kind)
                {
                    case "heading":
                        {
                            var sizes = new double[] { 20, 17, 14, 13, 12, 11 };
                            var fontSize = sizes[Math.Min(Math.Max(block.Level, 1) - 1, 5)];
                            Space(fontSize * 2 + 22);
                            Paragraph(block.RunsOrEmpty, indent, XFontStyleEx.Bold, fontSize);
                            break;
                        }
                    case "quote":
                    case "callout":
                        if (block.Kind == "callout" && !string.IsNullOrEmpty(block.Tone))
                        {
                            Paragraph([new Run { Text = block.Tone, Styles = ["bold"] }], indent + 16, XFontStyleEx.Italic, 11);
                        }
                        Blocks(record, block.BlocksOrEmpty, indent + 16, recordIndex);
                        break;
                    case "code":
                        if (record.Image(block.Src) is { } diagram)
                        {
                            Image(diagram, indent);
                            break;
                        }
                        y += 6;
                        foreach (var line in (block.Text ?? string.Empty).Split('\n'))
                        {
                            var font = new XFont(GoFonts.MonoFamily, 10);
                            foreach (var wrapped in Wrap(PdfText(line).Replace('\t', ' '), font, ContentWidth - indent))
                            {
                                Space(15);
                                graphics!.DrawRectangle(new XSolidBrush(XColor.FromArgb(243, 244, 246)), Margin + indent, y, ContentWidth - indent, 15);
                                graphics.DrawString(wrapped, font, XBrushes.Black, new XPoint(Margin + indent, y + 15 * 0.78));
                                y += 15;
                            }
                        }
                        y += 6;
                        break;
                    case "rule":
                        Space(12);
                        graphics!.DrawLine(new XPen(XColor.FromArgb(190, 190, 190), 0.2), Margin, y, Margin + ContentWidth, y);
                        y += 8;
                        break;
                    case "pageBreak":
                        AddPage();
                        break;
                    case "image":
                        if (record.Image(block.Src) is { } raster)
                        {
                            Image(raster, indent);
                            break;
                        }
                        Paragraph([new Run { Text = "Image: " + (block.Alt ?? string.Empty), Href = block.Src }], indent, XFontStyleEx.Regular, 11);
                        break;
                    case "list":
                        {
                            var item = 0;
                            foreach (var entry in block.ItemsOrEmpty)
                            {
                                var marker = "• ";
                                if (block.Ordered)
                                {
                                    marker = (Math.Max(block.Start, 1) + item).ToString(CultureInfo.InvariantCulture) + ". ";
                                }
                                if (entry.Checked is { } check)
                                {
                                    marker = check ? "☑ " : "☐ ";
                                }
                                IList<Block> itemBlocks = entry.Blocks;
                                if (itemBlocks.Count > 0 && itemBlocks[0].Kind == "paragraph")
                                {
                                    var first = itemBlocks[0];
                                    itemBlocks = [new Block { Kind = "paragraph", Runs = [new Run { Text = marker }, .. first.RunsOrEmpty] }, .. itemBlocks.Skip(1)];
                                }
                                else
                                {
                                    itemBlocks = [RenderTree.Paragraph(marker), .. itemBlocks];
                                }
                                Blocks(record, itemBlocks, indent + 14, recordIndex);
                                item++;
                            }
                            break;
                        }
                    case "table":
                        Table(block.RowsOrEmpty);
                        break;
                    case "details":
                        Paragraph(block.SummaryOrEmpty, indent, XFontStyleEx.Bold, 11);
                        Blocks(record, block.BlocksOrEmpty, indent, recordIndex);
                        break;
                    default: // paragraph, and any kind this build does not know but whose runs it can keep.
                        Paragraph(block.RunsOrEmpty, indent, XFontStyleEx.Regular, 11);
                        break;
                }
                index++;
            }
        }

        // Flows runs inline with wrapping, like fpdf's Write: words keep their run's font, lines
        // are size * 1.45 tall, and a run of "\n" ends the line.
        private void Paragraph(IList<Run> runs, double indent, XFontStyleEx baseStyle, double size)
        {
            var lineHeight = size * 1.45;
            var left = Margin + indent;
            var right = Margin + ContentWidth;
            x = left;
            Space(lineHeight);
            foreach (var run in runs)
            {
                if (run.Text == "\n")
                {
                    y += lineHeight;
                    x = left;
                    Space(lineHeight);
                    continue;
                }
                var style = baseStyle;
                if (run.Has("bold"))
                {
                    style |= XFontStyleEx.Bold;
                }
                if (run.Has("italic"))
                {
                    style |= XFontStyleEx.Italic;
                }
                if (run.Has("strike"))
                {
                    style |= XFontStyleEx.Strikeout;
                }
                if (run.Has("underline"))
                {
                    style |= XFontStyleEx.Underline;
                }
                var font = run.Has("code") ? new XFont(GoFonts.MonoFamily, size) : new XFont(GoFonts.Family, size, style);
                var link = !string.IsNullOrEmpty(run.Href) && TextRules.SafeDocumentLink(run.Href) ? run.Href : null;
                foreach (var piece in Pieces(PdfText(run.Text).Replace('\t', ' ')))
                {
                    if (piece == "\n")
                    {
                        y += lineHeight;
                        x = left;
                        Space(lineHeight);
                        continue;
                    }
                    var width = graphics!.MeasureString(piece, font).Width;
                    if (x + width > right && x > left)
                    {
                        y += lineHeight;
                        x = left;
                        Space(lineHeight);
                        if (piece.Length > 0 && piece[0] == ' ')
                        {
                            continue;
                        }
                    }
                    graphics.DrawString(piece, font, new XSolidBrush(XColor.FromArgb(35, 35, 35)), new XPoint(x, y + lineHeight * 0.78));
                    if (link is not null)
                    {
                        current!.AddWebLink(new PdfRectangle(graphics.Transformer.WorldToDefaultPage(new XRect(x, y, width, lineHeight))), link);
                    }
                    x += width;
                }
            }
            y += lineHeight;
            x = left;
        }

        // Words with their trailing space, and explicit line breaks, so wrapping happens at word boundaries.
        private static IEnumerable<string> Pieces(string text)
        {
            var start = 0;
            for (var index = 0; index < text.Length; index++)
            {
                if (text[index] == '\n')
                {
                    if (index > start)
                    {
                        yield return text[start..index];
                    }
                    yield return "\n";
                    start = index + 1;
                }
                else if (text[index] == ' ')
                {
                    yield return text[start..(index + 1)];
                    start = index + 1;
                }
            }
            if (start < text.Length)
            {
                yield return text[start..];
            }
        }

        private IEnumerable<string> Wrap(string text, XFont font, double width)
        {
            var line = new StringBuilder();
            foreach (var piece in Pieces(text))
            {
                if (piece == "\n")
                {
                    yield return line.ToString();
                    line.Clear();
                    continue;
                }
                if (line.Length > 0 && graphics!.MeasureString(line + piece.TrimEnd(), font).Width > width)
                {
                    yield return line.ToString().TrimEnd();
                    line.Clear();
                }
                line.Append(piece);
            }
            if (line.Length > 0 || text.Length == 0)
            {
                yield return line.ToString().TrimEnd();
            }
        }

        private void Table(IList<Row> rows)
        {
            var columns = rows.Count == 0 ? 0 : rows.Max(row => row.Cells.Count);
            if (columns == 0)
            {
                return;
            }
            var width = ContentWidth / columns;
            foreach (var row in rows)
            {
                var font = new XFont(GoFonts.Family, 10, row.Header ? XFontStyleEx.Bold : XFontStyleEx.Regular);
                var cells = new List<string>[columns];
                var count = 1;
                for (var column = 0; column < columns; column++)
                {
                    cells[column] = column < row.Cells.Count
                        ? Wrap(PdfText(RenderTree.Plain(row.Cells[column]).Replace("\n", " ", StringComparison.Ordinal)), font, Math.Max(width - 12, 1)).ToList()
                        : [];
                    count = Math.Max(count, cells[column].Count);
                }
                // Tall rows split across pages at line boundaries so no cell runs below the footer.
                for (var start = 0; start < count;)
                {
                    Space(22);
                    var take = Math.Min(count - start, Math.Max(1, (int)((Bottom - y - 8) / 14)));
                    var height = take * 14 + 8;
                    var top = y;
                    for (var column = 0; column < columns; column++)
                    {
                        var left = Margin + column * width;
                        var pen = new XPen(XColor.FromArgb(205, 210, 215), 0.2);
                        if (row.Header)
                        {
                            graphics!.DrawRectangle(pen, new XSolidBrush(XColor.FromArgb(244, 246, 248)), left, top, width, height);
                        }
                        else
                        {
                            graphics!.DrawRectangle(pen, left, top, width, height);
                        }
                        for (var n = 0; n < take && start + n < cells[column].Count; n++)
                        {
                            graphics.DrawString(cells[column][start + n], font, XBrushes.Black, new XPoint(left + 6, top + 4 + n * 14 + 14 * 0.78));
                        }
                    }
                    y = top + height;
                    start += take;
                }
            }
            y += 8;
        }

        private void Image(ExportImage raster, double indent)
        {
            var (width, height) = Images.Size(raster, ContentWidth - indent, Bottom - Margin);
            Space(height + 8);
            using var image = XImage.FromStream(new MemoryStream(raster.Data));
            graphics!.DrawImage(image, Margin + indent, y, width, height);
            y += height + 8;
        }
    }

    /// <summary>Serves the embedded Go fonts to PdfSharp by family and style.</summary>
    private sealed class GoFontResolver : IFontResolver
    {
        public byte[]? GetFont(string faceName) => faceName switch
        {
            "Go#Regular" => GoFonts.Regular,
            "Go#Bold" => GoFonts.Bold,
            "Go#Italic" => GoFonts.Italic,
            "Go#BoldItalic" => GoFonts.BoldItalic,
            "GoMono#Regular" => GoFonts.Mono,
            _ => null,
        };

        public FontResolverInfo? ResolveTypeface(string familyName, bool bold, bool italic)
        {
            if (string.Equals(familyName, GoFonts.MonoFamily, StringComparison.OrdinalIgnoreCase))
            {
                return new FontResolverInfo("GoMono#Regular", bold, italic);
            }
            if (!string.Equals(familyName, GoFonts.Family, StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }
            return new FontResolverInfo((bold, italic) switch
            {
                (true, true) => "Go#BoldItalic",
                (true, false) => "Go#Bold",
                (false, true) => "Go#Italic",
                _ => "Go#Regular",
            });
        }
    }
}
