using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Nix.Abstractions;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Scheduling;

namespace Nix.Persistence.Scheduling;

/// <summary>
/// Reconciles derived <c>scheduled_trigger</c> rows against every registered
/// <see cref="ITriggerSource"/>, every 60 seconds, 48 hours ahead (ADR-0051 section 2). Idempotent
/// by construction: replanning the same desired set upserts the rows their dedupe keys already
/// name and cancels only what a source no longer produces.
/// </summary>
public sealed class TriggerPlanner(
    IServiceScopeFactory scopes,
    TimeProvider clock,
    ILogger<TriggerPlanner>? logger = null) : BackgroundService
{
    private static readonly TimeSpan PlanInterval = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan PlanWindowSpan = TimeSpan.FromHours(48);
    private static readonly TimeSpan FailureDelay = TimeSpan.FromSeconds(5);

    private readonly ILogger<TriggerPlanner> _logger = logger ?? NullLogger<TriggerPlanner>.Instance;

    // When each source last planned, for sources with a PlanInterval. Only the planner's own loop
    // touches it, one pass at a time.
    private readonly Dictionary<string, DateTimeOffset> _lastPlanned = new(StringComparer.Ordinal);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await PlanOnceAsync(stoppingToken).ConfigureAwait(false);
                await Task.Delay(PlanInterval, clock, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
#pragma warning disable CA1031 // Justification: planning is durable and must retry after any transient database failure.
            catch (Exception exception)
            {
                TriggerPlannerLog.Failed(_logger, exception);
                await Task.Delay(FailureDelay, clock, stoppingToken).ConfigureAwait(false);
            }
#pragma warning restore CA1031
        }
    }

    /// <summary>Runs one full planning pass over every registered source; exposed for tests.</summary>
    public async Task PlanOnceAsync(CancellationToken cancellationToken)
    {
        var now = clock.GetUtcNow();
        var window = new PlanWindow(now, now + PlanWindowSpan);

        // Sources are resolved from a short-lived scope of their own, never held by this
        // singleton: a source is free to depend on scoped services (a store, a session-less
        // reader), and PlanAsync itself runs before any recipient's own session is established -
        // no source registered in this lane needs one to plan.
        var planningScope = scopes.CreateAsyncScope();
        List<(string Name, TriggerKind Kind, TriggerPlan Plan)> plans;
        await using (planningScope.ConfigureAwait(false))
        {
            var registered = planningScope.ServiceProvider.GetServices<ITriggerSource>().ToArray();
            TriggerSourceNames.RequireUnique(registered);
            plans = new List<(string Name, TriggerKind Kind, TriggerPlan Plan)>(registered.Length);
            foreach (var source in registered)
            {
                if (!source.IsPlanned
                    || (_lastPlanned.TryGetValue(source.Name, out var planned) && now - planned < source.PlanInterval))
                {
                    continue;
                }

                // One source's failure - a row so malformed its own defenses could not save it,
                // or any other exception - must not take every other source's planning down with
                // it. Every source here plans across every tenant at once; a single bad row in
                // one tenant aborting the whole pass would turn into an outage for every tenant,
                // for every kind of reminder, not just the one row that was wrong.
                TriggerPlan plan;
                try
                {
                    plan = await source.PlanAsync(window, cancellationToken).ConfigureAwait(false);
                }
#pragma warning disable CA1031 // Justification: isolating one source's failure from every other source's planning is the point.
                catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
                {
                    TriggerPlannerLog.SourceFailed(_logger, source.Name, exception);
                    continue;
                }
#pragma warning restore CA1031

                if (!plan.Complete)
                {
                    TriggerPlannerLog.SourceIncomplete(_logger, source.Name, plan.Triggers.Count);
                }

                _lastPlanned[source.Name] = now;
                plans.Add((source.Name, source.Kind, plan));
            }
        }

        foreach (var (name, kind, plan) in plans)
        {
            var owners = 0;
            var failedOwners = 0;
            foreach (var group in plan.Triggers.GroupBy(trigger => (trigger.TenantId, trigger.WorkspaceId, trigger.PrincipalId)))
            {
                owners++;
                var desired = group.ToArray();

                // Each owner reconciles in its own scope, connection and transaction, so one
                // owner's failure (a recipient deleted between finding and upserting, say, which
                // fails the principal foreign key) rolls back only that owner's rows; it must
                // not end the pass for every owner after it, pass after pass.
                try
                {
                    await ReconcileOwnerAsync(name, kind, group.Key, desired, plan, window, cancellationToken).ConfigureAwait(false);
                }
#pragma warning disable CA1031 // Justification: isolating one owner's failure from every other owner's planning is the point.
                catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
                {
                    failedOwners++;
                    TriggerPlannerLog.OwnerFailed(_logger, name, group.Key.TenantId.Value, group.Key.PrincipalId.Value, desired.Length, exception);
                }
#pragma warning restore CA1031
            }

            if (failedOwners > 0)
            {
                TriggerPlannerLog.OwnersFailed(_logger, name, failedOwners, owners);
            }
        }
    }

    private async Task ReconcileOwnerAsync(
        string source,
        TriggerKind kind,
        (Nix.Domain.Tenancy.TenantId TenantId, Nix.Domain.Tenancy.WorkspaceId? WorkspaceId, Nix.Domain.Identity.PrincipalId PrincipalId) owner,
        IReadOnlyList<DesiredTrigger> desired,
        TriggerPlan plan,
        PlanWindow window,
        CancellationToken cancellationToken)
    {
        var scope = scopes.CreateAsyncScope();
        await using (scope.ConfigureAwait(false))
        {
            var provider = scope.ServiceProvider;
            provider.GetRequiredService<ScopedNixSessionContextAccessor>().Set(new NixSessionContext(
                owner.TenantId, owner.WorkspaceId, owner.PrincipalId));
            var database = provider.GetRequiredService<NixDbContext>();
            var transaction = await database.Database.BeginTransactionAsync(cancellationToken).ConfigureAwait(false);
            await using (transaction.ConfigureAwait(false))
            {
                var store = provider.GetRequiredService<IScheduledTriggerStore>();
                await store.UpsertPendingAsync(kind, source, desired, cancellationToken).ConfigureAwait(false);

                // An incomplete plan stopped at its page cap: a row it did not reach is not "no
                // longer desired", so cancelling against it would drop reminders that still hold.
                if (plan.Complete)
                {
                    await store.CancelStaleAsync(
                        owner.TenantId,
                        owner.WorkspaceId,
                        owner.PrincipalId,
                        kind,
                        source,
                        window.Start,
                        window.End,
                        desired.Select(trigger => trigger.DedupeKey).ToArray(),
                        plan.IncompleteRules ?? [],
                        cancellationToken).ConfigureAwait(false);
                }

                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            }
        }
    }
}

