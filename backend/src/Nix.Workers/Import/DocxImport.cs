using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Xml;
using Nix.Workers.Files;
using Nix.Workers.Render;

namespace Nix.Workers.Import;

/// <summary>
/// Reads a DOCX into a nix-render tree plus its embedded images as child files. XML is read the
/// way Go's encoding/xml read it: no namespace resolution (an undeclared prefix is not an error),
/// names matched by their local part, and any DTD or entity declaration refused outright.
/// </summary>
internal static class DocxImport
{
    public const string MediaType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    private const int MaxXmlTokens = 500_000;

    public static ImportPlan Parse(ImportSource source, ImportPlanLimits limits, CancellationToken cancellationToken)
    {
        using var archive = ImportArchive.Open(source.Path, limits, allowNixFileVersions: false);
        var document = ImportArchive.ReadEntry(archive, "word/document.xml", limits.MaxBodyBytes);
        var maxDepth = Math.Max(limits.MaxDepth, 32);
        if (GoXml.Validate(document, maxDepth, MaxXmlTokens) is { } documentError)
        {
            throw new ImportPlanException("DOCX document.xml: " + documentError);
        }
        var (links, imageTargets) = ReadRelationships(archive, limits, maxDepth);
        var numbering = ReadNumbering(archive, limits, maxDepth);
        var assets = new Dictionary<string, (string SourceId, ImportFile File)>(StringComparer.Ordinal);
        foreach (var (relationId, target) in imageTargets)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var entry = ImportArchive.Find(archive, target);
            if (entry is not null && InspectAsset(entry, target[(target.LastIndexOf('/') + 1)..], cancellationToken) is { } file)
            {
                assets[relationId] = (string.Empty, file);
            }
        }
        // Source identifiers come from sorted archive paths, so a retry produces the same plan and checksum.
        // shortcut: ordinal UTF-16 order, which differs from Go's byte order only between astral and U+E000+ characters in a member name.
        var order = assets.Keys
            .OrderBy(id => assets[id].File.AssetPath, StringComparer.Ordinal)
            .ThenBy(id => id, StringComparer.Ordinal)
            .ToList();
        for (var index = 0; index < order.Count; index++)
        {
            assets[order[index]] = (string.Create(CultureInfo.InvariantCulture, $"asset-{index + 1:D4}"), assets[order[index]].File);
        }

