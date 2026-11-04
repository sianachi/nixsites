namespace Nix.Workers.Calendar;

/// <summary>
/// Maps the CLDR Windows zone names Graph reports in <c>originalStartTimeZone</c> and
/// <c>originalEndTimeZone</c> to the IANA zone a <see cref="CalendarBound"/> expects. Not the
/// full CLDR table: the common zones, with a UTC fallback the caller logs.
/// </summary>
public static class WindowsZones
{
    private static readonly Dictionary<string, string> Table = new(StringComparer.Ordinal)
    {
        ["UTC"] = "UTC",
        ["GMT Standard Time"] = "Europe/London",
        ["W. Europe Standard Time"] = "Europe/Berlin",
        ["Central Europe Standard Time"] = "Europe/Budapest",
        ["Central European Standard Time"] = "Europe/Warsaw",
        ["Romance Standard Time"] = "Europe/Paris",
        ["E. Europe Standard Time"] = "Europe/Chisinau",
        ["Russian Standard Time"] = "Europe/Moscow",
        ["Turkey Standard Time"] = "Europe/Istanbul",
        ["Israel Standard Time"] = "Asia/Jerusalem",
        ["Arabian Standard Time"] = "Asia/Dubai",
        ["India Standard Time"] = "Asia/Kolkata",
        ["China Standard Time"] = "Asia/Shanghai",
        ["Tokyo Standard Time"] = "Asia/Tokyo",
        ["Korea Standard Time"] = "Asia/Seoul",
        ["SE Asia Standard Time"] = "Asia/Bangkok",
        ["Singapore Standard Time"] = "Asia/Singapore",
        ["AUS Eastern Standard Time"] = "Australia/Sydney",
        ["AUS Central Standard Time"] = "Australia/Darwin",
        ["New Zealand Standard Time"] = "Pacific/Auckland",
        ["South Africa Standard Time"] = "Africa/Johannesburg",
        ["Eastern Standard Time"] = "America/New_York",
        ["Central Standard Time"] = "America/Chicago",
        ["Mountain Standard Time"] = "America/Denver",
        ["Pacific Standard Time"] = "America/Los_Angeles",
        ["Alaskan Standard Time"] = "America/Anchorage",
        ["Hawaiian Standard Time"] = "Pacific/Honolulu",
        ["Argentina Standard Time"] = "America/Argentina/Buenos_Aires",
        ["E. South America Standard Time"] = "America/Sao_Paulo",
        ["Pacific SA Standard Time"] = "America/Santiago",
        ["Atlantic Standard Time"] = "America/Halifax",
        ["Newfoundland Standard Time"] = "America/St_Johns",
    };

    /// <summary>The IANA zone for a Windows name; <paramref name="known"/> is false for the UTC fallback of an unrecognised name.</summary>
    public static string ToIana(string? windowsName, out bool known)
    {
        var trimmed = windowsName?.Trim() ?? string.Empty;
        if (trimmed.Length == 0)
        {
            known = true;
            return "UTC";
        }
        if (Table.TryGetValue(trimmed, out var iana))
        {
            known = true;
            return iana;
        }
        known = false;
        return "UTC";
    }
}
