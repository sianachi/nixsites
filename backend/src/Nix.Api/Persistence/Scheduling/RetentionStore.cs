using Nix.Abstractions.Scheduling;
using Nix.Persistence.Sql;
using Npgsql;

namespace Nix.Persistence.Scheduling;

/// <summary>
/// Calls the <c>nix_purge_old_notifications</c> and <c>nix_purge_finished_triggers</c> SECURITY
/// DEFINER functions directly against the connection pool - the same pattern as
/// <see cref="ScheduledTriggerLeaseStore"/> and <see cref="Nix.Persistence.ObjectStorage.AbandonedObjectOperationStore"/>.
/// </summary>
public sealed class RetentionStore(NpgsqlDataSource dataSource) : IRetentionStore
{
    private readonly PooledSql _db = new(dataSource);

    public Task<int> PurgeOldNotificationsAsync(int limit, CancellationToken cancellationToken) =>
        PurgeAsync("SELECT nix_purge_old_notifications(@limit)", limit, cancellationToken);

    public Task<int> PurgeFinishedTriggersAsync(int limit, CancellationToken cancellationToken) =>
        PurgeAsync("SELECT nix_purge_finished_triggers(@limit)", limit, cancellationToken);

    public Task<int> PurgeAutomationRunsAsync(int limit, CancellationToken cancellationToken) =>
        PurgeAsync("SELECT nix_purge_automation_runs(@limit)", limit, cancellationToken);

    public Task<int> PurgeCalendarSyncLogAsync(int limit, CancellationToken cancellationToken) =>
        PurgeAsync("SELECT nix_purge_calendar_sync_log(@limit)", limit, cancellationToken);

    public Task<int> PurgePetUsageAsync(int limit, CancellationToken cancellationToken) =>
        PurgeAsync("SELECT nix_purge_pet_usage(@limit)", limit, cancellationToken);

    private async Task<int> PurgeAsync(string sql, int limit, CancellationToken cancellationToken)
    {
        if (limit is < 1 or > 10_000)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }

        return await _db.ScalarAsync<int>(sql, cancellationToken, NixParameter.Integer("limit", limit)).ConfigureAwait(false) ?? 0;
    }
}