        var parser = new DocxParser(links, assets, numbering);
        foreach (var entry in archive.Entries)
        {
            parser.Report(entry.FullName);
        }
        parser.Parse(document);
        if (parser.Blocks.Count == 0)
        {
            parser.Blocks.Add(new Block { Kind = "paragraph" });
        }
        var items = new List<ImportItem>
        {
            ImportPlanner.NoteItem("root", null, 0, source.Title, new ImportBody { Encoding = "nix-render", Render = GoJson.Parse(RenderJson.Write(parser.Blocks)) }),
            ImportPlanner.OriginalItem(source, MediaType, 0),
        };
        for (var index = 0; index < parser.UsedAssets.Count; index++)
        {
            var (sourceId, file) = parser.UsedAssets[index];
            items.Add(new ImportItem
            {
                SourceId = sourceId,
                ParentSourceId = "root",
                Order = index + 1,
                Title = file.FileName,
                ItemType = "file",
                FinalLifecycleState = "active",
                File = file,
            });
        }
        if (parser.UsedAssets.Count > 0)
        {
            parser.Lose("DOCX inline image anchoring is approximated as a document block while the original image bytes are retained as child files.");
        }
        return new ImportPlan
        {
            Version = ImportPlan.CurrentVersion,
            Format = "docx",
            Title = source.Title,
            SourceSha256 = source.Sha256,
            Items = items,
            Loss = parser.Loss,
            Omissions = parser.Omissions,
        };
    }

    private static ImportFile? InspectAsset(ZipArchiveEntry entry, string fileName, CancellationToken cancellationToken)
    {
        FileMetadata metadata;
        string digest;
        try
        {
            (metadata, digest, _) = ImportArchive.Inspect(entry, cancellationToken);
        }
        catch (Exception exception) when (exception is InvalidDataException or IOException)
        {
            return null;
        }
        if (metadata.Malformed || !metadata.MediaType.StartsWith("image/", StringComparison.Ordinal))
        {
            return null;
        }
        return new ImportFile
        {
            SourceKind = "asset",
            AssetPath = entry.FullName,
            FileName = fileName,
            MediaType = metadata.MediaType,
            ByteLength = entry.Length,
            Sha256 = digest,
            Previewable = metadata.Previewable,
            PixelWidth = metadata.Width,
            PixelHeight = metadata.Height,
        };
    }

    private static (Dictionary<string, string> Links, Dictionary<string, string> Images) ReadRelationships(ZipArchive archive, ImportPlanLimits limits, int maxDepth)
    {
        var links = new Dictionary<string, string>(StringComparer.Ordinal);
        var images = new Dictionary<string, string>(StringComparer.Ordinal);
        const string name = "word/_rels/document.xml.rels";
        if (ImportArchive.Find(archive, name) is null)
        {
            return (links, images);
        }
        var body = ImportArchive.ReadEntry(archive, name, Math.Min(limits.MaxEntryBytes, 2 << 20));
        if (GoXml.Validate(body, maxDepth, MaxXmlTokens) is { } error)
        {
            throw new ImportPlanException("DOCX relationships: " + error);
        }
        foreach (var relation in GoXml.Tree(body).Children("Relationship"))
        {
            var id = relation.Attribute("Id");
            var type = relation.Attribute("Type");
            var target = relation.Attribute("Target");
            var mode = relation.Attribute("TargetMode");
            if (type.EndsWith("/hyperlink", StringComparison.Ordinal) && string.Equals(mode, "External", StringComparison.OrdinalIgnoreCase))
            {
                if (ExternalLink(target) is { } link)
                {
                    links[id] = link;
                }
                continue;
            }
            if (!type.EndsWith("/image", StringComparison.Ordinal) || mode.Length != 0)
            {
                continue;
            }
            if (ImageTarget(target) is { } image)
            {
                images[id] = image;
            }
        }
        return (links, images);
    }

    /// <summary>
    /// An http(s) link without credentials or fragment. shortcut: Go re-serialised the link through
    /// net/url; this keeps the source spelling with only the scheme lowercased, which is what that
    /// produced for ordinary links. Upgrade if a link with unusual escaping must match byte for byte.
    /// </summary>
    private static string? ExternalLink(string target)
    {
        if (target.Contains('#', StringComparison.Ordinal) || target.Any(c => c < 0x20 || c == 0x7f || c == ' ')
            || !Uri.TryCreate(target, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https") || uri.UserInfo.Length != 0)
        {
            return null;
        }
        var colon = target.IndexOf(':', StringComparison.Ordinal);
        return uri.Scheme + target[colon..];
    }

    /// <summary>A relative target that resolves under word/media/, as Go's url and path rules resolved it.</summary>
    private static string? ImageTarget(string target)
    {
        if (target.Contains('\\', StringComparison.Ordinal) || target.Contains('?', StringComparison.Ordinal) || target.Contains('#', StringComparison.Ordinal)
            || target.StartsWith('/') || target.Any(c => c < 0x20 || c == 0x7f))
        {
            return null;
        }
        var slash = target.IndexOf('/', StringComparison.Ordinal);
        if ((slash < 0 ? target : target[..slash]).Contains(':', StringComparison.Ordinal))
        {
            // A scheme, or a colon Go's url.Parse refused in the first segment.
            return null;
        }
        if (Unescape(target) is not { } decoded || decoded.StartsWith('/') || ImportArchive.CleanPath(decoded).StartsWith("../", StringComparison.Ordinal))
        {
            return null;
        }
        var resolved = ImportArchive.CleanPath("word/" + decoded);
        return resolved.StartsWith("word/media/", StringComparison.Ordinal) && !resolved.Contains('\\', StringComparison.Ordinal) ? resolved : null;
    }

    /// <summary>url.PathUnescape: %XX sequences decoded as UTF-8 bytes, a malformed escape refused.</summary>
    private static string? Unescape(string value)
    {
        if (!value.Contains('%', StringComparison.Ordinal))
        {
            return value;
        }
        var bytes = new List<byte>();
        var text = Encoding.UTF8.GetBytes(value);
        for (var index = 0; index < text.Length; index++)
        {
            if (text[index] != '%')
            {
                bytes.Add(text[index]);
                continue;
            }
            if (index + 2 >= text.Length || !byte.TryParse(Encoding.ASCII.GetString(text, index + 1, 2), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var decoded))
            {
                return null;
            }
            bytes.Add(decoded);
            index += 2;
        }
        return Encoding.UTF8.GetString([.. bytes]);
    }

    private static Dictionary<string, string> ReadNumbering(ZipArchive archive, ImportPlanLimits limits, int maxDepth)
    {
        const string name = "word/numbering.xml";
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        if (ImportArchive.Find(archive, name) is null)
        {
            return result;
        }
        var body = ImportArchive.ReadEntry(archive, name, Math.Min(limits.MaxEntryBytes, 2 << 20));
        if (GoXml.Validate(body, maxDepth, MaxXmlTokens) is { } error)
        {
            throw new ImportPlanException("DOCX numbering: " + error);
        }
        var document = GoXml.Tree(body);
        var abstracts = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var value in document.Children("abstractNum"))
        {
            var format = "bullet";
            foreach (var level in value.Children("lvl"))
            {
                var levelNumber = XmlInt(level.Attribute("ilvl"));
                var levelFormat = string.Empty;
                foreach (var numberFormat in level.Children("numFmt"))
                {
                    levelFormat = numberFormat.FindAttribute("val") ?? levelFormat;
                }
                if (levelNumber == 0 && levelFormat.Length != 0)
                {
                    format = levelFormat;
                    break;
                }
            }
            abstracts[value.Attribute("abstractNumId")] = format;
        }
        foreach (var value in document.Children("num"))
        {
            var abstractId = string.Empty;
            foreach (var reference in value.Children("abstractNumId"))
            {
                abstractId = reference.FindAttribute("val") ?? abstractId;
            }
            result[value.Attribute("numId")] = abstracts.GetValueOrDefault(abstractId) ?? string.Empty;
        }
        return result;
    }

    /// <summary>encoding/xml's int attribute: empty is zero, otherwise a trimmed base-10 integer or an error.</summary>
    private static long XmlInt(string value)
    {
        if (value.Length == 0)
        {
            return 0;
        }
        return long.TryParse(value.Trim(), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var number)
            ? number
            : throw new ImportPlanException("DOCX numbering: strconv.ParseInt: parsing \"" + value + "\": invalid syntax");
    }

    /// <summary>strconv.Atoi as the parser used it: a syntax error is zero, an out-of-range value saturates.</summary>
    internal static int Atoi(string value)
    {
        if (int.TryParse(value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var number))
        {
            return number;
        }
        var digits = value.TrimStart('+', '-');
        if (digits.Length > 0 && value.Length - digits.Length == 1 && digits.All(char.IsAsciiDigit))
        {
            return value[0] == '-' ? int.MinValue : int.MaxValue;
        }
        return 0;
    }

    private sealed class DocxParser(Dictionary<string, string> links, Dictionary<string, (string SourceId, ImportFile File)> assets, Dictionary<string, string> numbering)
    {
        private static readonly string[] Marks = ["bold", "italic", "underline", "strike"];
        private readonly HashSet<string> used = new(StringComparer.Ordinal);
        private HashSet<string> runMarks = new(StringComparer.Ordinal);
        private Table? table;
        private int tableDepth;
        private Paragraph? paragraph;
        private string hyperlink = string.Empty;
        private bool inRunProps;
        private bool inParaProps;
        private bool inText;

        public List<Block> Blocks { get; } = [];

        public List<(string SourceId, ImportFile File)> UsedAssets { get; } = [];

        public List<string> Loss { get; } = [];

        public List<string> Omissions { get; } = [];

        public void Lose(string value) => AddUnique(Loss, value);

        public void Report(string name)
        {
            if (name.StartsWith("word/header", StringComparison.Ordinal) && name.EndsWith(".xml", StringComparison.Ordinal))
            {
                AddUnique(Omissions, "DOCX headers are retained only in the original file.");
            }
            else if (name.StartsWith("word/footer", StringComparison.Ordinal) && name.EndsWith(".xml", StringComparison.Ordinal))
            {
                AddUnique(Omissions, "DOCX footers are retained only in the original file.");
            }
            else if (name is "word/footnotes.xml" or "word/endnotes.xml")
            {
                AddUnique(Omissions, "DOCX footnotes and endnotes are retained only in the original file.");
            }
            else if (name == "word/comments.xml")
            {
                AddUnique(Omissions, "DOCX comments are retained only in the original file.");
            }
            else if (name == "word/styles.xml")
            {
                Lose("DOCX named styles beyond supported headings are approximated using editable note formatting.");
            }
        }

        public void Parse(byte[] document)
        {
            try
            {
                foreach (var token in GoXml.Tokens(document))
                {
                    switch (token.Kind)
                    {
                        case GoXml.TokenKind.Start:
                            Start(token);
                            break;
                        case GoXml.TokenKind.End:
                            End(token.Name);
                            break;
                        case GoXml.TokenKind.Text when inText && paragraph is not null:
                            AppendText(token.Text);
                            break;
                    }
                }
            }
            catch (XmlException exception)
            {
                throw new ImportPlanException("DOCX document.xml: " + exception.Message, exception);
            }
        }

        private void Start(GoXml.Token token)
        {
            switch (token.Name)
            {
                case "tbl":
                    tableDepth++;
                    if (tableDepth == 1)
                    {
                        table = new Table();
                    }
                    else
                    {
                        Lose("Nested DOCX tables are flattened into their containing cell.");
                    }
                    break;
                case "tr":
                    if (table is not null && tableDepth == 1)
                    {
                        table.CurrentRow = [];
                    }
                    break;
                case "tc":
                    if (table is not null && tableDepth == 1)
                    {
                        table.CurrentCell = [];
                        table.InCell = true;
                    }
                    break;
                case "p":
                    paragraph = new Paragraph();
                    break;
                case "pPr":
                    inParaProps = true;
                    break;
                case "r":
                    runMarks = new HashSet<string>(StringComparer.Ordinal);
                    break;
                case "rPr":
                    inRunProps = true;
                    break;
                case "b" or "i" or "u" or "strike" or "dstrike":
                    if (inRunProps)
                    {
                        runMarks.Add(token.Name switch { "b" => "bold", "i" => "italic", "u" => "underline", _ => "strike" });
                    }
                    break;
                case "pStyle":
                    if (inParaProps && paragraph is not null)
                    {
                        paragraph.Style = token.Attribute("val");
                    }
                    break;
                case "numId":
                    if (inParaProps && paragraph is not null)
                    {
                        paragraph.NumId = token.Attribute("val");
                    }
                    break;
                case "ilvl":
                    if (inParaProps && paragraph is not null)
                    {
                        paragraph.Level = Atoi(token.Attribute("val"));
                    }
                    break;
                case "hyperlink":
                    hyperlink = links.GetValueOrDefault(token.Attribute("id")) ?? string.Empty;
                    break;
                case "t":
                    inText = true;
                    break;
                case "tab":
                    AppendText("\t");
                    break;
                case "br":
                    paragraph?.Runs.Add(new Run { Text = "\n" });
                    break;
                case "blip":
                    paragraph?.Images.Add(token.Attribute("embed"));
                    break;
                case "gridSpan" or "vMerge":
                    Lose("Merged DOCX table cells are flattened into ordinary cells.");
                    break;
                case "sectPr":
                    Lose("DOCX page size, margins, columns, and section layout are not preserved in the editable note.");
                    break;
                case "fldSimple" or "instrText":
                    Lose("DOCX dynamic fields are imported as their visible text where available.");
                    break;
                case "altChunk" or "object" or "oleObject":
                    AddUnique(Omissions, "Embedded DOCX objects and alternate content are retained only in the original file.");
                    break;
            }
        }

        private void End(string name)
        {
            switch (name)
            {
                case "t":
                    inText = false;
                    break;
                case "rPr":
                    inRunProps = false;
                    break;
                case "pPr":
                    inParaProps = false;
                    break;
                case "hyperlink":
                    hyperlink = string.Empty;
                    break;
                case "p":
                    FinishParagraph();
                    break;
                case "tc":
                    if (table is not null && tableDepth == 1)
                    {
                        if (table.CurrentCell.Count == 0)
                        {
                            table.CurrentCell.Add(new Block { Kind = "paragraph" });
                        }
                        table.CurrentRow.Add(table.CurrentCell);
                        table.CurrentCell = [];
                        table.InCell = false;
                    }
                    break;
                case "tr":
                    if (table is not null && tableDepth == 1 && table.CurrentRow.Count > 0)
                    {
                        table.Rows.Add(table.CurrentRow);
                        table.CurrentRow = [];
                    }
                    break;
                case "tbl":
                    if (tableDepth == 1)
                    {
                        FinishTable();
                    }
                    if (tableDepth > 0)
                    {
                        tableDepth--;
                    }
                    break;
            }
        }

        private void AppendText(string text)
        {
            if (paragraph is null || text.Length == 0)
            {
                return;
            }
            var styles = Marks.Where(runMarks.Contains).ToList();
            paragraph.Runs.Add(new Run { Text = text, Href = hyperlink, Styles = styles.Count == 0 ? null : styles });
        }

        private void FinishParagraph()
        {
            if (paragraph is null)
            {
                return;
            }
            var current = paragraph;
            paragraph = null;
            var node = new Block { Kind = "paragraph", Runs = current.Runs };
            var upperStyle = current.Style.ToUpperInvariant();
            if (upperStyle.StartsWith("HEADING", StringComparison.Ordinal)
                && int.TryParse(upperStyle["HEADING".Length..], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var level) && level is >= 1 and <= 6)
            {
                node.Kind = "heading";
                node.Level = level;
            }
            if (current.NumId.Length != 0)
            {
                var format = numbering.GetValueOrDefault(current.NumId) ?? string.Empty;
                if (current.Level > 0)
                {
                    Lose("Nested DOCX list indentation is flattened while list semantics are retained.");
                }
                AppendBlock(new Block { Kind = "list", Ordered = format.Length != 0 && format != "bullet", Items = [new ListItem { Blocks = [node] }] });
            }
            else
            {
                AppendBlock(node);
            }
            foreach (var relationId in current.Images)
            {
                if (!assets.TryGetValue(relationId, out var asset))
                {
                    Lose("An embedded DOCX image was unsupported or malformed and remains only in the retained original file.");
                    continue;
                }
                if (used.Add(relationId))
                {
                    UsedAssets.Add(asset);
                }
                AppendBlock(new Block { Kind = "image", Src = "nix-file:" + asset.SourceId, Alt = asset.File.FileName, Width = asset.File.PixelWidth ?? 0 });
            }
        }

        private void AppendBlock(Block node)
        {
            if (table is { InCell: true })
            {
                table.CurrentCell.Add(node);
                return;
            }
            Blocks.Add(node);
        }

        private void FinishTable()
        {
            if (table is null)
            {
                return;
            }
            var current = table;
            table = null;
            if (current.Rows.Count == 0)
            {
                return;
            }
            var rows = new List<Row>(current.Rows.Count);
            foreach (var row in current.Rows)
            {
                var cells = new List<IList<Run>>(row.Count);
                foreach (var content in row)
                {
                    // A cell holds runs only; its paragraphs are joined by line breaks. No runs at all stays null, as Go's nil slice.
                    List<Run>? runs = null;
                    for (var index = 0; index < content.Count; index++)
                    {
                        if (index > 0)
                        {
                            (runs ??= []).Add(new Run { Text = "\n" });
                        }
                        if (content[index].Runs is { Count: > 0 } blockRuns)
                        {
                            (runs ??= []).AddRange(blockRuns);
                        }
                    }
                    cells.Add(runs!);
                }
                rows.Add(new Row { Cells = cells });
            }
            Blocks.Add(new Block { Kind = "table", Rows = rows });
        }

        private static void AddUnique(List<string> values, string value)
        {
            if (!values.Contains(value, StringComparer.Ordinal))
            {
                values.Add(value);
            }
        }

        private sealed class Paragraph
        {
            public string Style { get; set; } = string.Empty;

            public string NumId { get; set; } = string.Empty;

            public int Level { get; set; }

            public List<Run> Runs { get; } = [];

            public List<string> Images { get; } = [];
        }

        private sealed class Table
        {
            public List<List<List<Block>>> Rows { get; } = [];

            public List<List<Block>> CurrentRow { get; set; } = [];

            public List<Block> CurrentCell { get; set; } = [];

            public bool InCell { get; set; }
        }
    }
}

