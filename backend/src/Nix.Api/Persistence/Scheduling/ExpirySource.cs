using System.Globalization;
using Nix.Abstractions;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Items;
using Nix.Domain.Notifications;
using Nix.Domain.Scheduling;
using Nix.Features.Items;
using Nix.Messaging;

namespace Nix.Persistence.Scheduling;

/// <summary>
/// Moves an item to the trash at the instant its <c>expiry</c> property names, after a notice seven
/// days earlier. The trash step is the ordinary <see cref="DeleteItem"/>, dispatched in the
/// dispatcher's own transaction and session as the setter, so permission, <c>no_delete</c> and
/// protected descendants are checked exactly as for a person.
/// </summary>
/// <remarks>
/// <para>
/// Only values stamped with <c>$expiry_set_by</c> are planned (the finder requires it), so old
/// data under the same key is never acted on. The recipient is whoever set the date, else the
/// creator, as for reminders.
/// </para>
/// <para>
/// <b>Retry.</b> The trash trigger's dedupe key carries the day it fires on, so an item that
/// could not be trashed (protected, pinned, a site root, the setter lost access) is planned again
/// each day and trashes on the first pass after the block lifts. Its notice is keyed by item,
/// expiry value and 30-day period, so the setter hears about it once a month.
/// </para>
/// <para>
/// Mute and quiet hours govern notices only. Quiet hours shift the seven-day warning; the notice
/// that accompanies the trash step is written when it happens.
/// <c>shortcut: the moved-to-trash and blocked notices ignore quiet hours, add a deferred notice trigger if a push at night proves unwelcome.</c>
/// </para>
/// </remarks>
public sealed class ExpirySource(
    IReminderCandidateFinder candidates,
    IItemTree tree,
    IPermissionResolver permissions,
    IMutedContainerChecker mutedContainers,
    IPrincipalStatusChecker principalStatus,
    INotificationWriter notifications,
    IItemLocks locks,
    ISiteStore sites,
    IItemProtections protections,
    NixDispatcher dispatcher,
    TimeProvider clock) : ITriggerSource
{
    private const string WarnPrefix = "expiry-warn:";
    private const string TrashPrefix = "expiry:";
    private const int BlockerNameLength = 60;
    private static readonly TimeSpan WarnLead = TimeSpan.FromDays(7);
    private static readonly TimeSpan NoticePeriod = TimeSpan.FromDays(30);

    /// <inheritdoc />
    public string Name => "expiry.item";

    /// <inheritdoc />
    public TriggerKind Kind => TriggerKind.Reminder;

    /// <inheritdoc />
    public async Task<TriggerPlan> PlanAsync(PlanWindow window, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(window);

        // See ExplicitReminderSource for why the pagination sentinel is not DateTimeOffset.MinValue.
        var start = new DateTimeOffset(1900, 1, 1, 0, 0, 0, TimeSpan.Zero);
        var (found, complete) = await ReminderSourceSupport.ReadAllPagesAsync<ExpiryCandidate>(
            last => candidates.FindExpiringAsync(
                window.End + WarnLead, ReminderSourceSupport.PageSize, last?.ExpiryAt ?? start, last?.ItemId ?? Guid.Empty, cancellationToken)).ConfigureAwait(false);

        if (found.Count == 0)
        {
            return new TriggerPlan([], complete);
        }

        var preferencesByRecipient = await ReminderSourceSupport.PreferencesByRecipientAsync(
            candidates,
            found.Select(candidate => new ReminderRecipient(candidate.TenantId, candidate.PrincipalId)),
            cancellationToken).ConfigureAwait(false);

        var desired = new List<DesiredTrigger>(found.Count * 2);
        foreach (var candidate in found)
        {
            var expiry = candidate.ExpiryAt;
            if (expiry > window.Start)
            {
                var warnAt = expiry - WarnLead < window.Start ? window.Start : expiry - WarnLead;
                if (preferencesByRecipient.TryGetValue(new ReminderRecipient(candidate.TenantId, candidate.PrincipalId), out var recipient))
                {
                    var quiet = ReminderQuietHours.Apply(warnAt, recipient.TimeZone, recipient.QuietStart, recipient.QuietEnd);
                    warnAt = quiet < expiry ? quiet : warnAt;
                }

                desired.Add(new DesiredTrigger(
                    candidate.TenantId, candidate.WorkspaceId, candidate.PrincipalId, candidate.ItemId, null, warnAt,
                    WarnKey(candidate.ItemId, expiry)));
            }

            if (expiry < window.End)
            {
                // Never shifted for quiet hours: the trash step is not a notice.
                var trashAt = expiry < window.Start ? window.Start : expiry;
                desired.Add(new DesiredTrigger(
                    candidate.TenantId, candidate.WorkspaceId, candidate.PrincipalId, candidate.ItemId, null, trashAt,
                    TrashKey(candidate.ItemId, expiry, trashAt)));
            }
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

        if (ReminderInstant.Read(item.Properties, ItemProperties.ExpiryKey) is not { } expiry)
        {
            return TriggerOutcome.Skipped("expiry_removed");
        }

        // Recomputed from the item's current value, so a date that moved since planning is stale
        // whether or not a later planning pass has caught up.
        var warning = trigger.DedupeKey.StartsWith(WarnPrefix, StringComparison.Ordinal);
        if (warning
                ? trigger.DedupeKey != WarnKey(itemId, expiry)
                : !trigger.DedupeKey.StartsWith(TrashKey(itemId, expiry, null), StringComparison.Ordinal))
        {
            return TriggerOutcome.Skipped("expiry_changed");
        }

        var recipientId = await ReminderSourceSupport
            .ResolveRecipientAsync(item, ItemProperties.ExpirySetByKey, principalStatus, cancellationToken)
            .ConfigureAwait(false);
        if (recipientId != trigger.PrincipalId)
        {
            return TriggerOutcome.Skipped("recipient_changed");
        }

        if (!await principalStatus.IsActiveAsync(trigger.PrincipalId, cancellationToken).ConfigureAwait(false))
        {
            return TriggerOutcome.Skipped("recipient_not_active");
        }

        var canRead = await permissions.CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false);
        if (warning && !canRead)
        {
            return TriggerOutcome.Skipped("access_lost");
        }

        var recipientPreferences = await candidates
            .PreferencesForAsync([new ReminderRecipient(trigger.TenantId, trigger.PrincipalId)], cancellationToken)
            .ConfigureAwait(false);
        var muted = await mutedContainers
            .IsMutedAsync(itemId, recipientPreferences.Count > 0 ? recipientPreferences[0].MutedContainerIds : [], cancellationToken)
            .ConfigureAwait(false);
        var title = await ReminderSourceSupport.NotificationTitleAsync(item, locks, cancellationToken).ConfigureAwait(false);

        if (warning)
        {
            if (muted)
            {
                return TriggerOutcome.Skipped("container_muted");
            }

            await NotifyAsync(
                trigger, item, NotificationKind.Reminder, title,
                $"Moves to trash on {expiry.UtcDateTime.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture)} UTC.",
                trigger.DedupeKey, cancellationToken).ConfigureAwait(false);
            return TriggerOutcome.Fired("expiry_warned");
        }

        // Quiet hours and mute stop the notice below, never the trash itself.
        async Task BlockedAsync(string text)
        {
            if (!muted && canRead)
            {
                await NotifyAsync(
                    trigger, item, NotificationKind.System, title, text,
                    $"expiry-blocked:{itemId:D}:{expiry.UtcDateTime:O}:{Period(expiry)}", cancellationToken).ConfigureAwait(false);
            }
        }

        if (!await permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            await BlockedAsync("Not moved to trash: you no longer have write access to this workspace.").ConfigureAwait(false);
            return TriggerOutcome.Skipped("write_access_lost");
        }

        // Only purge refuses a site root, so trashing one is refused here.
        if (await sites.HasLiveOrStoredSiteAsync(item.WorkspaceId, item.Id, cancellationToken).ConfigureAwait(false))
        {
            await BlockedAsync("Not moved to trash: this item is the root of a site. Unpublish the site first.").ConfigureAwait(false);
            return TriggerOutcome.Skipped("site_root");
        }

        var deleted = await dispatcher.SendAsync<DeleteItem, ItemId>(new DeleteItem(item.Id), cancellationToken).ConfigureAwait(false);
        if (deleted.IsFailure)
        {
            var blockers = await protections.FindDeleteBlockersAsync(item.Id, cancellationToken).ConfigureAwait(false);
            await BlockedAsync(await DescribeAsync(blockers, cancellationToken).ConfigureAwait(false)).ConfigureAwait(false);
            return TriggerOutcome.Skipped("blocked");
        }

        if (!muted)
        {
            await NotifyAsync(
                trigger, item, NotificationKind.Reminder, title, "Moved to trash because its expiry passed.",
                $"expiry-done:{itemId:D}:{expiry.UtcDateTime:O}", cancellationToken).ConfigureAwait(false);
        }

        return TriggerOutcome.Fired("expired");
    }

    private async Task<string> DescribeAsync(IReadOnlyList<DeleteBlocker> blockers, CancellationToken cancellationToken)
    {
        if (blockers.Count == 0)
        {
            return "Not moved to trash: it could not be deleted.";
        }

        var named = new List<string>(blockers.Count);
        foreach (var blocker in blockers)
        {
            // A blocker under a lock keeps its title to itself.
            var name = await locks.MayReadBodyAsync(blocker.Id, cancellationToken).ConfigureAwait(false)
                ? (blocker.Title.Length > BlockerNameLength ? blocker.Title[..BlockerNameLength] : blocker.Title)
                : "a locked item";
            named.Add($"{name} ({(blocker.Reason == "pinned" ? "pinned by a record" : "protected from deletion")})");
        }

        return $"Not moved to trash. Blocked by: {string.Join(", ", named)}. It is retried daily.";
    }

    private Task<NotificationWriteResult> NotifyAsync(
        DueTrigger trigger, Item item, NotificationKind kind, string title, string body, string dedupeKey, CancellationToken cancellationToken) =>
        notifications.CreateAsync(trigger.PrincipalId, kind, title, body, item.Id, item.WorkspaceId, dedupeKey, cancellationToken);

    /// <summary>The 30-day period since the expiry the current attempt falls in; one notice per period.</summary>
    private int Period(DateTimeOffset expiry) =>
        Math.Max(0, (int)((clock.GetUtcNow() - expiry) / NoticePeriod));

    private static string WarnKey(Guid itemId, DateTimeOffset expiry) =>
        $"{WarnPrefix}{itemId:D}:{expiry.UtcDateTime:O}";

    /// <summary>The trash trigger's key; without a day, the prefix every day's key for this value shares.</summary>
    private static string TrashKey(Guid itemId, DateTimeOffset expiry, DateTimeOffset? firesAt) =>
        $"{TrashPrefix}{itemId:D}:{expiry.UtcDateTime:O}:{(firesAt is { } at ? at.UtcDateTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : string.Empty)}";
}
