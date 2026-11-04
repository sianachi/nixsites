#pragma warning disable CA2227 // Justification: mutable record shapes the projection fills in place.
#pragma warning disable CA1819 // Justification: the document encoders take the raster bytes whole.
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Workers.Archive;
using Nix.Workers.Render;

namespace Nix.Workers.Export;

/// <summary>A validated raster for one converted note, never a capability URL.</summary>
public sealed class ExportImage
{
    public string Source { get; set; } = string.Empty;

    public byte[] Data { get; set; } = []; // byte[]: the document encoders take a complete validated raster

    public string Format { get; set; } = string.Empty;

    public int Width { get; set; }

    public int PixelWidth { get; set; }

    public int PixelHeight { get; set; }
}

/// <summary>One converted note: its render tree and the rasters the image blocks name.</summary>
public sealed class ExportRecord
{
    public string Id { get; set; } = string.Empty;

    public string ParentId { get; set; } = string.Empty;

    public string Title { get; set; } = string.Empty;

    public IList<Block> Blocks { get; set; } = [];

    public IList<ExportImage> Images { get; set; } = [];

    public ExportImage? Image(string? source) => source is null ? null : Images.FirstOrDefault(image => image.Source == source);
}

/// <summary>Fetches the raster of one file item; supplied by the job host, so projection has no network authority.</summary>
public delegate Task<byte[]> ImageLoader(string fileId, CancellationToken cancellationToken);

public sealed class Projected
{
    public IList<Block> Blocks { get; set; } = [];

    public IList<ExportImage> Images { get; set; } = [];

    public IList<string> Losses { get; set; } = [];
}

/// <summary>
/// Turns a bundle into blocks: the body as Collab shaped it (a <c>nix-render</c> tree), then the
/// sections the worker adds (properties, fields, views, comments). A sheet, canvas or unknown body
/// kind is inventoried as text. A port of the Go <c>portable.go</c>.
/// </summary>
public static class Projection
{
    private const int MaximumPortableDepth = 64;

    public static async Task<Projected> ProjectAsync(Bundle bundle, int maximumBytes, ImageLoader? load, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(bundle);
        if (maximumBytes <= 0)
        {
            throw new ArgumentException("projection limit must be positive", nameof(maximumBytes));
        }
        var properties = bundle.Properties;
        if (bundle.Raw.Length > 0)
        {
            // Decimal text stays exact: read the properties straight from the source line.
            using var raw = JsonDocument.Parse(bundle.Raw);
            properties = raw.RootElement.TryGetProperty("properties", out var found) && found.ValueKind == JsonValueKind.Object
                ? JsonObject.Create(found.Clone())
                : null;
        }
        var result = new Projected();
        foreach (var loss in bundle.BodyLosses ?? [])
        {
            result.Losses.Add(loss);
        }
        if (bundle.Type == "file")
        {
            result.Blocks.Add(RenderTree.Heading(2, "Attachment"));
            result.Blocks.Add(new Block { Kind = "paragraph", Runs = [new Run { Text = bundle.Title, Href = "nix://item/" + bundle.Id }] });
            result.Blocks.Add(RenderTree.Paragraph("Open the original attachment in Nix."));
            result.Losses.Add("Attachments are linked to their original Nix items; binary contents are not embedded as editable text.");
        }
        else if (IsValue(bundle.Render))
        {
            var document = RenderTree.Decode(JsonSerializer.SerializeToUtf8Bytes(bundle.Render!.Value));
            foreach (var loss in document.Losses)
            {
                result.Losses.Add(loss);
            }
            result.Blocks = document.Blocks;
            RenderTree.Walk(result.Blocks, block =>
            {
                if (!RenderTree.Known(block.Kind))
                {
                    AppendLoss(result.Losses, $"A \"{block.Kind}\" block written by a newer version of Nix was drawn as its text only.");
                }
            });
            result.Images = await Images.LoadAsync(result.Blocks, load, result.Losses, cancellationToken).ConfigureAwait(false);
        }
        else if (IsValue(bundle.Body))
        {
            var (blocks, losses) = ProjectNonProseBody(bundle.Body!.Value);
            foreach (var block in blocks)
            {
                result.Blocks.Add(block);
            }
            foreach (var loss in losses)
            {
                result.Losses.Add(loss);
            }
        }
        var (sections, sectionLosses) = Sections(bundle, properties);
        foreach (var block in sections)
        {
            result.Blocks.Add(block);
        }
        foreach (var loss in sectionLosses)
        {
            result.Losses.Add(loss);
        }
        if (result.Blocks.Count == 0)
        {
            result.Blocks.Add(RenderTree.Paragraph("Empty item."));
        }
        SanitizeBlocks(result.Blocks, maximumBytes);
        return result;
    }

