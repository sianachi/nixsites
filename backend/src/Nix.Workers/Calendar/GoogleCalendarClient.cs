using System.Globalization;
using System.Text.Json;

namespace Nix.Workers.Calendar;

/// <summary>
/// Google Calendar (events.list/insert/patch/delete) behind the configured origin. Facts this
/// client relies on: events.list with singleEvents, showDeleted and a syncToken returns every
/// change since the previous round; syncToken cannot be combined with timeMin/timeMax; a 410
/// means the token is gone and the round restarts as a full resync; paging uses
/// pageToken/nextPageToken and the final page carries nextSyncToken. All-day events use
/// start.date/end.date (end exclusive); timed events use start.dateTime plus start.timeZone.
/// </summary>
public sealed class GoogleCalendarClient(CalendarTransport transport) : ICalendarProvider
{
    public string Name => "google";

    public async Task<ProviderPage> PullAsync(string accessToken, string calendarId, string cursor, DateTimeOffset windowStart, DateTimeOffset windowEnd, string pageToken, CancellationToken cancellationToken)
    {
        var query = new List<KeyValuePair<string, string>>
        {
            new("singleEvents", "true"),
            new("showDeleted", "true"),
            new("maxResults", "100"),
        };
        if (!string.IsNullOrEmpty(cursor))
        {
            query.Add(new("syncToken", cursor));
        }
        else
        {
            query.Add(new("timeMin", Rfc3339Utc(windowStart)));
            query.Add(new("timeMax", Rfc3339Utc(windowEnd)));
        }
        if (!string.IsNullOrEmpty(pageToken))
        {
            query.Add(new("pageToken", pageToken));
        }
        var path = "/calendar/v3/calendars/" + CalendarWire.PathEscape(calendarId) + "/events?" + CalendarWire.QueryEncode(query);
        var (status, body) = await transport.SendAsync(HttpMethod.Get, path, CalendarTransport.BearerHeaders(accessToken), null, cancellationToken).ConfigureAwait(false);
        if (status == 410)
        {
            return ProviderPage.FullResync;
        }
        if (status != 200)
        {
            throw ApiError(status, body);
        }
        var decoded = Decode(body, CalendarProviderJsonContext.Default.GoogleEventsResponse, "events page");
        var events = new List<ProviderEvent>(decoded.Items?.Count ?? 0);
        foreach (var item in decoded.Items ?? [])
        {
            events.Add(Convert(item));
        }
        return new ProviderPage(events, !string.IsNullOrEmpty(decoded.NextPageToken), decoded.NextPageToken ?? string.Empty, decoded.NextSyncToken ?? string.Empty, false);
    }

    private static ProviderEvent Convert(GoogleEvent item)
    {
        if (item.Status == "cancelled")
        {
            // An incremental round reports a deleted event with only its id and status.
            return new ProviderEvent(item.Id ?? string.Empty, item.ETag ?? string.Empty, "cancelled", string.Empty, string.Empty, string.Empty, default, null, false, item.Updated ?? DateTimeOffset.UtcNow, null);
        }
        var start = Bound(item.Start ?? new GoogleDateTime(null, null, null), isEnd: false);
        CalendarBound? end = item.End is { } e && (!string.IsNullOrEmpty(e.Date) || !string.IsNullOrEmpty(e.DateTime)) ? Bound(e, isEnd: true) : null;
        var readOnly = item.Organizer is { Self: false } && !item.GuestsCanModify;
        return new ProviderEvent(
            item.Id ?? string.Empty,
            item.ETag ?? string.Empty,
            "confirmed",
            item.Summary ?? string.Empty,
            item.Location ?? string.Empty,
            item.Description ?? string.Empty,
            start,
            end,
            readOnly,
            item.Updated ?? default,
            ItemStamp(item.Id));
    }

