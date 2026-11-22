using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Domain.Habits;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Features.Items;
using Nix.Features.Properties;
using Nix.Messaging;

namespace Nix.Features.Habits;

/// <summary>Configures an ordinary item as a habit.</summary>
public sealed record SetHabitSettings(ItemId ItemId, HabitSettingsRequest Settings) : ICommand<HabitTrackerResponse>;
/// <summary>Reads an inclusive local-date range, defaulting to the last four weeks.</summary>
public sealed record ReadHabitTracker(ItemId ItemId, DateOnly? From, DateOnly? To) : IQuery<Result<HabitTrackerResponse>>;
/// <summary>Sets absolute progress for one local day.</summary>
public sealed record SetHabitCheckIn(ItemId ItemId, DateOnly OccurredOn, HabitCheckInRequest CheckIn) : ICommand<HabitCheckInResponse>;
/// <summary>Removes a day's recorded progress using ordinary item trash.</summary>
public sealed record UndoHabitCheckIn(ItemId ItemId, DateOnly OccurredOn) : ICommand<ItemId>;
/// <summary>Pauses, resumes, or archives a habit while retaining its ordinary item history.</summary>
public sealed record SetHabitStatus(ItemId ItemId, HabitStatusRequest Status) : ICommand<HabitStatusResponse>;

