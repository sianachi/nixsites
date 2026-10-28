using System.Globalization;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Calendar;
using Nix.Domain.Primitives;
using Nix.Domain.Recurrence;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Features.Calendar;

/// <summary>Reads every calendar in a workspace as one set of dated entries.</summary>
/// <param name="WorkspaceId">The workspace to read.</param>
/// <param name="From">The first day to include, as <c>yyyy-MM-dd</c>.</param>
/// <param name="To">The last day to include, as <c>yyyy-MM-dd</c>.</param>
public sealed record GetWorkspaceCalendar(WorkspaceId WorkspaceId, string From, string To)
    : IQuery<Result<WorkspaceCalendarResults>>;

/// <summary>One row on a merged calendar: a stored item, or an occurrence a rule produced.</summary>
/// <param name="Entry">The dated entry: who, which container, which property, and its value.</param>
/// <param name="Generated">
/// Whether a recurrence rule produced this row rather than it being read from storage.
/// </param>
/// <param name="Completed">
/// The occurrence's completion state when <paramref name="Generated"/> is <see langword="true"/>;
/// <see langword="null"/> for a concrete entry, which carries no completion state of its own.
/// </param>
public sealed record CalendarRow(CalendarEntry Entry, bool Generated, bool? Completed);

/// <summary>A repeating item a recurrence read found, that this calendar could not draw.</summary>
/// <param name="Candidate">The repeating item.</param>
/// <param name="Reason">
/// The stable token naming why it could not be placed: <c>calendar_not_by_due_date</c>,
/// <c>no_due_date</c>, or <c>unreadable_rule</c>. The wire-facing tokens live on the internal
/// <c>CalendarMapping</c>, which is what assigns this value; declared here as a plain
/// <see langword="string"/>, not a reference to that type, because this record is public and
/// <c>CalendarMapping</c> is not.
/// </param>
public sealed record UnplaceableCandidate(RecurringItem Candidate, string Reason);

/// <summary>What a calendar read found, and the ceilings it was read under.</summary>
/// <param name="Entries">
/// The dated rows, concrete and rule-generated together, in one merged order.
/// </param>
/// <param name="UnplaceableContainers">
/// The containers that offer a calendar but named no property to place children by.
/// </param>
/// <param name="UnplaceableCandidates">
/// The repeating items a recurrence read found but could not draw, and why - kept apart from
/// <paramref name="UnplaceableContainers"/> because the two answer different questions: one names
/// a container with no axis, the other an item whose series cannot ride the axis it has.
/// </param>
/// <param name="EntryLimit">The entry ceiling that was applied.</param>
/// <param name="SeriesTruncated">
/// Whether the candidate read hit <see cref="GetWorkspaceCalendarHandler.MaximumRecurringItems"/>,
/// or the merge stopped before every drawable series had been expanded. Kept apart from
/// <see cref="EntriesTruncated"/> on purpose: "there are more entries than were returned" and
/// "there are more series than were considered" are different facts, and a reader who wants to see
/// a specific series acts on the second one, not the first.
/// </param>
public sealed record WorkspaceCalendarResults(
    IReadOnlyList<CalendarRow> Entries,
    IReadOnlyList<UnplaceableCalendar> UnplaceableContainers,
    IReadOnlyList<UnplaceableCandidate> UnplaceableCandidates,
    int EntryLimit,
    bool SeriesTruncated)
{
    /// <summary>Whether the entry ceiling was reached.</summary>
    public bool EntriesTruncated => Entries.Count >= EntryLimit;
}