    public static bool IsValue(JsonElement? element) => element is { } value && value.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined);

    public static void AppendLoss(IList<string> losses, string loss)
    {
        ArgumentNullException.ThrowIfNull(losses);
        if (!losses.Contains(loss, StringComparer.Ordinal))
        {
            losses.Add(loss);
        }
    }

    // Cleans every piece of text once and enforces the byte budget, so no renderer has to do either.
    private static void SanitizeBlocks(IList<Block> blocks, int maximumBytes)
    {
        long remaining = maximumBytes;
        void Spend(ref string? text)
        {
            if (text is null)
            {
                return;
            }
            text = TextRules.Sanitize(text);
            remaining -= System.Text.Encoding.UTF8.GetByteCount(text);
        }
        void Runs(IList<Run>? runs)
        {
            foreach (var run in runs ?? [])
            {
                var text = run.Text;
                Spend(ref text!);
                run.Text = text!;
            }
        }
        RenderTree.Walk(blocks, block =>
        {
            Runs(block.Runs);
            Runs(block.Summary);
            var text = block.Text;
            Spend(ref text);
            block.Text = text;
            var alt = block.Alt;
            Spend(ref alt);
            block.Alt = alt;
            foreach (var row in block.RowsOrEmpty)
            {
                foreach (var cell in row.Cells)
                {
                    Runs(cell);
                }
            }
        });
        if (remaining < 0)
        {
            throw new StreamLimitException("projection exceeds the byte limit");
        }
    }

    // Sections the worker adds after the body. They are text the worker owns, not document content.
    private static (List<Block> Blocks, List<string> Losses) Sections(Bundle bundle, JsonObject? properties)
    {
        var blocks = new List<Block>();
        var losses = new List<string>();
        if (PublicKeys(properties).Count > 0)
        {
            blocks.Add(RenderTree.Heading(2, "Properties"));
            blocks.Add(PropertyList(properties));
        }
        if (IsValue(bundle.Schema) && bundle.Schema!.Value.ValueKind == JsonValueKind.Object
            && bundle.Schema.Value.TryGetProperty("properties", out var schemaProperties) && schemaProperties.ValueKind == JsonValueKind.Array)
        {
            var list = schemaProperties.EnumerateArray().Where(property => property.ValueKind == JsonValueKind.Object).ToList();
            if (list.Count > 0)
            {
                blocks.Add(RenderTree.Heading(2, "Fields"));
            }
            foreach (var property in list)
            {
                var asObject = JsonObject.Create(property)!;
                blocks.Add(RenderTree.Heading(3, DisplayValue(asObject["label"], 0)));
                blocks.Add(PropertyList(asObject));
            }
        }
        var views = IsValue(bundle.Views) && bundle.Views!.Value.ValueKind == JsonValueKind.Object
            && bundle.Views.Value.TryGetProperty("views", out var viewList) && viewList.ValueKind == JsonValueKind.Array
            ? viewList.EnumerateArray().Where(view => view.ValueKind == JsonValueKind.Object).ToList()
            : [];
        if (views.Count > 0)
        {
            blocks.Add(RenderTree.Heading(2, "Views"));
            foreach (var view in views)
            {
                var name = Text(view, "name");
                var kind = Text(view, "kind");
                blocks.Add(RenderTree.Heading(3, name + " (" + kind.Replace("_", " ", StringComparison.Ordinal) + ")"));
                if (view.TryGetProperty("columns", out var columns) && columns.ValueKind == JsonValueKind.Array && columns.GetArrayLength() > 0)
                {
                    blocks.Add(RenderTree.Paragraph("Fields: " + string.Join(", ", columns.EnumerateArray().Select(column => column.ValueKind == JsonValueKind.String ? column.GetString() : string.Empty))));
                }
                if (Text(view, "groupBy") is { Length: > 0 } groupBy)
                {
                    blocks.Add(RenderTree.Paragraph("Group by: " + groupBy));
                }
                if (Text(view, "dateProperty") is { Length: > 0 } dateProperty)
                {
                    blocks.Add(RenderTree.Paragraph("Date field: " + dateProperty));
                }
                if (view.TryGetProperty("filters", out var filters) && filters.ValueKind == JsonValueKind.Array && filters.GetArrayLength() > 0)
                {
                    blocks.Add(RenderTree.Paragraph("Saved filters: " + DisplayValue(JsonNode.Parse(filters.GetRawText()), 0)));
                }
                if (kind == "interactive_form" && view.TryGetProperty("interactiveForm", out var form) && form.ValueKind == JsonValueKind.Object)
                {
                    blocks.Add(RenderTree.Paragraph("Static form. All pages and conditional fields are shown."));
                    blocks.Add(PropertyList(JsonObject.Create(form)));
                }
                else
                {
                    blocks.Add(RenderTree.Paragraph("Readable source records are included below."));
                }
            }
            blocks.Add(RenderTree.Heading(3, "Source records"));
            blocks.Add(RenderTree.Paragraph("Static snapshot of accessible children. Saved queries, filters, chart calculations, habit check-in history and live controls are not evaluated here."));
            losses.Add("Views are represented by their accessible source records and form content; live queries, calculations and interactions are not reproduced.");
            if ((bundle.ViewRows?.Count ?? 0) == 0)
            {
                blocks.Add(RenderTree.Paragraph("No accessible source records were included."));
            }
            foreach (var raw in bundle.ViewRows ?? [])
            {
                if (raw.ValueKind != JsonValueKind.Object)
                {
                    throw new ArchiveFormatException("decode export source row: not an object");
                }
                var row = JsonObject.Create(raw)!;
                blocks.Add(RenderTree.Heading(4, row["title"]?.GetValueKind() == JsonValueKind.String ? row["title"]!.GetValue<string>() : string.Empty));
                var id = row["id"]?.GetValueKind() == JsonValueKind.String ? row["id"]!.GetValue<string>() : string.Empty;
                if (id.Length > 0)
                {
                    blocks.Add(new Block { Kind = "paragraph", Runs = [new Run { Text = "Open source", Href = "nix://item/" + id }] });
                }
                blocks.Add(PropertyList(row["properties"] as JsonObject));
            }
            if (bundle.ViewRowsTruncated)
            {
                blocks.Add(RenderTree.Paragraph("Source records are incomplete: the export limit was reached or some records were unavailable."));
                losses.Add("The exported view source records are incomplete.");
            }
        }
        if (IsValue(bundle.Comments))
        {
            if (bundle.Comments!.Value.ValueKind != JsonValueKind.Array)
            {
                throw new ArchiveFormatException("decode export comments: not an array");
            }
            var threads = bundle.Comments.Value.EnumerateArray().ToList();
            if (threads.Count > 0)
            {
                blocks.Add(RenderTree.Heading(2, "Comments"));
            }
            foreach (var thread in threads)
            {
                if (Text(thread, "quote") is { Length: > 0 } quote)
                {
                    blocks.Add(RenderTree.Quote(quote));
                }
                if (thread.TryGetProperty("resolved", out var resolved) && resolved.ValueKind == JsonValueKind.True)
                {
                    blocks.Add(RenderTree.Paragraph("(Resolved)"));
                }
                if (thread.TryGetProperty("comments", out var comments) && comments.ValueKind == JsonValueKind.Array)
                {
                    foreach (var comment in comments.EnumerateArray())
                    {
                        var date = Text(comment, "createdAt");
                        if (date.Length >= 10)
                        {
                            date = date[..10];
                        }
                        blocks.Add(new Block { Kind = "paragraph", Runs = [new Run { Text = Text(comment, "author"), Styles = ["bold"] }, new Run { Text = " · " + date }] });
                        blocks.Add(RenderTree.Paragraph(Text(comment, "body")));
                    }
                }
            }
        }
        return (blocks, losses);
    }

    private static string Text(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString()! : string.Empty;

    // Non-prose bodies are inventoried as text rather than disappearing from document exports.
    private static (List<Block> Blocks, List<string> Losses) ProjectNonProseBody(JsonElement body)
    {
        if (body.ValueKind != JsonValueKind.Object)
        {
            throw new ArchiveFormatException("decode body: not an object");
        }
        var envelope = JsonObject.Create(body)!;
        if (envelope.ContainsKey("prosemirror"))
        {
            throw new ArchiveFormatException("document body arrived as ProseMirror; the export source must be fetched with shape=render");
        }
        var blocks = new List<Block>();
        var losses = new List<string>();
        if (envelope["sheet"] is JsonObject sheet)
        {
            var cells = sheet["cells"] as JsonObject;
            blocks.Add(RenderTree.Heading(2, "Spreadsheet"));
            blocks.Add(RenderTree.Paragraph("Cell contents, including formulas as written."));
            var lines = SortedKeys(cells).Select(key => key + ": " + (cells![key]?.GetValueKind() == JsonValueKind.String ? cells[key]!.GetValue<string>() : string.Empty)).ToList();
            blocks.Add(lines.Count == 0 ? RenderTree.Paragraph("Empty spreadsheet.") : RenderTree.Bullets(lines));
            losses.Add("Spreadsheet cells and formulas are shown as text; formulas are not recalculated and grid styling is not preserved.");
        }
        else if (envelope["canvas"] is JsonObject canvas)
        {
            var elements = canvas["elements"] as JsonObject;
            blocks.Add(RenderTree.Heading(2, "Canvas"));
            blocks.Add(RenderTree.Paragraph("Static element inventory with text, geometry and connections."));
            var count = 0;
            foreach (var id in SortedKeys(elements))
            {
                if (elements![id] is not JsonObject element || (element["isDeleted"]?.GetValueKind() == JsonValueKind.True))
                {
                    continue;
                }
                count++;
                blocks.Add(RenderTree.Heading(3, DisplayValue(element["type"], 0) + " " + id));
                var lines = new List<string>();
                foreach (var key in new[] { "text", "originalText", "x", "y", "width", "height", "angle", "link", "strokeColor", "backgroundColor", "fillStyle", "fontSize", "startBinding", "endBinding", "points", "customData" })
                {
                    if (element.ContainsKey(key))
                    {
                        lines.Add(key + ": " + DisplayValue(element[key], 0));
                    }
                }
                if (lines.Count > 0)
                {
                    blocks.Add(RenderTree.Bullets(lines));
                }
            }
            if (count == 0)
            {
                blocks.Add(RenderTree.Paragraph("Empty canvas."));
            }
            losses.Add("Canvas elements are represented as a text inventory; their visual arrangement is described rather than drawn.");
        }
        else
        {
            if (envelope.Count == 0)
            {
                return (blocks, losses);
            }
            blocks.Add(RenderTree.Heading(2, "Content"));
            blocks.Add(RenderTree.Paragraph("Readable representation of this body's stored fields."));
            var lines = SortedKeys(envelope)
                .Where(key => key != "schemaVersion" && !key.StartsWith('$'))
                .Select(key => key + ": " + DisplayValue(envelope[key], 0))
                .ToList();
            if (lines.Count > 0)
            {
                blocks.Add(RenderTree.Bullets(lines));
            }
            losses.Add("An unfamiliar body kind was represented by its readable stored fields.");
        }
        return (blocks, losses);
    }

    public static IReadOnlyList<string> PublicKeys(JsonObject? values) =>
        SortedKeys(values).Where(key => !key.StartsWith('$') && !key.StartsWith("_nix", StringComparison.Ordinal)).ToList();

    private static List<string> SortedKeys(JsonObject? values) =>
        values is null ? [] : values.Select(pair => pair.Key).OrderBy(key => key, StringComparer.Ordinal).ToList();

    /// <summary>One bullet per public key, in key order.</summary>
    public static Block PropertyList(JsonObject? values) =>
        RenderTree.Bullets(PublicKeys(values).Select(key => key + ": " + DisplayValue(values![key], 0)));

    /// <summary>Go's <c>displayValue</c>: strings bare, lists and objects joined with "; ", numbers as the source text.</summary>
    public static string DisplayValue(JsonNode? value, int depth)
    {
        if (depth > MaximumPortableDepth)
        {
            return "[Value exceeds nesting limit]";
        }
        switch (value)
        {
            case null:
                return "Unset";
            case JsonArray array:
                return string.Join("; ", array.Select(entry => DisplayValue(entry, depth + 1)));
            case JsonObject obj:
                return string.Join("; ", PublicKeys(obj).Select(key => key + ": " + DisplayValue(obj[key], depth + 1)));
            case JsonValue leaf:
                return leaf.GetValueKind() switch
                {
                    JsonValueKind.String => leaf.GetValue<string>(),
                    JsonValueKind.True => "true",
                    JsonValueKind.False => "false",
                    JsonValueKind.Null => "Unset",
                    // Go decoded numbers with UseNumber, so the source digits are printed as written.
                    _ => leaf.ToJsonString(),
                };
            default:
                return value.ToJsonString();
        }
    }

    internal static string Invariant(long value) => value.ToString(CultureInfo.InvariantCulture);
}
