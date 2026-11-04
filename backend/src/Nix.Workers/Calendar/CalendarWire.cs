using System.Text;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Nix.Workers.Calendar;

/// <summary>Helpers shared by both provider clients, kept byte-compatible with the Go worker's output.</summary>
public static partial class CalendarWire
{
    /// <summary>A lower-case canonical UUID, the only shape the contracts accept.</summary>
    public static bool IsCanonicalUuid(string? value) => value is not null && CanonicalUuid().IsMatch(value);

    /// <summary>
    /// Go's <c>url.PathEscape</c>: unreserved characters and <c>$&amp;+:=@</c> pass, <c>/ ; , ?</c>
    /// and everything else are percent-encoded. Kept so a calendar id with an <c>@</c> produces
    /// the same path the Go worker sent.
    /// </summary>
    public static string PathEscape(string segment)
    {
        ArgumentNullException.ThrowIfNull(segment);
        // Unlike Go's client, System.Uri collapses dot segments, so "." or ".." would climb the provider path.
        if (segment is "." or "..")
        {
            throw new CalendarProviderException("calendar path segment is invalid");
        }
        var builder = new StringBuilder(segment.Length);
        foreach (var b in Encoding.UTF8.GetBytes(segment))
        {
            var c = (char)b;
            if (char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.' or '~' or '$' or '&' or '+' or ':' or '=' or '@')
            {
                builder.Append(c);
            }
            else
            {
                builder.Append('%').Append(b.ToString("X2", System.Globalization.CultureInfo.InvariantCulture));
            }
        }
        return builder.ToString();
    }

    /// <summary>Go's <c>url.Values.Encode</c>: keys sorted, values query-escaped (space as <c>+</c>).</summary>
    public static string QueryEncode(IEnumerable<KeyValuePair<string, string>> pairs)
    {
        ArgumentNullException.ThrowIfNull(pairs);
        return string.Join("&", pairs
            .OrderBy(pair => pair.Key, StringComparer.Ordinal)
            .Select(pair => QueryEscape(pair.Key) + "=" + QueryEscape(pair.Value)));
    }

    private static string QueryEscape(string value)
    {
        var builder = new StringBuilder(value.Length);
        foreach (var b in Encoding.UTF8.GetBytes(value))
        {
            var c = (char)b;
            if (char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.' or '~')
            {
                builder.Append(c);
            }
            else if (c == ' ')
            {
                builder.Append('+');
            }
            else
            {
                builder.Append('%').Append(b.ToString("X2", System.Globalization.CultureInfo.InvariantCulture));
            }
        }
        return builder.ToString();
    }

    /// <summary>Cuts <paramref name="value"/> to at most <paramref name="maximum"/> UTF-8 bytes without splitting a sequence.</summary>
    public static string TruncateUtf8(string value, int maximum)
    {
        ArgumentNullException.ThrowIfNull(value);
        if (Encoding.UTF8.GetByteCount(value) <= maximum)
        {
            return value;
        }
        var bytes = Encoding.UTF8.GetBytes(value);
        var cut = maximum;
        while (cut > 0 && (bytes[cut] & 0xC0) == 0x80)
        {
            cut--;
        }
        return Encoding.UTF8.GetString(bytes, 0, cut);
    }

    [GeneratedRegex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")]
    private static partial Regex CanonicalUuid();
}

// Google Calendar wire shapes. Reads ignore unknown members, as the Go decoder did.
internal sealed record GoogleDateTime(string? Date, string? DateTime, string? TimeZone);

internal sealed record GoogleOrganizer(bool Self);

internal sealed record GoogleEvent(
    string? Id,
    [property: JsonPropertyName("etag")] string? ETag,
    string? Status,
    string? Summary,
    string? Description,
    string? Location,
    GoogleDateTime? Start,
    GoogleDateTime? End,
    DateTimeOffset? Updated,
    GoogleOrganizer? Organizer,
    bool GuestsCanModify);

internal sealed record GoogleEventsResponse(string? NextPageToken, string? NextSyncToken, IReadOnlyList<GoogleEvent>? Items);

internal sealed record GoogleErrorBody(int Code, string? Message);

internal sealed record GoogleErrorResponse(GoogleErrorBody? Error);

/// <summary>A create, revive or patch body. Null members are written: PATCH merges, so the field the other kind used must be cleared.</summary>
internal sealed record GoogleEventBody(
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Id,
    string Summary,
    string Location,
    string Description,
    GoogleDateTime Start,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] GoogleDateTime? End,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Status);

// Microsoft Graph wire shapes.
internal sealed record GraphDateTime(string? DateTime, string? TimeZone);

internal sealed record GraphBody(string? ContentType, string? Content);

internal sealed record GraphLocation(string? DisplayName);

internal sealed record GraphRemoved(string? Reason);

internal sealed record GraphProperty(string Id, string Value);

internal sealed record GraphEvent(
    string? Id,
    string? ChangeKey,
    string? Subject,
    GraphBody? Body,
    GraphLocation? Location,
    GraphDateTime? Start,
    GraphDateTime? End,
    bool IsAllDay,
    DateTimeOffset? LastModifiedDateTime,
    string? OriginalStartTimeZone,
    string? OriginalEndTimeZone,
    bool? IsOrganizer,
    string? TransactionId,
    IReadOnlyList<GraphProperty>? SingleValueExtendedProperties,
    [property: JsonPropertyName("@removed")] GraphRemoved? Removed);

internal sealed record GraphDeltaResponse(
    [property: JsonPropertyName("@odata.nextLink")] string? NextLink,
    [property: JsonPropertyName("@odata.deltaLink")] string? DeltaLink,
    IReadOnlyList<GraphEvent>? Value);

internal sealed record GraphErrorBody(string? Code, string? Message);

internal sealed record GraphErrorResponse(GraphErrorBody? Error);

internal sealed record GraphEventBody(
    string Subject,
    GraphBody Body,
    GraphLocation Location,
    GraphDateTime Start,
    bool IsAllDay,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] GraphDateTime? End,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? TransactionId,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<GraphProperty>? SingleValueExtendedProperties);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(GoogleEventsResponse))]
[JsonSerializable(typeof(GoogleEvent))]
[JsonSerializable(typeof(GoogleErrorResponse))]
[JsonSerializable(typeof(GoogleEventBody))]
[JsonSerializable(typeof(GraphDeltaResponse))]
[JsonSerializable(typeof(GraphEvent))]
[JsonSerializable(typeof(GraphErrorResponse))]
[JsonSerializable(typeof(GraphEventBody))]
internal sealed partial class CalendarProviderJsonContext : JsonSerializerContext;
