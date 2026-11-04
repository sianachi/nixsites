#pragma warning disable CA2227 // Justification: plan DTOs are the wire shape the handlers read and tests edit in place, as the Go structs were.
using System.Text.Json;
using Nix.Workers.Archive;

namespace Nix.Workers.Import;

/// <summary>An uploaded source as the worker downloaded it. <see cref="Bytes"/> and <see cref="Sha256"/> describe the file at <see cref="Path"/>.</summary>
public sealed record ImportSource(string Path, string Format, string Title, string FileName, string MediaType, long Bytes, string Sha256);

/// <summary>Every bound a parse or plan read enforces (Go's importplan.Limits).</summary>
public sealed record ImportPlanLimits(
    long MaxSourceBytes,
    long MaxPlanBytes,
    long MaxBodyBytes,
    long MaxEntryBytes,
    int MaxItems,
    int MaxDepth,
    int PdfTimeoutSecs);

/// <summary>
/// The one failure type of the import planner. <see cref="Code"/> is the job failure code the Go
/// handler derived from the error's identity (importFailureCode); everything unclassified is
/// <see cref="SourceInvalid"/>. Encode and Decode failures carry <see cref="PlanInvalid"/>.
/// </summary>
public sealed class ImportPlanException : Exception
{
    public const string SourceInvalid = "import_source_invalid";
    public const string FormatUnsupported = "import_format_unsupported";
    public const string OcrUnavailable = "import_ocr_unavailable";
    public const string PdfEncrypted = "import_pdf_encrypted";
    public const string PlanInvalid = "import_plan_invalid";

    public ImportPlanException()
        : this(SourceInvalid, "import failed")
    {
    }

    public ImportPlanException(string message)
        : this(SourceInvalid, message)
    {
    }

    public ImportPlanException(string message, Exception innerException)
        : base(message, innerException)
    {
        Code = SourceInvalid;
    }

    public ImportPlanException(string code, string message, Exception? innerException = null)
        : base(message, innerException)
    {
        Code = code;
    }

    public string Code { get; }
}

public sealed class ImportPlan
{
    public const int CurrentVersion = 1;

    public int Version { get; set; }

    public string Format { get; set; } = string.Empty;

    public string Title { get; set; } = string.Empty;

    public string SourceSha256 { get; set; } = string.Empty;

    public IList<ImportItem> Items { get; set; } = [];

    /// <summary>Present for a .nix v2 archive only.</summary>
    public IList<FileVersionEntry>? FileVersions { get; set; }

    public IList<string> Loss { get; set; } = [];

    public IList<string> Omissions { get; set; } = [];
}

public sealed class ImportItem
{
    public string SourceId { get; set; } = string.Empty;

    public string? ParentSourceId { get; set; }

    public int Order { get; set; }

    public string Title { get; set; } = string.Empty;

    public string ItemType { get; set; } = string.Empty;

    public JsonElement? Properties { get; set; }

    public JsonElement? Recurrence { get; set; }

    public JsonElement? Schema { get; set; }

    public JsonElement? Views { get; set; }

    public string FinalLifecycleState { get; set; } = string.Empty;

    public ImportBody? Body { get; set; }

    public ImportFile? File { get; set; }

    /// <summary>The exported threads ([{id, quote, resolved, comments: [{author, body, createdAt}]}]); Core bounds and stores them.</summary>
    public JsonElement? Comments { get; set; }
}

public sealed class ImportBody
{
    public string Encoding { get; set; } = string.Empty;

    public string? Text { get; set; }

    /// <summary>A nix-render tree, the only document shape this worker emits.</summary>
    public JsonElement? Render { get; set; }

    public JsonElement? Archive { get; set; }
}

public sealed class ImportFile
{
    public string SourceKind { get; set; } = string.Empty;

    public string? AssetPath { get; set; }

    public string FileName { get; set; } = string.Empty;

    public string MediaType { get; set; } = string.Empty;

    public long ByteLength { get; set; }

