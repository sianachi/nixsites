using System.Globalization;

namespace Nix.Workers.Calendar;

/// <summary>
/// One endpoint (start or end) of a calendar event, in the "date or date-time" shape items use:
/// either an all-day date or a timed instant carried with its IANA zone. <see cref="Wire"/>
/// renders it exactly as contracts C2/C3 expect: <c>yyyy-MM-dd</c> for an all-day boundary, RFC
/// 9557 (an RFC 3339 timestamp followed by a bracketed IANA zone name) for a timed one.
/// </summary>
public readonly record struct CalendarBound(bool AllDay, string Date, DateTimeOffset Instant, string Zone)
{
    private const string DateLayout = "yyyy-MM-dd";
    private const string Rfc3339 = "yyyy-MM-dd'T'HH:mm:ssK";

    /// <summary>An all-day boundary on <paramref name="date"/> (yyyy-MM-dd).</summary>
    public static CalendarBound OnDate(string date) => new(true, date, default, string.Empty);

    /// <summary>A timed boundary at <paramref name="instant"/>, rendered in <paramref name="zone"/>.</summary>
    public static CalendarBound At(DateTimeOffset instant, string zone) => new(false, string.Empty, instant, zone);

    /// <summary>Renders the bound the way contracts C2 and C3 encode a DateOrTimestamp value.</summary>
    public string Wire() => AllDay ? Date : Rfc3339In(Instant, Zone) + "[" + Zone + "]";

    /// <summary>The instant rendered as RFC 3339 (second precision, <c>Z</c> for UTC) in <paramref name="zone"/>; UTC when the zone is unknown.</summary>
    public static string Rfc3339In(DateTimeOffset instant, string zone)
    {
        var local = TryZone(zone, out var info) ? TimeZoneInfo.ConvertTime(instant, info) : instant.ToUniversalTime();
        return local.ToString(Rfc3339, CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// Decodes a contract C2/C3 DateOrTimestamp string: exactly a bare <c>yyyy-MM-dd</c> date, or an
    /// RFC 9557 timestamp (RFC 3339 followed by <c>[IANA/Zone]</c>).
    /// </summary>
    public static CalendarBound Parse(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        if (value.Length == DateLayout.Length
            && DateOnly.TryParseExact(value, DateLayout, CultureInfo.InvariantCulture, DateTimeStyles.None, out var date))
        {
            return OnDate(date.ToString(DateLayout, CultureInfo.InvariantCulture));
        }
        var open = value.IndexOf('[', StringComparison.Ordinal);
        if (open <= 0 || !value.EndsWith(']'))
        {
            throw new FormatException($"calendar bound \"{value}\" is neither a date nor an RFC 9557 timestamp");
        }
        var zone = value[(open + 1)..^1];
        if (!TryZone(zone, out _))
        {
            throw new FormatException($"calendar bound zone \"{zone}\" is invalid");
        }
        if (!DateTimeOffset.TryParseExact(value[..open], ["yyyy-MM-dd'T'HH:mm:ssK", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFFK"], CultureInfo.InvariantCulture, DateTimeStyles.None, out var instant))
        {
            throw new FormatException($"calendar bound timestamp \"{value}\" is invalid");
        }
        return At(instant, zone);
    }

    /// <summary>Whether <paramref name="zone"/> names a known IANA time zone.</summary>
    public static bool TryZone(string zone, out TimeZoneInfo info)
    {
        if (string.IsNullOrEmpty(zone))
        {
            info = TimeZoneInfo.Utc;
            return false;
        }
        if (zone == "UTC")
        {
            info = TimeZoneInfo.Utc;
            return true;
        }
        return TimeZoneInfo.TryFindSystemTimeZoneById(zone, out info!);
    }

    /// <summary>
    /// Converts a provider's end-exclusive all-day end date (Google <c>end.date</c>, Graph's end
    /// when <c>isAllDay</c>) to the inclusive end date items use: the day before.
    /// </summary>
    public static string InclusiveEndDate(string exclusiveEnd) => ShiftDate(exclusiveEnd, -1, "provider end date");

    /// <summary>The inverse of <see cref="InclusiveEndDate"/>, for pushing to the providers.</summary>
    public static string ExclusiveEndDate(string inclusiveEnd) => ShiftDate(inclusiveEnd, 1, "item end date");

    private static string ShiftDate(string value, int days, string what)
    {
        if (!DateOnly.TryParseExact(value, DateLayout, CultureInfo.InvariantCulture, DateTimeStyles.None, out var date))
        {
            throw new FormatException($"{what} \"{value}\" is invalid");
        }
        return date.AddDays(days).ToString(DateLayout, CultureInfo.InvariantCulture);
    }
}
