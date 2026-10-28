using System.Collections.Immutable;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Nix.Domain.Recurrence;

/// <summary>
/// Reads and writes the stored shape of a <see cref="RecurrenceRule"/>.
/// </summary>
/// <remarks>
/// <para>
/// <b>Reading fails closed, exactly as <c>PropertySchemaJson</c> does.</b> A rule this build
/// cannot parse is not a rule: the item expands to nothing rather than to something invented. An
/// older instance still serving traffic stops repeating an item it cannot interpret, which is a
/// loss of function and recoverable; guessing is not.
/// </para>
/// <para>
/// <b>Writing is guarded here, not at the database.</b> The column's CHECK is a backstop for a
/// write path that forgot; <see cref="MaximumBytes"/> is the guard that turns an oversized rule
/// into a mapped refusal rather than a constraint violation and a 500.
/// </para>
/// </remarks>
public static class RecurrenceRuleJson
{
    /// <summary>The largest a stored rule may be, matching the column's own bound.</summary>
    /// <remarks>
    /// A rule is not a document: its fixed part is about 120 bytes and the exception list is
    /// bounded at <see cref="MaximumCompleted"/> entries, so this is headroom rather than a
    /// ceiling anybody should meet.
    /// </remarks>
    public const int MaximumBytes = 4096;

    /// <summary>The most exception days a rule may carry before a write is refused.</summary>
    /// <remarks>
    /// Reaching 200 scattered, non-contiguous completions is not a workflow - in-order completion
    /// compacts into the watermark and leaves the list empty. The refusal is a mapped result with
    /// a stable code, never the CHECK.
    /// </remarks>
    public const int MaximumCompleted = 200;

    /// <summary>The point at which the writer folds contiguous completions into the watermark.</summary>
    public const int CompactionThreshold = 64;

    /// <summary>The longest interval a rule may carry, so a series cannot be effectively inert.</summary>
    public const int MaximumInterval = 366;

    /// <summary>Reads a stored rule, or null when this build cannot interpret it.</summary>
    /// <param name="json">The stored JSON, or null.</param>
    /// <returns>The rule, or null when absent or unreadable.</returns>
    public static RecurrenceRule? Read(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }

        JsonNode? node;
        try
        {
            node = JsonNode.Parse(json);
        }
        catch (JsonException)
        {
            return null;
        }

        if (node is not JsonObject document)
        {
            return null;
        }

        if (!TryFrequency(document["freq"]?.GetValue<string>(), out var frequency))
        {
            return null;
        }

        var interval = ReadInt(document["interval"]);
        if (interval is null or < 1 or > MaximumInterval)
        {
            return null;
        }

        var weekdays = ReadWeekdays(document["weekdays"]);
        if (weekdays is null)
        {
            return null;
        }

        // Weekdays on a non-weekly rule is refused rather than ignored: silently dropping an
        // input somebody typed is a lie about what the series will do.
        if (weekdays.Value.Length > 0 && frequency != RecurrenceFrequency.Weekly)
        {
            return null;
        }

        if (!TryDay(document["until"], out var until)
            || !TryDay(document["completedThrough"], out var completedThrough))
        {
            return null;
        }

        var completed = ReadDays(document["completed"]);
        if (completed is null || completed.Value.Length > MaximumCompleted)
        {
            return null;
        }

        // Ascending and above the watermark, both required: an unsorted or shadowed list means
        // the two halves of the completion state disagree, and there is no way to know which was
        // meant.
        for (var index = 0; index < completed.Value.Length; index++)
        {
            if (index > 0 && completed.Value[index] <= completed.Value[index - 1])
            {
                return null;
            }

            if (completedThrough is { } through && completed.Value[index] <= through)
            {
                return null;
            }
        }

