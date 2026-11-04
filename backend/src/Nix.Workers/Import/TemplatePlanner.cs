#pragma warning disable CA2227 // Justification: template plan DTOs are the wire shape the handlers read and tests edit in place, as the Go structs were.
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Nix.Workers.Archive;

namespace Nix.Workers.Import;

/// <summary>The additive profile carried by a reusable .nix archive.</summary>
public sealed class TemplateProfile
{
    public string Kind { get; set; } = string.Empty;

    public int Version { get; set; }

    public string Key { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public string Description { get; set; } = string.Empty;

    public bool IncludeBody { get; set; }

    public bool IncludeChildren { get; set; }

    public TemplateInitialization? Initialization { get; set; }
}

public sealed class TemplateInitialization
{
    public int Version { get; set; }

    public IList<TemplateInitializationInput>? Inputs { get; set; }

    public IList<TemplateInitializationRule>? Rules { get; set; }

    public IList<TemplateReferenceRule>? References { get; set; }
}

public sealed class TemplateInitializationInput
{
    public string Key { get; set; } = string.Empty;

    public string Label { get; set; } = string.Empty;

    public string Type { get; set; } = string.Empty;

    public bool Required { get; set; }

    public string? DefaultValue { get; set; }
}

public sealed class TemplateInitializationRule
{
    public string SourceId { get; set; } = string.Empty;

    public string PropertyKey { get; set; } = string.Empty;

    public string Kind { get; set; } = string.Empty;

    /// <summary>Absent is null; an explicit JSON null is kept (and written back) as a null element.</summary>
    public JsonElement? Value { get; set; }

    public string? InputKey { get; set; }

    public int? OffsetDays { get; set; }

    public string? TimeOfDay { get; set; }

    public string? TimeZone { get; set; }
}

public sealed class TemplateReferenceRule
{
    public string SourceItemId { get; set; } = string.Empty;

    public string Policy { get; set; } = string.Empty;

    public string? InputKey { get; set; }
}

/// <summary>The bounded, deterministic handoff between template preview and commit.</summary>
public sealed class TemplatePlan
{
    public const int CurrentVersion = 1;

    public int Version { get; set; }

    public string SourceSha256 { get; set; } = string.Empty;

    public TemplateProfile Profile { get; set; } = new();

    public string RootItemType { get; set; } = string.Empty;

    public int ItemCount { get; set; }

    public int BodyCount { get; set; }

    public int ViewCount { get; set; }

    public IList<TemplateItem> Items { get; set; } = [];

    public IList<FileVersionEntry>? Files { get; set; }
}

/// <summary>An archive item's portable identity, parentage, signed sequence and body.</summary>
public sealed class TemplateItem
{
    public string SourceId { get; set; } = string.Empty;

    public string? ParentSourceId { get; set; }

    public string Seq { get; set; } = string.Empty;

    public string Title { get; set; } = string.Empty;

    public string ItemType { get; set; } = string.Empty;

    public JsonElement? Properties { get; set; }

    public JsonElement? Schema { get; set; }

    public JsonElement? Views { get; set; }

    public JsonElement? Body { get; set; }

    public JsonElement? Recurrence { get; set; }
}

/// <summary>Template-profile .nix archives: parsed through the same bounded reader as ordinary imports, then normalised for staging.</summary>
public static partial class TemplatePlanner
{
    private const string PlanInvalid = "template_plan_invalid";

    public static Task<TemplatePlan> ParseAsync(ImportSource source, ImportPlanLimits limits, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(limits);
        ImportPlanner.ValidateSource(source, limits);
        if (ImportPlanner.NormalizeFormat(source.Format) != "nix")
        {
            throw new ImportPlanException(ImportPlanException.FormatUnsupported, "unsupported import format: " + source.Format);
        }
        try
        {
            return Task.FromResult(Parse(source, limits, cancellationToken));
        }
        catch (Exception exception) when (exception is IOException or InvalidDataException or JsonException or ArchiveFormatException or UnauthorizedAccessException)
        {
            throw new ImportPlanException(ImportPlanException.SourceInvalid, exception.Message, exception);
        }
    }

