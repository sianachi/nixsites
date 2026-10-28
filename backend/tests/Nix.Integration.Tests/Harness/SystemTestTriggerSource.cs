using System.Collections.Concurrent;
using Nix.Abstractions;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Notifications;
using Nix.Domain.Scheduling;

namespace Nix.Integration.Tests.Harness;

/// <summary>
/// A trigger source that exists only to exercise plan -&gt; fire -&gt; notify end to end in tests.
/// Never registered by production composition; a test host adds it explicitly (as
/// <c>ITriggerSource</c>) when it wants the dispatcher and planner exercised against a source it
/// fully controls, instead of waiting on a real reminder or automation source.
/// </summary>
/// <remarks>
/// The desired set is process-wide (a <see cref="ConcurrentDictionary{TKey,TValue}"/> keyed by
/// dedupe key) rather than per-instance, because the planner and the dispatcher resolve
/// <c>ITriggerSource</c> from different DI scopes; a test seeds it once and both the planning pass
/// and the eventual fire see the same desired set.
/// </remarks>
public sealed class SystemTestTriggerSource(INotificationWriter notifications) : ITriggerSource
{
    private static readonly ConcurrentDictionary<string, DesiredTrigger> Desired = new(StringComparer.Ordinal);

    /// <inheritdoc />
    public string Name => "system.test";

    /// <inheritdoc />
    public TriggerKind Kind => TriggerKind.System;

    /// <summary>Adds or replaces a trigger a test wants the next planning pass to pick up.</summary>
    public static void Want(DesiredTrigger trigger)
    {
        ArgumentNullException.ThrowIfNull(trigger);
        Desired[trigger.DedupeKey] = trigger;
    }

    private static volatile bool incomplete;

    /// <summary>
    /// Makes the next planning passes report their plan as incomplete (as a source that reached its
    /// page cap would), until <see cref="Reset"/>.
    /// </summary>
    public static void ReportIncomplete() => incomplete = true;

    /// <summary>Removes every desired trigger a test previously registered, so suites do not leak into each other.</summary>
    public static void Reset()
    {
        Desired.Clear();
        incomplete = false;
    }

    /// <inheritdoc />
    public Task<TriggerPlan> PlanAsync(PlanWindow window, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(window);
        IReadOnlyList<DesiredTrigger> matching = Desired.Values
            .Where(trigger => trigger.FireAt >= window.Start && trigger.FireAt < window.End)
            .ToArray();
        return Task.FromResult(new TriggerPlan(matching, Complete: !incomplete));
    }

    /// <inheritdoc />
    public async Task<TriggerOutcome> FireAsync(DueTrigger trigger, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(trigger);
        if (!Desired.ContainsKey(trigger.DedupeKey))
        {
            return TriggerOutcome.Skipped("system_test_trigger_withdrawn");
        }

        await notifications.CreateAsync(
            trigger.PrincipalId,
            NotificationKind.System,
            "System test trigger",
            "Fired by the system test trigger source.",
            itemId: null,
            trigger.WorkspaceId,
            $"system-test-fired:{trigger.DedupeKey}",
            cancellationToken).ConfigureAwait(false);
        return TriggerOutcome.Fired("system_test_trigger_fired");
    }
}
