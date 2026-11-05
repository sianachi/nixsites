using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Nix.Abstractions;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Scheduling;

namespace Nix.Persistence.Scheduling;

/// <summary>
/// Core's one clock (ADR-0051 section 1). Leases due <c>scheduled_trigger</c> rows across every
/// tenant, and for each one opens a scoped session and a transaction exactly like
/// <see cref="Nix.Persistence.ObjectStorage.AbandonedObjectReaper"/>, resolves the
/// <see cref="ITriggerSource"/> for its kind, and re-verifies before acting.
/// </summary>
public sealed class ScheduleDispatcher(
    IScheduledTriggerLeaseStore leases,
    IRetentionStore retention,
    IServiceScopeFactory scopes,
    TimeProvider clock,
    ILogger<ScheduleDispatcher>? logger = null) : BackgroundService
{
    /// <summary>How many triggers one lease pass claims at most.</summary>
    public const int BatchSize = 50;

    /// <summary>How many rows one retention pass purges at most, per table.</summary>
    public const int RetentionBatchSize = 500;

    private const string FireSavepoint = "before_fire";
    private const int LeaseSeconds = 60;
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan FailureDelay = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan RetentionInterval = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan RetentionBudget = TimeSpan.FromSeconds(5);

    // 1 minute, 5 minutes, 30 minutes for the first three failed attempts; the fourth and fifth
    // retry share the last backoff rather than growing further, since five attempts is the ceiling.
    private static readonly TimeSpan[] RetryBackoff =
    [
        TimeSpan.FromMinutes(1),
        TimeSpan.FromMinutes(5),
        TimeSpan.FromMinutes(30),
    ];

    /// <summary>
    /// How many times a trigger may be leased before it is finalized as skipped instead of tried
    /// again - by <see cref="HandleFireFailureAsync"/> after an ordinary fire failure, and by
    /// <c>nix_lease_due_triggers</c> itself for a lease that expired without ever finishing
    /// because the process holding it died mid-fire (ADR-0051 Amendment 2).
    /// </summary>
    internal const int MaxAttempts = 5;

    private readonly ILogger<ScheduleDispatcher> _logger = logger ?? NullLogger<ScheduleDispatcher>.Instance;
    private readonly string _owner = $"schedule-dispatcher:{Environment.MachineName}:{Guid.NewGuid():N}";
    private DateTimeOffset _lastRetentionAt = DateTimeOffset.MinValue;
    private IReadOnlyList<string>? _prioritySources;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var processed = await DispatchOnceAsync(stoppingToken).ConfigureAwait(false);
                await RetentionOnceIfDueAsync(stoppingToken).ConfigureAwait(false);
                if (processed < BatchSize)
                {
                    await Task.Delay(PollInterval, clock, stoppingToken).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
#pragma warning disable CA1031 // Justification: dispatch is durable and must retry after any transient database failure.
            catch (Exception exception)
            {
                ScheduleDispatcherLog.Failed(_logger, exception);
                await Task.Delay(FailureDelay, clock, stoppingToken).ConfigureAwait(false);
            }
#pragma warning restore CA1031
        }
    }

    /// <summary>
    /// Leases and processes one bounded batch; exposed for operational probes and integration tests.
    /// </summary>
    /// <remarks>
    /// Reminder sources are leased first and every source after, from what is left of the batch
    /// (ADR-0051 Amendment 4): a bulk write can enqueue a large backlog of automation triggers due
    /// before a reminder, and ordering one lease by due time alone would make that reminder wait
    /// behind all of it.
    /// </remarks>
    public async Task<int> DispatchOnceAsync(CancellationToken cancellationToken)
    {
        var first = await PrioritySourcesAsync().ConfigureAwait(false);
        IReadOnlyList<DueTrigger> priority = first.Count == 0
            ? []
            : await leases.LeaseDueAsync(BatchSize, _owner, LeaseSeconds, MaxAttempts, first, cancellationToken).ConfigureAwait(false);
        IReadOnlyList<DueTrigger> rest = priority.Count < BatchSize
            ? await leases.LeaseDueAsync(BatchSize - priority.Count, _owner, LeaseSeconds, MaxAttempts, null, cancellationToken).ConfigureAwait(false)
            : [];
        foreach (var trigger in priority.Concat(rest))
        {
            await ProcessAsync(trigger, cancellationToken).ConfigureAwait(false);
        }

        return priority.Count + rest.Count;
    }

    /// <summary>The names of every registered reminder source, read once from a scope of their own.</summary>
    private async Task<IReadOnlyList<string>> PrioritySourcesAsync()
    {
        if (_prioritySources is { } known)
        {
            return known;
        }

        var scope = scopes.CreateAsyncScope();
        await using (scope.ConfigureAwait(false))
        {
            _prioritySources = [.. scope.ServiceProvider.GetServices<ITriggerSource>()
                .Where(source => source.Kind == TriggerKind.Reminder)
                .Select(source => source.Name)
                .Order(StringComparer.Ordinal)];
        }

        return _prioritySources;
    }

    /// <summary>
    /// Purges expired notifications, finished triggers, old automation runs and old calendar sync
    /// log rows and tombstones at most once every
    /// <see cref="RetentionInterval"/>, in bounded batches - retention is opportunistic background
    /// work, not correctness-critical, so it rides the same loop rather than a service of its own.
    /// </summary>
    /// <remarks>
    /// Each purge repeats its batch until a batch comes back short, within
    /// <see cref="RetentionBudget"/> for the whole pass: one batch per ten minutes falls behind
    /// anything that writes more than that, and a backlog would then never drain. The budget keeps
    /// a large backlog from holding up dispatch; whatever is left waits for the next pass.
    /// </remarks>
    public async Task RetentionOnceIfDueAsync(CancellationToken cancellationToken)
    {
        var now = clock.GetUtcNow();
        if (now - _lastRetentionAt < RetentionInterval)
        {
            return;
        }
        _lastRetentionAt = now;
        var started = clock.GetTimestamp();
        await DrainAsync(retention.PurgeOldNotificationsAsync, started, cancellationToken).ConfigureAwait(false);
        await DrainAsync(retention.PurgeFinishedTriggersAsync, started, cancellationToken).ConfigureAwait(false);
        await DrainAsync(retention.PurgeAutomationRunsAsync, started, cancellationToken).ConfigureAwait(false);
        await DrainAsync(retention.PurgeCalendarSyncLogAsync, started, cancellationToken).ConfigureAwait(false);
    }

    private async Task DrainAsync(Func<int, CancellationToken, Task<int>> purge, long started, CancellationToken cancellationToken)
    {
        do
        {
            if (await purge(RetentionBatchSize, cancellationToken).ConfigureAwait(false) < RetentionBatchSize)
            {
                return;
            }
        }
        while (clock.GetElapsedTime(started) < RetentionBudget);
    }

    private async Task ProcessAsync(DueTrigger trigger, CancellationToken cancellationToken)
    {
        var scope = scopes.CreateAsyncScope();
        await using (scope.ConfigureAwait(false))
        {
            var provider = scope.ServiceProvider;
            provider.GetRequiredService<ScopedNixSessionContextAccessor>().Set(new NixSessionContext(
                trigger.TenantId,
                trigger.WorkspaceId,
                trigger.PrincipalId));
            var database = provider.GetRequiredService<NixDbContext>();
            var transaction = await database.Database.BeginTransactionAsync(cancellationToken).ConfigureAwait(false);
            await using (transaction.ConfigureAwait(false))
            {
                // Resolved by Source, the unique name the planner recorded on this row - never by
                // Kind, which more than one registered source may share. A row whose source is no
                // longer registered (retired, or a typo nobody caught) is skipped by name rather
                // than falling back to guessing at a same-kind source that never planned it.
                var registered = provider.GetServices<ITriggerSource>().ToArray();
                TriggerSourceNames.RequireUnique(registered);
                var source = registered.FirstOrDefault(candidate => candidate.Name == trigger.Source);
                if (source is null)
                {
                    await CommitIfStillOwnedAsync(
                        transaction,
                        await FinishAsync(database, trigger, TriggerStatus.Skipped, "unknown_source", cancellationToken).ConfigureAwait(false),
                        cancellationToken).ConfigureAwait(false);
                    return;
                }

                // A savepoint, not just a try/catch: a source's exception can come from this same
                // connection (a constraint violation, a deadlock), which poisons the transaction
                // until something rolls it back. Rolling back to here - taken before FireAsync
                // writes anything - undoes only the source's partial work, leaving the transaction
                // usable for the finish call below and, if this were the last trigger to use this
                // scope, nothing else depends on it staying open.
                await transaction.CreateSavepointAsync(FireSavepoint, cancellationToken).ConfigureAwait(false);
                TriggerOutcome outcome;
                try
                {
                    outcome = await source.FireAsync(trigger, cancellationToken).ConfigureAwait(false);
                }
#pragma warning disable CA1031 // Justification: a source's failure must record and retry, never abort the whole batch.
                catch (Exception exception)
                {
                    await transaction.RollbackToSavepointAsync(FireSavepoint, cancellationToken).ConfigureAwait(false);
                    await CommitIfStillOwnedAsync(
                        transaction,
                        await HandleFireFailureAsync(database, trigger, exception, provider, cancellationToken).ConfigureAwait(false),
                        cancellationToken).ConfigureAwait(false);
                    return;
                }
#pragma warning restore CA1031

                // The finish runs on this same connection and transaction as the source's writes
                // above, not on a separate one: they must commit or roll back together, or a crash
                // between the two would either fire twice (finish rolled back, action kept - never
                // possible here, since both are in one transaction) or silently lose the action
                // (finish committed, action lost - the failure mode a separate connection would
                // have). Committing is further conditioned on FinishAsync still holding the lease:
                // if another replica already reclaimed it after this one's lease expired, that
                // replica will fire (or skip) it too, and this transaction must be discarded rather
                // than let the action apply a second time.
                await CommitIfStillOwnedAsync(
                    transaction,
                    await FinishAsync(
                        database,
                        trigger,
                        outcome.Status == TriggerFireStatus.Fired ? TriggerStatus.Fired : TriggerStatus.Skipped,
                        outcome.Reason,
                        cancellationToken).ConfigureAwait(false),
                    cancellationToken).ConfigureAwait(false);
            }
        }
    }

    /// <summary>Records a failed fire attempt. Returns whether this replica still held the lease.</summary>
    private async Task<bool> HandleFireFailureAsync(
        NixDbContext database,
        DueTrigger trigger,
        Exception exception,
        IServiceProvider provider,
        CancellationToken cancellationToken)
    {
        ScheduleDispatcherLog.FireFailed(_logger, trigger.Id, exception);

        // The error class only - never the message, which can carry user text (ADR-0051's
        // "never the message content" for automation guards applies equally here).
        var errorClass = exception.GetType().Name;
        if (trigger.Attempts >= MaxAttempts)
        {
            return await FinishAsync(database, trigger, TriggerStatus.Skipped, errorClass, cancellationToken).ConfigureAwait(false);
        }

        var finished = await FinishAsync(database, trigger, TriggerStatus.Pending, errorClass, cancellationToken).ConfigureAwait(false);
        if (!finished)
        {
            return false;
        }

        // The savepoint rollback above already restored this transaction to a usable state, so
        // this runs on the same connection as the finish just above it and commits with it.
        var backoff = RetryBackoff[Math.Min(trigger.Attempts - 1, RetryBackoff.Length - 1)];
        await provider.GetRequiredService<IScheduledTriggerStore>()
            .RescheduleAsync(trigger.TenantId, trigger.Id, clock.GetUtcNow() + backoff, cancellationToken)
            .ConfigureAwait(false);
        return true;
    }

    /// <summary>
    /// Calls <c>nix_finish_trigger</c> on this row's own connection and transaction - not the
    /// separate pool <see cref="IScheduledTriggerLeaseStore"/> leases from - so it commits or rolls
    /// back atomically with whatever the fire action wrote.
    /// </summary>
    private async Task<bool> FinishAsync(NixDbContext database, DueTrigger trigger, TriggerStatus status, string reason, CancellationToken cancellationToken)
    {
        var statusText = TriggerStorage.ToText(status);
        var detailJson = JsonSerializer.Serialize(new { reason });
        return await database.Database.SqlQuery<bool>($"""
            SELECT nix_finish_trigger({trigger.TenantId.Value}, {trigger.Id}, {this._owner}, {statusText}, {detailJson}::jsonb) AS "Value"
            """).SingleAsync(cancellationToken).ConfigureAwait(false);
    }

    private static Task CommitIfStillOwnedAsync(
        Microsoft.EntityFrameworkCore.Storage.IDbContextTransaction transaction,
        bool stillOwned,
        CancellationToken cancellationToken) =>
        stillOwned
            ? transaction.CommitAsync(cancellationToken)
            : transaction.RollbackAsync(cancellationToken);
}

internal static partial class ScheduleDispatcherLog
{
    [LoggerMessage(5300, LogLevel.Error, "Schedule dispatch failed and will retry")]
    internal static partial void Failed(ILogger logger, Exception exception);

    [LoggerMessage(5301, LogLevel.Warning, "Trigger {TriggerId} failed to fire")]
    internal static partial void FireFailed(ILogger logger, Guid triggerId, Exception exception);
}
