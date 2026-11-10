using System.Collections.Immutable;
using System.Text.Json.Nodes;
using Nix.Domain.Items;

namespace Nix.Domain.Automations;

/// <summary>One reason a rule document was refused.</summary>
/// <param name="Path">Where in the document, such as <c>trigger.time</c> or <c>actions[1].key</c>.</param>
/// <param name="Reason">A short, fixed English reason - never an echo of the caller's value.</param>
/// <param name="Unavailable">
/// Whether the part is recognised but not available in this build (an action whose lane has not
/// shipped), rather than malformed. The API reports it with its own code.
/// </param>
public sealed record AutomationViolation(string Path, string Reason, bool Unavailable = false)
{
    /// <inheritdoc />
    public override string ToString() => $"{Path}: {Reason}";
}

/// <summary>The outcome of reading one part of a rule document: the value, or every violation.</summary>
/// <typeparam name="T">What was read.</typeparam>
public sealed record AutomationParse<T>(T? Value, ImmutableArray<AutomationViolation> Violations)
{
    /// <summary>Gets whether nothing was refused.</summary>
    public bool IsValid => Violations.IsDefaultOrEmpty;
}

/// <summary>The strict-reading helpers every automation JSON reader shares.</summary>
internal static class AutomationJsonRead
{
    /// <summary>The longest property key a rule may name, matching the <c>watch_key</c> column.</summary>
    internal const int MaximumKeyLength = 128;

    /// <summary>Adds a violation for every member of <paramref name="node"/> not in <paramref name="allowed"/>.</summary>
    internal static void RefuseUnknown(JsonObject node, string path, ICollection<AutomationViolation> violations, params string[] allowed)
    {
        foreach (var member in node)
        {
            if (!allowed.Contains(member.Key, StringComparer.Ordinal))
            {
                violations.Add(new AutomationViolation($"{path}.{member.Key}", "is not a recognised field"));
            }
        }
    }

    /// <summary>Reads a required string member, or <see langword="null"/> after recording a violation.</summary>
    internal static string? String(JsonObject node, string member, string path, ICollection<AutomationViolation> violations)
    {
        if (node[member] is JsonValue value && value.TryGetValue<string>(out var text))
        {
            return text;
        }

        violations.Add(new AutomationViolation($"{path}.{member}", "must be a string"));
        return null;
    }

    /// <summary>Reads an optional string member; a present non-string is a violation.</summary>
    internal static string? OptionalString(JsonObject node, string member, string path, ICollection<AutomationViolation> violations)
    {
        if (!node.TryGetPropertyValue(member, out var raw) || raw is null)
        {
            return null;
        }

        if (raw is JsonValue value && value.TryGetValue<string>(out var text))
        {
            return text;
        }

        violations.Add(new AutomationViolation($"{path}.{member}", "must be a string"));
        return null;
    }

    /// <summary>Reads an integer member, or <see langword="null"/> after recording a violation.</summary>
    internal static int? Integer(JsonObject node, string member, string path, ICollection<AutomationViolation> violations, bool required = true)
    {
        if (!node.TryGetPropertyValue(member, out var raw) || raw is null)
        {
            if (required)
            {
                violations.Add(new AutomationViolation($"{path}.{member}", "is required"));
            }

            return null;
        }

        if (raw is JsonValue value && value.TryGetValue<int>(out var number))
        {
            return number;
        }

        if (raw is JsonValue decimalValue && decimalValue.TryGetValue<decimal>(out var dec)
            && dec == decimal.Truncate(dec) && dec is >= int.MinValue and <= int.MaxValue)
        {
            return (int)dec;
        }

        violations.Add(new AutomationViolation($"{path}.{member}", "must be a whole number"));
        return null;
    }

    /// <summary>
    /// Checks a property key a rule names: 1..128 characters, and never a <c>$</c>-prefixed system
    /// key - the scheduler's set-by keys, the habit keys, and anything a later lane
    /// reserves the same way.
    /// </summary>
    internal static bool CheckKey(string? key, string path, ICollection<AutomationViolation> violations)
    {
        if (key is null)
        {
            return false;
        }

        if (key.Length is 0 or > MaximumKeyLength || key.Any(char.IsControl))
        {
            violations.Add(new AutomationViolation(path, "must be 1 to 128 characters"));
            return false;
        }

        if (key.StartsWith('$') || ItemProperties.IsReservedSchedulingKey(key))
        {
            violations.Add(new AutomationViolation(path, "names a system property automations cannot use"));
            return false;
        }

        return true;
    }

    /// <summary>The UTF-8 size of a JSON node as it would be stored.</summary>
    internal static int Bytes(JsonNode? node) =>
        System.Text.Encoding.UTF8.GetByteCount(node?.ToJsonString() ?? "null");
}