/// <summary>
/// Collates every calendar view in a workspace into one set of dated items.
/// </summary>
/// <remarks>
/// <para>
/// <b>One permission answer, used twice, and the second use is the one that matters.</b> The caller
/// must be able to read the workspace they named - otherwise this answers "an empty calendar",
/// which for a workspace identifier they guessed is still a statement about a workspace they may
/// not see. And the readable set goes on into the query, so the rows are filtered while they are
/// being chosen rather than after they have been read. Both come from one call, so the gate and the
/// filter cannot drift apart. The same shape <c>GetWorkspaceGraphHandler</c> uses, deliberately.
/// </para>
/// <para>
/// A workspace the caller may not read is reported as not found, matching every other read in the
/// product. "You may not see this" confirms the thing exists.
/// </para>
/// <para>
/// <b>Which property is a date is decided by the data, not by the caller.</b> A container's calendar
/// view names the property it places its children by, and different containers may name different
/// ones. There is no parameter to override that: a caller who could choose the property could ask
/// this endpoint to project any field of every item in the workspace, which is a different and much
/// larger disclosure than a calendar.
/// </para>
/// </remarks>
public sealed class GetWorkspaceCalendarHandler(
    IWorkspaceCalendar calendar,
    IRecurrenceCandidates recurrence,
    IPermissionResolver permissions)
    : IQueryHandler<GetWorkspaceCalendar, Result<WorkspaceCalendarResults>>
{
    /// <summary>
    /// The most entries one calendar read may return.
    /// </summary>
    /// <remarks>
    /// Two thousand, chosen against what a calendar can honestly show rather than what the database
    /// can return. A month grid holding two thousand entries is already sixty-five a day, well past
    /// the point where a cell shows a count instead of its contents - so a higher ceiling would buy
    /// a slower response nobody can read. It also bounds the payload: two thousand entries of
    /// identifier, title, container and value is a few hundred kilobytes of JSON, and the lists
    /// behind them stay inside the per-request allocation budget.
    /// </remarks>
    public const int MaximumEntries = 2_000;

    /// <summary>The widest window one read may ask for, in days.</summary>
    /// <remarks>
    /// A little over a year, so the ordinary asks - a month, a week, a day, or a year at a glance -
    /// all fit and an unbounded range does not. Without it a client could ask for every date the
    /// calendar supports and turn a windowed read back into a whole-workspace one, which is the
    /// thing the window exists to prevent.
    /// </remarks>
    public const int MaximumWindowDays = 400;

    /// <summary>
    /// The most repeating series one calendar read considers before any of them is expanded.
    /// </summary>
    /// <remarks>
    /// A ceiling on how many <em>series</em> are read, which is a different fact from
    /// <see cref="MaximumEntries"/>, the ceiling on how many <em>entries</em> come back. A
    /// workspace can hold many series that each contribute at most one occurrence to a short
    /// window, or a handful that each contribute hundreds - so the search for repeating items has
    /// to be bounded on its own axis, or a busy calendar could make finding the candidates the
    /// expensive part of the read even when almost none of them end up drawn.
    /// </remarks>
    public const int MaximumRecurringItems = 500;

    /// <summary>
    /// The reserved property key a series' anchor is always read from.
    /// </summary>
    /// <remarks>
    /// A series repeats from the day it is due, not from whatever property a container's calendar
    /// happens to place by - <see cref="RecurringItem"/>'s own docs say why. A candidate whose
    /// container places by a different key is therefore reported as unplaceable rather than drawn
    /// on an axis nobody asked for.
    /// </remarks>
    private const string DueDateProperty = "due_date";

    private readonly IWorkspaceCalendar _calendar = calendar;
    private readonly IRecurrenceCandidates _recurrence = recurrence;

    /// <summary>Reads the calendar.</summary>
    /// <param name="query">The workspace and the window.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The calendar, or why it could not be read.</returns>
    public async ValueTask<Result<WorkspaceCalendarResults>> HandleAsync(
        GetWorkspaceCalendar query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        if (!TryReadWindow(query.From, query.To, out var from, out var to, out var problem))
        {
            return Result.Failure<WorkspaceCalendarResults>(
                CalendarErrors.InvalidWindow(problem));
        }

        var workspaces = await permissions
            .ReadableWorkspacesAsync(cancellationToken)
            .ConfigureAwait(false);

        if (!workspaces.Contains(query.WorkspaceId))
        {
            return Result.Failure<WorkspaceCalendarResults>(
                CalendarErrors.WorkspaceNotFound($"No workspace {query.WorkspaceId} is visible."));
        }

        var calendar = await _calendar
            .ReadAsync(query.WorkspaceId, workspaces, query.From, query.To, MaximumEntries, cancellationToken)
            .ConfigureAwait(false);

        var candidates = await _recurrence
            .ReadAsync(query.WorkspaceId, workspaces, query.From, query.To, MaximumRecurringItems, cancellationToken)
            .ConfigureAwait(false);

        var candidateCeilingReached = candidates.Count >= MaximumRecurringItems;

        // A candidate is drawable only when it repeats from the item's own due_date - the axis
        // this calendar's occurrences are anchored to - and this build could read both a value on
        // that axis and the rule itself. Anything else is reported as unplaceable, with the reason
        // that is specifically true of it, rather than silently dropped or drawn on an axis nobody
        // asked for.
        var drawable = new List<RecurringItem>(candidates.Count);
        var unplaceableCandidates = new List<UnplaceableCandidate>();

        foreach (var candidate in candidates)
        {
            if (!string.Equals(candidate.DateProperty, DueDateProperty, StringComparison.Ordinal))
            {
                unplaceableCandidates.Add(new UnplaceableCandidate(candidate, CalendarMapping.NotByDueDateReason));
            }
            else if (candidate.Anchor is null)
            {
                unplaceableCandidates.Add(new UnplaceableCandidate(candidate, CalendarMapping.NoDueDateReason));
            }
            else if (candidate.Rule is null)
            {
                unplaceableCandidates.Add(new UnplaceableCandidate(candidate, CalendarMapping.UnreadableRuleReason));
            }
            else
            {
                drawable.Add(candidate);
            }
        }

        // The concrete read already spent up to MaximumEntries; whatever it did not spend is what
        // the merge may fill with generated occurrences. RecurrenceMerge's own remarks explain why
        // this ordering - concrete first, then the remaining ceiling - loses nothing from the union.
        var ceiling = Math.Max(0, MaximumEntries - calendar.Entries.Count);
        var merge = RecurrenceMerge.Expand(drawable, from, to, ceiling);

        var entries = MergeEntries(calendar.Entries, merge.Occurrences);
        var seriesTruncated = candidateCeilingReached || merge.Truncated;

        return Result.Success(new WorkspaceCalendarResults(
            entries,
            calendar.Unplaceable,
            unplaceableCandidates,
            MaximumEntries,
            seriesTruncated));
    }

    /// <summary>
    /// Merges the concrete entries and the generated occurrences into one list, ordered by value
    /// then by the order they arrived.
    /// </summary>
    /// <param name="concrete">The stored entries, earliest first.</param>
    /// <param name="generated">The generated occurrences, earliest first.</param>
    /// <returns>The two, interleaved by day.</returns>
    /// <remarks>
    /// <para>
    /// Both inputs already arrive sorted ascending by value, so this is a merge, not a sort - the
    /// same shape <see cref="RecurrenceMerge"/> itself uses to combine many series. A plain sort
    /// over the concatenation would cost more for the same answer and would not, on its own, fix
    /// the tie order below.
    /// </para>
    /// <para>
    /// <b>Ties favour the concrete entry.</b> When a stored entry and a generated occurrence land
    /// on the same value, the stored one is placed first - it is the caller's own data, read
    /// before any series is expanded, so it is the one that "arrived" first. This is deterministic
    /// regardless of how many series a workspace holds, which is what "the same window cuts the
    /// same rows twice" requires.
    /// </para>
    /// </remarks>
    private static List<CalendarRow> MergeEntries(
        IReadOnlyList<CalendarEntry> concrete,
        IReadOnlyList<GeneratedOccurrence> generated)
    {
        var merged = new List<CalendarRow>(concrete.Count + generated.Count);
        var concreteIndex = 0;
        var generatedIndex = 0;

        while (concreteIndex < concrete.Count && generatedIndex < generated.Count)
        {
            if (string.CompareOrdinal(concrete[concreteIndex].Value, generated[generatedIndex].Entry.Value) <= 0)
            {
                merged.Add(new CalendarRow(concrete[concreteIndex], Generated: false, Completed: null));
                concreteIndex++;
            }
            else
            {
                var occurrence = generated[generatedIndex];
                merged.Add(new CalendarRow(occurrence.Entry, Generated: true, occurrence.Completed));
                generatedIndex++;
            }
        }

        while (concreteIndex < concrete.Count)
        {
            merged.Add(new CalendarRow(concrete[concreteIndex], Generated: false, Completed: null));
            concreteIndex++;
        }

        while (generatedIndex < generated.Count)
        {
            var occurrence = generated[generatedIndex];
            merged.Add(new CalendarRow(occurrence.Entry, Generated: true, occurrence.Completed));
            generatedIndex++;
        }

        return merged;
    }

    /// <summary>
    /// Whether the window is two real dates in the right order and inside the width bound.
    /// </summary>
    /// <param name="from">The first day.</param>
    /// <param name="to">The last day.</param>
    /// <param name="first">The first day, parsed, when the window may be used.</param>
    /// <param name="last">The last day, parsed, when the window may be used.</param>
    /// <param name="problem">Why it was refused, when it was.</param>
    /// <returns><see langword="true"/> when the window may be used.</returns>
    /// <remarks>
    /// <para>
    /// Parsed here rather than trusted, even though the values reach the statement as text and are
    /// only ever compared as text. Two reasons, and neither is injection - the parameter is bound.
    /// The first is that <c>2026-13-45</c> compares perfectly well as a string and would silently
    /// return nothing, which a reader would read as "nothing is scheduled". The second is that the
    /// width bound cannot be checked without knowing what the two values mean.
    /// </para>
    /// <para>
    /// <see cref="DateOnly.TryParseExact(string, string, out DateOnly)"/> with an exact format, so
    /// <c>2026-3-1</c> is refused rather than accepted and then compared against stored values that
    /// are always zero-padded - which would match nothing and look like an empty month.
    /// </para>
    /// <para>
    /// The parsed days are handed back rather than reparsed by the caller, because the recurrence
    /// merge needs them as <see cref="DateOnly"/> too - one parse, used twice, so the two cannot
    /// disagree about what the window means.
    /// </para>
    /// </remarks>
    private static bool TryReadWindow(string from, string to, out DateOnly first, out DateOnly last, out string problem)
    {
        if (!DateOnly.TryParseExact(from, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out first))
        {
            last = default;
            problem = $"'{from}' is not a date. Windows are given as yyyy-MM-dd.";
            return false;
        }

        if (!DateOnly.TryParseExact(to, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out last))
        {
            problem = $"'{to}' is not a date. Windows are given as yyyy-MM-dd.";
            return false;
        }

        if (last < first)
        {
            problem = $"The window ends ({to}) before it begins ({from}).";
            return false;
        }

        var days = last.DayNumber - first.DayNumber + 1;
        if (days > MaximumWindowDays)
        {
            problem =
                $"The window covers {days.ToString(CultureInfo.InvariantCulture)} days, and the "
                + $"most one read may cover is {MaximumWindowDays.ToString(CultureInfo.InvariantCulture)}.";
            return false;
        }

        problem = string.Empty;
        return true;
    }
}