        return new RecurrenceRule(
            frequency,
            interval.Value,
            weekdays.Value,
            until,
            completedThrough,
            completed.Value);
    }

    /// <summary>Writes a rule for storage.</summary>
    /// <param name="rule">The rule.</param>
    /// <returns>The JSON to store.</returns>
    public static string Write(RecurrenceRule rule)
    {
        ArgumentNullException.ThrowIfNull(rule);

        var document = new JsonObject
        {
            ["freq"] = FrequencyText(rule.Frequency),
            ["interval"] = rule.Interval,
        };

        if (!rule.Weekdays.IsDefaultOrEmpty)
        {
            document["weekdays"] = new JsonArray(
                [.. rule.Weekdays.Select(day => JsonValue.Create(WeekdayText(day)))]);
        }

        if (rule.Until is { } until)
        {
            document["until"] = Iso(until);
        }

        if (rule.CompletedThrough is { } through)
        {
            document["completedThrough"] = Iso(through);
        }

        if (!rule.Completed.IsDefaultOrEmpty)
        {
            document["completed"] = new JsonArray(
                [.. rule.Completed.Select(day => JsonValue.Create(Iso(day)))]);
        }

        return document.ToJsonString();
    }

    /// <summary>Whether a rule is small enough to store, measured the way the column measures.</summary>
    /// <param name="json">The written rule.</param>
    /// <returns><see langword="true"/> when within <see cref="MaximumBytes"/>.</returns>
    public static bool IsWithinBounds(string json)
    {
        ArgumentNullException.ThrowIfNull(json);
        return Encoding.UTF8.GetByteCount(json) <= MaximumBytes;
    }

    /// <summary>
    /// Folds every contiguous completed occurrence into the watermark, leaving only the gaps.
    /// </summary>
    /// <param name="rule">The rule to compact.</param>
    /// <param name="anchor">The series' anchor, so contiguity is judged against real occurrences.</param>
    /// <returns>The compacted rule, or the same rule when nothing folded.</returns>
    /// <remarks>
    /// In-order completion compacts on every write and the exception list stays empty, which is
    /// what keeps a years-old daily series inside the size bound.
    /// </remarks>
    public static RecurrenceRule Compact(RecurrenceRule rule, DateOnly anchor)
    {
        ArgumentNullException.ThrowIfNull(rule);

        if (rule.Completed.IsDefaultOrEmpty)
        {
            return rule;
        }

        var through = rule.CompletedThrough;
        var remaining = rule.Completed;

        // Walk the occurrences from just past the watermark: each one that is completed advances
        // it, and the first that is not stops the fold.
        for (; ; )
        {
            var next = RecurrenceExpansion
                .Occurrences(
                    rule,
                    anchor,
                    through is { } watermark ? watermark.AddDays(1) : anchor,
                    remaining[^1])
                .FirstOrDefault();

            if (next == default || !remaining.Contains(next))
            {
                break;
            }

            through = next;
            remaining = remaining.Remove(next);
            if (remaining.IsEmpty)
            {
                break;
            }
        }

        return rule with { CompletedThrough = through, Completed = remaining };
    }

    internal static bool TryFrequency(string? text, out RecurrenceFrequency frequency)
    {
        switch (text)
        {
            case "daily":
                frequency = RecurrenceFrequency.Daily;
                return true;
            case "weekly":
                frequency = RecurrenceFrequency.Weekly;
                return true;
            case "monthly":
                frequency = RecurrenceFrequency.Monthly;
                return true;
            case "yearly":
                frequency = RecurrenceFrequency.Yearly;
                return true;
            default:
                frequency = default;
                return false;
        }
    }

    internal static string FrequencyText(RecurrenceFrequency frequency) => frequency switch
    {
        RecurrenceFrequency.Daily => "daily",
        RecurrenceFrequency.Weekly => "weekly",
        RecurrenceFrequency.Monthly => "monthly",
        RecurrenceFrequency.Yearly => "yearly",
        _ => throw new ArgumentOutOfRangeException(nameof(frequency), frequency, "Unknown frequency."),
    };

    internal static bool TryWeekday(string? text, out IsoDayOfWeek weekday)
    {
        weekday = text switch
        {
            "mo" => IsoDayOfWeek.Monday,
            "tu" => IsoDayOfWeek.Tuesday,
            "we" => IsoDayOfWeek.Wednesday,
            "th" => IsoDayOfWeek.Thursday,
            "fr" => IsoDayOfWeek.Friday,
            "sa" => IsoDayOfWeek.Saturday,
            "su" => IsoDayOfWeek.Sunday,
            _ => default,
        };
        return weekday != default;
    }

    internal static string WeekdayText(IsoDayOfWeek weekday) => weekday switch
    {
        IsoDayOfWeek.Monday => "mo",
        IsoDayOfWeek.Tuesday => "tu",
        IsoDayOfWeek.Wednesday => "we",
        IsoDayOfWeek.Thursday => "th",
        IsoDayOfWeek.Friday => "fr",
        IsoDayOfWeek.Saturday => "sa",
        IsoDayOfWeek.Sunday => "su",
        _ => throw new ArgumentOutOfRangeException(nameof(weekday), weekday, "Unknown weekday."),
    };

    private static int? ReadInt(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue(out int parsed) ? parsed : null;

    private static bool TryDay(JsonNode? node, out DateOnly? day)
    {
        if (node is null)
        {
            day = null;
            return true;
        }

        if (node is JsonValue value
            && value.TryGetValue(out string? text)
            && text is not null
            && DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed))
        {
            day = parsed;
            return true;
        }

        day = null;
        return false;
    }

    /// <summary>The weekday list, empty when absent; null when it is present and malformed.</summary>
    private static ImmutableArray<IsoDayOfWeek>? ReadWeekdays(JsonNode? node)
    {
        if (node is null)
        {
            return ImmutableArray<IsoDayOfWeek>.Empty;
        }

        if (node is not JsonArray array || array.Count == 0)
        {
            return null;
        }

        var days = ImmutableArray.CreateBuilder<IsoDayOfWeek>(array.Count);
        foreach (var entry in array)
        {
            if (entry is not JsonValue value
                || !value.TryGetValue(out string? text)
                || !TryWeekday(text, out var weekday)
                || days.Contains(weekday))
            {
                return null;
            }

            days.Add(weekday);
        }

        return days.ToImmutable();
    }

    /// <summary>The completion list, empty when absent; null when it is present and malformed.</summary>
    private static ImmutableArray<DateOnly>? ReadDays(JsonNode? node)
    {
        if (node is null)
        {
            return ImmutableArray<DateOnly>.Empty;
        }

        if (node is not JsonArray array)
        {
            return null;
        }

        var days = ImmutableArray.CreateBuilder<DateOnly>(array.Count);
        foreach (var entry in array)
        {
            if (!TryDay(entry, out var day) || day is null)
            {
                return null;
            }

            days.Add(day.Value);
        }

        return days.ToImmutable();
    }

    internal static string Iso(DateOnly day) => day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
}
