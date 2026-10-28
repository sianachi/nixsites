using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Domain.Habits;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Recurrence;
using Nix.Domain.Tenancy;
using Nix.Features.Habits;
using Nix.Features.Items;
using Nix.Features.Query;
using Nix.Messaging;
using NodaTime;

namespace Nix.Features.MyDay;

/// <summary>Reads what the caller should do today in one workspace.</summary>
/// <param name="WorkspaceId">The workspace.</param>
public sealed record GetMyDay(WorkspaceId WorkspaceId) : IQuery<Result<MyDayResponse>>;

/// <summary>
/// Projects a workspace's tasks and habits onto the caller's day, without owning either.
/// </summary>
/// <remarks>
/// <para>
/// <b>A read over original items, and nothing else.</b> No row is stored or copied; each names the
/// item and the existing command that finishes it. The workspace-query machinery finds candidates
/// (<see cref="IMyDayCandidates"/>), the effective schema decides which are tasks, the recurrence
/// domain decides which occurrence is open, and <see cref="ReadHabitTracker"/> decides each habit's
/// day. This handler only joins those answers.
/// </para>
/// <para>
/// <b>Completeness is part of the answer.</b> Every ceiling and every item the read could not judge
/// is a coverage reason, so a caller never reads "nothing here" off a prefix. A database failure
/// fails the whole read: a section cannot be reported complete after a statement was aborted.
/// </para>
/// <para>
/// <b>Repeating tasks show only today's open occurrence.</b> Earlier missed occurrences are not an
/// overdue backlog here, because no recurrence history window is defined for one.
/// </para>
/// </remarks>
public sealed class GetMyDayHandler(
    IItemTree tree,
    IPermissionResolver permissions,
    INixSessionContextAccessor session,
    IPrincipalPreferencesStore preferences,
    IMyDayCandidates candidates,
    ISchemaResolver schemas,
    NixDispatcher dispatcher,
    QueryConcurrencyLimiter concurrency,
    TimeProvider clock)
    : IQueryHandler<GetMyDay, Result<MyDayResponse>>
{
    /// <summary>The most task candidates one read considers.</summary>
    public const int TaskCandidateLimit = 200;

    /// <summary>The most task rows one read returns.</summary>
    public const int TaskRowLimit = 100;

    /// <summary>The most habits one read considers, and so the most it returns.</summary>
    /// <remarks>
    /// Small because each habit runs the habit reader, which loads its bounded history. Measure
    /// before raising it.
    /// </remarks>
    public const int HabitLimit = 24;

    private const string Today = "today";
    private const string Overdue = "overdue";
    private const string Assigned = "assigned";

    private static readonly string CompletionKey = PropertyTypes.ToText(PropertyType.Completion);
    private static readonly string DueKey = PropertyTypes.ToText(PropertyType.DueDate);
    private static readonly string StartKey = PropertyTypes.ToText(PropertyType.StartDate);
    private static readonly string AssigneeKey = PropertyTypes.ToText(PropertyType.Assignee);
    private static readonly string PriorityKey = PropertyTypes.ToText(PropertyType.Priority);
    private static readonly string EstimateKey = PropertyTypes.ToText(PropertyType.Estimate);

    private readonly INixSessionContextAccessor _session = session;
    private readonly IMyDayCandidates _candidates = candidates;

    /// <summary>Reads the day.</summary>
    /// <param name="query">The workspace.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The day, or why it could not be read.</returns>
    public async ValueTask<Result<MyDayResponse>> HandleAsync(GetMyDay query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        var caller = _session.Current
            ?? throw new InvalidOperationException(
                "No session context has been established for this unit of work. My Day is read for "
                + "an acting principal; there is no anonymous path.");

        // Missing and unreadable answer alike, so the route cannot confirm a workspace exists.
        if (!await tree.WorkspaceExistsAsync(query.WorkspaceId, cancellationToken).ConfigureAwait(false)
            || !await permissions.CanReadWorkspaceAsync(query.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<MyDayResponse>(
                ItemErrors.WorkspaceNotFound($"No workspace {query.WorkspaceId} is visible."));
        }

        using var lease = concurrency.TryEnter(caller.PrincipalId);
        if (lease is null)
        {
            return Result.Failure<MyDayResponse>(QueryErrors.TooManyInFlight(
                $"At most {QueryConcurrencyLimiter.MaximumInFlight} queries may run at once for one person; wait for one to finish."));
        }

        var now = clock.GetUtcNow();
        var zone = await ZoneAsync(caller, cancellationToken).ConfigureAwait(false);
        var date = Instant.FromDateTimeOffset(now).InZone(zone).Date;
        var day = new DateOnly(date.Year, date.Month, date.Day);

        MyDayCandidates found;
        try
        {
            found = await _candidates
                .ReadAsync(query.WorkspaceId, caller.PrincipalId, day, TaskCandidateLimit, HabitLimit, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (ItemQueryFailedException failure)
        {
            return Result.Failure<MyDayResponse>(QueryErrors.From(failure));
        }

        var tasks = await ProjectTasksAsync(found.Tasks, day, caller.PrincipalId.ToString(), cancellationToken).ConfigureAwait(false);
        var habits = await ProjectHabitsAsync(found.Habits, now, cancellationToken).ConfigureAwait(false);

        return Result.Success(new MyDayResponse(query.WorkspaceId.Value, now, day, zone.Id, tasks, habits));
    }

    private async ValueTask<DateTimeZone> ZoneAsync(NixSessionContext caller, CancellationToken cancellationToken)
    {
        var stored = await preferences.FindAsync(caller.TenantId, caller.PrincipalId, cancellationToken).ConfigureAwait(false);
        return stored?.TimeZone is { Length: > 0 } name && DateTimeZoneProviders.Tzdb.GetZoneOrNull(name) is { } zone
            ? zone
            : DateTimeZone.Utc;
    }

    private async ValueTask<MyDayTaskSection> ProjectTasksAsync(
        MyDayBatch batch,
        DateOnly day,
        string me,
        CancellationToken cancellationToken)
    {
        var rows = new List<(MyDayTaskRow Row, int Rank)>();
        var reasons = new Reasons();
        reasons.CapIf(batch.Truncated, "candidate_limit");

        foreach (var candidate in batch.Rows)
        {
            var schema = await schemas.ResolveForItemAsync(candidate.Id, cancellationToken).ConfigureAwait(false);

            // Task identity is the schema's Completion field, never a body type or a lookalike key.
            if (schema.Find(CompletionKey) is not { Type: PropertyType.Completion })
            {
                continue;
            }

            if (JsonObjectOrNull(candidate.PropertiesJson) is not { } bag)
            {
                reasons.Add("invalid_properties");
                continue;
            }

            var hasDue = schema.Find(DueKey) is { Type: PropertyType.DueDate };
            var hasStart = schema.Find(StartKey) is { Type: PropertyType.StartDate };
            var hasAssignee = schema.Find(AssigneeKey) is { Type: PropertyType.Assignee };

            if (!TryReadDay(bag, DueKey, hasDue, out var due) || !TryReadDay(bag, StartKey, hasStart, out var start))
            {
                reasons.Add("invalid_properties");
                continue;
            }

            if (start > day)
            {
                continue;
            }

            string section;
            MyDayTaskAction action;

            if (candidate.RecurrenceJson is not null)
            {
                // A series anchors on the stored due day whatever the schema declares, as
                // setting and completing a recurrence do.
                var rule = RecurrenceRuleJson.Read(candidate.RecurrenceJson);
                if (rule is null || !TryReadDay(bag, DueKey, true, out var stored) || stored is not { } anchor)
                {
                    reasons.Add("invalid_recurrence");
                    continue;
                }

                // The rule's own occurrence state decides, not the series' generic completion flag.
                if (!RecurrenceExpansion.Occurrences(rule, anchor, day, day).Any() || rule.IsCompleted(day))
                {
                    continue;
                }

                section = Today;
                due = day;
                action = new MyDayTaskAction("occurrence", null, day);
            }
            else
            {
                if (bag[CompletionKey] is { } finished)
                {
                    if (finished is not JsonValue flag || !flag.TryGetValue<bool>(out var done))
                    {
                        reasons.Add("invalid_properties");
                        continue;
                    }

                    if (done)
                    {
                        continue;
                    }
                }

                var mine = hasAssignee
                    && bag[AssigneeKey] is JsonValue assignee
                    && assignee.TryGetValue<string>(out var who)
                    && string.Equals(who, me, StringComparison.OrdinalIgnoreCase);

                if (due == day)
                {
                    section = Today;
                }
                else if (due < day)
                {
                    section = Overdue;
                }
                else if (mine)
                {
                    section = Assigned;
                }
                else
                {
                    continue;
                }

                action = new MyDayTaskAction("property", CompletionKey, null);
            }

            rows.Add((new MyDayTaskRow(
                candidate.Id.Value,
                candidate.ContainerId?.Value,
                candidate.ContainerTitle,
                candidate.Title ?? string.Empty,
                section,
                due,
                start,
                ReadNumber<int>(bag, PriorityKey),
                ReadNumber<decimal>(bag, EstimateKey),
                action), SectionRank(section)));
        }

        var ordered = rows
            .OrderBy(entry => entry.Rank)
            .ThenBy(entry => entry.Row.DueDay is null ? 1 : 0)
            .ThenBy(entry => entry.Row.DueDay)
            .ThenBy(entry => entry.Row.ItemId)
            .Select(entry => entry.Row)
            .ToList();

        var omitted = Math.Max(0, ordered.Count - TaskRowLimit);
        reasons.CapIf(omitted > 0, "row_limit", omitted);
        return new MyDayTaskSection(
            ordered.Take(TaskRowLimit).ToList(),
            reasons.ToCoverage(),
            new MyDayLimits(TaskCandidateLimit, TaskRowLimit));
    }

    private async ValueTask<MyDayHabitSection> ProjectHabitsAsync(
        MyDayBatch batch,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var rows = new List<MyDayHabitRow>();
        var reasons = new Reasons();
        reasons.CapIf(batch.Truncated, "candidate_limit");

        // Sequential on purpose: every read shares this request's connection and transaction.
        foreach (var candidate in batch.Rows)
        {
            var settings = HabitSettings.Read(candidate.PropertiesJson);
            if (settings is null)
            {
                reasons.Add("invalid_habit");
                continue;
            }

            // The habit's own local day, which can differ from the task day by up to a day.
            var habitDay = settings.Today(now);
            var read = await dispatcher
                .QueryAsync<ReadHabitTracker, Result<HabitTrackerResponse>>(
                    new ReadHabitTracker(candidate.Id, habitDay, habitDay),
                    cancellationToken)
                .ConfigureAwait(false);

            if (read.IsFailure)
            {
                reasons.Add(read.Error.Code switch
                {
                    "items.locked" => "habit_locked",
                    "habits.history_limit" => "habit_history_limit",
                    _ => "invalid_habit",
                });
                continue;
            }

            var tracker = read.Value;
            var occurrence = tracker.Occurrences?.FirstOrDefault(entry => entry.Date == habitDay);
            if (tracker.Status == "active" && occurrence is { Scheduled: true })
            {
                rows.Add(new MyDayHabitRow(
                    candidate.Id.Value,
                    candidate.ContainerId?.Value,
                    candidate.ContainerTitle,
                    candidate.Title ?? string.Empty,
                    tracker.Timezone,
                    occurrence));
            }
        }

        return new MyDayHabitSection(rows, reasons.ToCoverage(), new MyDayLimits(HabitLimit, HabitLimit));
    }

    private static int SectionRank(string section) => section switch
    {
        Today => 0,
        Overdue => 1,
        _ => 2,
    };

    private static JsonObject? JsonObjectOrNull(string? json)
    {
        try
        {
            return JsonNode.Parse(json ?? "{}") as JsonObject;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// Reads a stored day-valued property as its leading ten characters. Absent, or not declared by the schema,
    /// is fine and yields null; present but unreadable is not.
    /// </summary>
    private static bool TryReadDay(JsonObject bag, string key, bool declared, out DateOnly? day)
    {
        day = null;
        if (!declared || bag[key] is null)
        {
            return true;
        }

        if (bag[key] is JsonValue value
            && value.TryGetValue<string>(out var text)
            && text.Length >= 10
            && DateOnly.TryParseExact(text[..10], "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed))
        {
            day = parsed;
            return true;
        }

        return false;
    }

    private static T? ReadNumber<T>(JsonObject bag, string key)
        where T : struct =>
        bag[key] is JsonValue value && value.TryGetValue<T>(out var number) ? number : null;

    /// <summary>Counts the reasons a section is partial, one entry per code.</summary>
    private sealed class Reasons
    {
        private readonly Dictionary<string, int?> _counts = [];

        public void Add(string code) =>
            _counts[code] = (_counts.GetValueOrDefault(code) ?? 0) + 1;

        public void CapIf(bool reached, string code, int? omitted = null)
        {
            if (reached)
            {
                _counts[code] = omitted;
            }
        }

        public MyDayCoverage ToCoverage() =>
            _counts.Count == 0
                ? new MyDayCoverage("complete", [])
                : new MyDayCoverage("partial", [.. _counts.OrderBy(pair => pair.Key, StringComparer.Ordinal).Select(pair => new MyDayCoverageReason(pair.Key, pair.Value))]);
    }
}