    private static CalendarBound Bound(GoogleDateTime value, bool isEnd)
    {
        if (!string.IsNullOrEmpty(value.Date))
        {
            return CalendarBound.OnDate(isEnd ? CalendarBound.InclusiveEndDate(value.Date) : value.Date);
        }
        if (!DateTimeOffset.TryParseExact(value.DateTime, ["yyyy-MM-dd'T'HH:mm:ssK", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFFK"], CultureInfo.InvariantCulture, DateTimeStyles.None, out var instant))
        {
            throw new CalendarProviderException($"google event dateTime \"{value.DateTime}\" is invalid");
        }
        var zone = string.IsNullOrEmpty(value.TimeZone) ? "UTC" : value.TimeZone;
        if (!CalendarBound.TryZone(zone, out _))
        {
            zone = "UTC";
        }
        return CalendarBound.At(instant, zone);
    }

    /// <summary>
    /// Inserts under a client-supplied id derived from the item id (a UUID's 32 hex digits are a
    /// valid base32hex id). A 409 means that id exists already: this item's earlier create whose
    /// report was lost, or an upstream deletion Google keeps the id for; the event is patched back
    /// to the pushed fields, confirmed, and returned as the created one.
    /// </summary>
    public async Task<(string ExternalId, string Version)> CreateEventAsync(string accessToken, string calendarId, PushEvent push, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(push);
        var id = EventId(push.NixItemId);
        var body = JsonSerializer.Serialize(Body(push, id, status: null), CalendarProviderJsonContext.Default.GoogleEventBody);
        var path = "/calendar/v3/calendars/" + CalendarWire.PathEscape(calendarId) + "/events";
        var (status, response) = await transport.SendAsync(HttpMethod.Post, path, CalendarTransport.BearerHeaders(accessToken, json: true), body, cancellationToken).ConfigureAwait(false);
        if (status == 409 && id is not null)
        {
            return await ReviveAsync(accessToken, calendarId, id, push, cancellationToken).ConfigureAwait(false);
        }
        if (status is not (200 or 201))
        {
            throw ApiError(status, response);
        }
        var created = Decode(response, CalendarProviderJsonContext.Default.GoogleEvent, "create response");
        return (created.Id ?? string.Empty, created.ETag ?? string.Empty);
    }

    private async Task<(string ExternalId, string Version)> ReviveAsync(string accessToken, string calendarId, string id, PushEvent push, CancellationToken cancellationToken)
    {
        var body = JsonSerializer.Serialize(Body(push, id: null, status: "confirmed"), CalendarProviderJsonContext.Default.GoogleEventBody);
        var path = "/calendar/v3/calendars/" + CalendarWire.PathEscape(calendarId) + "/events/" + CalendarWire.PathEscape(id);
        var (status, response) = await transport.SendAsync(HttpMethod.Patch, path, CalendarTransport.BearerHeaders(accessToken, json: true), body, cancellationToken).ConfigureAwait(false);
        if (status != 200)
        {
            throw ApiError(status, response);
        }
        var revived = Decode(response, CalendarProviderJsonContext.Default.GoogleEvent, "revive response");
        return (id, revived.ETag ?? string.Empty);
    }

    public async Task<string> UpdateEventAsync(string accessToken, string calendarId, string externalId, string version, PushEvent push, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(push);
        var body = JsonSerializer.Serialize(Body(push, id: null, status: null), CalendarProviderJsonContext.Default.GoogleEventBody);
        var headers = CalendarTransport.BearerHeaders(accessToken, json: true);
        if (!string.IsNullOrEmpty(version))
        {
            headers["If-Match"] = version;
        }
        var path = "/calendar/v3/calendars/" + CalendarWire.PathEscape(calendarId) + "/events/" + CalendarWire.PathEscape(externalId);
        var (status, response) = await transport.SendAsync(HttpMethod.Patch, path, headers, body, cancellationToken).ConfigureAwait(false);
        return status switch
        {
            200 => Decode(response, CalendarProviderJsonContext.Default.GoogleEvent, "update response").ETag ?? string.Empty,
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
        var path = "/calendar/v3/calendars/" + CalendarWire.PathEscape(calendarId) + "/events/" + CalendarWire.PathEscape(externalId);
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

    /// <summary>The client-supplied event id for an item: its UUID without dashes, or null when there is nothing to stamp.</summary>
    public static string? EventId(string? itemId) => itemId is not null && CalendarWire.IsCanonicalUuid(itemId) ? itemId.Replace("-", "", StringComparison.Ordinal) : null;

    /// <summary>Reads the item id back out of an event id <see cref="EventId"/> made; any other id yields null.</summary>
    public static string? ItemStamp(string? eventId)
    {
        if (eventId is not { Length: 32 })
        {
            return null;
        }
        var itemId = $"{eventId[..8]}-{eventId[8..12]}-{eventId[12..16]}-{eventId[16..20]}-{eventId[20..32]}";
        return CalendarWire.IsCanonicalUuid(itemId) ? itemId : null;
    }

    private static GoogleEventBody Body(PushEvent push, string? id, string? status) => new(
        id,
        push.Title,
        push.Location,
        push.Details,
        DateTimeBody(push.Start, isEnd: false),
        push.End is { } end ? DateTimeBody(end, isEnd: true) : null,
        status);

    // The unused fields are named as null: PATCH merges nested objects, so an event moving between
    // all-day and timed would otherwise keep the old field and Google refuses both at once.
    private static GoogleDateTime DateTimeBody(CalendarBound bound, bool isEnd)
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
                    // Go kept the date as given when it could not be shifted.
                }
            }
            return new GoogleDateTime(date, null, null);
        }
        return new GoogleDateTime(null, CalendarBound.Rfc3339In(bound.Instant, bound.Zone), bound.Zone);
    }

    private static string Rfc3339Utc(DateTimeOffset value) => value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);

    private static T Decode<T>(byte[] body, System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> info, string what)
    {
        try
        {
            return JsonSerializer.Deserialize(body, info) ?? throw new CalendarProviderException($"decode google calendar {what}: empty");
        }
        catch (JsonException exception)
        {
            throw new CalendarProviderException($"decode google calendar {what}: {exception.Message}", exception);
        }
    }

    private static CalendarProviderException ApiError(int status, byte[] body)
    {
        try
        {
            var decoded = JsonSerializer.Deserialize(body, CalendarProviderJsonContext.Default.GoogleErrorResponse);
            if (decoded?.Error?.Message is { Length: > 0 } message)
            {
                return new CalendarProviderException($"google calendar API returned {status}: {message}");
            }
        }
        catch (JsonException)
        {
            // Fall through to the bare status.
        }
        return new CalendarProviderException($"google calendar API returned {status}");
    }
}