/// <summary>
/// Route handler for reading a workspace's collated calendar.
/// </summary>
internal static class GetWorkspaceCalendarEndpoint
{
    /// <summary>Handles a calendar request.</summary>
    /// <param name="workspaceId">The workspace to read.</param>
    /// <param name="from">The first day of the window.</param>
    /// <param name="to">The last day of the window.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the query to its handler.</param>
    /// <returns>The calendar.</returns>
    internal static async Task<Results<Ok<WorkspaceCalendarResponse>, ProblemHttpResult>> Handle(
        Guid workspaceId,
        string? from,
        string? to,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        // Absent is not the same as malformed, and both are the caller's mistake rather than ours.
        // Defaulting to "this month" would be a server guessing at a question, and a client that
        // forgot the parameter would get a plausible answer to something it did not ask.
        if (string.IsNullOrEmpty(from) || string.IsNullOrEmpty(to))
        {
            return TypedResults.Problem(CalendarEndpoints.Problem(
                httpContext,
                CalendarErrors.InvalidWindow("Both 'from' and 'to' are required, as yyyy-MM-dd.")));
        }

        var result = await dispatcher
            .QueryAsync<GetWorkspaceCalendar, Result<WorkspaceCalendarResults>>(
                new GetWorkspaceCalendar(WorkspaceId.From(workspaceId), from, to),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        if (result.IsFailure)
        {
            return TypedResults.Problem(CalendarEndpoints.Problem(httpContext, result.Error));
        }

        var found = result.Value;
        return TypedResults.Ok(new WorkspaceCalendarResponse(
            workspaceId,
            from,
            to,
            CalendarMapping.ToEntryResponses(found.Entries),
            CalendarMapping.ToUnplaceableResponses(found.UnplaceableContainers, found.UnplaceableCandidates),
            found.EntryLimit,
            found.EntriesTruncated,
            found.SeriesTruncated));
    }
}