    public string Sha256 { get; set; } = string.Empty;

    public bool Previewable { get; set; }

    public int? PixelWidth { get; set; }

    public int? PixelHeight { get; set; }
}

/// <summary>Writes and reads the plan JSON exactly as the Go worker did (see <see cref="GoJsonWriter"/>).</summary>
internal static class PlanJson
{
    public static byte[] Write(ImportPlan plan)
    {
        var writer = new GoJsonWriter();
        writer.Begin()
            .Name("version").Number(plan.Version)
            .Name("format").String(plan.Format)
            .Name("title").String(plan.Title)
            .Name("sourceSha256").String(plan.SourceSha256)
            .Name("items").BeginArray();
        foreach (var item in plan.Items)
        {
            WriteItem(writer, item);
        }
        writer.EndArray();
        if (plan.FileVersions is { Count: > 0 })
        {
            writer.Name("fileVersions");
            WriteFileVersions(writer, plan.FileVersions);
        }
        writer.Name("loss").Strings(plan.Loss).Name("omissions").Strings(plan.Omissions).End();
        return writer.ToUtf8();
    }

    public static void WriteFileVersions(GoJsonWriter writer, IList<FileVersionEntry> files)
    {
        writer.BeginArray();
        foreach (var file in files)
        {
            writer.Begin()
                .Name("itemId").String(file.ItemId)
                .Name("version").Number(file.Version)
                .Name("current").Bool(file.Current)
                .Name("fileName").String(file.FileName)
                .Name("mediaType").String(file.MediaType)
                .Name("byteLength").Number(file.ByteLength)
                .Name("sha256").String(file.Sha256)
                .Name("previewable").Bool(file.Previewable)
                .Name("pixelWidth");
            if (file.PixelWidth is { } width)
            {
                writer.Number(width);
            }
            else
            {
                writer.Null();
            }
            writer.Name("pixelHeight");
            if (file.PixelHeight is { } height)
            {
                writer.Number(height);
            }
            else
            {
                writer.Null();
            }
            writer.End();
        }
        writer.EndArray();
    }

    private static void WriteItem(GoJsonWriter writer, ImportItem item)
    {
        writer.Begin()
            .Name("sourceId").String(item.SourceId)
            .Name("parentSourceId").String(item.ParentSourceId)
            .Name("order").Number(item.Order)
            .Name("title").String(item.Title)
            .Name("itemType").String(item.ItemType);
        OptionalRaw(writer, "properties", item.Properties);
        OptionalRaw(writer, "recurrence", item.Recurrence);
        OptionalRaw(writer, "schema", item.Schema);
        OptionalRaw(writer, "views", item.Views);
        writer.Name("finalLifecycleState").String(item.FinalLifecycleState);
        if (item.Body is { } body)
        {
            writer.Name("body").Begin().Name("encoding").String(body.Encoding);
            if (!string.IsNullOrEmpty(body.Text))
            {
                writer.Name("text").String(body.Text);
            }
            OptionalRaw(writer, "render", body.Render);
            OptionalRaw(writer, "archive", body.Archive);
            writer.End();
        }
        if (item.File is { } file)
        {
            writer.Name("file").Begin().Name("sourceKind").String(file.SourceKind);
            if (file.AssetPath is not null)
            {
                writer.Name("assetPath").String(file.AssetPath);
            }
            writer.Name("fileName").String(file.FileName)
                .Name("mediaType").String(file.MediaType)
                .Name("byteLength").Number(file.ByteLength)
                .Name("sha256").String(file.Sha256)
                .Name("previewable").Bool(file.Previewable);
            if (file.PixelWidth is { } width)
            {
                writer.Name("pixelWidth").Number(width);
            }
            if (file.PixelHeight is { } height)
            {
                writer.Name("pixelHeight").Number(height);
            }
            writer.End();
        }
        OptionalRaw(writer, "comments", item.Comments);
        writer.End();
    }

