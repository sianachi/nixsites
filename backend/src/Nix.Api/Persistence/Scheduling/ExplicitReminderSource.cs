using Nix.Abstractions;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Notifications;
using Nix.Domain.Scheduling;

namespace Nix.Persistence.Scheduling;

/// <summary>
/// Fires once at the instant an item's <c>reminder</c> property names (ADR-0051 section 4).
/// </summary>
/// <remarks>
/// The recipient is whoever set the reminder (<c>$reminder_set_by</c>, stamped by the write path
/// exactly like <c>$due_set_by</c>) while that principal is active in the item's tenant, falling
/// back to the item's creator otherwise.
/// </remarks>
public sealed class ExplicitReminderSource(
    IReminderCandidateFinder candidates,
    IItemTree tree,
    IWorkspaceMembershipIgnoringLock membership,
    IMutedContainerChecker mutedContainers,
    IPrincipalStatusChecker principalStatus,
    INotificationWriter notifications,
    IItemLocks locks) : ITriggerSource
{
    // How far behind window.Start the finder looks. A reminder whose instant passed while Core
    // was down (a deploy, an outage) is still planned - clamped to "now" - rather than silently
    // lost; a day covers any outage a person would still want a late reminder for. A reminder that
    // already fired keeps its dedupe key's row as fired, which replanning never touches, so the
    // look-back can never deliver one twice.
    private static readonly TimeSpan LookBack = TimeSpan.FromHours(24);

    /// <inheritdoc />
    public string Name => "reminder.explicit";

    /// <inheritdoc />
    public TriggerKind Kind => TriggerKind.Reminder;

    /// <inheritdoc />
    public async Task<TriggerPlan> PlanAsync(PlanWindow window, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(window);

        var findFrom = window.Start - LookBack;

        // Not DateTimeOffset.MinValue: Npgsql's date/timestamp range near the .NET minimum (year
        // 1) does not round-trip reliably as a bound parameter against Postgres's own much wider
        // range, and produced a NULL keyset comparison rather than the expected TRUE in testing.
        // Any instant safely before this system could ever have a real reminder is just as good a
        // "start of pagination" sentinel.
        var start = new DateTimeOffset(1900, 1, 1, 0, 0, 0, TimeSpan.Zero);
        var (found, complete) = await ReminderSourceSupport.ReadAllPagesAsync<ExplicitReminderCandidate>(
            last => candidates.FindExplicitAsync(
                findFrom, window.End, ReminderSourceSupport.PageSize, last?.ReminderAt ?? start, last?.ItemId ?? Guid.Empty, cancellationToken)).ConfigureAwait(false);

        if (found.Count == 0)
        {
            return new TriggerPlan([], complete);
        }

        var preferencesByRecipient = await ReminderSourceSupport.PreferencesByRecipientAsync(
            candidates,
            found.Select(candidate => new ReminderRecipient(candidate.TenantId, candidate.PrincipalId)),
            cancellationToken).ConfigureAwait(false);

        var desired = new List<DesiredTrigger>(found.Count);
        foreach (var candidate in found)
        {
            // Clamped to window.Start, never dropped and never fired early - the same way
            // DueTaskReminderSource and HabitReminderSource clamp an overdue occurrence.
            var clampedReminderAt = candidate.ReminderAt < window.Start ? window.Start : candidate.ReminderAt;
            var fireAt = preferencesByRecipient.TryGetValue(new ReminderRecipient(candidate.TenantId, candidate.PrincipalId), out var recipient)
                ? ReminderQuietHours.Apply(clampedReminderAt, recipient.TimeZone, recipient.QuietStart, recipient.QuietEnd)
                : clampedReminderAt;

            desired.Add(new DesiredTrigger(
                candidate.TenantId,
                candidate.WorkspaceId,
                candidate.PrincipalId,
                candidate.ItemId,
                null,
                fireAt,
                ReminderDedupeKeys.Explicit(candidate.ItemId, candidate.ReminderAt)));
        }

        return new TriggerPlan(desired, complete);
    }

    /// <inheritdoc />
    public async Task<TriggerOutcome> FireAsync(DueTrigger trigger, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(trigger);

        if (trigger.SourceItemId is not { } itemId)
        {
            return TriggerOutcome.Skipped("missing_item");
        }

        var item = await tree.FindAsync(ItemId.From(itemId), cancellationToken).ConfigureAwait(false);
        if (item is null || item.LifecycleState != ItemLifecycleState.Active)
        {
            return TriggerOutcome.Skipped("item_gone");
        }

        var currentInstant = ReminderInstant.Read(item.Properties, ItemProperties.ReminderKey);
        if (currentInstant is not { } instant)
        {
            return TriggerOutcome.Skipped("reminder_removed");
        }

        // Recomputing the dedupe key from the item's current state, rather than parsing the
        // trigger's own dedupe key back apart, is what lets this compare against exactly the same
        // rule PlanAsync used to produce it: if the reminder moved since this trigger was
        // planned, the key it would produce now differs, and this is stale regardless of whether
        // a later planning pass has caught up yet.
        if (ReminderDedupeKeys.Explicit(itemId, instant) != trigger.DedupeKey)
        {
            return TriggerOutcome.Skipped("reminder_changed");
        }

        // ADR-0051 section 2 lists "completed" as a skip reason generally, not only for a due
        // task: an item a reminder was set on may also carry a completion property (a checklist
        // item finished before its reminder fired, say), and a completed item's reminder is no
        // longer useful regardless of which source planned it.
        if (IsCompleted(item.Properties))
        {
            return TriggerOutcome.Skipped("item_completed");
        }

        var recipientId = await ReminderSourceSupport
            .ResolveRecipientAsync(item, ItemProperties.ReminderSetByKey, principalStatus, cancellationToken)
            .ConfigureAwait(false);
        if (recipientId != trigger.PrincipalId)
        {
            return TriggerOutcome.Skipped("recipient_changed");
        }

        if (!await principalStatus.IsActiveAsync(trigger.PrincipalId, cancellationToken).ConfigureAwait(false))
        {
            return TriggerOutcome.Skipped("recipient_not_active");
        }

        // Membership, not the lock: a workspace password withholds the item's text from the notification
        // (the locked title below) but does not drop the reminder.
        if (await membership.RoleIgnoringLockAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false) is null)
        {
            return TriggerOutcome.Skipped("access_lost");
        }

        var recipientPreferences = await candidates
            .PreferencesForAsync([new ReminderRecipient(trigger.TenantId, trigger.PrincipalId)], cancellationToken)
            .ConfigureAwait(false);
        var mutedContainerIds = recipientPreferences.Count > 0
            ? recipientPreferences[0].MutedContainerIds
            : [];
        if (await mutedContainers.IsMutedAsync(itemId, mutedContainerIds, cancellationToken).ConfigureAwait(false))
        {
            return TriggerOutcome.Skipped("container_muted");
        }

        var truncatedTitle = await ReminderSourceSupport
            .NotificationTitleAsync(item, locks, cancellationToken)
            .ConfigureAwait(false);

        await notifications.CreateAsync(
            trigger.PrincipalId,
            NotificationKind.Reminder,
            truncatedTitle,
            "Reminder",
            ItemId.From(itemId),
            item.WorkspaceId,
            trigger.DedupeKey,
            cancellationToken).ConfigureAwait(false);

        return TriggerOutcome.Fired("reminder_fired");
    }

    /// <summary>Whether an item's own <c>completion</c> property, if it has one, is true.</summary>
    private static bool IsCompleted(string? properties)
    {
        if (string.IsNullOrWhiteSpace(properties))
        {
            return false;
        }

        try
        {
            return System.Text.Json.Nodes.JsonNode.Parse(properties) is System.Text.Json.Nodes.JsonObject bag
                && bag["completion"] is System.Text.Json.Nodes.JsonValue value
                && value.TryGetValue<bool>(out var completed)
                && completed;
        }
        catch (System.Text.Json.JsonException)
        {
            return false;
        }
    }
}
