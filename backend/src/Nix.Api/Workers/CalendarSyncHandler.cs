using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Nix.Features.CalendarSync;
using Nix.Workers.Calendar;

namespace Nix.Workers;

/// <summary>
/// The <c>calendar.sync</c> job (ADR-0052 steps 1-5, contracts C1-C6): session, pull pages and
/// apply them in batches, push outstanding item changes when the link is two-way, then store the
/// cursor only after every page has been applied. A port of the Go <c>calendarsync</c> handler.
/// </summary>
public sealed class CalendarSyncHandler(
    WorkerLoopbackClient core,
    IReadOnlyDictionary<string, ICalendarProvider> providers,
    ILogger<CalendarSyncHandler>? logger = null) : IWorkerJobHandler
{
    private const int ChangesPageLimit = 100;
    private const int MaxTitleBytes = 500;
    private const int MaxDetailsBytes = 8000;
    private const int MaxCursorLength = 4096;
    private const int MaxEventsPerBatch = 100;
    private const int MaxPullBodyBytes = 2 << 20;
    private const int SessionResponseLimit = 16 << 10;
    private const int ChangesResponseLimit = 8 << 20;
    private readonly ILogger<CalendarSyncHandler> _logger = logger ?? NullLogger<CalendarSyncHandler>.Instance;

    public IReadOnlyList<string> Kinds { get; } = ["calendar.sync"];

    public async Task<string?> HandleAsync(WorkerExecution job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        CalendarSyncJobPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize(job.Job.Payload, CalendarWorkerJsonContext.Default.CalendarSyncJobPayload);
        }
        catch (JsonException)
        {
            payload = null;
        }
        if (payload is null || payload.LinkId == Guid.Empty)
        {
            throw WorkerJobException.Fail("calendar_payload_invalid", "the durable calendar sync request is invalid");
        }
        var linkId = payload.LinkId.ToString("D");
        var basePath = $"/internal/worker-executions/calendar/links/{linkId}";

        CalendarSessionResponse session;
        try
        {
            session = await core.PostJsonAsync(job, $"{basePath}/session", null, CalendarWorkerJsonContext.Default.CalendarSessionResponse, SessionResponseLimit, cancellationToken).ConfigureAwait(false)
                ?? throw new WorkerLoopbackException(200, basePath, "the session is empty");
        }
        catch (Exception exception) when (IsCoreFailure(exception, cancellationToken))
        {
            throw ApiFailure("calendar_session_unavailable", exception);
        }
        if (session.Provider is not ("google" or "microsoft")
            || string.IsNullOrEmpty(session.ExternalCalendarId)
            || session.Direction is not ("two_way" or "import_only")
            || session.WindowStart == default || session.WindowEnd == default || session.WindowEnd <= session.WindowStart
            || string.IsNullOrEmpty(session.AccessToken) || session.AccessTokenExpiresAt <= DateTimeOffset.UtcNow)
        {
            throw WorkerJobException.Retry("calendar_session_unavailable", "worker API calendar session is invalid");
        }
        if (!providers.TryGetValue(session.Provider, out var provider))
        {
            throw WorkerJobException.Fail("calendar_provider_unsupported", $"no calendar provider client is configured for \"{session.Provider}\"");
        }

        var (applied, conflicts, full) = await PullAsync(job, provider, basePath, session, cancellationToken).ConfigureAwait(false);
        var pushed = session.Direction == "two_way"
            ? await PushAsync(job, provider, basePath, session, cancellationToken).ConfigureAwait(false)
            : 0;
        return JsonSerializer.Serialize(
            new CalendarSyncResult(session.Provider, applied, conflicts, pushed, full),
            CalendarWorkerRequestJsonContext.Default.CalendarSyncResult);
    }

    // Step 2: fetch pages and apply them in batches, restarting as a full resync when the provider
    // rejects the stored cursor, then store the new cursor only after every page has been applied.
    private async Task<(int Applied, int Conflicts, bool Full)> PullAsync(WorkerExecution job, ICalendarProvider provider, string basePath, CalendarSessionResponse session, CancellationToken cancellationToken)
    {
        var cursor = session.Cursor ?? string.Empty;
        var full = cursor.Length == 0;
        var pageToken = string.Empty;
        var restarted = false;
        var applied = 0;
        var conflicts = 0;
        while (true)
        {
            ProviderPage page;
            try
            {
                page = await provider.PullAsync(session.AccessToken, session.ExternalCalendarId, cursor, session.WindowStart, session.WindowEnd, pageToken, cancellationToken).ConfigureAwait(false);
            }
            catch (CalendarProviderException exception)
            {
                await LogProviderErrorAsync(job, basePath, "pull", exception.Message, cancellationToken).ConfigureAwait(false);
                throw WorkerJobException.Retry("calendar_pull_failed", exception.Message);
            }
            if (page.FullResyncRequired)
            {
                if (restarted)
                {
                    throw WorkerJobException.Fail("calendar_pull_failed", "the calendar provider repeatedly rejected a full resync");
                }
                restarted = true;
                cursor = string.Empty;
                pageToken = string.Empty;
                full = true;
                applied = 0;
                conflicts = 0;
                continue;
            }
            var wire = page.Events.Select(ToWire).ToArray();
            if (wire.Length > 0 || full)
            {
                var result = await ApplyAsync(job, basePath, new CalendarPullRequest(full, wire), cancellationToken).ConfigureAwait(false);
                applied += result.Applied;
                conflicts += result.Conflicts;
            }
            if (!page.Next)
            {
                if (page.Cursor.Length > MaxCursorLength)
                {
                    throw WorkerJobException.Retry("calendar_cursor_failed", "calendar cursor request is invalid");
                }
                try
                {
                    await core.PostJsonAsync<object>(job, $"{basePath}/cursor",
                        WorkerLoopbackClient.Json(new CalendarCursorRequest(page.Cursor, full, session.WindowStart, session.WindowEnd), CalendarWorkerRequestJsonContext.Default.CalendarCursorRequest),
                        null, 0, cancellationToken).ConfigureAwait(false);
                }
                catch (Exception exception) when (IsCoreFailure(exception, cancellationToken))
                {
                    throw ApiFailure("calendar_cursor_failed", exception);
                }
                return (applied, conflicts, full);
            }
            pageToken = page.PageToken;
        }
    }

    // C2, split in halves when the encoded batch exceeds Core's body limit; every request carries the same Full flag.
    private async Task<CalendarPullResponse> ApplyAsync(WorkerExecution job, string basePath, CalendarPullRequest request, CancellationToken cancellationToken)
    {
        if (request.Events.Count > MaxEventsPerBatch)
        {
            throw WorkerJobException.Retry("calendar_pull_apply_failed", "calendar pull request is invalid");
        }
        foreach (var e in request.Events)
        {
            if (Validate(e) is { } problem)
            {
                throw WorkerJobException.Retry("calendar_pull_apply_failed", problem);
            }
        }
        return await ApplyBatchAsync(job, basePath, request, cancellationToken).ConfigureAwait(false);
    }

    private async Task<CalendarPullResponse> ApplyBatchAsync(WorkerExecution job, string basePath, CalendarPullRequest request, CancellationToken cancellationToken)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(request, CalendarWorkerRequestJsonContext.Default.CalendarPullRequest);
        if (body.Length > MaxPullBodyBytes)
        {
            if (request.Events.Count < 2)
            {
                throw WorkerJobException.Retry("calendar_pull_apply_failed", "calendar pull event exceeds the request body limit");
            }
            var middle = request.Events.Count / 2;
            var first = await ApplyBatchAsync(job, basePath, new CalendarPullRequest(request.Full, [.. request.Events.Take(middle)]), cancellationToken).ConfigureAwait(false);
            var second = await ApplyBatchAsync(job, basePath, new CalendarPullRequest(request.Full, [.. request.Events.Skip(middle)]), cancellationToken).ConfigureAwait(false);
            return new CalendarPullResponse(first.Applied + second.Applied, first.Conflicts + second.Conflicts);
        }
        try
        {
            var result = await core.PostJsonAsync(job, $"{basePath}/pull", new ByteArrayContent(body) { Headers = { ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/json") } },
                CalendarWorkerJsonContext.Default.CalendarPullResponse, SessionResponseLimit, cancellationToken).ConfigureAwait(false);
            if (result is null || result.Applied < 0 || result.Conflicts < 0)
            {
                throw WorkerJobException.Retry("calendar_pull_apply_failed", "worker API calendar pull response is invalid");
            }
            return result;
        }
        catch (Exception exception) when (IsCoreFailure(exception, cancellationToken))
        {
            throw ApiFailure("calendar_pull_apply_failed", exception);
        }
    }

    // Step 3: push Core's outstanding item changes and report each outcome (C3, C4).
    private async Task<int> PushAsync(WorkerExecution job, ICalendarProvider provider, string basePath, CalendarSessionResponse session, CancellationToken cancellationToken)
    {
        CalendarChangesResponse? changes;
        try
        {
            changes = await core.GetJsonAsync(job, $"{basePath}/changes?limit={ChangesPageLimit}", CalendarWorkerJsonContext.Default.CalendarChangesResponse, ChangesResponseLimit, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (IsCoreFailure(exception, cancellationToken))
        {
            throw ApiFailure("calendar_changes_unavailable", exception);
        }
        if (changes is null || changes.Changes.Count > ChangesPageLimit || changes.Changes.Any(change => change.Op is not ("create" or "update" or "delete") || change.ItemId == Guid.Empty))
        {
            throw WorkerJobException.Retry("calendar_changes_unavailable", "worker API calendar changes response is invalid");
        }
        if (changes.Changes.Count == 0)
        {
            return 0;
        }
        var results = new List<CalendarPushResult>(changes.Changes.Count);
        foreach (var change in changes.Changes)
        {
            results.Add(await PushOneAsync(provider, session, change, cancellationToken).ConfigureAwait(false));
        }
        try
        {
            await core.PostJsonAsync<object>(job, $"{basePath}/pushed",
                WorkerLoopbackClient.Json(new CalendarPushedRequest(results), CalendarWorkerRequestJsonContext.Default.CalendarPushedRequest),
                null, 0, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (IsCoreFailure(exception, cancellationToken))
        {
            throw ApiFailure("calendar_pushed_report_failed", exception);
        }
        return results.Count;
    }

    private static async Task<CalendarPushResult> PushOneAsync(ICalendarProvider provider, CalendarSessionResponse session, CalendarChangeResponse change, CancellationToken cancellationToken)
    {
        var externalId = change.ExternalId ?? string.Empty;
        var version = change.Version ?? string.Empty;
        if (change.Op == "delete")
        {
            if (externalId.Length == 0)
            {
                return new CalendarPushResult(change.ItemId, string.Empty, string.Empty, "ok");
            }
            try
            {
                await provider.DeleteEventAsync(session.AccessToken, session.ExternalCalendarId, externalId, version, cancellationToken).ConfigureAwait(false);
                return new CalendarPushResult(change.ItemId, externalId, version, "ok");
            }
            catch (Exception exception) when (exception is ProviderWriteException or CalendarProviderException)
            {
                return Failed(change.ItemId, externalId, version, exception);
            }
        }
        PushEvent push;
        try
        {
            push = new PushEvent(change.Title, change.Location, change.Details, CalendarBound.Parse(change.Start), change.End is null ? null : CalendarBound.Parse(change.End), change.ItemId.ToString("D"));
        }
        catch (FormatException exception)
        {
            return new CalendarPushResult(change.ItemId, externalId, version, "failed", CalendarWire.TruncateUtf8(exception.Message, MaxTitleBytes));
        }
        try
        {
            if (externalId.Length == 0)
            {
                var (newId, newVersion) = await provider.CreateEventAsync(session.AccessToken, session.ExternalCalendarId, push, cancellationToken).ConfigureAwait(false);
                return new CalendarPushResult(change.ItemId, newId, newVersion, "ok");
            }
            var updated = await provider.UpdateEventAsync(session.AccessToken, session.ExternalCalendarId, externalId, version, push, cancellationToken).ConfigureAwait(false);
            return new CalendarPushResult(change.ItemId, externalId, updated, "ok");
        }
        catch (Exception exception) when (exception is ProviderWriteException or CalendarProviderException)
        {
            return Failed(change.ItemId, externalId, version, exception);
        }
    }

    private static CalendarPushResult Failed(Guid itemId, string externalId, string version, Exception exception)
    {
        var status = exception is ProviderWriteException write
            ? write.Failure == ProviderWriteFailure.Conflict ? "conflict" : "gone"
            : "failed";
        return new CalendarPushResult(itemId, externalId, version, status, CalendarWire.TruncateUtf8(exception.Message, MaxTitleBytes));
    }

    private async Task LogProviderErrorAsync(WorkerExecution job, string basePath, string direction, string detail, CancellationToken cancellationToken)
    {
        try
        {
            await core.PostJsonAsync<object>(job, $"{basePath}/log",
                WorkerLoopbackClient.Json(new CalendarLogRequest([new CalendarWorkerLogEntry(direction, "error", CalendarWire.TruncateUtf8(detail, MaxTitleBytes))]), CalendarWorkerRequestJsonContext.Default.CalendarLogRequest),
                null, 0, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (IsCoreFailure(exception, cancellationToken))
        {
            CalendarSyncHandlerLog.LogEntryFailed(_logger, exception.GetType().Name);
        }
    }

    // A cancelled event carries no bounds; provider text is cut to the contract bounds on a UTF-8 boundary.
    private static CalendarPullEvent ToWire(ProviderEvent e) => new(
        e.ExternalId,
        e.Version,
        e.Status,
        CalendarWire.TruncateUtf8(e.Title, MaxTitleBytes),
        e.Status == "cancelled" ? string.Empty : e.Start.Wire(),
        CalendarWire.TruncateUtf8(e.Location, MaxTitleBytes),
        CalendarWire.TruncateUtf8(e.Details, MaxDetailsBytes),
        e.ReadOnly,
        e.UpdatedAt,
        e.Status == "cancelled" ? null : e.End?.Wire(),
        CalendarWire.IsCanonicalUuid(e.NixItemId) ? Guid.Parse(e.NixItemId!) : null);

    private static string? Validate(CalendarPullEvent e)
    {
        if (string.IsNullOrWhiteSpace(e.ExternalId) || e.ExternalId.Length > MaxTitleBytes)
        {
            return "calendar event external id is invalid";
        }
        if (e.Version.Length > MaxCursorLength)
        {
            return "calendar event version is invalid";
        }
        if (e.Status is not ("confirmed" or "cancelled"))
        {
            return "calendar event status is invalid";
        }
        if (e.Status == "confirmed" && string.IsNullOrWhiteSpace(e.Start))
        {
            return "calendar event start is required";
        }
        return e.UpdatedAt == default ? "calendar event updatedAt is required" : null;
    }

    private static bool IsCoreFailure(Exception exception, CancellationToken cancellationToken) =>
        exception is HttpRequestException or WorkerLoopbackException or TaskCanceledException && !cancellationToken.IsCancellationRequested;

    // A refused execution is retried from the top by the host (lease moved on); Core's own calendar
    // refusals and other 4xx rejections are terminal; 5xx, 408, 429 and transport errors retry.
    private static WorkerJobException ApiFailure(string code, Exception exception)
    {
        if (exception is not WorkerLoopbackException { FromProblem: true } answered)
        {
            return WorkerJobException.Retry(code, exception.Message);
        }
        return answered switch
        {
            { Status: 409, Code: "worker.execution_refused" } => WorkerJobException.Retry("worker_execution_refused", exception.Message),
            { Status: 409, Code: "calendar.link_unavailable" } => WorkerJobException.Fail("calendar_link_unavailable", exception.Message),
            { Status: 409, Code: "calendar.needs_reauth" } => WorkerJobException.Fail("calendar_needs_reauth", exception.Message),
            { Status: 408 or 429 or >= 500 } => WorkerJobException.Retry(code, exception.Message),
            { Status: >= 400 } => WorkerJobException.Fail(code, exception.Message),
            _ => WorkerJobException.Retry(code, exception.Message),
        };
    }
}

/// <summary>The durable result of a <c>calendar.sync</c> execution.</summary>
public sealed record CalendarSyncResult(string Provider, int Applied, int Conflicts, int Pushed, bool FullSync);

/// <summary>Writes instants the way Go's <c>time.Time</c> does: RFC 3339, <c>Z</c> for UTC, fractional seconds only when present.</summary>
internal sealed class GoTimeConverter : JsonConverter<DateTimeOffset>
{
    public override DateTimeOffset Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) => reader.GetDateTimeOffset();

    public override void Write(Utf8JsonWriter writer, DateTimeOffset value, JsonSerializerOptions options) =>
        writer.WriteStringValue(value.Offset == TimeSpan.Zero
            ? value.ToString("yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'", System.Globalization.CultureInfo.InvariantCulture)
            : value.ToString("yyyy-MM-dd'T'HH:mm:ss.FFFFFFFK", System.Globalization.CultureInfo.InvariantCulture));
}

/// <summary>The C2/C4/C5/C6 request bodies as the Go worker wrote them: absent, not null, for optional members.</summary>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull, Converters = [typeof(GoTimeConverter)])]
[JsonSerializable(typeof(CalendarPullRequest))]
[JsonSerializable(typeof(CalendarPushedRequest))]
[JsonSerializable(typeof(CalendarCursorRequest))]
[JsonSerializable(typeof(CalendarLogRequest))]
[JsonSerializable(typeof(CalendarSyncResult))]
internal sealed partial class CalendarWorkerRequestJsonContext : JsonSerializerContext;

internal static partial class CalendarSyncHandlerLog
{
    [LoggerMessage(5430, LogLevel.Warning, "Calendar sync log entry failed: {Error}")]
    internal static partial void LogEntryFailed(ILogger logger, string error);

    [LoggerMessage(5431, LogLevel.Warning, "Unrecognized Windows time zone {Zone}; falling back to UTC")]
    internal static partial void UnknownZone(ILogger logger, string zone);
}
