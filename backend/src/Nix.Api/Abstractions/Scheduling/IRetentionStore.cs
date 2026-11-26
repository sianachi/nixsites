namespace Nix.Abstractions.Scheduling;

/// <summary>
/// Bounded, cross-tenant deletion of expired notifications and finished triggers - the one
/// legitimate cross-principal writer for each, backed by a SECURITY DEFINER function exactly as
/// the lease and finish operations are.
/// </summary>
public interface IRetentionStore
{
    /// <summary>Deletes up to <paramref name="limit"/> notifications older than 90 days. Returns how many were removed.</summary>
    public Task<int> PurgeOldNotificationsAsync(int limit, CancellationToken cancellationToken);

    /// <summary>Deletes up to <paramref name="limit"/> finished (fired, skipped, or cancelled) triggers older than 30 days. Returns how many were removed.</summary>
    public Task<int> PurgeFinishedTriggersAsync(int limit, CancellationToken cancellationToken);

    /// <summary>Deletes up to <paramref name="limit"/> automation runs older than 30 days. Returns how many were removed.</summary>
    public Task<int> PurgeAutomationRunsAsync(int limit, CancellationToken cancellationToken);

    /// <summary>
    /// Deletes up to <paramref name="limit"/> calendar sync log rows older than 30 days and up to as
    /// many event-map tombstones older than 30 days. Returns the larger of the two counts, so a
    /// caller repeating while a full batch comes back drains both.
    /// </summary>
    public Task<int> PurgeCalendarSyncLogAsync(int limit, CancellationToken cancellationToken);

    /// <summary>Deletes up to <paramref name="limit"/> pet usage rows older than 13 months. Returns how many were removed.</summary>
    public Task<int> PurgePetUsageAsync(int limit, CancellationToken cancellationToken);
}