    private static TemplatePlan Parse(ImportSource source, ImportPlanLimits limits, CancellationToken cancellationToken)
    {
        var parsed = NixImport.Validate(source, limits, cancellationToken);
        var manifest = parsed.Manifest;
        if (manifest.Omitted.Count != 0 || manifest.Loss.Count != 0)
        {
            throw new ImportPlanException("a template archive cannot contain omissions or loss");
        }
        if (GoJson.IsNull(manifest.Profile))
        {
            throw new ImportPlanException("the Nix archive does not contain a template profile");
        }
        TemplateProfile profile;
        try
        {
            profile = TemplateJson.ReadProfile(manifest.Profile!.Value);
        }
        catch (JsonException exception)
        {
            throw new ImportPlanException("decode template profile: " + exception.Message, exception);
        }
        if (ValidateProfile(profile) is { } profileError)
        {
            throw new ImportPlanException(profileError);
        }
        if (profile.Initialization is { Rules: { } rules })
        {
            var included = parsed.Items.Select(item => item.Entry.Id).ToHashSet(StringComparer.Ordinal);
            if (rules.Any(rule => !included.Contains(rule.SourceId)))
            {
                throw new ImportPlanException("template initialization refers to an item outside the archive");
            }
        }
        if (!profile.IncludeChildren && parsed.Items.Count != 1)
        {
            throw new ImportPlanException("the template profile excludes children but the archive contains descendants");
        }
        var plan = new TemplatePlan
        {
            Version = TemplatePlan.CurrentVersion,
#pragma warning disable CA1308 // Justification: the plan's digest format is lowercase hex, as Go's strings.ToLower wrote it.
            SourceSha256 = source.Sha256.ToLowerInvariant(),
#pragma warning restore CA1308
            Profile = profile,
            ItemCount = parsed.Items.Count,
            Items = new List<TemplateItem>(parsed.Items.Count),
            Files = manifest.Files,
        };
        foreach (var (entry, bundle) in parsed.Items)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var views = GoJson.Nullable(bundle.Views);
            plan.ViewCount += CountViews(views) ?? throw new ImportPlanException($"Nix item {entry.Id}: template item views are invalid");
            var body = GoJson.Nullable(bundle.Body);
            if (body is not null)
            {
                plan.BodyCount++;
            }
            if (entry.Id == manifest.Root)
            {
                plan.RootItemType = bundle.Type;
                if (!profile.IncludeBody && body is not null)
                {
                    throw new ImportPlanException("the template profile excludes the root body but the archive contains it");
                }
            }
            // Templates are starting points: comments from a document export are dropped here, never planned or imported.
            plan.Items.Add(new TemplateItem
            {
                SourceId = entry.Id,
                ParentSourceId = entry.ParentId,
                Seq = entry.Seq,
                Title = bundle.Title,
                ItemType = bundle.Type,
                Properties = bundle.Properties,
                Schema = NixImport.ImportSchema(entry.Id == manifest.Root, manifest.RootEffectiveSchema, bundle.Schema),
                Views = views,
                Body = body,
                Recurrence = GoJson.Nullable(bundle.Recurrence),
            });
        }
        if (ValidatePlan(plan, limits) is { } planError)
        {
            throw new ImportPlanException(planError);
        }
        return plan;
    }

    public static (byte[] Bytes, string Sha256Hex) Encode(TemplatePlan plan, long maxBytes)
    {
        ArgumentNullException.ThrowIfNull(plan);
        if (maxBytes <= 0)
        {
            throw new ImportPlanException(PlanInvalid, "template plan byte limit must be positive");
        }
        if (ValidatePlan(plan, null) is { } error)
        {
            throw new ImportPlanException(PlanInvalid, error);
        }
        var body = TemplateJson.Write(plan);
        if (body.Length > maxBytes)
        {
            throw new ImportPlanException(PlanInvalid, "template plan exceeds the configured byte limit");
        }
        return (body, Convert.ToHexStringLower(SHA256.HashData(body)));
    }

    public static TemplatePlan Decode(byte[] body, string expectedDigest, ImportPlanLimits limits) => Decode(body.AsSpan(), expectedDigest, limits);

