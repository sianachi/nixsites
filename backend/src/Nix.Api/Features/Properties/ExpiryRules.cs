using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Scheduling;

namespace Nix.Features.Properties;

/// <summary>
/// The write-time check for the built-in <c>expiry</c> key. It is undeclared in schemas, so no
/// schema would refuse a malformed or already-passed value; a past one would trash the item on the
/// next planning pass.
/// </summary>
internal static class ExpiryRules
{
    // An instant with its offset, and optionally the zone Nix timestamps carry. Agents send plain
    // ISO 8601; a date alone is refused because it does not say which midnight it means.
    private static readonly Regex Instant = new(
        @"^\d{4}-\d{2}-\d{2}T[^\[\]]+(Z|[+-]\d{2}:\d{2})(\[[^\[\]]+\])?$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant,
        TimeSpan.FromSeconds(1));

    /// <summary>
    /// Refuses a write that names <c>expiry</c> with a malformed value or an instant not after
    /// <paramref name="now"/>. Clearing with null is allowed, and a write that does not name the
    /// key is never refused: an item already past its date can still be renamed.
    /// </summary>
    /// <param name="bag">The bag as it will be stored.</param>
    /// <param name="touchedKeys">The keys this write named.</param>
    /// <param name="now">The current instant.</param>
    /// <returns>The refusal, or <see langword="null"/> when the write may go on.</returns>
    internal static NixError? Check(string bag, IEnumerable<string> touchedKeys, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(bag);
        ArgumentNullException.ThrowIfNull(touchedKeys);
        if (!touchedKeys.Contains(ItemProperties.ExpiryKey, StringComparer.Ordinal)
            || JsonNode.Parse(bag) is not JsonObject document
            || document[ItemProperties.ExpiryKey] is null)
        {
            return null;
        }

        if (document[ItemProperties.ExpiryKey] is not JsonValue value
            || !value.TryGetValue<string>(out var text)
            || !Instant.IsMatch(text)
            || ReminderInstant.Read(bag, ItemProperties.ExpiryKey) is not { } instant)
        {
            return PropertyErrors.InvalidProperties(
                [new PropertyViolation(ItemProperties.ExpiryKey, "Expiry must be a time with its offset, such as 2027-04-02T17:00:00Z.")]);
        }

        return instant > now
            ? null
            : PropertyErrors.InvalidProperties(
                [new PropertyViolation(ItemProperties.ExpiryKey, "Expiry must be a time in the future.")]);
    }
}
