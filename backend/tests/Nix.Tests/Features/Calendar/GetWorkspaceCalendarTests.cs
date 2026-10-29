using System.Collections.Immutable;
using Nix.Abstractions;
using Nix.Domain.Calendar;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Recurrence;
using Nix.Domain.Tenancy;
using Nix.Features.Calendar;

namespace Nix.Tests.Features.Calendar;

/// <summary>
/// The calendar handler's second job: drawing repeating items alongside concrete ones, and saying
/// honestly what it left out.
/// </summary>
/// <remarks>
/// <para>
/// The concrete read and the permission gate are exercised by <c>GetWorkspaceGraphTests</c>'s
/// sibling assertions on the graph handler and by the integration suite's authorization tests
/// against real Postgres; what is worth pinning here, free of any database, is the merge itself -
/// the order rows come back in, which candidates get drawn versus reported unplaceable and why,
/// and the two truncation flags, which answer different questions and must be able to disagree.
/// </para>
/// </remarks>
public sealed class GetWorkspaceCalendarTests
{
    private static readonly WorkspaceId Readable = WorkspaceId.From(new Guid("11111111-1111-4111-8111-111111111111"));
    private static readonly DateOnly WindowStart = new(2026, 3, 1);

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Generated_occurrences_and_concrete_entries_merge_into_one_day_ordered_list()
    {
        var concrete = new WorkspaceCalendar(
            [
                Entry("concrete-1", "2026-03-01"),
                Entry("concrete-2", "2026-03-03"),
            ],
            []);

        // Every second day from 03-02: 03-02, 03-04 - neither falls on a concrete entry's day, so
        // this test isolates day-ordering from the tie-break the next test covers.
        var candidate = Candidate("series", new DateOnly(2026, 3, 2), RecurrenceFrequency.Daily, interval: 2);

        var handler = Handler(concrete, [candidate]);

        var result = await handler.HandleAsync(Query(), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(
            ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04"],
            result.Value.Entries.Select(row => row.Entry.Value));
        Assert.Equal(
            [false, true, false, true],
            result.Value.Entries.Select(row => row.Generated));
        Assert.Equal(
            ["concrete-1", "concrete-2"],
            result.Value.Entries.Where(row => !row.Generated).Select(row => row.Entry.Title));
    }

    [Fact]
    public async Task A_concrete_entry_and_a_generated_occurrence_on_the_same_day_keep_the_concrete_one_first()
    {
        var concrete = new WorkspaceCalendar([Entry("concrete", "2026-03-01")], []);
        var candidate = Candidate("series", WindowStart, RecurrenceFrequency.Daily);

        var handler = Handler(concrete, [candidate]);

        var result = await handler.HandleAsync(new GetWorkspaceCalendar(Readable, "2026-03-01", "2026-03-01"), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(2, result.Value.Entries.Count);
        Assert.Equal(["2026-03-01", "2026-03-01"], result.Value.Entries.Select(row => row.Entry.Value));

        // The same window has to cut the same rows twice, so a day two sources share cannot break
        // the tie by whichever one happened to be generated first - it is the concrete entry,
        // read before any series is expanded, that "arrived" first.
        Assert.False(result.Value.Entries[0].Generated);
        Assert.True(result.Value.Entries[1].Generated);
    }

    [Fact]
    public async Task A_candidate_whose_container_places_by_something_other_than_due_date_is_unplaceable()
    {
        var candidate = Candidate("series", WindowStart, RecurrenceFrequency.Daily) with
        {
            DateProperty = "start_date",
        };

        var handler = Handler(WorkspaceCalendar.Empty, [candidate]);

        var result = await handler.HandleAsync(Query(), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Empty(result.Value.Entries);
        var unplaceable = Assert.Single(result.Value.UnplaceableCandidates);
        Assert.Equal("calendar_not_by_due_date", unplaceable.Reason);
        Assert.Equal(candidate.ItemId, unplaceable.Candidate.ItemId);
    }

    [Fact]
    public async Task A_candidate_with_no_value_on_the_due_date_axis_is_unplaceable_as_no_due_date()
    {
        var candidate = Candidate("series", WindowStart, RecurrenceFrequency.Daily) with
        {
            Anchor = null,
        };

        var handler = Handler(WorkspaceCalendar.Empty, [candidate]);

        var result = await handler.HandleAsync(Query(), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Empty(result.Value.Entries);
        var unplaceable = Assert.Single(result.Value.UnplaceableCandidates);
        Assert.Equal("no_due_date", unplaceable.Reason);
    }

    [Fact]
    public async Task A_candidate_whose_rule_this_build_could_not_read_is_unplaceable_as_unreadable_rule()
    {
        var candidate = Candidate("series", WindowStart, RecurrenceFrequency.Daily) with
        {
            Rule = null,
        };

        var handler = Handler(WorkspaceCalendar.Empty, [candidate]);

        var result = await handler.HandleAsync(Query(), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Empty(result.Value.Entries);
        var unplaceable = Assert.Single(result.Value.UnplaceableCandidates);
        Assert.Equal("unreadable_rule", unplaceable.Reason);
    }

    [Fact]
    public async Task Reaching_the_entry_ceiling_reports_entries_truncated_but_not_series_truncated()
    {
        var entries = new List<CalendarEntry>(GetWorkspaceCalendarHandler.MaximumEntries);
        for (var index = 0; index < GetWorkspaceCalendarHandler.MaximumEntries; index++)
        {
            entries.Add(Entry($"entry-{index}", "2026-03-01"));
        }

        var handler = Handler(new WorkspaceCalendar(entries, []), []);

        var result = await handler.HandleAsync(Query(), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.True(result.Value.EntriesTruncated);
        Assert.False(result.Value.SeriesTruncated);
    }

    [Fact]
    public async Task Reaching_the_candidate_ceiling_reports_series_truncated_but_not_entries_truncated()
    {
        var candidates = new List<RecurringItem>(GetWorkspaceCalendarHandler.MaximumRecurringItems);
        for (var index = 0; index < GetWorkspaceCalendarHandler.MaximumRecurringItems; index++)
        {
            // Not by due_date, so none of them consume the entry ceiling either - the point is to
            // isolate the candidate ceiling from the entry one.
            candidates.Add(Candidate($"series-{index}", WindowStart, RecurrenceFrequency.Daily) with
            {
                DateProperty = "start_date",
            });
        }

        var handler = Handler(WorkspaceCalendar.Empty, candidates);

        var result = await handler.HandleAsync(Query(), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.False(result.Value.EntriesTruncated);
        Assert.True(result.Value.SeriesTruncated);
    }

    [Fact]
    public async Task A_full_concrete_read_leaves_a_zero_ceiling_and_still_reports_series_truncated()
    {
        // The subtle case the merge's own docs warn about: the entry ceiling is fully spent by
        // concrete rows before any rule is expanded, so the recurrence merge gets a ceiling of
        // zero. A series that would have produced an occurrence in the window still has to be
        // reported as more series existing than this response drew - seriesTruncated must not
        // quietly read as false just because the entries ceiling, not the candidate ceiling, is
        // what was hit.
        var entries = new List<CalendarEntry>(GetWorkspaceCalendarHandler.MaximumEntries);
        for (var index = 0; index < GetWorkspaceCalendarHandler.MaximumEntries; index++)
        {
            entries.Add(Entry($"entry-{index}", "2026-03-01"));
        }

        var candidate = Candidate("series", WindowStart, RecurrenceFrequency.Daily);

        var handler = Handler(new WorkspaceCalendar(entries, []), [candidate]);

        var result = await handler.HandleAsync(Query(), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(GetWorkspaceCalendarHandler.MaximumEntries, result.Value.Entries.Count);
        Assert.True(result.Value.EntriesTruncated);
        Assert.True(result.Value.SeriesTruncated);
    }

    [Fact]
    public async Task A_generated_occurrences_completion_state_rides_through_from_its_rule()
    {
        var candidate = Candidate("series", WindowStart, RecurrenceFrequency.Daily) with
        {
            Rule = new RecurrenceRule(
                RecurrenceFrequency.Daily,
                Interval: 1,
                Weekdays: [],
                Until: null,
                CompletedThrough: WindowStart,
                Completed: [WindowStart.AddDays(2)]),
        };

        var handler = Handler(WorkspaceCalendar.Empty, [candidate]);

        var result = await handler.HandleAsync(Query(), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(
            ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04"],
            result.Value.Entries.Select(row => row.Entry.Value));

        // At or below the watermark (03-01), and the one exception (03-03), are complete; the
        // rest are not. A concrete entry never carries this - only these rows, which have none,
        // could.
        Assert.Equal(
            [true, false, true, false],
            result.Value.Entries.Select(row => row.Completed));
        Assert.All(result.Value.Entries, row => Assert.True(row.Generated));
    }

    private static GetWorkspaceCalendar Query() =>
        new(Readable, "2026-03-01", "2026-03-04");

    private static GetWorkspaceCalendarHandler Handler(
        WorkspaceCalendar calendar,
        IReadOnlyList<RecurringItem> candidates) =>
        new(
            new FakeWorkspaceCalendar(calendar),
            new FakeRecurrenceCandidates(candidates),
            new StubPermissions([Readable]));

    private static CalendarEntry Entry(string title, string value) =>
        new(
            ItemId.From(Guid.NewGuid()),
            title,
            ItemId.From(Guid.NewGuid()),
            "container",
            "due_date",
            value);

    private static RecurringItem Candidate(
        string title,
        DateOnly anchor,
        RecurrenceFrequency frequency,
        int interval = 1) =>
        new(
            ItemId.From(Guid.NewGuid()),
            title,
            ItemId.From(Guid.NewGuid()),
            "container",
            "due_date",
            anchor,
            new RecurrenceRule(
                frequency,
                interval,
                Weekdays: ImmutableArray<IsoDayOfWeek>.Empty,
                Until: null,
                CompletedThrough: null,
                Completed: ImmutableArray<DateOnly>.Empty));

    /// <summary>Answers with a fixed readable set, the way the resolver does for one principal.</summary>
    private sealed class StubPermissions : IPermissionResolver
    {
        private readonly IReadOnlyList<WorkspaceId> _readable;

        internal StubPermissions(IReadOnlyList<WorkspaceId> readable) => _readable = readable;

        public ValueTask<bool> CanReadWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(_readable.Contains(workspaceId));

        public ValueTask<bool> CanWriteWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(_readable.Contains(workspaceId));

        public ValueTask<bool> CanCommentWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(false);


        public ValueTask<bool> CanManageWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(false);

        public ValueTask<IReadOnlyList<WorkspaceId>> ReadableWorkspacesAsync(CancellationToken cancellationToken) =>
            ValueTask.FromResult(_readable);

        public ValueTask<bool> IsTenantAdministratorAsync(CancellationToken cancellationToken) =>
            ValueTask.FromResult(false);
    }

    /// <summary>A reader that answers with a prepared calendar, ignoring what it was asked.</summary>
    /// <remarks>
    /// A fake for an I/O port, the sanctioned reason to write one. The handler's relationship with
    /// the permission resolver is covered on the graph handler, whose reader and query are the same
    /// shape as this one's - what is specific to the calendar is the merge, which is what these
    /// tests exercise instead.
    /// </remarks>
    private sealed class FakeWorkspaceCalendar : IWorkspaceCalendar
    {
        private readonly WorkspaceCalendar _calendar;

        internal FakeWorkspaceCalendar(WorkspaceCalendar calendar) => _calendar = calendar;

        public ValueTask<WorkspaceCalendar> ReadAsync(
            WorkspaceId workspaceId,
            IReadOnlyList<WorkspaceId> readableWorkspaces,
            string firstDay,
            string lastDay,
            int entryLimit,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult(_calendar);
    }

    /// <summary>A reader that answers with a prepared set of candidates, ignoring what it was asked.</summary>
    private sealed class FakeRecurrenceCandidates : IRecurrenceCandidates
    {
        private readonly IReadOnlyList<RecurringItem> _candidates;

        internal FakeRecurrenceCandidates(IReadOnlyList<RecurringItem> candidates) => _candidates = candidates;

        public ValueTask<IReadOnlyList<RecurringItem>> ReadAsync(
            WorkspaceId workspaceId,
            IReadOnlyList<WorkspaceId> readableWorkspaces,
            string firstDay,
            string lastDay,
            int candidateLimit,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult(_candidates);
    }
}
