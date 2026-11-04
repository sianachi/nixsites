using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using Nix.Workers.Archive;

namespace Nix.Workers.Import;

internal sealed record NixManifestItem(string Id, string? ParentId, string Seq, string Title, string Type);

internal sealed record NixSchemaSnapshot(JsonElement? Properties, JsonElement? Declared, bool Inherit);

internal sealed record NixManifest(
    string Format,
    int FormatVersion,
    int SchemaVersion,
    JsonElement? Profile,
    string ExportedAt,
    string Root,
    NixSchemaSnapshot? RootEffectiveSchema,
    List<NixManifestItem> Items,
    List<FileVersionEntry>? Files,
    List<(string? Id, string ParentId, string Reason, string Detail)> Omitted,
    List<(string ItemId, string Kind, string Detail)> Loss);

internal sealed record NixBundle(
    string Id,
    string? ParentId,
    string WorkspaceId,
    string Type,
    string Title,
    string Seq,
    string LifecycleState,
    JsonElement? Properties,
    JsonElement? Recurrence,
    NixSchemaSnapshot? Schema,
    JsonElement? Views,
    JsonElement? ViewRows,
    JsonElement? Body,
    JsonElement? Comments);

internal sealed record ValidatedNixArchive(NixManifest Manifest, List<(NixManifestItem Entry, NixBundle Bundle)> Items);

/// <summary>Reads a .nix archive into a plan: every member listed, every payload matching its manifest entry, parents before children.</summary>
internal static class NixImport
{
    private const string ArchiveFormat = "nix-archive";
    private const int SchemaMinimum = 1;

    // Keep this in lockstep with @nix/editor-schema's SCHEMA_VERSION. The importer preserves newer
    // ProseMirror content opaquely after checking the body envelope.
    private const int SchemaMaximum = 7;

    private static readonly HashSet<string> PropertyTypes = new(StringComparer.Ordinal)
    {
        "text", "number", "select", "multi_select", "date", "checkbox", "url", "timestamp", "image", "due_date", "start_date",
        "completion", "priority", "estimate", "assignee", "long_text", "formula", "rollup", "datetime", "reminder",
    };

    private static readonly HashSet<string> Aggregates = new(StringComparer.Ordinal) { "count", "sum", "min", "max", "average", "any", "all" };

