#pragma warning disable CA2227 // Justification: the tree is mutable on purpose; projection and the renderers edit it in place, as the Go structs were.
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Nix.Workers.Render;

/// <summary>A span of text in one style, optionally a link.</summary>
public sealed class Run
{
    public string Text { get; set; } = string.Empty;

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IList<string>? Styles { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Href { get; set; }

    public bool Has(string style) => Styles is not null && Styles.Contains(style, StringComparer.Ordinal);
}

public sealed class ListItem
{
    /// <summary>Present on task-list items only.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Checked { get; set; }

    public IList<Block> Blocks { get; set; } = [];
}

public sealed class Row
{
    public bool Header { get; set; }

    public IList<IList<Run>> Cells { get; set; } = [];
}

/// <summary>
/// Every block kind in one class: the members a kind does not use stay at their defaults. The
/// shape the Go worker read, and the shape Collab's <c>packages/export/src/render.ts</c> writes.
/// </summary>
public sealed class Block
{
    public string Kind { get; set; } = string.Empty;

    // paragraph, heading
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IList<Run>? Runs { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public int Level { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Align { get; set; }

    // callout
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Tone { get; set; }

    // code
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Language { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Text { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? RenderFile { get; set; }

    // image
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Src { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Alt { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? File { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public int Width { get; set; }

    // list
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool Ordered { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public int Start { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IList<ListItem>? Items { get; set; }

    // table
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IList<Row>? Rows { get; set; }

    // details
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IList<Run>? Summary { get; set; }

    // quote, callout, details
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IList<Block>? Blocks { get; set; }

    /// <summary>The runs, never null, for renderers.</summary>
    [JsonIgnore]
    public IList<Run> RunsOrEmpty => Runs ?? [];

    [JsonIgnore]
    public IList<Block> BlocksOrEmpty => Blocks ?? [];

    [JsonIgnore]
    public IList<ListItem> ItemsOrEmpty => Items ?? [];

    [JsonIgnore]
    public IList<Row> RowsOrEmpty => Rows ?? [];

    [JsonIgnore]
    public IList<Run> SummaryOrEmpty => Summary ?? [];
}

public sealed class RenderDocument
{
    public string Format { get; set; } = string.Empty;

    public int Version { get; set; }

    public IList<Block> Blocks { get; set; } = [];

    public IList<string> Losses { get; set; } = [];
}

/// <summary>
/// The Nix side of <c>nix-render</c>: the presentation tree Collab produces from a document body
/// and the only shape of a body the exporter ever reads. A reader rejects an unknown format or
/// major version outright and skips an unknown block kind with a loss.
/// </summary>
public static class RenderTree
{
    public const string Format = "nix-render";
    public const int Version = 1;
    private const int MaximumDepth = 64;

    /// <summary>Kinds this build draws. Anything else is reported and skipped.</summary>
    public static IReadOnlyList<string> Kinds { get; } = ["paragraph", "heading", "quote", "callout", "code", "rule", "pageBreak", "image", "list", "table", "details"];

    public static bool Known(string kind) => Kinds.Contains(kind, StringComparer.Ordinal);

    /// <summary>Reads a tree; the version check is the whole contract.</summary>
    public static RenderDocument Decode(ReadOnlySpan<byte> raw)
    {
        RenderDocument? document;
        try
        {
            document = JsonSerializer.Deserialize(raw, RenderJsonContext.Default.RenderDocument);
        }
        catch (JsonException exception)
        {
            throw new FormatException("decode render tree: " + exception.Message, exception);
        }
        if (document is null)
        {
            throw new FormatException("decode render tree: empty");
        }
        if (document.Format != Format || document.Version != Version)
        {
            throw new FormatException($"unsupported render tree \"{document.Format}\" version {document.Version}; this worker reads {Format} version {Version}");
        }
        if (Depth(document.Blocks, 0) > MaximumDepth)
        {
            throw new FormatException("render tree exceeds the nesting limit");
        }
        document.Losses ??= [];
        return document;
    }

    private static int Depth(IList<Block>? blocks, int current)
    {
        var deepest = current;
        foreach (var block in blocks ?? [])
        {
            if (current + 1 > MaximumDepth)
            {
                return current + 1;
            }
            deepest = Math.Max(deepest, Depth(block.Blocks, current + 1));
            foreach (var item in block.ItemsOrEmpty)
            {
                deepest = Math.Max(deepest, Depth(item.Blocks, current + 1));
            }
        }
        return deepest;
    }

    /// <summary>Visits every block, depth first, including those nested in quotes, lists and details.</summary>
    public static void Walk(IList<Block>? blocks, Action<Block> visit)
    {
        ArgumentNullException.ThrowIfNull(visit);
        foreach (var block in blocks ?? [])
        {
            visit(block);
            Walk(block.Blocks, visit);
            foreach (var item in block.ItemsOrEmpty)
            {
                Walk(item.Blocks, visit);
            }
        }
    }

    /// <summary>The text of runs without any styling.</summary>
    public static string Plain(IList<Run>? runs) => string.Concat((runs ?? []).Select(run => run.Text));

    public static Block Paragraph(string text) => new() { Kind = "paragraph", Runs = [new Run { Text = text }] };

    public static Block Heading(int level, string text) => new() { Kind = "heading", Level = level, Runs = [new Run { Text = text }] };

    public static Block Bullets(IEnumerable<string> lines) => new()
    {
        Kind = "list",
        Items = [.. lines.Select(line => new ListItem { Blocks = [Paragraph(line)] })],
    };

    public static Block Quote(string text) => new() { Kind = "quote", Blocks = [Paragraph(text)] };
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(RenderDocument))]
internal sealed partial class RenderJsonContext : JsonSerializerContext;