    public static TemplatePlan Decode(ReadOnlySpan<byte> body, string expectedDigest, ImportPlanLimits limits)
    {
        ArgumentNullException.ThrowIfNull(limits);
        if (body.Length > limits.MaxPlanBytes)
        {
            throw new ImportPlanException(PlanInvalid, "template plan exceeds the configured byte limit");
        }
        if (!string.Equals(Convert.ToHexStringLower(SHA256.HashData(body)), expectedDigest, StringComparison.OrdinalIgnoreCase))
        {
            throw new ImportPlanException(PlanInvalid, "template plan checksum does not match the preview");
        }
        if (!GoJson.DepthWithin(body, limits.MaxDepth + 8, out var depthError))
        {
            throw new ImportPlanException(PlanInvalid, "template plan JSON: " + depthError);
        }
        TemplatePlan plan;
        try
        {
            plan = TemplateJson.ReadPlan(GoJson.Parse(body));
        }
        catch (JsonException exception)
        {
            throw new ImportPlanException(PlanInvalid, exception.Message, exception);
        }
        if (ValidatePlan(plan, limits) is { } error)
        {
            throw new ImportPlanException(PlanInvalid, error);
        }
        return plan;
    }

    /// <summary>Strictly decodes initialization metadata on its own (the shared fixture's contract).</summary>
    public static TemplateInitialization ReadInitialization(ReadOnlySpan<byte> body)
    {
        try
        {
            return TemplateJson.ReadInitialization(GoJson.Parse(body));
        }
        catch (JsonException exception)
        {
            throw new ImportPlanException(exception.Message, exception);
        }
    }

    internal static string? ValidateProfile(TemplateProfile profile)
    {
        if (profile.Kind != "template" || profile.Version != 1)
        {
            return "the template profile kind or version is unsupported";
        }
        if (!TemplateKeyPattern().IsMatch(profile.Key) || !BoundedText(profile.Name, 200, false) || !BoundedText(profile.Description, 1000, true))
        {
            return "the template profile key, name, or description is invalid";
        }
        return ValidateInitialization(profile.Initialization);
    }

