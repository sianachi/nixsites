#pragma warning disable CA2227 // Justification: wire shapes the stream deserialises; the handler rewrites the file list in place.
#pragma warning disable CA1819 // Justification: Raw is the exact source line, handed to the archive writer whole.
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Nix.Workers.Archive;

/// <summary>The <c>.nix</c> archive contract: manifest, bundles, file versions and their bounds.</summary>
public static partial class NixArchive
{
    public const string Format = "nix-archive";
    public const int FormatVersion = 1;
    public const int FileFormatVersion = 2;
    public const int MaxFileVersionsPerItem = 100;
    public const int MaxArchiveEntries = 100_001;
    public const int MaxArchiveItems = 10_000;
    public const long MaxFileVersionBytes = 100L << 20;

    public static bool SafeId(string? value) => value is not null && SafeIdPattern().IsMatch(value);

    public static bool SafeSha256(string? value) => value is not null && Sha256Pattern().IsMatch(value);

    public static void ValidateManifest(Manifest manifest, int maxItems)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        if (manifest.Format != Format || (manifest.FormatVersion != FormatVersion && manifest.FormatVersion != FileFormatVersion))
        {
            throw new ArchiveFormatException("unsupported Nix archive format");
        }
        if (string.IsNullOrEmpty(manifest.Root) || !SafeId(manifest.Root))
        {
            throw new ArchiveFormatException("manifest root is not a safe item identifier");
        }
        if (manifest.Items.Count == 0 || manifest.Items.Count > maxItems)
        {
            throw new ArchiveFormatException("manifest item count is outside limits");
        }
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in manifest.Items)
        {
            if (!SafeId(item.Id) || string.IsNullOrEmpty(item.Title) || string.IsNullOrEmpty(item.Seq))
            {
                throw new ArchiveFormatException("manifest contains an invalid item");
            }
            if (!seen.Add(item.Id))
            {
                throw new ArchiveFormatException($"manifest contains duplicate item {item.Id}");
            }
        }
        if (!seen.Contains(manifest.Root))
        {
            throw new ArchiveFormatException("manifest root is not listed");
        }
        if (manifest.Omitted.Count > maxItems || manifest.Loss.Count > 128)
        {
            throw new ArchiveFormatException("manifest report count is outside limits");
        }
        if (manifest.FormatVersion == FormatVersion)
        {
            if (manifest.Files is not null)
            {
                throw new ArchiveFormatException("Nix archive v1 cannot declare file versions");
            }
        }
        else
        {
            if (manifest.Files is null)
            {
                throw new ArchiveFormatException("Nix archive v2 must declare file versions");
            }
            ValidateFileVersions(manifest.Files, manifest.Items);
        }
        foreach (var omission in manifest.Omitted)
        {
            if ((omission.Id is not null && !SafeId(omission.Id))
                || (!string.IsNullOrEmpty(omission.ParentId) && !SafeId(omission.ParentId))
                || !SafeReportText(omission.Reason, 64) || !SafeReportText(omission.Detail, 500))
            {
                throw new ArchiveFormatException("manifest contains an invalid omission");
            }
        }
        foreach (var loss in manifest.Loss)
        {
            if ((!string.IsNullOrEmpty(loss.ItemId) && !SafeId(loss.ItemId)) || !SafeReportText(loss.Kind, 64) || !SafeReportText(loss.Detail, 500))
            {
                throw new ArchiveFormatException("manifest contains an invalid loss entry");
            }
        }
    }

    public static void ValidateFileVersions(IList<FileVersionEntry> entries, IList<ManifestItem> items)
    {
        ArgumentNullException.ThrowIfNull(entries);
        ArgumentNullException.ThrowIfNull(items);
        var fileItems = items.Where(item => string.Equals(item.Type, "file", StringComparison.OrdinalIgnoreCase)).Select(item => item.Id).ToHashSet(StringComparer.Ordinal);
        var byItem = new Dictionary<string, List<FileVersionEntry>>(StringComparer.Ordinal);
        foreach (var entry in entries)
        {
            if (!SafeId(entry.ItemId) || !SafeFileName(entry.FileName) || !SafeMediaType(entry.MediaType)
                || entry.Version < 1 || entry.Version > MaxFileVersionsPerItem || entry.ByteLength < 0 || entry.ByteLength > MaxFileVersionBytes
                || !SafeSha256(entry.Sha256) || !ValidFileDimensions(entry))
            {
                throw new ArchiveFormatException("Nix archive v2 contains invalid file-version metadata");
            }
            if (!fileItems.Contains(entry.ItemId))
            {
                throw new ArchiveFormatException($"Nix archive v2 describes a non-file item {entry.ItemId}");
            }
            if (!byItem.TryGetValue(entry.ItemId, out var versions))
            {
                versions = [];
                byItem[entry.ItemId] = versions;
            }
            if (versions.Any(existing => existing.Version == entry.Version))
            {
                throw new ArchiveFormatException("Nix archive v2 contains a duplicate file version");
            }
            versions.Add(entry);
        }
        if (byItem.Count != fileItems.Count)
        {
            throw new ArchiveFormatException("Nix archive v2 must describe every file item");
        }
        foreach (var itemId in fileItems)
        {
            var versions = byItem.GetValueOrDefault(itemId) ?? [];
            if (versions.Count == 0 || versions.Count > MaxFileVersionsPerItem)
            {
                throw new ArchiveFormatException("Nix archive v2 file history is outside limits");
            }
            var currentCount = 0;
            for (var version = 1; version <= versions.Count; version++)
            {
                var found = false;
                foreach (var entry in versions)
                {
                    if (entry.Version != version)
                    {
                        continue;
                    }
                    found = true;
                    if (entry.Current)
                    {
                        currentCount++;
                        if (version != versions.Count)
                        {
                            throw new ArchiveFormatException("Nix archive v2 current file version must be newest");
                        }
                    }
                }
                if (!found)
                {
                    throw new ArchiveFormatException("Nix archive v2 file versions must be contiguous");
                }
            }
            if (currentCount != 1)
            {
                throw new ArchiveFormatException("Nix archive v2 must declare exactly one current file version");
            }
        }
    }

    public static bool SafeFileName(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 255 || value.IndexOfAny(['/', '\\', '\0']) >= 0)
        {
            return false;
        }
        return value.All(c => c >= 0x20 && c != 0x7f);
    }

    public static bool SafeMediaType(string? value)
    {
        if (value is null)
        {
            return false;
        }
        var separator = value.IndexOf('/', StringComparison.Ordinal);
        if (separator <= 0 || separator == value.Length - 1 || value.Length > 160 || value.IndexOfAny([';', '\\']) >= 0)
        {
            return false;
        }
        return value.All(c => c >= 0x21 && c <= 0x7e);
    }

    private static bool ValidFileDimensions(FileVersionEntry entry)
    {
        if (entry.PixelWidth is null && entry.PixelHeight is null)
        {
            return !entry.Previewable || (entry.MediaType == "application/pdf" && entry.ByteLength <= 10L << 20);
        }
        if (entry.PixelWidth is null || entry.PixelHeight is null || entry.PixelWidth <= 0 || entry.PixelHeight <= 0 || (long)entry.PixelWidth * entry.PixelHeight > 1_000_000_000)
        {
            return false;
        }
        return !entry.Previewable || (entry.ByteLength < 10L << 20 && (long)entry.PixelWidth * entry.PixelHeight <= 40_000_000);
    }

    public static bool SafeReportText(string? value, int maximum) =>
        !string.IsNullOrWhiteSpace(value) && value.Length <= maximum && value.IndexOfAny(['\r', '\n']) < 0;

    [GeneratedRegex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")]
    private static partial Regex SafeIdPattern();

    [GeneratedRegex("^[0-9a-f]{64}$")]
    private static partial Regex Sha256Pattern();
}