/// <summary>Writes a render tree as Go's render.Document.Encode did, omitempty and all.</summary>
internal static class RenderJson
{
    public static byte[] Write(IList<Block> blocks)
    {
        var writer = new GoJsonWriter();
        writer.Begin().Name("format").String(RenderTree.Format).Name("version").Number(RenderTree.Version).Name("blocks");
        Blocks(writer, blocks);
        writer.Name("losses").BeginArray().EndArray().End();
        return writer.ToUtf8();
    }

    private static void Blocks(GoJsonWriter writer, IList<Block>? blocks)
    {
        if (blocks is null)
        {
            writer.Null();
            return;
        }
        writer.BeginArray();
        foreach (var block in blocks)
        {
            writer.Begin().Name("kind").String(block.Kind);
            if (block.Runs is { Count: > 0 })
            {
                writer.Name("runs");
                Runs(writer, block.Runs);
            }
            OptionalNumber(writer, "level", block.Level);
            OptionalString(writer, "align", block.Align);
            OptionalString(writer, "tone", block.Tone);
            if (block.Language is not null)
            {
                writer.Name("language").String(block.Language);
            }
            OptionalString(writer, "text", block.Text);
            OptionalString(writer, "renderFile", block.RenderFile);
            OptionalString(writer, "src", block.Src);
            OptionalString(writer, "alt", block.Alt);
            OptionalString(writer, "file", block.File);
            OptionalNumber(writer, "width", block.Width);
            if (block.Ordered)
            {
                writer.Name("ordered").Bool(true);
            }
            OptionalNumber(writer, "start", block.Start);
            if (block.Items is { Count: > 0 })
            {
                writer.Name("items").BeginArray();
                foreach (var item in block.Items)
                {
                    writer.Begin();
                    if (item.Checked is { } isChecked)
                    {
                        writer.Name("checked").Bool(isChecked);
                    }
                    writer.Name("blocks");
                    Blocks(writer, item.Blocks);
                    writer.End();
                }
                writer.EndArray();
            }
            if (block.Rows is { Count: > 0 })
            {
                writer.Name("rows").BeginArray();
                foreach (var row in block.Rows)
                {
                    writer.Begin().Name("header").Bool(row.Header).Name("cells");
                    if (row.Cells is null)
                    {
                        writer.Null();
                    }
                    else
                    {
                        writer.BeginArray();
                        foreach (var cell in row.Cells)
                        {
                            Runs(writer, cell);
                        }
                        writer.EndArray();
                    }
                    writer.End();
                }
                writer.EndArray();
            }
            if (block.Summary is { Count: > 0 })
            {
                writer.Name("summary");
                Runs(writer, block.Summary);
            }
            if (block.Blocks is { Count: > 0 })
            {
                writer.Name("blocks");
                Blocks(writer, block.Blocks);
            }
            writer.End();
        }
        writer.EndArray();
    }

    private static void Runs(GoJsonWriter writer, IList<Run>? runs)
    {
        if (runs is null)
        {
            writer.Null();
            return;
        }
        writer.BeginArray();
        foreach (var run in runs)
        {
            writer.Begin().Name("text").String(run.Text);
            if (run.Styles is { Count: > 0 })
            {
                writer.Name("styles").Strings(run.Styles);
            }
            OptionalString(writer, "href", run.Href);
            writer.End();
        }
        writer.EndArray();
    }

    private static void OptionalString(GoJsonWriter writer, string name, string? value)
    {
        if (!string.IsNullOrEmpty(value))
        {
            writer.Name(name).String(value);
        }
    }

    private static void OptionalNumber(GoJsonWriter writer, string name, int value)
    {
        if (value != 0)
        {
            writer.Name(name).Number(value);
        }
    }
}
