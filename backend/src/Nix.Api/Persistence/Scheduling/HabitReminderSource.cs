using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Habits;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Notifications;
using Nix.Domain.Scheduling;
using NodaTime;

namespace Nix.Persistence.Scheduling;

/// <summary>
/// Fires at a habit's own <c>reminderTime</c>, in the habit's own zone, on a scheduled day that
/// has no check-in yet (ADR-0051 section 4). The recipient is the item's creator - a habit carries
/// no per-set-by attribution, the way <c>due_date</c>'s <c>$due_set_by</c> does.
/// </summary>
/// <remarks>
/// "No check-in yet" is checked only at fire time, never at plan time: a plan window looks up to
/// 48 hours ahead, where a future day's check-in cannot exist yet by construction, and today's own
/// check-in (recorded after an earlier planning pass already produced today's trigger) is exactly
/// the kind of fact re-verification exists to catch before acting on stale planning.
/// </remarks>
public sealed class HabitReminderSource(
    IReminderCandidateFinder candidates,
    IItemTree tree,
    IWorkspaceMembershipIgnoringLock membership,
    IMutedContainerChecker mutedContainers,
    IPrincipalStatusChecker principalStatus,
    INotificationWriter notifications,
    IItemLocks locks,
    NixDbContext database) : ITriggerSource
{
    /// <inheritdoc />
    public string Name => "reminder.habit";

    /// <inheritdoc />
    public TriggerKind Kind => TriggerKind.Reminder;

    /// <inheritdoc />
    public async Task<TriggerPlan> PlanAsync(PlanWindow window, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(window);

        var (found, complete) = await ReminderSourceSupport.ReadAllPagesAsync<HabitReminderCandidate>(
            last => candidates.FindHabitsAsync(ReminderSourceSupport.PageSize, last?.ItemId ?? Guid.Empty, cancellationToken)).ConfigureAwait(false);

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
            var settings = HabitSettings.Read(candidate.Settings);
            if (settings?.ReminderTime is not { } reminderTimeText
                || !TimeOnly.TryParseExact(reminderTimeText, "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out var reminderTime))
            {
                continue;
            }

            if (!preferencesByRecipient.TryGetValue(new ReminderRecipient(candidate.TenantId, candidate.PrincipalId), out var recipient)
                || !recipient.HabitReminders)
            {
                continue;
            }

            // NodaTime's Tzdb, not the host's - the same reason ReminderQuietHours uses it - and a
            // habit's own zone, once saved, is not re-validated against it on every read the way a
            // write is (HabitSettings.Validate accepts anything TimeZoneInfo.TryFindSystemTimeZoneById
            // resolves), so an unresolvable zone here is skipped for this one habit rather than
            // aborting every other candidate's planning.
            var zone = DateTimeZoneProviders.Tzdb.GetZoneOrNull(settings.Timezone);
            if (zone is null)
            {
                continue;
            }

            // Widened by a day on each side for the same reason DueTaskReminderSource widens its
            // scan: a habit's own zone can place a day's reminder instant just outside the window
            // when the window boundary and the habit's local midnight do not line up.
            var windowStartLocal = Instant.FromDateTimeOffset(window.Start).InZone(zone);
            var windowEndLocal = Instant.FromDateTimeOffset(window.End).InZone(zone);
            var scanFrom = new DateOnly(windowStartLocal.Year, windowStartLocal.Month, windowStartLocal.Day).AddDays(-1);
            var scanTo = new DateOnly(windowEndLocal.Year, windowEndLocal.Month, windowEndLocal.Day).AddDays(1);

            var scheduledOccurrences = new List<(DateOnly Day, DateTimeOffset NaiveFireAt)>();
            for (var day = scanFrom; day <= scanTo; day = day.AddDays(1))
            {
                if (!settings.IsScheduled(day))
                {
                    continue;
                }

                var naiveFireAt = LocalInstant(day, reminderTime, settings.Timezone);
                if (naiveFireAt < window.End)
                {
                    scheduledOccurrences.Add((day, naiveFireAt));
                }
            }

            // Same collapsing rule as DueTaskReminderSource, for the same reason: scanFrom's
            // one-day pad exists to catch a zone-boundary case, not to resurrect a whole extra
            // scheduled day, so at most one already-passed occurrence is kept (the most recent),
            // clamped to "now", alongside whatever is still ahead in the window.
            var mostRecentOverdue = scheduledOccurrences
                .Where(occurrence => occurrence.NaiveFireAt < window.Start)
                .OrderByDescending(occurrence => occurrence.Day)
                .Take(1);
            var dueNow = scheduledOccurrences.Where(occurrence => occurrence.NaiveFireAt >= window.Start);

            foreach (var (day, naiveFireAt) in dueNow.Concat(mostRecentOverdue))
            {
                var clampedFireAt = naiveFireAt < window.Start ? window.Start : naiveFireAt;
                var fireAt = ReminderQuietHours.Apply(clampedFireAt, recipient.TimeZone, recipient.QuietStart, recipient.QuietEnd);
                desired.Add(new DesiredTrigger(
                    candidate.TenantId,
                    candidate.WorkspaceId,
                    candidate.PrincipalId,
                    candidate.ItemId,
                    null,
                    fireAt,
                    ReminderDedupeKeys.Habit(candidate.ItemId, day)));
            }
        }

        return new TriggerPlan(desired, complete);
    }

    private static DateTimeOffset LocalInstant(DateOnly day, TimeOnly time, string timeZone) =>
        ReminderQuietHours.ResolveLocalInstant(day, time, timeZone);

    /// <inheritdoc />
    public async Task<TriggerOutcome> FireAsync(DueTrigger trigger, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(trigger);

        if (trigger.SourceItemId is not { } itemId || !TryParseScheduledDay(trigger.DedupeKey, out var scheduledDay))
        {
            return TriggerOutcome.Skipped("missing_item");
        }

        var item = await tree.FindAsync(ItemId.From(itemId), cancellationToken).ConfigureAwait(false);
        if (item is null || item.LifecycleState != ItemLifecycleState.Active)
        {
            return TriggerOutcome.Skipped("item_gone");
        }

        if (item.CreatedBy != trigger.PrincipalId)
        {
            return TriggerOutcome.Skipped("recipient_changed");
        }

        var settings = HabitSettings.ReadForDay(item.Properties, scheduledDay);
        if (settings?.ReminderTime is null || !settings.IsScheduled(scheduledDay))
        {
            return TriggerOutcome.Skipped("habit_setting_changed");
        }

        // A paused or archived habit accepts no check-ins (HabitTracker.SetHabitCheckIn refuses
        // one outright), so a reminder prompting for one would be a dead end for the recipient -
        // the same "not scheduled" reasoning, from the lifecycle side rather than the calendar
        // side.
        var history = HabitHistory.Read(item.Properties);
        if (history is null || history.StatusOn(scheduledDay) != "active")
        {
            return TriggerOutcome.Skipped("habit_not_active");
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
        if (recipientPreferences.Count == 0 || !recipientPreferences[0].HabitReminders)
        {
            return TriggerOutcome.Skipped("habit_reminders_disabled");
        }

        if (await mutedContainers.IsMutedAsync(itemId, recipientPreferences[0].MutedContainerIds, cancellationToken).ConfigureAwait(false))
        {
            return TriggerOutcome.Skipped("container_muted");
        }

        if (await HasCheckInAsync(item, scheduledDay, cancellationToken).ConfigureAwait(false))
        {
            return TriggerOutcome.Skipped("already_checked_in");
        }

        var truncatedTitle = await ReminderSourceSupport
            .NotificationTitleAsync(item, locks, cancellationToken)
            .ConfigureAwait(false);

        await notifications.CreateAsync(
            trigger.PrincipalId,
            NotificationKind.Reminder,
            truncatedTitle,
            "Time to check in",
            ItemId.From(itemId),
            item.WorkspaceId,
            trigger.DedupeKey,
            cancellationToken).ConfigureAwait(false);

        return TriggerOutcome.Fired("habit_reminder_fired");
    }

    /// <summary>
    /// Whether a habit's live child items already record a check-in for a day - the
    /// <c>$habit_check_in_date</c> key <c>HabitTracker</c>'s own check-in write path stores.
    /// </summary>
    /// <remarks>
    /// Asks exactly that question in SQL (EXISTS, so it stops at the first match) rather than
    /// listing children: a long-lived daily habit has thousands of check-ins, and any listing cap
    /// would eventually leave today's check-in unread and remind someone who already checked in.
    /// Runs under the dispatcher's session, so row security still applies.
    /// </remarks>
    private async Task<bool> HasCheckInAsync(Item habit, DateOnly day, CancellationToken cancellationToken)
    {
        var dayText = day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        return await database.Database.SqlQuery<bool>($"""
            SELECT EXISTS (
                SELECT 1
                  FROM item child
                 WHERE child.tenant_id = {habit.TenantId.Value}
                   AND child.workspace_id = {habit.WorkspaceId.Value}
                   AND child.parent_id = {habit.Id.Value}
                   AND child.lifecycle_state = 'active'
                   AND child.properties ->> '$habit_check_in_date' = {dayText}) AS "Value"
            """).SingleAsync(cancellationToken).ConfigureAwait(false);
    }

    private static bool TryParseScheduledDay(string dedupeKey, out DateOnly scheduledDay)
    {
        scheduledDay = default;
        const string prefix = "habit:";
        if (!dedupeKey.StartsWith(prefix, StringComparison.Ordinal))
        {
            return false;
        }

        var lastColon = dedupeKey.LastIndexOf(':');
        if (lastColon < prefix.Length)
        {
            return false;
        }

        return DateOnly.TryParseExact(
            dedupeKey[(lastColon + 1)..],
            "yyyy-MM-dd",
            CultureInfo.InvariantCulture,
            DateTimeStyles.None,
            out scheduledDay);
    }
}
