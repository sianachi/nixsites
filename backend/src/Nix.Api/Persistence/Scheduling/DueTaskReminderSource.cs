using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Notifications;
using Nix.Domain.Recurrence;
using Nix.Domain.Scheduling;

namespace Nix.Persistence.Scheduling;

/// <summary>
/// Fires at <c>due_reminder_time</c>, in the recipient's own zone, on an item's due day - and on
/// every occurrence day a recurring item produces, skipping any already complete (ADR-0051 section
/// 4). The recipient is whoever set the due date (<c>$due_set_by</c>) while that principal is active
/// in the item's tenant, falling back to the item's creator otherwise.
/// </summary>
public sealed class DueTaskReminderSource(
    IReminderCandidateFinder candidates,
    IItemTree tree,
    IWorkspaceMembershipIgnoringLock membership,
    IMutedContainerChecker mutedContainers,
    IPrincipalStatusChecker principalStatus,
    INotificationWriter notifications,
    IItemLocks locks) : ITriggerSource
{
    /// <inheritdoc />
    public string Name => "reminder.due";

    /// <inheritdoc />
    public TriggerKind Kind => TriggerKind.Reminder;

    /// <inheritdoc />
    public async Task<TriggerPlan> PlanAsync(PlanWindow window, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(window);

        var windowStartDay = DateOnly.FromDateTime(window.Start.UtcDateTime);
        // A recipient's due_reminder_time can push an occurrence's fire instant up to 24h past
        // its due day (a 09:00 reminder on a day whose midnight already fell inside the plan
        // window's start needs the day *before* window.Start considered too), so the day range
        // handed to the finder is widened by one on each side and the resulting fire instants are
        // filtered back down to the real window below.
        var findFrom = windowStartDay.AddDays(-1);
        var findTo = DateOnly.FromDateTime(window.End.UtcDateTime).AddDays(1);

        // The plain and recurring arms page independently, each by its own keyset over its own
        // index, so neither population can starve the other.
        var (plain, plainComplete) = await ReminderSourceSupport.ReadAllPagesAsync<DueReminderCandidate>(
            last => candidates.FindDueAsync(
                findFrom, findTo, ReminderSourceSupport.PageSize, last?.DueDayText ?? string.Empty, last?.ItemId ?? Guid.Empty, cancellationToken)).ConfigureAwait(false);
        var (recurring, recurringComplete) = await ReminderSourceSupport.ReadAllPagesAsync<RecurringDueReminderCandidate>(
            last => candidates.FindRecurringDueAsync(
                findFrom, findTo, ReminderSourceSupport.PageSize, last?.ItemId ?? Guid.Empty, cancellationToken)).ConfigureAwait(false);
        var complete = plainComplete && recurringComplete;

        if (plain.Count == 0 && recurring.Count == 0)
        {
            return new TriggerPlan([], complete);
        }

        var preferencesByRecipient = await ReminderSourceSupport.PreferencesByRecipientAsync(
            candidates,
            plain.Select(candidate => new ReminderRecipient(candidate.TenantId, candidate.PrincipalId))
                .Concat(recurring.Select(candidate => new ReminderRecipient(candidate.TenantId, candidate.PrincipalId))),
            cancellationToken).ConfigureAwait(false);

        var desired = new List<DesiredTrigger>(plain.Count + recurring.Count);
        foreach (var candidate in plain)
        {
            if (candidate.DueDay is { } dueDay && dueDay >= findFrom && dueDay <= findTo)
            {
                AddOccurrences(
                    desired, window, preferencesByRecipient,
                    candidate.TenantId, candidate.WorkspaceId, candidate.PrincipalId, candidate.ItemId, [dueDay]);
            }
        }

        foreach (var candidate in recurring)
        {
            if (candidate.AnchorDay is { } anchor && RecurrenceRuleJson.Read(candidate.Recurrence) is { } rule)
            {
                AddOccurrences(
                    desired, window, preferencesByRecipient,
                    candidate.TenantId, candidate.WorkspaceId, candidate.PrincipalId, candidate.ItemId,
                    RecurrenceExpansion.Occurrences(rule, anchor, findFrom, findTo).Where(day => !rule.IsCompleted(day)));
            }
        }

        return new TriggerPlan(desired, complete);
    }

    /// <summary>Adds the triggers one candidate's not-yet-complete occurrence days produce.</summary>
    private static void AddOccurrences(
        List<DesiredTrigger> desired,
        PlanWindow window,
        Dictionary<ReminderRecipient, ReminderPreferences> preferencesByRecipient,
        Nix.Domain.Tenancy.TenantId tenantId,
        Nix.Domain.Tenancy.WorkspaceId workspaceId,
        PrincipalId principalId,
        Guid itemId,
        IEnumerable<DateOnly> occurrenceDays)
    {
        if (!preferencesByRecipient.TryGetValue(new ReminderRecipient(tenantId, principalId), out var recipient)
            || !recipient.DueReminders)
        {
            return;
        }

        // Occurrence day, and the instant its due_reminder_time names before any clamping or
        // quiet-hours deferral - computed for every candidate occurrence in the window (plus
        // findFrom's one-day pad, to catch a recipient whose zone puts "today" ahead of
        // window.Start's UTC calendar day) so the overdue-collapsing rule below can see all of
        // them at once.
        var occurrences = occurrenceDays
            .Select(day => (Day: day, NaiveFireAt: LocalInstant(day, recipient.DueReminderTime, recipient.TimeZone)))
            .Where(occurrence => occurrence.NaiveFireAt < window.End)
            .ToList();

        // Of any occurrences whose natural instant already passed window.Start, only the single
        // most recent is kept, to be clamped to "now" below: a daily item, planned fresh for the
        // first time, would otherwise have both yesterday's and today's occurrence in this list
        // at once (the one-day pad above exists to catch a boundary case, not to resurrect a
        // whole extra day), firing two reminders together instead of the one still actually
        // owed. A steadily-running scheduler never accumulates more than one overdue occurrence
        // in the first place; collapsing here only matters for a cold start or an outage.
        var mostRecentOverdue = occurrences
            .Where(occurrence => occurrence.NaiveFireAt < window.Start)
            .OrderByDescending(occurrence => occurrence.Day)
            .Take(1);
        var dueNow = occurrences.Where(occurrence => occurrence.NaiveFireAt >= window.Start);

        foreach (var (occurrenceDay, naiveFireAt) in dueNow.Concat(mostRecentOverdue))
        {
            var clampedFireAt = naiveFireAt < window.Start ? window.Start : naiveFireAt;
            var fireAt = ReminderQuietHours.Apply(clampedFireAt, recipient.TimeZone, recipient.QuietStart, recipient.QuietEnd);
            desired.Add(new DesiredTrigger(
                tenantId,
                workspaceId,
                principalId,
                itemId,
                null,
                fireAt,
                ReminderDedupeKeys.Due(itemId, occurrenceDay)));
        }
    }

    /// <summary>The instant a local day and time-of-day mean in a zone.</summary>
    private static DateTimeOffset LocalInstant(DateOnly day, TimeOnly time, string timeZone) =>
        ReminderQuietHours.ResolveLocalInstant(day, time, timeZone);

    /// <inheritdoc />
    public async Task<TriggerOutcome> FireAsync(DueTrigger trigger, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(trigger);

        if (trigger.SourceItemId is not { } itemId || !TryParseOccurrenceDay(trigger.DedupeKey, out var occurrenceDay))
        {
            return TriggerOutcome.Skipped("missing_item");
        }

        var item = await tree.FindAsync(ItemId.From(itemId), cancellationToken).ConfigureAwait(false);
        if (item is null || item.LifecycleState != ItemLifecycleState.Active)
        {
            return TriggerOutcome.Skipped("item_gone");
        }

        var recipientId = await ReminderSourceSupport
            .ResolveRecipientAsync(item, ItemProperties.DueSetByKey, principalStatus, cancellationToken)
            .ConfigureAwait(false);
        if (recipientId != trigger.PrincipalId)
        {
            return TriggerOutcome.Skipped("recipient_changed");
        }

        var stillDue = item.Recurrence is { } recurrenceJson
            ? IsRecurringOccurrenceStillDue(recurrenceJson, item.DueDay, occurrenceDay)
            : IsPlainOccurrenceStillDue(item, occurrenceDay);
        if (!stillDue)
        {
            return TriggerOutcome.Skipped("occurrence_changed");
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
        if (recipientPreferences.Count == 0 || !recipientPreferences[0].DueReminders)
        {
            return TriggerOutcome.Skipped("due_reminders_disabled");
        }

        if (await mutedContainers.IsMutedAsync(itemId, recipientPreferences[0].MutedContainerIds, cancellationToken).ConfigureAwait(false))
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
            "Due today",
            ItemId.From(itemId),
            item.WorkspaceId,
            trigger.DedupeKey,
            cancellationToken).ConfigureAwait(false);

        return TriggerOutcome.Fired("due_reminder_fired");
    }

    /// <summary>Recovers the occurrence day a "due:{itemId}:{yyyy-MM-dd}" dedupe key names.</summary>
    private static bool TryParseOccurrenceDay(string dedupeKey, out DateOnly occurrenceDay)
    {
        occurrenceDay = default;
        const string prefix = "due:";
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
            out occurrenceDay);
    }

    private static bool IsPlainOccurrenceStillDue(Item item, DateOnly occurrenceDay)
    {
        if (item.DueDay is null
            || !DateOnly.TryParseExact(item.DueDay, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var dueDay)
            || dueDay != occurrenceDay)
        {
            return false;
        }

        try
        {
            var bag = JsonNode.Parse(item.Properties ?? "{}") as JsonObject;
            var completed = bag?["completion"] is JsonValue completion && completion.TryGetValue<bool>(out var value) && value;
            return !completed;
        }
        catch (JsonException)
        {
            return true;
        }
    }

    private static bool IsRecurringOccurrenceStillDue(string recurrenceJson, string? anchorText, DateOnly occurrenceDay)
    {
        if (anchorText is null
            || !DateOnly.TryParseExact(anchorText, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var anchor))
        {
            return false;
        }

        var rule = RecurrenceRuleJson.Read(recurrenceJson);
        if (rule is null)
        {
            return false;
        }

        // The occurrence must still be one the rule actually produces on this day - not merely
        // "not yet completed" - so a rule edited since planning (a new interval, a new Until) that
        // no longer lands on this day is caught here too.
        var producesDay = RecurrenceExpansion.Occurrences(rule, anchor, occurrenceDay, occurrenceDay).Any();
        return producesDay && !rule.IsCompleted(occurrenceDay);
    }
}