    /// <summary>The reason initialization metadata is refused, or null.</summary>
    public static string? ValidateInitialization(TemplateInitialization? value)
    {
        if (value is null)
        {
            return null;
        }
        if (value.Version != 1 || value.Inputs is null || value.Rules is null || value.References is null || value.Inputs.Count > 100 || value.Rules.Count + value.References.Count > 2000)
        {
            return "template initialization metadata is invalid";
        }
        var inputKeys = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var input in value.Inputs)
        {
            if (!InputKeyPattern().IsMatch(input.Key) || !BoundedText(input.Label, 120, false) || input.Type is not ("text" or "date" or "member" or "item"))
            {
                return "template initialization inputs are invalid";
            }
            if (input.DefaultValue is not null && !ValidDefault(input.Type, input.DefaultValue))
            {
                return "template initialization default value is invalid";
            }
            if (!inputKeys.TryAdd(input.Key, input.Type))
            {
                return "template initialization inputs contain duplicate keys";
            }
        }
        var seenRules = new HashSet<string>(StringComparer.Ordinal);
        foreach (var rule in value.Rules)
        {
            if (!NixArchive.SafeId(rule.SourceId) || !BoundedText(rule.PropertyKey, 160, false)
                || rule.Kind is not ("keep" or "clear" or "set" or "input" or "relativeDate")
                || (rule.InputKey is not null && Utf8Length(rule.InputKey) > 64) || (rule.TimeOfDay is not null && Utf8Length(rule.TimeOfDay) > 32) || (rule.TimeZone is not null && Utf8Length(rule.TimeZone) > 128))
            {
                return "template initialization rules are invalid";
            }
            if (!seenRules.Add(rule.SourceId + "\0" + rule.PropertyKey))
            {
                return "template initialization rules contain duplicate targets";
            }
            var hasValue = !GoJson.IsNull(rule.Value);
            var hasInput = rule.InputKey is not null;
            var hasOffset = rule.OffsetDays is not null;
            var hasTime = rule.TimeOfDay is not null;
            var hasZone = rule.TimeZone is not null;
            var inputType = rule.InputKey is null ? string.Empty : inputKeys.GetValueOrDefault(rule.InputKey) ?? string.Empty;
            switch (rule.Kind)
            {
                case "keep" or "clear":
                    if (hasValue || hasInput || hasOffset || hasTime || hasZone)
                    {
                        return "keep and clear initialization rules must not carry value or date fields";
                    }
                    break;
                case "set":
                    if (!hasValue || hasInput || hasOffset || hasTime || hasZone)
                    {
                        return "set initialization rules must carry only a non-null value";
                    }
                    if (rule.PropertyKey == "recurrence.until"
                        && (rule.Value!.Value.ValueKind != JsonValueKind.String || !ValidDefault("date", rule.Value.Value.GetString()!)))
                    {
                        return "a set recurrence end rule requires an ISO calendar day value";
                    }
                    break;
                case "input":
                    if (hasValue || !hasInput || inputType.Length == 0 || hasOffset || hasTime || hasZone)
                    {
                        return "input initialization rules must refer only to a declared input";
                    }
                    if (rule.PropertyKey == "recurrence.until" && inputType != "date")
                    {
                        return "the recurrence end rule requires a date input";
                    }
                    break;
                case "relativeDate":
                    if (hasValue || !hasInput || inputType != "date" || !hasOffset || rule.OffsetDays is < -36500 or > 36500)
                    {
                        return "a relative-date rule requires a date input and a bounded integer offset";
                    }
                    if (rule.PropertyKey == "recurrence.until")
                    {
                        if (hasTime || hasZone)
                        {
                            return "the recurrence end rule accepts no time fields";
                        }
                    }
                    else if (hasTime != hasZone || (hasTime && !TimePattern().IsMatch(rule.TimeOfDay!)) || (hasZone && rule.TimeZone!.Trim().Length == 0))
                    {
                        return "relative timestamp rules require a valid time and time zone together";
                    }
                    break;
            }
        }
        var seenReferences = new HashSet<string>(StringComparer.Ordinal);
        foreach (var reference in value.References)
        {
            if (!NixArchive.SafeId(reference.SourceItemId) || reference.Policy is not ("retain" or "omit" or "replace")
                || (reference.InputKey is not null && Utf8Length(reference.InputKey) > 64))
            {
                return "template initialization reference policies are invalid";
            }
            if (!seenReferences.Add(reference.SourceItemId))
            {
                return "template initialization contains duplicate reference policies";
            }
            if (reference.Policy == "replace" && (reference.InputKey is null || inputKeys.GetValueOrDefault(reference.InputKey) != "item"))
            {
                return "a replacement reference requires a declared item input";
            }
            if (reference.Policy != "replace" && reference.InputKey is not null)
            {
                return "retain and omit references must not carry an input key";
            }
        }
        return null;
    }

    private static bool ValidDefault(string inputType, string value) => inputType switch
    {
        "text" => Utf8Length(value) <= 4096,
        "date" => DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed)
            && parsed.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) == value,
        "member" or "item" => UuidPattern().IsMatch(value),
        _ => false,
    };

    private static string? ValidatePlan(TemplatePlan plan, ImportPlanLimits? limits)
    {
        if (plan.Version != TemplatePlan.CurrentVersion || !NixArchive.SafeSha256(plan.SourceSha256) || ValidateProfile(plan.Profile) is not null || plan.Items.Count == 0)
        {
            return "template plan metadata is invalid";
        }
        if (limits is not null && (plan.Items.Count > limits.MaxItems || limits.MaxDepth <= 0 || limits.MaxBodyBytes <= 0))
        {
            return "template plan exceeds the configured limits";
        }
        if (plan.Files is not null)
        {
            if (limits is not null && plan.Files.Count > (long)limits.MaxItems * NixArchive.MaxFileVersionsPerItem)
            {
                return "template plan declares too many file versions";
            }
            try
            {
                NixArchive.ValidateFileVersions(plan.Files, [.. plan.Items.Select(item => new ManifestItem(item.SourceId, item.ParentSourceId, item.Seq, item.Title, item.ItemType))]);
            }
            catch (ArchiveFormatException exception)
            {
                return exception.Message;
            }
        }
        var depths = new Dictionary<string, int>(StringComparer.Ordinal);
        int rootCount = 0, bodyCount = 0, viewCount = 0;
        var rootType = string.Empty;
        var rootHasBody = false;
        foreach (var item in plan.Items)
        {
            if (!NixArchive.SafeId(item.SourceId) || !NixImport.ValidIntegerString(item.Seq) || !BoundedText(item.Title, 500, true) || !BoundedText(item.ItemType, 64, false) || !GoJson.IsObject(item.Properties))
            {
                return "template plan contains an invalid item envelope";
            }
            if (depths.ContainsKey(item.SourceId))
            {
                return "template plan contains a duplicate source item";
            }
            var depth = 0;
            if (item.ParentSourceId is null)
            {
                rootCount++;
                rootType = item.ItemType;
                rootHasBody = !GoJson.IsNull(item.Body);
            }
            else
            {
                if (!NixArchive.SafeId(item.ParentSourceId))
                {
                    return "template plan contains an invalid parent source item";
                }
                if (!depths.TryGetValue(item.ParentSourceId, out var parentDepth))
                {
                    return "template plan items are not parent-first";
                }
                depth = parentDepth + 1;
            }
            if (limits is not null && depth > limits.MaxDepth)
            {
                return "template plan tree is too deep";
            }
            depths[item.SourceId] = depth;
            if (limits is not null)
            {
                foreach (var (name, value) in (ReadOnlySpan<(string, JsonElement?)>)[("properties", item.Properties), ("schema", item.Schema), ("views", item.Views), ("body", item.Body), ("recurrence", item.Recurrence)])
                {
                    if (!GoJson.DepthWithin(value, limits.MaxDepth, out var depthError))
                    {
                        return $"template plan item {item.SourceId} {name}: {depthError}";
                    }
                }
            }
            if (!GoJson.IsNull(item.Schema) && !GoJson.IsObject(item.Schema))
            {
                return "template plan contains an invalid property schema";
            }
            if (!GoJson.IsNull(item.Views) && !GoJson.IsObject(item.Views))
            {
                return "template plan contains invalid views";
            }
            if (!GoJson.IsNull(item.Body))
            {
                if (!GoJson.IsObject(item.Body) || (limits is not null && GoJson.RawLength(item.Body) > limits.MaxBodyBytes))
                {
                    return "template plan contains an invalid or oversized body";
                }
                bodyCount++;
            }
            if (CountViews(item.Views) is not { } count)
            {
                return "template item views are invalid";
            }
            viewCount += count;
        }
        if (rootCount != 1 || rootType != plan.RootItemType || plan.ItemCount != plan.Items.Count || plan.BodyCount != bodyCount || plan.ViewCount != viewCount)
        {
            return "template plan counts or root metadata are inconsistent";
        }
        if (!plan.Profile.IncludeChildren && plan.Items.Count != 1)
        {
            return "template plan descendants disagree with its profile";
        }
        if (!plan.Profile.IncludeBody && rootHasBody)
        {
            return "template plan root body disagrees with its profile";
        }
        return null;
    }

    /// <summary>The number of views in a snapshot, or null when it is malformed.</summary>
    private static int? CountViews(JsonElement? value)
    {
        if (GoJson.IsNull(value))
        {
            return 0;
        }
        try
        {
            var snapshot = GoFields.Require(value!.Value, true, "views", "default");
            snapshot.String("default");
            return snapshot.List("views", element => element)?.Count;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>Valid text of at most <paramref name="maximum"/> code points, optionally blank.</summary>
    private static bool BoundedText(string value, int maximum, bool allowEmpty) =>
        CodePoints(value) is >= 0 and var count && count <= maximum && (allowEmpty || value.Trim().Length != 0);

    /// <summary>Code points in the string, or -1 when a lone surrogate makes it invalid (Go's utf8.ValidString).</summary>
    private static int CodePoints(string value)
    {
        var count = 0;
        for (var index = 0; index < value.Length; index++)
        {
            if (char.IsHighSurrogate(value[index]) && index + 1 < value.Length && char.IsLowSurrogate(value[index + 1]))
            {
                index++;
            }
            else if (char.IsSurrogate(value[index]))
            {
                return -1;
            }
            count++;
        }
        return count;
    }

    private static int Utf8Length(string value) => System.Text.Encoding.UTF8.GetByteCount(value);

    [GeneratedRegex(@"^[a-z0-9](?:[a-z0-9._-]{0,158}[a-z0-9])?\z", RegexOptions.CultureInvariant)]
    private static partial Regex TemplateKeyPattern();

    [GeneratedRegex(@"^[a-z][a-z0-9_-]{0,63}\z", RegexOptions.CultureInvariant)]
    private static partial Regex InputKeyPattern();

    [GeneratedRegex(@"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\z", RegexOptions.CultureInvariant)]
    private static partial Regex UuidPattern();

    [GeneratedRegex(@"^([01][0-9]|2[0-3]):[0-5][0-9]\z", RegexOptions.CultureInvariant)]
    private static partial Regex TimePattern();
}