internal static partial class TriggerPlannerLog
{
    [LoggerMessage(5310, LogLevel.Error, "Trigger planning failed and will retry")]
    internal static partial void Failed(ILogger logger, Exception exception);

    [LoggerMessage(5311, LogLevel.Error, "Trigger source {SourceName} failed to plan; every other source still ran")]
    internal static partial void SourceFailed(ILogger logger, string sourceName, Exception exception);

    [LoggerMessage(5312, LogLevel.Warning, "Trigger source {SourceName} reached its page cap with {TriggerCount} triggers; stale triggers are not cancelled this pass")]
    internal static partial void SourceIncomplete(ILogger logger, string sourceName, int triggerCount);

    [LoggerMessage(5313, LogLevel.Warning, "Trigger source {SourceName} could not reconcile {TriggerCount} triggers for principal {PrincipalId} in tenant {TenantId}; other owners still ran")]
    internal static partial void OwnerFailed(ILogger logger, string sourceName, Guid tenantId, Guid principalId, int triggerCount, Exception exception);

    [LoggerMessage(5314, LogLevel.Warning, "Trigger source {SourceName} failed to reconcile {FailedOwners} of {Owners} owners this pass")]
    internal static partial void OwnersFailed(ILogger logger, string sourceName, int failedOwners, int owners);
}
