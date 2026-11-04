using System.Text.Json.Serialization;

namespace Nix.Features.CalendarSync;

// The C1-C6 wire shapes, matched field for field to the in-process calendar worker
// (Nix.Workers.CalendarSyncHandler) and the shared fixtures in fixtures/calendar-contract/.
// Requests refuse unknown members, missing members and nulls the worker never sends; responses
// carry exactly the members it decodes, strictly, as the Go worker did before it.

/// <summary>C1 response: the link's sync state and a short-lived access token.</summary>
public sealed record CalendarSessionResponse(
    string Provider,
    string ExternalCalendarId,
    string Direction,
    string? Cursor,
    DateTimeOffset WindowStart,
    DateTimeOffset WindowEnd,
    string AccessToken,
    DateTimeOffset AccessTokenExpiresAt);

/// <summary>C2 request: one batch of pulled events.</summary>
public sealed record CalendarPullRequest(bool Full, IReadOnlyList<CalendarPullEvent> Events);

/// <summary>
/// One pulled event. <see cref="End"/> is absent for an event with no end and for a cancelled one.
/// <see cref="NixItemId"/> is present only for an event Nix created: the item id the worker stamped
/// on it (Google's client-supplied event id, Graph's <c>transactionId</c>), read back on pull.
/// </summary>
public sealed record CalendarPullEvent(
    string ExternalId,
    string Version,
    string Status,
    string Title,
    string Start,
    string Location,
    string Details,
    bool ReadOnly,
    DateTimeOffset UpdatedAt,
    string? End = null,
    Guid? NixItemId = null);

/// <summary>C2 response.</summary>
public sealed record CalendarPullResponse(int Applied, int Conflicts);

/// <summary>C3 response.</summary>
public sealed record CalendarChangesResponse(IReadOnlyList<CalendarChangeResponse> Changes);

/// <summary>One change to push. <c>location</c> and <c>details</c> are always strings; <c>end</c> is always present.</summary>
public sealed record CalendarChangeResponse(
    Guid ItemId,
    string? ExternalId,
    string? Version,
    string Op,
    string Title,
    string Start,
    string? End,
    string Location,
    string Details,
    DateTimeOffset UpdatedAt);

/// <summary>C4 request.</summary>
public sealed record CalendarPushedRequest(IReadOnlyList<CalendarPushResult> Results);

/// <summary>One push outcome: <c>ok</c>, <c>conflict</c>, <c>gone</c> or <c>failed</c>.</summary>
public sealed record CalendarPushResult(Guid ItemId, string ExternalId, string Version, string Status, string? Detail = null);

/// <summary>C5 request: the round's new cursor, stored only after every page applied.</summary>
public sealed record CalendarCursorRequest(string Cursor, bool Full, DateTimeOffset WindowStart, DateTimeOffset WindowEnd);

/// <summary>C6 request.</summary>
public sealed record CalendarLogRequest(IReadOnlyList<CalendarWorkerLogEntry> Entries);

/// <summary>One worker-side log row; <c>action</c> is <c>error</c>, <c>skipped</c> or <c>conflict</c>.</summary>
public sealed record CalendarWorkerLogEntry(string Direction, string Action, string Detail, Guid? ItemId = null, string? ExternalId = null);

/// <summary>The <c>calendar.sync</c> job payload, decoded as strictly as the worker does.</summary>
public sealed record CalendarSyncJobPayload(Guid LinkId, bool Full);

/// <summary>The worker-execution JSON: camelCase, strict on the way in.</summary>
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    RespectNullableAnnotations = true,
    RespectRequiredConstructorParameters = true)]
[JsonSerializable(typeof(CalendarSessionResponse))]
[JsonSerializable(typeof(CalendarPullRequest))]
[JsonSerializable(typeof(CalendarPullResponse))]
[JsonSerializable(typeof(CalendarChangesResponse))]
[JsonSerializable(typeof(CalendarPushedRequest))]
[JsonSerializable(typeof(CalendarCursorRequest))]
[JsonSerializable(typeof(CalendarLogRequest))]
[JsonSerializable(typeof(CalendarSyncJobPayload))]
internal sealed partial class CalendarWorkerJsonContext : JsonSerializerContext;
