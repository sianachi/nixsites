using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Nix.Domain.Scheduling;

/// <summary>
/// Reads the instant out of an item's <c>reminder</c> (or <c>expiry</c>) property, for a source's own re-verification
/// at fire time - never for validating a write, which is <c>PropertyValidator.CheckTimestamp</c>'s
/// job.
/// </summary>
public static class ReminderInstant
{
    /// <summary>The stored value's instant, or <see langword="null"/> when there is no reminder or it cannot be read.</summary>
    /// <param name="properties">The item's property bag, as stored.</param>
    /// <param name="key">The property holding the instant, <c>reminder</c> or <c>expiry</c>.</param>
    /// <remarks>
    /// Strips the bracketed zone name the same way the planning finder's SQL does
    /// (<c>split_part(..., '[', 1)</c>) - the offset-bearing prefix is what
    /// <see cref="DateTimeOffset"/> parses, and every value that reached storage passed
    /// <c>PropertyValidator.CheckTimestamp</c>, so a malformed one here means the property was
    /// removed or replaced since planning, not that this parse is stricter than the write path's.
    /// </remarks>
    public static DateTimeOffset? Read(string? properties, string key)
    {
        if (string.IsNullOrWhiteSpace(properties))
        {
            return null;
        }

        try
        {
            if (JsonNode.Parse(properties) is not JsonObject bag
                || bag[key] is not JsonValue value
                || !value.TryGetValue<string>(out var text))
            {
                return null;
            }

            var bracket = text.IndexOf('[', StringComparison.Ordinal);
            var instantText = bracket >= 0 ? text[..bracket] : text;
            return DateTimeOffset.TryParse(
                instantText,
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                out var instant)
                ? instant
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
