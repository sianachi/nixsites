using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Identity;
using Nix.Domain.Items;

namespace Nix.Persistence.Scheduling;

/// <summary>The paging and recipient rules the three reminder sources share.</summary>
internal static class ReminderSourceSupport
{
    /// <summary>The finder page size; every finder refuses more.</summary>
    internal const int PageSize = 500;

    /// <summary>
    /// A ceiling on pages per finder per planning pass, not on how many reminders may exist:
    /// 200 pages of 500 is 100,000 candidates, a full sweep at ten times today's largest measured
    /// corpus. A source that reaches it reports an incomplete plan, so the planner upserts what was
    /// found but cancels nothing for that source until a pass completes.
    /// </summary>
    internal const int MaxPages = 200;

    /// <summary>
    /// Reads every keyset page of one finder, up to <see cref="MaxPages"/>, passing each call the
    /// last row of the previous page (<see langword="null"/> for the first).
    /// </summary>
    /// <returns>The rows found, and whether the last page was short (so nothing was left unread).</returns>
    internal static async Task<(List<T> Rows, bool Complete)> ReadAllPagesAsync<T>(
        Func<T?, Task<IReadOnlyList<T>>> readPage)
        where T : class
    {
        var rows = new List<T>();
        T? last = null;
        for (var page = 0; page < MaxPages; page++)
        {
            var batch = await readPage(last).ConfigureAwait(false);
            rows.AddRange(batch);
            if (batch.Count < PageSize)
            {
                return (rows, true);
            }

            last = batch[^1];
        }

        return (rows, false);
    }

    /// <summary>Preferences for every distinct recipient, keyed by recipient.</summary>
    internal static async Task<Dictionary<ReminderRecipient, ReminderPreferences>> PreferencesByRecipientAsync(
        IReminderCandidateFinder candidates,
        IEnumerable<ReminderRecipient> recipients,
        CancellationToken cancellationToken)
    {
        var preferences = await candidates
            .PreferencesForAsync(recipients.Distinct().ToArray(), cancellationToken)
            .ConfigureAwait(false);
        return preferences.ToDictionary(entry => entry.Recipient);
    }

    /// <summary>The title a reminder for an item under a lock carries instead of the item's own.</summary>
    internal const string LockedItemTitle = "Reminder for a locked item";

    /// <summary>
    /// The notification title for a reminder about <paramref name="item"/>: its own title, cut to
    /// the notification limit, or <see cref="LockedItemTitle"/> when any lock covers it.
    /// </summary>
    /// <remarks>
    /// Notification content follows locks (ADR-0051 Amendment 4). The dispatcher's scope has no
    /// credential, so no grant past a lock counts here: a notification outlives any grant and is
    /// pushed to every device the recipient subscribed, not only the browser that unlocked. The
    /// reminder is still delivered; only the item's text is withheld.
    /// </remarks>
    internal static async Task<string> NotificationTitleAsync(
        Item item,
        IItemLocks locks,
        CancellationToken cancellationToken)
    {
        if (!await locks.MayReadBodyAsync(item.Id, cancellationToken).ConfigureAwait(false))
        {
            return LockedItemTitle;
        }

        var title = ItemProperties.ReadTitle(item.Properties);
        return title.Length > 200 ? title[..200] : title;
    }

    /// <summary>
    /// The fire-time mirror of the finders' recipient rule: the principal named by
    /// <paramref name="setByKey"/> when it is active in the session's tenant (the dispatcher's
    /// session is scoped to the trigger's tenant, and <c>principal</c> is tenant-isolated), and
    /// the item's creator otherwise.
    /// </summary>
    internal static async Task<PrincipalId> ResolveRecipientAsync(
        Item item,
        string setByKey,
        IPrincipalStatusChecker principalStatus,
        CancellationToken cancellationToken)
    {
        if (ReadPrincipal(item.Properties, setByKey) is { } setBy
            && await principalStatus.IsActiveAsync(setBy, cancellationToken).ConfigureAwait(false))
        {
            return setBy;
        }

        return item.CreatedBy;
    }

    internal static PrincipalId? ReadPrincipal(string? properties, string key)
    {
        if (string.IsNullOrWhiteSpace(properties))
        {
            return null;
        }

        try
        {
            return JsonNode.Parse(properties) is JsonObject bag
                && bag[key] is JsonValue value
                && value.TryGetValue<string>(out var text)
                && Guid.TryParse(text, out var principalGuid)
                    ? PrincipalId.From(principalGuid)
                    : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
