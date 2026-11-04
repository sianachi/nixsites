using System.Globalization;
using System.Text.Json;

namespace Nix.Workers.Calendar;

/// <summary>
/// Microsoft Graph calendars (calendarView/delta and events create/patch/delete) behind the
/// configured origin. The first round queries calendarView/delta with the window, then follows
/// @odata.nextLink pages and stores @odata.deltaLink; deletions and events leaving the window
/// arrive with an "@removed" annotation; Prefer asks for 50-event pages, UTC and plain-text
/// bodies. All-day events have midnight start/end and an exclusive end, like Google's.
/// </summary>
public sealed class GraphCalendarClient(CalendarTransport transport, Action<string>? unknownZone = null) : ICalendarProvider
{
    /// <summary>The single-value extended property a created event carries the item id in, beside transactionId.</summary>
    public const string ItemPropertyId = "String {6f1c2d8e-4b7a-4e39-9c55-2a7d3e1b9f40} Name NixItemId";

    private const string Prefer = "odata.maxpagesize=50, outlook.timezone=\"UTC\", outlook.body-content-type=\"text\"";

    public string Name => "microsoft";

    public async Task<ProviderPage> PullAsync(string accessToken, string calendarId, string cursor, DateTimeOffset windowStart, DateTimeOffset windowEnd, string pageToken, CancellationToken cancellationToken)
    {
        var target = pageToken;
        if (string.IsNullOrEmpty(target))
        {
            target = !string.IsNullOrEmpty(cursor)
                ? cursor
                : "/v1.0/me/calendars/" + CalendarWire.PathEscape(calendarId) + "/calendarView/delta?" + CalendarWire.QueryEncode(
                [
                    new("startDateTime", windowStart.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture)),
                    new("endDateTime", windowEnd.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture)),
                ]);
        }
        var headers = CalendarTransport.BearerHeaders(accessToken);
        headers["Prefer"] = Prefer;
        var (status, body) = await transport.SendAsync(HttpMethod.Get, target, headers, null, cancellationToken).ConfigureAwait(false);
        if (status == 410 || (status == 400 && !string.IsNullOrEmpty(cursor) && string.IsNullOrEmpty(pageToken)))
        {
            return ProviderPage.FullResync;
        }
        if (status != 200)
        {
            throw ApiError(status, body);
        }
        var decoded = Decode(body, CalendarProviderJsonContext.Default.GraphDeltaResponse, "delta page");
        var events = new List<ProviderEvent>(decoded.Value?.Count ?? 0);
        foreach (var item in decoded.Value ?? [])
        {
            // "changed" means the event only left the delta window; it still exists upstream.
            if (item.Removed is { Reason: "changed" })
            {
                continue;
            }
            events.Add(Convert(item));
        }
        return new ProviderPage(events, !string.IsNullOrEmpty(decoded.NextLink), decoded.NextLink ?? string.Empty, decoded.DeltaLink ?? string.Empty, false);
    }

    private ProviderEvent Convert(GraphEvent item)
    {
        if (item.Removed is not null)
        {
            return new ProviderEvent(item.Id ?? string.Empty, string.Empty, "cancelled", string.Empty, string.Empty, string.Empty, default, null, false, item.LastModifiedDateTime ?? DateTimeOffset.UtcNow, null);
        }
        var startZone = Zone(item.OriginalStartTimeZone);
        var endZone = Zone(item.OriginalEndTimeZone);
        if (endZone == "UTC" && string.IsNullOrEmpty(item.OriginalEndTimeZone))
        {
            endZone = startZone;
        }
        var start = Bound(item.Start, startZone, item.IsAllDay, isEnd: false);
        var end = Bound(item.End, endZone, item.IsAllDay, isEnd: true);
        return new ProviderEvent(
            item.Id ?? string.Empty,
            item.ChangeKey ?? string.Empty,
            "confirmed",
            item.Subject ?? string.Empty,
            item.Location?.DisplayName ?? string.Empty,
            item.Body?.Content ?? string.Empty,
            start,
            end,
            item.IsOrganizer is false,
            item.LastModifiedDateTime ?? default,
            ItemStamp(item));
    }

    private string Zone(string? windowsName)
    {
        var iana = WindowsZones.ToIana(windowsName, out var known);
        if (!known)
        {
            unknownZone?.Invoke(windowsName!.Trim());
        }
        return iana;
    }

    /// <summary>The item id a created event was stamped with: its transactionId, or the extended property when present.</summary>
    internal static string? ItemStamp(GraphEvent item)
    {
        ArgumentNullException.ThrowIfNull(item);
        if (CalendarWire.IsCanonicalUuid(item.TransactionId))
        {
            return item.TransactionId;
        }
        return item.SingleValueExtendedProperties?.FirstOrDefault(property => property.Id == ItemPropertyId && CalendarWire.IsCanonicalUuid(property.Value))?.Value;
    }

    // Graph's dateTime carries no offset; Prefer asked for UTC, so it is a naive UTC instant re-expressed
    // in the event's authored zone. All-day events carry midnight instants and an exclusive end.
    private static CalendarBound Bound(GraphDateTime? value, string zone, bool allDay, bool isEnd)
    {
        if (!DateTime.TryParseExact(value?.DateTime, ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFF"], CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var parsed))
        {
            parsed = DateTime.MinValue;
        }
        var instant = new DateTimeOffset(DateTime.SpecifyKind(parsed, DateTimeKind.Utc));
        if (allDay)
        {
            var date = instant.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            if (isEnd)
            {
                try
                {
                    date = CalendarBound.InclusiveEndDate(date);
                }
                catch (FormatException)
                {
                    // Keep the date as given.
                }
            }
            return CalendarBound.OnDate(date);
        }
        return CalendarBound.At(instant, CalendarBound.TryZone(zone, out _) ? zone : "UTC");
    }

    /// <summary>Posts the event stamped with the item id twice over: transactionId and a single-value extended property.</summary>
    public async Task<(string ExternalId, string Version)> CreateEventAsync(string accessToken, string calendarId, PushEvent push, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(push);
        var stamp = CalendarWire.IsCanonicalUuid(push.NixItemId) ? push.NixItemId : null;
        var body = JsonSerializer.Serialize(
            Body(push) with { TransactionId = stamp, SingleValueExtendedProperties = stamp is null ? null : [new GraphProperty(ItemPropertyId, stamp)] },
            CalendarProviderJsonContext.Default.GraphEventBody);
        var path = "/v1.0/me/calendars/" + CalendarWire.PathEscape(calendarId) + "/events";
        var (status, response) = await transport.SendAsync(HttpMethod.Post, path, CalendarTransport.BearerHeaders(accessToken, json: true), body, cancellationToken).ConfigureAwait(false);
        if (status is not (200 or 201))
        {
            throw ApiError(status, response);
        }
        var created = Decode(response, CalendarProviderJsonContext.Default.GraphEvent, "create response");
        return (created.Id ?? string.Empty, created.ChangeKey ?? string.Empty);
    }

    public async Task<string> UpdateEventAsync(string accessToken, string calendarId, string externalId, string version, PushEvent push, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(push);
        var body = JsonSerializer.Serialize(Body(push), CalendarProviderJsonContext.Default.GraphEventBody);
        var headers = CalendarTransport.BearerHeaders(accessToken, json: true);
        if (!string.IsNullOrEmpty(version))
        {
            headers["If-Match"] = version;
        }
        var path = "/v1.0/me/calendars/" + CalendarWire.PathEscape(calendarId) + "/events/" + CalendarWire.PathEscape(externalId);
        var (status, response) = await transport.SendAsync(HttpMethod.Patch, path, headers, body, cancellationToken).ConfigureAwait(false);
        return status switch
        {
            200 => Decode(response, CalendarProviderJsonContext.Default.GraphEvent, "update response").ChangeKey ?? string.Empty,
            412 => throw new ProviderWriteException(ProviderWriteFailure.Conflict),
            404 or 410 => throw new ProviderWriteException(ProviderWriteFailure.Gone),
            _ => throw ApiError(status, response),
        };
    }

    public async Task DeleteEventAsync(string accessToken, string calendarId, string externalId, string version, CancellationToken cancellationToken)
    {
        var headers = CalendarTransport.BearerHeaders(accessToken);
        if (!string.IsNullOrEmpty(version))
        {
            headers["If-Match"] = version;
        }
        var path = "/v1.0/me/calendars/" + CalendarWire.PathEscape(calendarId) + "/events/" + CalendarWire.PathEscape(externalId);
        var (status, response) = await transport.SendAsync(HttpMethod.Delete, path, headers, null, cancellationToken).ConfigureAwait(false);
        switch (status)
        {
            case 200 or 204 or 404 or 410:
                return;
            case 412:
                throw new ProviderWriteException(ProviderWriteFailure.Conflict);
            default:
                throw ApiError(status, response);
        }
    }

    private static GraphEventBody Body(PushEvent push) => new(
        push.Title,
        new GraphBody("text", push.Details),
        new GraphLocation(push.Location),
        DateTimeBody(push.Start, isEnd: false),
        push.Start.AllDay,
        push.End is { } end ? DateTimeBody(end, isEnd: true) : null,
        null,
        null);

    private static GraphDateTime DateTimeBody(CalendarBound bound, bool isEnd)
    {
        if (bound.AllDay)
        {
            var date = bound.Date;
            if (isEnd)
            {
                try
                {
                    date = CalendarBound.ExclusiveEndDate(date);
                }
                catch (FormatException)
                {
                    // Keep the date as given.
                }
            }
            return new GraphDateTime(date + "T00:00:00.0000000", "UTC");
        }
        var local = CalendarBound.TryZone(bound.Zone, out var info) ? TimeZoneInfo.ConvertTime(bound.Instant, info) : bound.Instant.ToUniversalTime();
        return new GraphDateTime(local.ToString("yyyy-MM-dd'T'HH:mm:ss.0000000", CultureInfo.InvariantCulture), bound.Zone);
    }

    private static T Decode<T>(byte[] body, System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> info, string what)
    {
        try
        {
            return JsonSerializer.Deserialize(body, info) ?? throw new CalendarProviderException($"decode graph calendar {what}: empty");
        }
        catch (JsonException exception)
        {
            throw new CalendarProviderException($"decode graph calendar {what}: {exception.Message}", exception);
        }
    }

    private static CalendarProviderException ApiError(int status, byte[] body)
    {
        try
        {
            var decoded = JsonSerializer.Deserialize(body, CalendarProviderJsonContext.Default.GraphErrorResponse);
            if (decoded?.Error?.Message is { Length: > 0 } message)
            {
                return new CalendarProviderException($"microsoft graph calendar API returned {status}: {message}");
            }
        }
        catch (JsonException)
        {
            // Fall through to the bare status.
        }
        return new CalendarProviderException($"microsoft graph calendar API returned {status}");
    }
}
