using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions.Importing;
using Nix.Domain.Items;
using Nix.Domain.Properties;
using Nix.Domain.Views;
using Npgsql;

namespace Nix.Persistence.Importing;

public sealed partial class DocumentImportStore
{
    private bool TryValidatePlan(
        IReadOnlyList<ImportEnvelopePlan> plans,
        out IReadOnlyList<ImportEnvelopePlan> ordered)
    {
        ordered = Array.Empty<ImportEnvelopePlan>();
        if (plans.Count is < 1 or > MaximumItems)
        {
            return false;
        }
        var byId = new Dictionary<string, ImportEnvelopePlan>(plans.Count, StringComparer.Ordinal);
        foreach (var plan in plans)
        {
            if (!ValidSourceId(plan.SourceId)
                || !byId.TryAdd(plan.SourceId, plan)
                || (plan.ParentSourceId is not null && !ValidSourceId(plan.ParentSourceId))
                || plan.Order < 0
                || string.IsNullOrWhiteSpace(plan.Title)
                || plan.Title.Length > 500
                || string.IsNullOrWhiteSpace(plan.ItemType)
                || plan.ItemType.Length > 64
                || plan.FinalLifecycleState is not ("active" or "deleted")
                || (plan.ItemType != "file" && plan.File is not null)
                || (plan.File is not null && plan.BodyRequired)
                || !ValidFile(plan.File))
            {
                return false;
            }
        }
        if (byId.Values.Count(value => value.ParentSourceId is null) != 1)
        {
            return false;
        }

        var sorted = new List<ImportEnvelopePlan>(plans.Count);
        var state = new Dictionary<string, byte>(plans.Count, StringComparer.Ordinal);
        bool Visit(ImportEnvelopePlan value, int depth)
        {
            if (depth > MaximumDepth)
            {
                return false;
            }
            if (state.GetValueOrDefault(value.SourceId) == 2)
            {
                return true;
            }
            if (state.GetValueOrDefault(value.SourceId) == 1)
            {
                return false;
            }
            state[value.SourceId] = 1;
            if (value.ParentSourceId is { } parentId)
            {
                if (!byId.TryGetValue(parentId, out var parent) || !Visit(parent, depth + 1))
                {
                    return false;
                }
            }
            state[value.SourceId] = 2;
            sorted.Add(value);
            return true;
        }
        foreach (var plan in plans.OrderBy(value => value.Order))
        {
            if (!Visit(plan, 0))
            {
                return false;
            }
        }

        var effectiveSchemas = new Dictionary<string, PropertySchema>(plans.Count, StringComparer.Ordinal);
        foreach (var plan in sorted)
        {
            var declared = PropertySchemaJson.Read(plan.Schema);
            var effective = plan.ParentSourceId is { } parentId && declared.Inherit
                ? PropertySchema.Merge(effectiveSchemas[parentId], declared)
                : declared;
            effectiveSchemas[plan.SourceId] = effective;
            if (validator.ValidateEnvelope(
                ItemProperties.WithTitle(plan.Properties, plan.Title),
                plan.Schema,
                plan.Views,
                effective) is not null)
            {
                return false;
            }
            if (JsonNode.Parse(plan.Properties ?? "{}") is JsonObject properties && properties.ContainsKey("$chat_config")
                && (ChatSchema.Refuse(effective) is not null || !ViewDefinitionsJson.Read(plan.Views).Views.Any(view => view.Kind == ViewKind.Chat)))
            {
                return false;
            }
        }
        ordered = sorted;
        return true;
    }

    private static bool TryValidateFileVersions(
        IReadOnlyList<ImportFileVersionPlan>? fileVersions,
        IReadOnlyList<ImportEnvelopePlan> items)
    {
        if (fileVersions is null)
        {
            return true;
        }

        if (fileVersions.Count > 100_000)
        {
            return false;
        }

        var fileItems = items.Where(value => value.ItemType == "file")
            .Select(value => value.SourceId).ToHashSet(StringComparer.Ordinal);
        var groups = new Dictionary<string, List<int>>(StringComparer.Ordinal);
        foreach (var file in fileVersions)
        {
            if (!fileItems.Contains(file.SourceItemId)
                || file.Version is < 1 or > 100
                || !ValidFile(new ImportFilePlan("asset", "archive", file.FileName, file.MediaType,
                    file.ByteLength, file.Sha256, file.Previewable, file.PixelWidth, file.PixelHeight)))
            {
                return false;
            }

            if (!groups.TryGetValue(file.SourceItemId, out var history))
            {
                history = [];
                groups[file.SourceItemId] = history;
            }
            history.Add(file.Version);
        }
        return groups.Values.All(history => history.Count is > 0 and <= 100
            && history.Distinct().Count() == history.Count
            && history.Order().SequenceEqual(Enumerable.Range(1, history.Count)));
    }

    private static bool ValidFile(ImportFilePlan? file)
    {
        if (file is null)
        {
            return true;
        }
        return file.SourceKind is "source" or "asset"
            && (file.SourceKind != "asset" || ValidAssetPath(file.AssetPath))
            && file.FileName.Length is > 0 and <= 255
            && file.FileName.IndexOfAny(['/', '\\', '\0']) < 0
            && file.MediaType.Length is > 2 and <= 160
            && file.MediaType.Contains('/', StringComparison.Ordinal)
            && file.ByteLength is >= 0 and <= MaximumFileBytes
            && ValidDigest(file.Sha256)
            && ((file.PixelWidth is null && file.PixelHeight is null)
                || file is { PixelWidth: > 0 and <= 100_000, PixelHeight: > 0 and <= 100_000 }
                    && (long)file.PixelWidth.Value * file.PixelHeight.Value <= 1_000_000_000);
    }

    private static bool ValidSourceId(string? value) =>
        !string.IsNullOrWhiteSpace(value)
        && value.Length <= 160
        && value.All(character => char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or '-' or ':' or '/');

    private static bool ValidAssetPath(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)
            || !ValidSourceId(value)
            || value[0] == '/')
        {
            return false;
        }
        return value.Split('/').All(segment => segment is not ("" or "." or ".."));
    }

    private static bool ValidDigest(string value) =>
        value.Length == 64
        && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');
}
