using System.Globalization;
using NodaTime;

namespace Nix.Features.PetRuns;

/// <summary>Builds the line that tells the planner model what day it is.</summary>
public static class PetRunClock
{
    /// <summary>Describes the current date in the owner's zone, or in UTC when they have none this build knows.</summary>
    /// <param name="now">The current instant.</param>
    /// <param name="timeZone">The owner's stored IANA zone, if any.</param>
    /// <returns>The date line.</returns>
    public static string Describe(DateTimeOffset now, string? timeZone = null)
    {
        // Only a name the zone database knows reaches the model, never the stored text as typed.
        var zone = timeZone is { Length: > 0 } ? DateTimeZoneProviders.Tzdb.GetZoneOrNull(timeZone) : null;
        var day = Instant.FromDateTimeOffset(now).InZone(zone ?? DateTimeZone.Utc).Date
            .ToString("dddd yyyy-MM-dd", CultureInfo.InvariantCulture);
        return zone is null || zone == DateTimeZone.Utc || zone.Id == "Etc/UTC"
            ? $"Current date (UTC): {day}."
            : $"Owner's date ({zone.Id}): {day}.";
    }
}
