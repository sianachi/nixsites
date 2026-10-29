using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Notifications;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using Nix.Features.Charts;
using Nix.Tests.Support;

namespace Nix.Tests.Features.Charts;

/// <summary>
/// Which days the chart handler asks the day read for: the reader's own today, the window, and the
/// default end. Rows are proven against real Postgres in <c>Nix.Integration.Tests</c>.
/// </summary>
public sealed class RunItemChartTests
{
    private static readonly ItemId Container = ItemId.From(new Guid("10000000-0000-4000-8000-000000000001"));
    private static readonly WorkspaceId Workspace = WorkspaceId.From(new Guid("20000000-0000-4000-8000-000000000002"));
    private static readonly TenantId Tenant = TenantId.From(new Guid("99999999-9999-4999-8999-999999999999"));
    private static readonly PrincipalId Reader = PrincipalId.From(new Guid("55555555-5555-4555-8555-555555555555"));

    // Sunday 11 October 2026, 20:00 UTC: already Monday 12 October in Tokyo.
    private static readonly DateTimeOffset Now = new(2026, 10, 11, 20, 0, 0, TimeSpan.Zero);

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Theory]
    [InlineData("Asia/Tokyo", "2026-10-12")]
    [InlineData("Europe/London", "2026-10-05")]
    [InlineData(null, "2026-10-05")]
    [InlineData("Not/AZone", "2026-10-05")]
    public async Task The_current_period_is_the_readers_own(string? zone, string expectedWeek)
    {
        var aggregates = new RecordingAggregates();
        var handler = Handler(aggregates, new ChartOptions(ChartKinds.Column, "week", LastPeriods: 1), zone);

        var result = await handler.HandleAsync(new RunItemChart(Container, "chart"), Cancellation);

        Assert.True(result.IsSuccess);
        var expected = DateOnly.Parse(expectedWeek, System.Globalization.CultureInfo.InvariantCulture);
        Assert.Equal(expected, aggregates.FirstDay);
        Assert.Equal(expected.AddDays(6), aggregates.LastDay);
    }

    [Fact]
    public async Task With_no_stored_end_the_axis_reads_up_to_the_end_of_the_current_period()
    {
        // Anything dated later - a 2099 typo - is outside the window, not a reason to stretch the axis.
        var aggregates = new RecordingAggregates();
        var handler = Handler(aggregates, new ChartOptions(ChartKinds.Line, "month"), "UTC");

        await handler.HandleAsync(new RunItemChart(Container, "chart"), Cancellation);

        Assert.Null(aggregates.FirstDay);
        Assert.Equal(new DateOnly(2026, 10, 31), aggregates.LastDay);
    }

    [Fact]
    public async Task A_year_grid_reads_fifty_three_whole_weeks_ending_with_this_one()
    {
        var aggregates = new RecordingAggregates();
        var handler = Handler(aggregates, new ChartOptions(ChartKinds.Year, "day"), "UTC");

        var result = await handler.HandleAsync(new RunItemChart(Container, "chart"), Cancellation);

        Assert.Equal(new DateOnly(2025, 10, 6), aggregates.FirstDay);
        Assert.Equal(new DateOnly(2026, 10, 11), aggregates.LastDay);
        Assert.Equal(ChartOptions.MaximumPeriods, aggregates.LastDay!.Value.DayNumber - aggregates.FirstDay!.Value.DayNumber + 1);
        Assert.Equal(ChartKinds.Year, result.Value.Kind);
    }

    [Fact]
    public async Task The_stored_drawing_options_come_back_with_the_buckets()
    {
        var aggregates = new RecordingAggregates();
        var handler = Handler(
            aggregates,
            new ChartOptions(ChartKinds.Area, "week", "owner", Cumulative: true, RollingAverage: true, Stacked: true),
            "UTC");

        var result = await handler.HandleAsync(new RunItemChart(Container, "chart"), Cancellation);

        Assert.True(result.Value.Stacked);
        Assert.True(result.Value.Cumulative);
        Assert.True(result.Value.RollingAverage);
        Assert.Equal(ChartFolding.MaximumSeries, aggregates.SeriesLimit);
    }

    private static RunItemChartHandler Handler(RecordingAggregates aggregates, ChartOptions options, string? zone)
    {
        var views = ViewDefinitionsJson.Write(
            [new ViewDefinition("chart", "Chart", ViewKind.Chart, [], "done_on", [], null, null, false, Chart: options)]);

        return new RunItemChartHandler(
            new StubTree(ItemWithViews(views)),
            new StubPermissions([Workspace]),
            aggregates,
            new StubLocks(open: true),
            new FixedTimeProvider(Now),
            new StubPreferences(zone),
            new StubSession(NixSessionContext.ForTenant(Tenant, Reader)));
    }

    private static Item ItemWithViews(string? views) => new()
    {
        Id = Container,
        TenantId = Tenant,
        WorkspaceId = Workspace,
        Type = "note",
        Seq = 1,
        Views = views,
        LifecycleState = ItemLifecycleState.Active,
        CreatedBy = Reader,
        LastModifiedBy = Reader,
        CreatedAt = DateTimeOffset.UnixEpoch,
        LastModifiedAt = DateTimeOffset.UnixEpoch,
    };

    private sealed class StubPreferences(string? zone) : IPrincipalPreferencesStore
    {
        public ValueTask<PrincipalPreferences?> FindAsync(
            TenantId tenantId,
            PrincipalId principalId,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult(zone is null
                ? null
                : new PrincipalPreferences
                {
                    TenantId = tenantId,
                    PrincipalId = principalId,
                    TimeZone = zone,
                    DueReminderTime = new TimeOnly(9, 0),
                    DueReminders = false,
                    HabitReminders = false,
                    MutedContainerIds = [],
                    Revision = 1,
                });

        public Task<bool> SaveAsync(PrincipalPreferences preferences, long expectedRevision, CancellationToken cancellationToken) =>
            throw new NotSupportedException();
    }

    /// <summary>A bucketing port that answers empty and remembers the window it was asked for.</summary>
    private sealed class RecordingAggregates : IChildAggregates
    {
        public DateOnly? FirstDay { get; private set; }

        public DateOnly? LastDay { get; private set; }

        public int SeriesLimit { get; private set; }

        public ValueTask<IReadOnlyDictionary<ChildAggregateKey, ChildAggregate>> FoldAsync(
            WorkspaceId workspaceId,
            IReadOnlyList<ItemId> parents,
            IReadOnlyList<string> keys,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<ChildBuckets> BucketAsync(
            WorkspaceId workspaceId,
            ItemId parent,
            string groupKey,
            string? measureKey,
            int limit,
            CancellationToken cancellationToken) => ValueTask.FromResult(new ChildBuckets([], 0, 0));

        public ValueTask<ChildCells> BucketBySeriesAsync(
            WorkspaceId workspaceId,
            ItemId parent,
            string groupKey,
            string splitKey,
            string? measureKey,
            int seriesLimit,
            int bucketLimit,
            int cellLimit,
            CancellationToken cancellationToken) => ValueTask.FromResult(new ChildCells([], 0, 0, false));

        public ValueTask<ChildCells> BucketByDayAsync(
            WorkspaceId workspaceId,
            ItemId parent,
            string dateKey,
            string? splitKey,
            string? measureKey,
            DateOnly? firstDay,
            DateOnly? lastDay,
            int seriesLimit,
            int cellLimit,
            CancellationToken cancellationToken)
        {
            FirstDay = firstDay;
            LastDay = lastDay;
            SeriesLimit = seriesLimit;
            return ValueTask.FromResult(new ChildCells([], 0, null, false));
        }
    }

    /// <summary>Finds the one prepared item, however it is asked.</summary>
    private sealed class StubTree : IItemTree
    {
        private readonly Item? _item;

        internal StubTree(Item? item) => _item = item;

        public ValueTask<Item?> FindAsync(ItemId id, CancellationToken cancellationToken) =>
            ValueTask.FromResult(_item?.Id == id ? _item : null);

        public ValueTask<Item?> FindStoredAsync(ItemId id, CancellationToken cancellationToken) =>
            FindAsync(id, cancellationToken);

        public ValueTask<IReadOnlySet<ItemId>> WithChildrenAsync(
            WorkspaceId workspaceId,
            IReadOnlyList<ItemId> parents,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<IReadOnlyList<Item>> ListChildrenAsync(
            WorkspaceId workspaceId,
            ItemId? parentId,
            bool includeDeleted,
            long? afterSequence,
            int limit,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<bool> WorkspaceExistsAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask<long> NextSiblingSequenceAsync(
            WorkspaceId workspaceId,
            ItemId? parentId,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<long> AllocateSiblingSequenceAsync(
            WorkspaceId workspaceId,
            ItemId? parentId,
            ItemId movingId,
            ItemId? afterId,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask InsertAsync(Item item, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask UpdatePropertiesAsync(
            ItemId id,
            string properties,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask UpdateSchemaAsync(
            ItemId id,
            string? schema,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask UpdateViewsAsync(
            ItemId id,
            string? views,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask TouchAsync(
            ItemId id,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<bool> WouldCreateCycleAsync(
            ItemId id,
            ItemId newParentId,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask ReparentAsync(
            ItemId id,
            ItemId? newParentId,
            long seq,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask SetLifecycleAsync(
            ItemId id,
            ItemLifecycleState state,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken) => throw new NotSupportedException();
    }

    /// <summary>Answers every lock question with one fixed answer: everything open, or everything closed.</summary>
    private sealed class StubLocks(bool open) : IItemLocks
    {
        public ValueTask<ItemLockState> GetStateAsync(ItemId itemId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(new ItemLockState(!open, null, open ? null : itemId, !open));

        public ValueTask<bool> MayReadBodyAsync(ItemId itemId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(open);

        public ValueTask<bool> AnyInSubtreeAsync(ItemId itemId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(!open);

        public ValueTask<IReadOnlySet<ItemId>> LockedAmongAsync(
            IReadOnlyList<ItemId> itemIds,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult<IReadOnlySet<ItemId>>(open ? new HashSet<ItemId>() : itemIds.ToHashSet());

        public ValueTask<string?> FindVerifierAsync(ItemId itemId, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask<bool> LockAsync(ItemId itemId, string verifier, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask<bool> ChangeVerifierAsync(
            ItemId itemId,
            string expected,
            string verifier,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<bool> RemoveAsync(ItemId itemId, string expected, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask<bool> GrantAsync(
            ItemId itemId,
            string verifier,
            DateTimeOffset expiresAt,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<bool> IsLockedAsync(ItemId itemId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(!open);

        public ValueTask RevokeAsync(ItemId itemId, CancellationToken cancellationToken) =>
            throw new NotSupportedException();
    }

    /// <summary>Answers with a fixed session context, or none - the way a missing pipeline setup would.</summary>
    private sealed class StubSession : INixSessionContextAccessor
    {
        internal StubSession(NixSessionContext? current) => Current = current;

        public NixSessionContext? Current { get; }
    }

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

}