    public static ImportPlan Parse(ImportSource source, ImportPlanLimits limits, CancellationToken cancellationToken)
    {
        var parsed = Validate(source, limits, cancellationToken);
        var items = new List<ImportItem>(parsed.Items.Count);
        var orders = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var (entry, bundle) in parsed.Items)
        {
            var parentKey = entry.ParentId ?? "$root";
            var order = orders.GetValueOrDefault(parentKey);
            orders[parentKey] = order + 1;
            items.Add(new ImportItem
            {
                SourceId = entry.Id,
                ParentSourceId = entry.ParentId,
                Order = order,
                Title = bundle.Title,
                ItemType = bundle.Type,
                Properties = bundle.Properties,
                Recurrence = GoJson.Nullable(bundle.Recurrence),
                Schema = ImportSchema(entry.Id == parsed.Manifest.Root, parsed.Manifest.RootEffectiveSchema, bundle.Schema),
                Views = GoJson.Nullable(bundle.Views),
                FinalLifecycleState = bundle.LifecycleState,
                Comments = GoJson.Nullable(bundle.Comments),
                Body = GoJson.IsNull(bundle.Body) ? null : new ImportBody { Encoding = "archive", Archive = bundle.Body },
            });
        }
        return new ImportPlan
        {
            Version = ImportPlan.CurrentVersion,
            Format = "nix",
            Title = source.Title,
            SourceSha256 = source.Sha256,
            Items = items,
            FileVersions = parsed.Manifest.Files,
            Loss = [.. parsed.Manifest.Loss.Select(value => value.Kind + ": " + value.Detail)],
            Omissions = [.. parsed.Manifest.Omitted.Select(value => value.Reason + ": " + value.Detail)],
        };
    }

    public static ValidatedNixArchive Validate(ImportSource source, ImportPlanLimits limits, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var archive = OpenNix(source.Path, limits);
        var entries = archive.Entries;
        if (entries.Count == 0 || entries[0].FullName != "manifest.json")
        {
            throw new ImportPlanException("the first Nix archive entry must be manifest.json");
        }
        var manifestBody = ImportArchive.ReadEntry(archive, "manifest.json", limits.MaxEntryBytes);
        NixManifest manifest;
        JsonElement manifestRoot;
        try
        {
            manifestRoot = GoJson.Parse(manifestBody);
            manifest = ReadManifest(manifestRoot);
        }
        catch (JsonException exception)
        {
            throw new ImportPlanException("decode Nix manifest: " + exception.Message, exception);
        }
        if (manifest.FormatVersion == NixArchive.FormatVersion && manifestRoot.ValueKind == JsonValueKind.Object && manifestRoot.TryGetProperty("files", out _))
        {
            throw new ImportPlanException("Nix archive v1 must not declare file-version entries");
        }
        ValidateManifest(manifest, limits);
        if (entries.Count != manifest.Items.Count + (manifest.Files?.Count ?? 0) + 1)
        {
            throw new ImportPlanException("the Nix archive contains unlisted or missing entries");
        }

        var bundles = new Dictionary<string, NixBundle>(StringComparer.Ordinal);
        var expectedFiles = new Dictionary<string, FileVersionEntry>(StringComparer.Ordinal);
        foreach (var file in manifest.Files ?? [])
        {
            expectedFiles[ImportArchive.NixFileVersionEntryName(file.ItemId, file.Version)] = file;
        }
        var seenEntries = new HashSet<string>(StringComparer.Ordinal) { "manifest.json" };
        foreach (var entry in entries.Skip(1))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!seenEntries.Add(entry.FullName))
            {
                throw new ImportPlanException($"the Nix archive contains duplicate entry \"{entry.FullName}\"");
            }
            if (ImportArchive.IsNixFileVersionPath(entry.FullName))
            {
                if (!expectedFiles.Remove(entry.FullName, out var file))
                {
                    throw new ImportPlanException($"the Nix archive contains an undeclared file-version entry \"{entry.FullName}\"");
                }
                VerifyFileVersion(entry, file, cancellationToken);
                continue;
            }
            if (!TryItemId(entry.FullName, out var id))
            {
                throw new ImportPlanException($"the Nix archive entry \"{entry.FullName}\" is not supported");
            }
            var body = ImportArchive.ReadEntry(entry, limits.MaxEntryBytes);
            NixBundle bundle;
            try
            {
                bundle = ReadBundle(GoJson.Parse(body));
            }
            catch (JsonException exception)
            {
                throw new ImportPlanException($"decode Nix item {id}: {exception.Message}", exception);
            }
            if (bundle.Id != id || bundles.ContainsKey(id))
            {
                throw new ImportPlanException($"the Nix archive contains a duplicate or mismatched item {id}");
            }
            bundles[id] = bundle;
        }
        if (expectedFiles.Count != 0)
        {
            throw new ImportPlanException("the Nix archive is missing a declared file-version entry");
        }

        var items = new List<(NixManifestItem, NixBundle)>(manifest.Items.Count);
        var depths = new Dictionary<string, int>(StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in manifest.Items)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!bundles.TryGetValue(entry.Id, out var bundle))
            {
                throw new ImportPlanException($"the Nix archive has no payload for item {entry.Id}");
            }
            if (seen.Contains(entry.Id) || bundle.ParentId != entry.ParentId || bundle.Seq != entry.Seq || bundle.Type != entry.Type || bundle.Title != entry.Title)
            {
                throw new ImportPlanException($"the Nix payload for item {entry.Id} disagrees with its manifest");
            }
            if (entry.Id == manifest.Root)
            {
                if (entry.ParentId is not null)
                {
                    throw new ImportPlanException("the Nix archive root has a parent");
                }
            }
            else if (entry.ParentId is null || !seen.Contains(entry.ParentId))
            {
                throw new ImportPlanException($"Nix item {entry.Id} does not follow its parent");
            }
            var depth = entry.ParentId is null ? 0 : depths.GetValueOrDefault(entry.ParentId) + 1;
            if (depth > limits.MaxDepth)
            {
                throw new ImportPlanException("the Nix archive tree is too deep");
            }
            depths[entry.Id] = depth;
            seen.Add(entry.Id);
            if (bundle.LifecycleState is not "active" and not "deleted")
            {
                throw new ImportPlanException($"Nix item {entry.Id} has an unsupported lifecycle state");
            }
            var error = ValidateBundle(bundle, manifest.SchemaVersion, limits);
            if (error is not null)
            {
                throw new ImportPlanException($"Nix item {entry.Id}: {error}");
            }
            items.Add((entry, bundle));
        }
        if (!seen.Contains(manifest.Root))
        {
            throw new ImportPlanException("the Nix archive root is not listed");
        }
        return new ValidatedNixArchive(manifest, items);
    }

    private static ZipArchive OpenNix(string path, ImportPlanLimits limits)
    {
        try
        {
            return ImportArchive.Open(path, limits, allowNixFileVersions: true);
        }
        catch (ImportPlanException exception)
        {
            throw new ImportPlanException("open Nix archive: " + exception.Message, exception);
        }
    }

    private static void VerifyFileVersion(ZipArchiveEntry entry, FileVersionEntry descriptor, CancellationToken cancellationToken)
    {
        var prefix = string.Create(CultureInfo.InvariantCulture, $"Nix file {descriptor.ItemId}/{descriptor.Version}: ");
        if (entry.Length != descriptor.ByteLength)
        {
            throw new ImportPlanException(prefix + "the byte length does not match its manifest descriptor");
        }
        var (metadata, digest, total) = ImportArchive.Inspect(entry, cancellationToken);
        if (total != descriptor.ByteLength)
        {
            throw new ImportPlanException(prefix + "the streamed byte length does not match its manifest descriptor");
        }
        if (digest != descriptor.Sha256)
        {
            throw new ImportPlanException(prefix + "the SHA-256 digest does not match its manifest descriptor");
        }
        if (metadata.Malformed || metadata.MediaType != descriptor.MediaType || metadata.Previewable != descriptor.Previewable
            || metadata.Width != descriptor.PixelWidth || metadata.Height != descriptor.PixelHeight)
        {
            throw new ImportPlanException(prefix + "the inspected file metadata does not match its manifest descriptor");
        }
    }

    private static NixManifest ReadManifest(JsonElement root)
    {
        var fields = GoFields.Require(root, true, "format", "formatVersion", "schemaVersion", "profile", "exportedAt", "root", "rootEffectiveSchema", "includesDeleted", "items", "files", "omitted", "loss");
        fields.Bool("includesDeleted");
        return new NixManifest(
            fields.String("format"),
            fields.Int("formatVersion"),
            fields.Int("schemaVersion"),
            fields.Raw("profile"),
            fields.String("exportedAt"),
            fields.String("root"),
            fields.TryGet("rootEffectiveSchema", out var schema) ? ReadSchema(schema) : null,
            fields.List("items", element =>
            {
                var item = GoFields.Require(element, true, "id", "parentId", "seq", "title", "type");
                return new NixManifestItem(item.String("id"), item.OptionalString("parentId"), item.String("seq"), item.String("title"), item.String("type"));
            }) ?? [],
            fields.List("files", PlanJson.ReadFileVersion),
            fields.List("omitted", element =>
            {
                var omission = GoFields.Require(element, true, "id", "parentId", "reason", "detail");
                return (omission.OptionalString("id"), omission.String("parentId"), omission.String("reason"), omission.String("detail"));
            }) ?? [],
            fields.List("loss", element =>
            {
                var loss = GoFields.Require(element, true, "itemId", "kind", "detail");
                return (loss.String("itemId"), loss.String("kind"), loss.String("detail"));
            }) ?? []);
    }

    private static NixSchemaSnapshot ReadSchema(JsonElement element)
    {
        var fields = GoFields.Require(element, true, "properties", "declared", "inherit");
        return new NixSchemaSnapshot(fields.Raw("properties"), fields.Raw("declared"), fields.Bool("inherit"));
    }

    internal static NixBundle ReadBundle(JsonElement root)
    {
        var fields = GoFields.Require(root, true, "id", "parentId", "workspaceId", "type", "title", "seq", "lifecycleState", "createdAt", "updatedAt", "properties", "recurrence", "schema", "views", "viewRows", "viewRowsTruncated", "body", "comments");
        fields.String("createdAt");
        fields.String("updatedAt");
        fields.Bool("viewRowsTruncated");
        return new NixBundle(
            fields.String("id"),
            fields.OptionalString("parentId"),
            fields.String("workspaceId"),
            fields.String("type"),
            fields.String("title"),
            fields.String("seq"),
            fields.String("lifecycleState"),
            fields.Raw("properties"),
            fields.Raw("recurrence"),
            fields.TryGet("schema", out var schema) ? ReadSchema(schema) : null,
            fields.Raw("views"),
            fields.Raw("viewRows"),
            fields.Raw("body"),
            fields.Raw("comments"));
    }

    private static void ValidateManifest(NixManifest manifest, ImportPlanLimits limits)
    {
        if (manifest.Format != ArchiveFormat || (manifest.FormatVersion != NixArchive.FormatVersion && manifest.FormatVersion != NixArchive.FileFormatVersion))
        {
            throw new ImportPlanException("the Nix archive format or version is unsupported");
        }
        if (manifest.SchemaVersion is < SchemaMinimum or > SchemaMaximum)
        {
            throw new ImportPlanException("the Nix archive editor schema is unsupported");
        }
        if (!NixArchive.SafeId(manifest.Root) || manifest.ExportedAt.Length == 0 || manifest.Items.Count == 0 || manifest.Items.Count > limits.MaxItems)
        {
            throw new ImportPlanException("the Nix archive manifest is incomplete or exceeds the item limit");
        }
        if (manifest.Omitted.Count > limits.MaxItems || manifest.Loss.Count > limits.MaxItems)
        {
            throw new ImportPlanException("the Nix archive report exceeds the item limit");
        }
        if (manifest.RootEffectiveSchema is not null && ValidateSchema(manifest.RootEffectiveSchema) is { } schemaError)
        {
            throw new ImportPlanException("root effective schema: " + schemaError);
        }
        if (manifest.FormatVersion == NixArchive.FormatVersion)
        {
            if (manifest.Files is not null)
            {
                throw new ImportPlanException("Nix archive v1 must not declare file-version entries");
            }
        }
        else
        {
            if (manifest.Files is null)
            {
                throw new ImportPlanException("Nix archive v2 must declare file-version entries");
            }
            if (manifest.Files.Count > (long)limits.MaxItems * NixArchive.MaxFileVersionsPerItem)
            {
                throw new ImportPlanException("the Nix archive declares too many file versions");
            }
            try
            {
                NixArchive.ValidateFileVersions(manifest.Files, [.. manifest.Items.Select(item => new ManifestItem(item.Id, item.ParentId, item.Seq, item.Title, item.Type))]);
            }
            catch (ArchiveFormatException exception)
            {
                throw new ImportPlanException(exception.Message, exception);
            }
        }
        foreach (var entry in manifest.Items)
        {
            if (!NixArchive.SafeId(entry.Id) || (entry.ParentId is not null && !NixArchive.SafeId(entry.ParentId))
                || !ValidIntegerString(entry.Seq) || Encoding.UTF8.GetByteCount(entry.Title) > 500 || entry.Type.Trim().Length == 0 || Encoding.UTF8.GetByteCount(entry.Type) > 64)
            {
                throw new ImportPlanException("the Nix archive manifest contains an invalid item");
            }
        }
        foreach (var (id, parentId, reason, detail) in manifest.Omitted)
        {
            if (!NixArchive.SafeId(parentId) || (id is not null && !NixArchive.SafeId(id))
                || (reason is not "not-readable" and not "soft-deleted" and not "limit-reached") || Encoding.UTF8.GetByteCount(detail) > 1000)
            {
                throw new ImportPlanException("the Nix archive manifest contains an invalid omission");
            }
        }
        foreach (var (itemId, kind, detail) in manifest.Loss)
        {
            if (!NixArchive.SafeId(itemId) || kind.Trim().Length == 0 || Encoding.UTF8.GetByteCount(kind) > 100 || Encoding.UTF8.GetByteCount(detail) > 1000)
            {
                throw new ImportPlanException("the Nix archive manifest contains an invalid loss entry");
            }
        }
    }

    private static string? ValidateBundle(NixBundle bundle, int manifestSchema, ImportPlanLimits limits)
    {
        if (!NixArchive.SafeId(bundle.Id) || !NixArchive.SafeId(bundle.WorkspaceId)
            || (bundle.ParentId is not null && !NixArchive.SafeId(bundle.ParentId)) || !ValidIntegerString(bundle.Seq)
            || bundle.Type.Trim().Length == 0 || Encoding.UTF8.GetByteCount(bundle.Type) > 64 || Encoding.UTF8.GetByteCount(bundle.Title) > 500
            || !GoJson.IsObject(bundle.Properties) || !GoJson.IsArray(bundle.ViewRows) || GoJson.RawLength(bundle.Body) > limits.MaxBodyBytes)
        {
            return "the item envelope is invalid";
        }
        if (bundle.Schema is not null && ValidateSchema(bundle.Schema) is { } schemaError)
        {
            return schemaError;
        }
        if (!GoJson.IsNull(bundle.Views) && !GoJson.IsObject(bundle.Views))
        {
            return "the item views are invalid";
        }
        if (!GoJson.IsNull(bundle.Body))
        {
            GoFields body;
            int schemaVersion;
            try
            {
                body = GoFields.Require(bundle.Body!.Value, true, "schemaVersion", "prosemirror", "sheet", "canvas");
                schemaVersion = body.Int("schemaVersion");
            }
            catch (JsonException)
            {
                return "the item body is invalid";
            }
            if (schemaVersion < 1)
            {
                return "the item body is invalid";
            }
            var sheet = bundle.Type is "sheet" or "spreadsheet";
            var expected = bundle.Type == "canvas" ? body.Raw("canvas") : sheet ? body.Raw("sheet") : body.Raw("prosemirror");
            if (!GoJson.IsObject(expected) || (!sheet && schemaVersion > manifestSchema))
            {
                return "the item body does not match its type or schema";
            }
        }
        return null;
    }

    internal static string? ValidateSchema(NixSchemaSnapshot schema)
    {
        foreach (var encoded in (JsonElement?[])[schema.Properties, schema.Declared])
        {
            if (!GoJson.IsArray(encoded))
            {
                return "the property schema is invalid";
            }
            foreach (var element in encoded!.Value.EnumerateArray())
            {
                string key, type;
                List<string>? options;
                bool required;
                string? expression, aggregate, source;
                try
                {
                    var property = GoFields.Require(element, false, "key", "type", "options", "required", "expression", "aggregate", "source");
                    key = property.String("key");
                    type = property.String("type");
                    options = property.List("options", GoFields.StringValue);
                    required = property.Bool("required");
                    expression = property.OptionalString("expression");
                    aggregate = property.OptionalString("aggregate");
                    source = property.OptionalString("source");
                }
                catch (JsonException)
                {
                    return "the property schema is invalid";
                }
                if (key.Trim().Length == 0)
                {
                    return "the property schema contains an invalid property";
                }
                if (!PropertyTypes.Contains(type))
                {
                    return $"the property schema contains unsupported type \"{type}\"";
                }
                if (type == "formula")
                {
                    if (expression is null || expression.Trim().Length == 0 || expression.Length > 1024)
                    {
                        return $"the formula property \"{key}\" needs an expression of at most 1024 characters";
                    }
                }
                else if (expression is not null)
                {
                    return $"the non-formula property \"{key}\" contains an expression";
                }
                if (type == "rollup")
                {
                    if (aggregate is null)
                    {
                        return $"the rollup property \"{key}\" needs an aggregate";
                    }
                    if (!Aggregates.Contains(aggregate))
                    {
                        return $"the rollup property \"{key}\" contains an unsupported aggregate";
                    }
                    if ((source is null && aggregate != "count") || (source is not null && (source.Trim().Length == 0 || source == key)))
                    {
                        return $"the rollup property \"{key}\" needs a valid source property";
                    }
                }
                else if (aggregate is not null || source is not null)
                {
                    return $"the non-rollup property \"{key}\" contains aggregate or source metadata";
                }
                if (type is "formula" or "rollup" && (required || options is { Count: > 0 }))
                {
                    return $"the computed property \"{key}\" cannot be required or contain options";
                }
            }
        }
        return null;
    }

    /// <summary>The root carries its effective schema, redeclared; any other item its own declarations.</summary>
    internal static JsonElement? ImportSchema(bool root, NixSchemaSnapshot? effective, NixSchemaSnapshot? declared)
    {
        var selected = root && effective is not null ? effective : declared;
        if (selected is null)
        {
            return null;
        }
        var writer = new GoJsonWriter();
        writer.Begin().Name("properties").Raw(root ? selected.Properties : selected.Declared).Name("inherit").Bool(!root && selected.Inherit).End();
        return GoJson.Parse(writer.ToUtf8());
    }

    private static bool TryItemId(string name, out string id)
    {
        id = string.Empty;
        if (!name.StartsWith("items/", StringComparison.Ordinal) || !name.EndsWith(".json", StringComparison.Ordinal))
        {
            return false;
        }
        id = name["items/".Length..^".json".Length];
        return NixArchive.SafeId(id);
    }

    internal static bool ValidIntegerString(string value) =>
        value.Length > 0 && long.TryParse(value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out _);
}
