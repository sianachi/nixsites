#pragma warning disable CA2227 // Justification: plan DTOs are the wire shape the handlers read and tests edit in place.
using System.Diagnostics.CodeAnalysis;
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

    [AllowNull]
    public IList<ImportItem> Items { get; set => field = value ?? []; } = [];

    /// <summary>Present for a .nix v2 archive only.</summary>
    public IList<FileVersionEntry>? FileVersions { get; set; }

    [AllowNull]
    public IList<string> Loss { get; set => field = value ?? []; } = [];

    [AllowNull]
    public IList<string> Omissions { get; set => field = value ?? []; } = [];
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

/// <summary>Writes and reads the plan JSON. A retry must write the same bytes, so the order here is fixed.</summary>
internal static class PlanJson
{
    public static byte[] Write(ImportPlan plan) => WorkerJson.Write(writer =>
    {
        writer.WriteStartObject();
        writer.WriteNumber("version", plan.Version);
        writer.WriteString("format", plan.Format);
        writer.WriteString("title", plan.Title);
        writer.WriteString("sourceSha256", plan.SourceSha256);
        writer.WriteStartArray("items");
        foreach (var item in plan.Items)
        {
            WriteItem(writer, item);
        }
        writer.WriteEndArray();
        if (plan.FileVersions is { Count: > 0 })
        {
            WriteFileVersions(writer, "fileVersions", plan.FileVersions);
        }
        WorkerJson.WriteStrings(writer, "loss", plan.Loss);
        WorkerJson.WriteStrings(writer, "omissions", plan.Omissions);
        writer.WriteEndObject();
    });

    public static void WriteFileVersions(Utf8JsonWriter writer, string name, IList<FileVersionEntry> files)
    {
        writer.WriteStartArray(name);
        foreach (var file in files)
        {
            writer.WriteStartObject();
            writer.WriteString("itemId", file.ItemId);
            writer.WriteNumber("version", file.Version);
            writer.WriteBoolean("current", file.Current);
            writer.WriteString("fileName", file.FileName);
            writer.WriteString("mediaType", file.MediaType);
            writer.WriteNumber("byteLength", file.ByteLength);
            writer.WriteString("sha256", file.Sha256);
            writer.WriteBoolean("previewable", file.Previewable);
            WriteNullableNumber(writer, "pixelWidth", file.PixelWidth);
            WriteNullableNumber(writer, "pixelHeight", file.PixelHeight);
            writer.WriteEndObject();
        }
        writer.WriteEndArray();
    }

    private static void WriteNullableNumber(Utf8JsonWriter writer, string name, int? value)
    {
        if (value is { } number)
        {
            writer.WriteNumber(name, number);
        }
        else
        {
            writer.WriteNull(name);
        }
    }

    private static void WriteItem(Utf8JsonWriter writer, ImportItem item)
    {
        writer.WriteStartObject();
        writer.WriteString("sourceId", item.SourceId);
        writer.WriteString("parentSourceId", item.ParentSourceId);
        writer.WriteNumber("order", item.Order);
        writer.WriteString("title", item.Title);
        writer.WriteString("itemType", item.ItemType);
        WorkerJson.WriteOptionalRaw(writer, "properties", item.Properties);
        WorkerJson.WriteOptionalRaw(writer, "recurrence", item.Recurrence);
        WorkerJson.WriteOptionalRaw(writer, "schema", item.Schema);
        WorkerJson.WriteOptionalRaw(writer, "views", item.Views);
        writer.WriteString("finalLifecycleState", item.FinalLifecycleState);
        if (item.Body is { } body)
        {
            writer.WriteStartObject("body");
            writer.WriteString("encoding", body.Encoding);
            if (!string.IsNullOrEmpty(body.Text))
            {
                writer.WriteString("text", body.Text);
            }
            WorkerJson.WriteOptionalRaw(writer, "render", body.Render);
            WorkerJson.WriteOptionalRaw(writer, "archive", body.Archive);
            writer.WriteEndObject();
        }
        if (item.File is { } file)
        {
            writer.WriteStartObject("file");
            writer.WriteString("sourceKind", file.SourceKind);
            if (file.AssetPath is not null)
            {
                writer.WriteString("assetPath", file.AssetPath);
            }
            writer.WriteString("fileName", file.FileName);
            writer.WriteString("mediaType", file.MediaType);
            writer.WriteNumber("byteLength", file.ByteLength);
            writer.WriteString("sha256", file.Sha256);
            writer.WriteBoolean("previewable", file.Previewable);
            if (file.PixelWidth is { } width)
            {
                writer.WriteNumber("pixelWidth", width);
            }
            if (file.PixelHeight is { } height)
            {
                writer.WriteNumber("pixelHeight", height);
            }
            writer.WriteEndObject();
        }
        WorkerJson.WriteOptionalRaw(writer, "comments", item.Comments);
        writer.WriteEndObject();
    }

    public static ImportPlan Read(JsonElement root) =>
        WorkerJson.Read(root, ImportJsonContext.Default.ImportPlan) ?? new ImportPlan();
}