/// <summary>A manifest, as the stream's first line carries it. <see cref="Raw"/> is that line, kept so the archive writes it unchanged.</summary>
public sealed class Manifest
{
    [JsonIgnore]
    public byte[]? Raw { get; set; } // byte[]: the exact source line, written through to the archive

    public string Format { get; set; } = string.Empty;

    public int FormatVersion { get; set; }

    public int SchemaVersion { get; set; }

    public string ExportedAt { get; set; } = string.Empty;

    public string Root { get; set; } = string.Empty;

    public JsonElement? RootEffectiveSchema { get; set; }

    public bool IncludesDeleted { get; set; }

    public IList<ManifestItem> Items { get; set; } = [];

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IList<FileVersionEntry>? Files { get; set; }

    public IList<Omission> Omitted { get; set; } = [];

    public IList<LossEntry> Loss { get; set; } = [];
}

public sealed record ManifestItem(string Id, string? ParentId, string Seq, string Title, string Type);

public sealed record Omission(string? Id, string? ParentId, string Reason, string Detail);

public sealed record LossEntry(string? ItemId, string Kind, string Detail);

public sealed record FileVersionEntry(
    string ItemId,
    int Version,
    bool Current,
    string FileName,
    string MediaType,
    long ByteLength,
    string Sha256,
    bool Previewable,
    int? PixelWidth,
    int? PixelHeight);

/// <summary>One item as Collab streams it. <see cref="Raw"/> is the exact line.</summary>
public sealed class Bundle
{
    [JsonIgnore]
    public byte[] Raw { get; set; } = []; // byte[]: the exact source line, written through to the archive

    public string Id { get; set; } = string.Empty;

    public string? ParentId { get; set; }

    public string WorkspaceId { get; set; } = string.Empty;

    public string Type { get; set; } = string.Empty;

    public string Title { get; set; } = string.Empty;

    public string Seq { get; set; } = string.Empty;

    public string LifecycleState { get; set; } = string.Empty;

    public string CreatedAt { get; set; } = string.Empty;

    public string UpdatedAt { get; set; } = string.Empty;

    public JsonObject? Properties { get; set; }

    public JsonElement? Recurrence { get; set; }

    public JsonElement? Schema { get; set; }

    public JsonElement? Views { get; set; }

    public IList<JsonElement>? ViewRows { get; set; }

    public bool ViewRowsTruncated { get; set; }

    public JsonElement? Body { get; set; }

    /// <summary>The body as a nix-render tree when the stream was asked for <c>shape=render</c>.</summary>
    public JsonElement? Render { get; set; }

    public IList<string>? BodyLosses { get; set; }

    /// <summary>Present only when the export asked for comment threads.</summary>
    public JsonElement? Comments { get; set; }
}

public class ArchiveFormatException : Exception
{
    public ArchiveFormatException(string message)
        : base(message)
    {
    }

    public ArchiveFormatException()
    {
    }

    public ArchiveFormatException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}

/// <summary>The stream's and the ".nix" input's JSON: camelCase, unknown members ignored as Go's decoder ignored them.</summary>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(Manifest))]
[JsonSerializable(typeof(Bundle))]
[JsonSerializable(typeof(StreamEnd))]
internal sealed partial class ArchiveJsonContext : JsonSerializerContext;

internal sealed record StreamEnd(bool End, int Items);