    /// <summary>Go's omitempty on a RawMessage: omitted only when absent.</summary>
    public static void OptionalRaw(GoJsonWriter writer, string name, JsonElement? value)
    {
        if (value is not null)
        {
            writer.Name(name).Raw(value);
        }
    }

    public static ImportPlan Read(JsonElement root)
    {
        var fields = GoFields.Require(root, true, "version", "format", "title", "sourceSha256", "items", "fileVersions", "loss", "omissions");
        return new ImportPlan
        {
            Version = fields.Int("version"),
            Format = fields.String("format"),
            Title = fields.String("title"),
            SourceSha256 = fields.String("sourceSha256"),
            Items = fields.List("items", ReadItem) ?? [],
            FileVersions = fields.List("fileVersions", ReadFileVersion),
            Loss = fields.List("loss", GoFields.StringValue) ?? [],
            Omissions = fields.List("omissions", GoFields.StringValue) ?? [],
        };
    }

    private static ImportItem ReadItem(JsonElement element)
    {
        var fields = GoFields.Require(element, true, "sourceId", "parentSourceId", "order", "title", "itemType", "properties", "recurrence", "schema", "views", "finalLifecycleState", "body", "file", "comments");
        var item = new ImportItem
        {
            SourceId = fields.String("sourceId"),
            ParentSourceId = fields.OptionalString("parentSourceId"),
            Order = fields.Int("order"),
            Title = fields.String("title"),
            ItemType = fields.String("itemType"),
            Properties = fields.Raw("properties"),
            Recurrence = fields.Raw("recurrence"),
            Schema = fields.Raw("schema"),
            Views = fields.Raw("views"),
            FinalLifecycleState = fields.String("finalLifecycleState"),
            Comments = fields.Raw("comments"),
        };
        if (fields.TryGet("body", out var bodyElement))
        {
            var body = GoFields.Require(bodyElement, true, "encoding", "text", "render", "archive");
            item.Body = new ImportBody { Encoding = body.String("encoding"), Text = body.OptionalString("text"), Render = body.Raw("render"), Archive = body.Raw("archive") };
        }
        if (fields.TryGet("file", out var fileElement))
        {
            var file = GoFields.Require(fileElement, true, "sourceKind", "assetPath", "fileName", "mediaType", "byteLength", "sha256", "previewable", "pixelWidth", "pixelHeight");
            item.File = new ImportFile
            {
                SourceKind = file.String("sourceKind"),
                AssetPath = file.OptionalString("assetPath"),
                FileName = file.String("fileName"),
                MediaType = file.String("mediaType"),
                ByteLength = file.Long("byteLength"),
                Sha256 = file.String("sha256"),
                Previewable = file.Bool("previewable"),
                PixelWidth = file.OptionalInt("pixelWidth"),
                PixelHeight = file.OptionalInt("pixelHeight"),
            };
        }
        return item;
    }

    private static readonly string[] FileVersionFields = ["itemId", "version", "current", "fileName", "mediaType", "byteLength", "sha256", "previewable", "pixelWidth", "pixelHeight"];

    /// <summary>nixarchive.FileVersionEntry's strict decode: no unknown member, every member present.</summary>
    public static FileVersionEntry ReadFileVersion(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            throw new JsonException("file-version metadata is not an object");
        }
        var fields = GoFields.Require(element, true, FileVersionFields);
        foreach (var name in FileVersionFields)
        {
            // Go checked the exact member names with a map decode.
            if (!element.TryGetProperty(name, out _))
            {
                throw new JsonException("file-version metadata is missing " + name);
            }
        }
        return new FileVersionEntry(
            fields.String("itemId"),
            fields.Int("version"),
            fields.Bool("current"),
            fields.String("fileName"),
            fields.String("mediaType"),
            fields.Long("byteLength"),
            fields.String("sha256"),
            fields.Bool("previewable"),
            fields.OptionalInt("pixelWidth"),
            fields.OptionalInt("pixelHeight"));
    }
}
