using System.Text.Json;

namespace Nix.Workers.Archive;

/// <summary>Archive v1 is refused when completing it would lose file bytes.</summary>
public sealed class FileBytesUnsupportedException : ArchiveFormatException
{
    public FileBytesUnsupportedException(string message)
        : base(message)
    {
    }

    public FileBytesUnsupportedException()
    {
    }

    public FileBytesUnsupportedException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}

/// <summary>The rules that keep a <c>.nix</c> archive lossless about files.</summary>
public static class Portability
{
    public static void ValidateManifest(Manifest manifest)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        var fileItems = manifest.Items.Where(item => item.Type == "file").Select(item => item.Id).ToHashSet(StringComparer.Ordinal);
        if (manifest.Raw is { Length: > 0 })
        {
            using var document = Parse(manifest.Raw);
            if (document.RootElement.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in items.EnumerateArray())
                {
                    if (item.ValueKind == JsonValueKind.Object && item.TryGetProperty("type", out var type) && type.ValueEquals("file")
                        && item.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String)
                    {
                        fileItems.Add(id.GetString()!);
                    }
                }
            }
        }
        if (manifest.FormatVersion == NixArchive.FormatVersion)
        {
            if (manifest.Items.FirstOrDefault(item => item.Type == "file") is { } file)
            {
                throw new FileBytesUnsupportedException($"Nix archive v1 has no file-byte entry format: cannot export file item {file.Id} losslessly");
            }
            return;
        }
        foreach (var entry in manifest.Files ?? [])
        {
            if (!fileItems.Contains(entry.ItemId))
            {
                throw new ArchiveFormatException($"Nix archive file entry refers to unknown file item {entry.ItemId}");
            }
        }
    }

    public static void ValidateBundle(Bundle bundle, Manifest manifest)
    {
        ArgumentNullException.ThrowIfNull(bundle);
        ArgumentNullException.ThrowIfNull(manifest);
        JsonElement? rawBody = null;
        JsonDocument? rawDocument = null;
        try
        {
            if (bundle.Raw.Length > 0)
            {
                rawDocument = Parse(bundle.Raw);
                var root = rawDocument.RootElement;
                var id = root.TryGetProperty("id", out var idValue) && idValue.ValueKind == JsonValueKind.String ? idValue.GetString() : null;
                var type = root.TryGetProperty("type", out var typeValue) && typeValue.ValueKind == JsonValueKind.String ? typeValue.GetString() : null;
                if (id != bundle.Id || (type ?? string.Empty) != bundle.Type)
                {
                    throw new ArchiveFormatException("archive bundle source does not match its validated descriptor");
                }
                if (type == "file" && manifest.FormatVersion == NixArchive.FormatVersion)
                {
                    throw FileItemUnsupported(bundle.Id);
                }
                if (root.TryGetProperty("body", out var body))
                {
                    rawBody = body;
                }
            }
            if (bundle.Type == "file" && manifest.FormatVersion == NixArchive.FormatVersion)
            {
                throw FileItemUnsupported(bundle.Id);
            }
            var bodies = new[] { bundle.Body, rawBody };
            if (manifest.FormatVersion == NixArchive.FormatVersion)
            {
                foreach (var body in bodies)
                {
                    if (DurableFileReferences(body).Count > 0)
                    {
                        throw new FileBytesUnsupportedException($"Nix archive v1 has no file-byte entry format: cannot export item {bundle.Id} losslessly because its body contains a durable file reference");
                    }
                }
                return;
            }
            var fileItems = (manifest.Files ?? []).Select(entry => entry.ItemId).ToHashSet(StringComparer.Ordinal);
            foreach (var body in bodies)
            {
                foreach (var itemId in DurableFileReferences(body))
                {
                    if (!fileItems.Contains(itemId))
                    {
                        throw new ArchiveFormatException($"archive bundle {bundle.Id} refers to file item {itemId} without included file bytes");
                    }
                }
            }
        }
        finally
        {
            rawDocument?.Dispose();
        }
    }

    private static FileBytesUnsupportedException FileItemUnsupported(string itemId) =>
        new($"Nix archive v1 has no file-byte entry format: cannot export file item {itemId} losslessly");

    /// <summary>The file items a body points at: ProseMirror image nodes and canvas file markers.</summary>
    public static IReadOnlyList<string> DurableFileReferences(JsonElement? body)
    {
        if (body is not { ValueKind: JsonValueKind.Object } root)
        {
            return [];
        }
        var references = new List<string>();
        if (root.TryGetProperty("prosemirror", out var document))
        {
            var pending = new Stack<JsonElement>();
            pending.Push(document);
            while (pending.Count > 0)
            {
                var node = pending.Pop();
                if (node.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }
                if (node.TryGetProperty("type", out var type) && type.ValueEquals("image"))
                {
                    var fileItemId = node.TryGetProperty("attrs", out var attrs) && attrs.ValueKind == JsonValueKind.Object && attrs.TryGetProperty("fileItemId", out var file) && file.ValueKind == JsonValueKind.String ? file.GetString() : null;
                    var source = attrs.ValueKind == JsonValueKind.Object && attrs.TryGetProperty("src", out var src) && src.ValueKind == JsonValueKind.String ? src.GetString() : null;
                    if (!string.IsNullOrEmpty(fileItemId))
                    {
                        references.Add(fileItemId);
                    }
                    else if (source is not null && source.StartsWith("nix-file:", StringComparison.Ordinal))
                    {
                        references.Add(source["nix-file:".Length..]);
                    }
                }
                if (node.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array)
                {
                    foreach (var child in content.EnumerateArray())
                    {
                        pending.Push(child);
                    }
                }
            }
        }
        if (root.TryGetProperty("canvas", out var scene) && scene.ValueKind == JsonValueKind.Object && scene.TryGetProperty("elements", out var elements))
        {
            var items = elements.ValueKind switch
            {
                JsonValueKind.Array => elements.EnumerateArray().ToList(),
                JsonValueKind.Object => elements.EnumerateObject().Select(property => property.Value).ToList(),
                _ => [],
            };
            foreach (var element in items)
            {
                if (element.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }
                if (element.TryGetProperty("customData", out var custom) && custom.ValueKind == JsonValueKind.Object
                    && custom.TryGetProperty("nix", out var marker) && marker.ValueKind == JsonValueKind.Object
                    && marker.TryGetProperty("kind", out var kind) && kind.ValueEquals("file")
                    && marker.TryGetProperty("itemId", out var itemId) && itemId.ValueKind == JsonValueKind.String && itemId.GetString() is { Length: > 0 } markerId)
                {
                    references.Add(markerId);
                }
                if (element.TryGetProperty("type", out var type) && type.ValueEquals("image")
                    && element.TryGetProperty("imageItemId", out var image) && image.ValueKind == JsonValueKind.String && image.GetString() is { Length: > 0 } imageId)
                {
                    references.Add(imageId);
                }
            }
        }
        return references;
    }

    private static JsonDocument Parse(byte[] raw)
    {
        try
        {
            return JsonDocument.Parse(raw);
        }
        catch (JsonException exception)
        {
            throw new ArchiveFormatException("archive source JSON is invalid: " + exception.Message, exception);
        }
    }
}
