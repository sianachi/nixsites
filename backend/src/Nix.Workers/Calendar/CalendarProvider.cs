namespace Nix.Workers.Calendar;

/// <summary>
/// One event pulled from Google or Microsoft, normalised to the shape contract C2 needs.
/// <see cref="NixItemId"/> is the item id an event Nix created was stamped with, or null.
/// </summary>
public sealed record ProviderEvent(
    string ExternalId,
    string Version,
    string Status,
    string Title,
    string Location,
    string Details,
    CalendarBound Start,
    CalendarBound? End,
    bool ReadOnly,
    DateTimeOffset UpdatedAt,
    string? NixItemId);

/// <summary>
/// What the worker sends upstream when creating or updating a provider event from an item change.
/// <see cref="NixItemId"/> is set on a create so the provider stores it and pull reads it back.
/// </summary>
public sealed record PushEvent(string Title, string Location, string Details, CalendarBound Start, CalendarBound? End, string? NixItemId);

/// <summary>
/// One page of a provider pull. <see cref="Next"/> says <see cref="PageToken"/> continues the
/// round; otherwise <see cref="Cursor"/> is the syncToken or deltaLink to store once every page
/// has been applied. <see cref="FullResyncRequired"/> means the provider rejected the cursor.
/// </summary>
public sealed record ProviderPage(IReadOnlyList<ProviderEvent> Events, bool Next, string PageToken, string Cursor, bool FullResyncRequired)
{
    public static ProviderPage FullResync { get; } = new([], false, string.Empty, string.Empty, true);
}

/// <summary>Why a provider write was refused: the version was stale, or the event is gone upstream.</summary>
public enum ProviderWriteFailure
{
    Conflict,
    Gone,
}

/// <summary>A provider refused an update or delete for a reason the sync reports rather than retries.</summary>
public sealed class ProviderWriteException : Exception
{
    public ProviderWriteException(ProviderWriteFailure failure)
        : base(failure == ProviderWriteFailure.Conflict ? "calendar provider rejected a stale version" : "calendar event no longer exists upstream")
    {
        Failure = failure;
    }

    public ProviderWriteException()
    {
    }

    public ProviderWriteException(string message)
        : base(message)
    {
    }

    public ProviderWriteException(string message, Exception innerException)
        : base(message, innerException)
    {
    }

    public ProviderWriteFailure Failure { get; }
}

/// <summary>The two calendar back ends behind the pull/push shape the sync algorithm needs.</summary>
public interface ICalendarProvider
{
    /// <summary>"google" or "microsoft".</summary>
    public string Name { get; }

    /// <summary>One page of changes. <paramref name="cursor"/> is empty for a full round; <paramref name="pageToken"/> continues a round in progress.</summary>
    public Task<ProviderPage> PullAsync(string accessToken, string calendarId, string cursor, DateTimeOffset windowStart, DateTimeOffset windowEnd, string pageToken, CancellationToken cancellationToken);

    /// <summary>Creates an upstream event stamped with the item id; creating again for the same item returns the existing event.</summary>
    public Task<(string ExternalId, string Version)> CreateEventAsync(string accessToken, string calendarId, PushEvent push, CancellationToken cancellationToken);

    /// <summary>Patches an upstream event guarded by its last known version and returns the new version.</summary>
    public Task<string> UpdateEventAsync(string accessToken, string calendarId, string externalId, string version, PushEvent push, CancellationToken cancellationToken);

    /// <summary>Deletes an upstream event guarded by its last known version; an already-gone event is not an error.</summary>
    public Task DeleteEventAsync(string accessToken, string calendarId, string externalId, string version, CancellationToken cancellationToken);
}

/// <summary>A provider answered with an error status or an unreadable body; the sync retries the job.</summary>
public sealed class CalendarProviderException : Exception
{
    public CalendarProviderException(string message)
        : base(message)
    {
    }

    public CalendarProviderException()
    {
    }

    public CalendarProviderException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