/// <summary>Habit operations share ordinary item authorization, writes and transaction boundaries.</summary>
public sealed class HabitTrackerHandler(
    IItemTree tree,
    IVisibleItems visible,
    IItemLocks locks,
    IHabitLock habitLock,
    NixDispatcher dispatcher,
    TimeProvider clock) :
    ICommandHandler<SetHabitSettings, HabitTrackerResponse>,
    IQueryHandler<ReadHabitTracker, Result<HabitTrackerResponse>>,
    ICommandHandler<SetHabitCheckIn, HabitCheckInResponse>,
    ICommandHandler<UndoHabitCheckIn, ItemId>,
    ICommandHandler<SetHabitStatus, HabitStatusResponse>
{
    private const int MaximumChildren = 2000;
    private const string DateKey = "$habit_check_in_date";
    private const string CompletedKey = "$habit_check_in_completed";
    private const string QuantityKey = "$habit_check_in_quantity";
    private const string StatusKey = "$habit_status";

    public async ValueTask<Result<HabitStatusResponse>> HandleAsync(SetHabitStatus command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        ArgumentNullException.ThrowIfNull(command.Status);
        if (command.Status.Status is not ("active" or "paused" or "archived"))
        {
            return Failure<HabitStatusResponse>("invalid_status", "Status must be active, paused, or archived.");
        }
        var parent = await FindAsync(command.ItemId, true, cancellationToken).ConfigureAwait(false);
        if (parent is null)
        {
            return NotFound<HabitStatusResponse>();
        }
        await habitLock.AcquireAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
        parent = await FindAsync(command.ItemId, true, cancellationToken).ConfigureAwait(false);
        if (parent is null || HabitSettings.Read(parent.Properties) is null)
        {
            return Failure<HabitStatusResponse>("not_configured", "This item has no valid habit settings.");
        }
        var history = HabitHistory.Read(parent.Properties);
        if (history is null)
        {
            return Failure<HabitStatusResponse>("invalid_history", "The saved habit history is malformed.");
        }
        var statusProperties = history.ChangeStatus(command.Status.Status, HabitSettings.Read(parent.Properties)!.Today(clock.GetUtcNow()));
        if (statusProperties is null)
        {
            return Failure<HabitStatusResponse>("history_limit", "This habit has reached the limit of 512 lifecycle revisions.");
        }
        var update = await dispatcher.SendAsync<SetItemProperties, Item>(
            new SetItemProperties(command.ItemId, statusProperties.ToJsonString()) { HabitWrite = true }, cancellationToken).ConfigureAwait(false);
        return update.IsFailure
            ? Result.Failure<HabitStatusResponse>(update.Error)
            : Result.Success(new HabitStatusResponse(command.ItemId.Value, command.Status.Status));
    }

    /// <inheritdoc />
    public async ValueTask<Result<HabitTrackerResponse>> HandleAsync(SetHabitSettings command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        ArgumentNullException.ThrowIfNull(command.Settings);
        var request = command.Settings;
        var settings = new HabitSettings(request.Frequency, request.Weekdays ?? [], request.Timezone, request.StartDate, request.Target, request.Unit, request.ReminderTime);
        if (settings.Validate() is { } invalid)
        {
            return Failure<HabitTrackerResponse>("invalid_settings", invalid);
        }
        var parent = await FindAsync(command.ItemId, true, cancellationToken).ConfigureAwait(false);
        if (parent is null)
        {
            return NotFound<HabitTrackerResponse>();
        }
        await habitLock.AcquireAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
        parent = await FindAsync(command.ItemId, true, cancellationToken).ConfigureAwait(false);
        if (parent is null)
        {
            return NotFound<HabitTrackerResponse>();
        }
        var children = await ChildrenAsync(parent, cancellationToken).ConfigureAwait(false);
        if (children.IsFailure)
        {
            return Result.Failure<HabitTrackerResponse>(children.Error);
        }
        var previous = HabitSettings.Read(parent.Properties);
        var properties = settings.ToProperties();
        if (previous is not null)
        {
            var history = HabitHistory.Read(parent.Properties);
            if (history is null)
            {
                return Failure<HabitTrackerResponse>("invalid_history", "The saved habit history is malformed.");
            }
            if (settings.SameSchedule(previous))
            {
                return await HandleAsync(new ReadHabitTracker(command.ItemId, null, null), cancellationToken).ConfigureAwait(false);
            }
            var effective = previous.Today(clock.GetUtcNow());
            // A recorded day keeps its original target and schedule, including older check-ins without snapshots.
            if (children.Value.Any(child => ReadCheckIn(child)?.OccurredOn == effective))
            {
                if (effective == DateOnly.MaxValue)
                {
                    return Failure<HabitTrackerResponse>("invalid_settings", "The settings cannot take effect beyond the supported calendar.");
                }
                effective = effective.AddDays(1);
            }
            var changes = history.ChangeSettings(settings, effective);
            if (changes is null)
            {
                return Failure<HabitTrackerResponse>("history_limit", "This habit has reached the limit of 512 settings revisions.");
            }
            properties = changes;
        }
        var written = await dispatcher.SendAsync<SetItemProperties, Item>(
            new SetItemProperties(command.ItemId, properties.ToJsonString()) { HabitWrite = true }, cancellationToken).ConfigureAwait(false);
        if (written.IsFailure)
        {
            return Result.Failure<HabitTrackerResponse>(written.Error);
        }
        return await HandleAsync(new ReadHabitTracker(command.ItemId, null, null), cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<Result<HabitTrackerResponse>> HandleAsync(ReadHabitTracker query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        var parent = await FindAsync(query.ItemId, false, cancellationToken).ConfigureAwait(false);
        if (parent is null)
        {
            return NotFound<HabitTrackerResponse>();
        }
        var settings = HabitSettings.Read(parent.Properties);
        if (settings is null)
        {
            return Failure<HabitTrackerResponse>(HasProperty(parent, "$habit_frequency") ? "invalid_settings" : "not_configured", "This item has no valid habit settings.");
        }
        var end = query.To ?? settings.Today(clock.GetUtcNow());
        var start = query.From ?? DateOnly.FromDayNumber(Math.Max(0, end.DayNumber - 27));
        if (end < start || end.DayNumber - start.DayNumber >= 366)
        {
            return Failure<HabitTrackerResponse>("invalid_range", "Choose an ordered date range of no more than 366 days.");
        }
        var children = await ChildrenAsync(parent, cancellationToken).ConfigureAwait(false);
        if (children.IsFailure)
        {
            return Result.Failure<HabitTrackerResponse>(children.Error);
        }
        var history = HabitHistory.Read(parent.Properties);
        if (history is null)
        {
            return Failure<HabitTrackerResponse>("invalid_history", "The saved habit history is malformed.");
        }
        var today = settings.Today(clock.GetUtcNow());
        if (today.DayNumber - history.Start.DayNumber > 36_600)
        {
            return Failure<HabitTrackerResponse>("history_limit", "Habit statistics support a history of at most 100 years.");
        }
        var allRows = new List<HabitCheckInResponse>();
        var seen = new HashSet<DateOnly>();
        foreach (var child in children.Value.Where(IsCheckIn))
        {
            var row = ReadCheckIn(child);
            if (row is null || !seen.Add(row.OccurredOn))
            {
                return Failure<HabitTrackerResponse>("invalid_history", "A check-in is malformed or duplicated. Review the habit's child items before using its totals.");
            }
            allRows.Add(row);
        }
        var rows = allRows.Where(row => row.OccurredOn >= start && row.OccurredOn <= end).OrderBy(row => row.OccurredOn).ToList();
        var occurrences = BuildOccurrences(history, allRows, start, end, today);
        var lifetime = BuildOccurrences(history, allRows, history.Start, today, today);
        return Result.Success(new HabitTrackerResponse(parent.Id.Value, settings.Frequency, settings.Weekdays, settings.Timezone, settings.StartDate, settings.Target, settings.Unit, rows, BuildWeeks(occurrences), ReadStatus(parent.Properties), occurrences, BuildProgress(occurrences, lifetime, today), BuildMonths(occurrences), settings.ReminderTime));
    }

    /// <inheritdoc />
    public async ValueTask<Result<HabitCheckInResponse>> HandleAsync(SetHabitCheckIn command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        ArgumentNullException.ThrowIfNull(command.CheckIn);
        var parent = await FindAsync(command.ItemId, true, cancellationToken).ConfigureAwait(false);
        if (parent is null)
        {
            return NotFound<HabitCheckInResponse>();
        }
        await habitLock.AcquireAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
        parent = await FindAsync(command.ItemId, true, cancellationToken).ConfigureAwait(false);
        if (parent is null)
        {
            return NotFound<HabitCheckInResponse>();
        }
        var settings = HabitSettings.ReadForDay(parent.Properties, command.OccurredOn);
        if (settings is null)
        {
            return Failure<HabitCheckInResponse>(HasProperty(parent, "$habit_frequency") ? "invalid_settings" : "not_configured", "This item has no valid habit settings.");
        }
        if (ReadStatus(parent.Properties) is "paused" or "archived")
        {
            return Failure<HabitCheckInResponse>("paused", "A paused or archived habit does not accept check-ins.");
        }
        var history = HabitHistory.Read(parent.Properties);
        if (history is null)
        {
            return Failure<HabitCheckInResponse>("invalid_history", "The saved habit history is malformed.");
        }
        settings = history.SettingsOn(command.OccurredOn);
        if (!settings.IsScheduled(command.OccurredOn) || history.StatusOn(command.OccurredOn) != "active" || command.OccurredOn > settings.Today(clock.GetUtcNow()))
        {
            return Failure<HabitCheckInResponse>("not_scheduled", "Check-ins must be on a scheduled day between the start date and today in the habit's timezone.");
        }
        var quantity = command.CheckIn.Quantity;
        if (quantity is < 0 or > HabitSettings.MaximumQuantity)
        {
            return Failure<HabitCheckInResponse>("invalid_quantity", "Quantity must be between zero and one million.");
        }
        var children = await ChildrenAsync(parent, cancellationToken).ConfigureAwait(false);
        if (children.IsFailure)
        {
            return Result.Failure<HabitCheckInResponse>(children.Error);
        }
        var matches = children.Value.Where(child => ReadCheckIn(child)?.OccurredOn == command.OccurredOn).ToArray();
        if (matches.Length > 1 || children.Value.Any(child => IsCheckIn(child) && ReadCheckIn(child) is null))
        {
            return Failure<HabitCheckInResponse>("invalid_history", "Review malformed or duplicate child check-ins before recording progress.");
        }
        var completed = quantity is { } amount ? amount >= settings.Target : command.CheckIn.Completed;
        var properties = new JsonObject
        {
            [DateKey] = command.OccurredOn.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            [CompletedKey] = completed,
            [QuantityKey] = quantity,
        };
        Result<Item> written;
        if (matches.Length == 1)
        {
            written = await dispatcher.SendAsync<SetItemProperties, Item>(new SetItemProperties(matches[0].Id, properties.ToJsonString()) { HabitWrite = true }, cancellationToken).ConfigureAwait(false);
        }
        else
        {
            written = await dispatcher.SendAsync<CreateItem, Item>(new CreateItem(parent.WorkspaceId, "note", $"Check-in · {command.OccurredOn:yyyy-MM-dd}", parent.Id, properties) { HabitWrite = true }, cancellationToken).ConfigureAwait(false);
        }
        return written.IsFailure ? Result.Failure<HabitCheckInResponse>(written.Error) : Result.Success(new HabitCheckInResponse(written.Value.Id.Value, command.OccurredOn, completed, quantity));
    }

    /// <inheritdoc />
    public async ValueTask<Result<ItemId>> HandleAsync(UndoHabitCheckIn command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var parent = await FindAsync(command.ItemId, true, cancellationToken).ConfigureAwait(false);
        if (parent is null)
        {
            return NotFound<ItemId>();
        }
        await habitLock.AcquireAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
        parent = await FindAsync(command.ItemId, true, cancellationToken).ConfigureAwait(false);
        if (parent is null)
        {
            return NotFound<ItemId>();
        }
        var children = await ChildrenAsync(parent, cancellationToken).ConfigureAwait(false);
        if (children.IsFailure)
        {
            return Result.Failure<ItemId>(children.Error);
        }
        foreach (var row in children.Value.Where(child => ReadCheckIn(child)?.OccurredOn == command.OccurredOn))
        {
            var deleted = await dispatcher.SendAsync<DeleteItem, ItemId>(new DeleteItem(row.Id), cancellationToken).ConfigureAwait(false);
            if (deleted.IsFailure)
            {
                return deleted;
            }
        }
        return Result.Success(command.ItemId);
    }

    private async ValueTask<Item?> FindAsync(ItemId itemId, bool write, CancellationToken cancellationToken)
    {
        var lookup = await visible.FindAsync(itemId, write ? ItemAccess.Write : ItemAccess.Read, cancellationToken).ConfigureAwait(false);
        return lookup.IsSuccess ? lookup.Value : null;
    }

    private async ValueTask<Result<IReadOnlyList<Item>>> ChildrenAsync(Item parent, CancellationToken cancellationToken)
    {
        // A lock covers everything under it, a habit's check-ins included.
        if (!await locks.MayReadBodyAsync(parent.Id, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<IReadOnlyList<Item>>(new NixError("items.locked", $"Item {parent.Id} is locked. Unlock it to see its history."));
        }

        var children = new List<Item>();
        long? after = null;
        while (true)
        {
            var page = await tree.ListChildrenAsync(parent.WorkspaceId, parent.Id, false, after, 200, cancellationToken).ConfigureAwait(false);
            children.AddRange(page);
            if (children.Count > MaximumChildren)
            {
                return Failure<IReadOnlyList<Item>>("history_limit", "This first version supports at most 2,000 children per habit. Its totals cannot be calculated safely.");
            }
            if (page.Count < 200)
            {
                return Result.Success<IReadOnlyList<Item>>(children);
            }
            after = page[^1].Seq;
        }
    }

    private static bool IsCheckIn(Item item) => HasProperty(item, DateKey);

    private static bool HasProperty(Item item, string key)
    {
        try
        {
            return JsonNode.Parse(item.Properties ?? "{}") is JsonObject bag && bag.ContainsKey(key);
        }
        catch (JsonException)
        {
            // Invalid stored JSON is reported by the history reader instead of hiding a row.
            return true;
        }
    }

    private static HabitCheckInResponse? ReadCheckIn(Item item)
    {
        try
        {
            var bag = JsonNode.Parse(item.Properties ?? "{}") as JsonObject;
            if (bag?[DateKey]?.GetValue<string>() is not { } date
                || !DateOnly.TryParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day)
                || bag[CompletedKey]?.GetValue<bool>() is not { } completed)
            {
                return null;
            }
            var quantity = bag[QuantityKey]?.GetValue<decimal>();
            return quantity is < 0 or > HabitSettings.MaximumQuantity ? null : new(item.Id.Value, day, completed, quantity);
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or FormatException or OverflowException)
        {
            return null;
        }
    }

    private static List<HabitWeekSummary> BuildWeeks(List<HabitOccurrence> occurrences) =>
        occurrences.GroupBy(row => Math.Max(0, row.Date.DayNumber - (((int)row.Date.DayOfWeek + 6) % 7)))
            .Select(group => new HabitWeekSummary(DateOnly.FromDayNumber(group.Key), group.Count(row => row.Scheduled), group.Count(row => row.Scheduled && row.Completed), group.Sum(row => row.Quantity ?? 0))).ToList();

    private static List<HabitOccurrence> BuildOccurrences(HabitHistory history, List<HabitCheckInResponse> rows, DateOnly from, DateOnly to, DateOnly today)
    {
        var byDay = rows.ToDictionary(row => row.OccurredOn);
        var result = new List<HabitOccurrence>();
        for (var number = from.DayNumber; number <= to.DayNumber; number++)
        {
            var day = DateOnly.FromDayNumber(number);
            var effective = history.SettingsOn(day);
            byDay.TryGetValue(day, out var row);
            var scheduled = row is not null || (effective.IsScheduled(day) && history.StatusOn(day) == "active");
            var state = !scheduled ? "unscheduled" : row?.Completed == true ? "completed" : row?.Quantity is > 0 ? "partial" : day >= today ? "scheduled" : "missed";
            result.Add(new(day, scheduled, state, effective.Target, effective.Unit, row?.Quantity, row?.Completed == true));
        }
        return result;
    }

    private static HabitProgress BuildProgress(List<HabitOccurrence> occurrences, List<HabitOccurrence> lifetime, DateOnly today)
    {
        var planned = occurrences.Count(row => row.Scheduled && (row.Date < today || row.Completed));
        var completed = occurrences.Count(row => row.Scheduled && row.Completed);
        var current = 0;
        var best = 0;
        foreach (var row in lifetime)
        {
            if (!row.Scheduled || row.Date > today || (row.Date == today && !row.Completed))
            {
                continue;
            }
            current = row.Completed ? current + 1 : 0;
            best = Math.Max(best, current);
        }
        return new(current, best, planned, completed, planned == 0 ? 0 : (decimal)completed / planned, occurrences.Sum(row => row.Quantity ?? 0));
    }

    private static List<HabitMonthSummary> BuildMonths(List<HabitOccurrence> occurrences) => occurrences.GroupBy(row => row.Date.ToString("yyyy-MM", CultureInfo.InvariantCulture)).OrderBy(group => group.Key).Select(group => new HabitMonthSummary(group.Key, group.Count(row => row.Scheduled), group.Count(row => row.Scheduled && row.Completed), group.Sum(row => row.Quantity ?? 0))).ToList();

    private static Result<T> Failure<T>(string code, string message) => Result.Failure<T>(new NixError($"habits.{code}", message));
    private static Result<T> NotFound<T>() => Result.Failure<T>(ItemErrors.NotFound("No such habit is visible and accessible."));
    private static string ReadStatus(string? properties)
    {
        try
        {
            var bag = JsonNode.Parse(properties ?? "{}") as JsonObject;
            var value = bag?[StatusKey]?.GetValue<string>();
            return value is "paused" or "archived" ? value : "active";
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or FormatException)
        {
            return "active";
        }
    }
}
