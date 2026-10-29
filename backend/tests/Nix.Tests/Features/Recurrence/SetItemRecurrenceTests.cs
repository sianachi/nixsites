using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Recurrence;
using Nix.Domain.Tenancy;
using Nix.Features.Recurrence;

namespace Nix.Tests.Features.Recurrence;

/// <summary>
/// <see cref="SetItemRecurrenceHandler"/>: authoring a rule, refusing a malformed request with its
/// own stable code before storage is ever touched, and carrying completion state across an edit.
/// </summary>
/// <remarks>
/// Row-level security, tenancy and the database round trip are exercised by the integration suite;
/// what is worth pinning here, free of any database, is the request mapping and the completion
/// carry-over - the two pieces of behaviour this handler owns outright.
/// </remarks>
public sealed class SetItemRecurrenceTests
{
    private static readonly TenantId Tenant = TenantId.From(new Guid("11111111-1111-4111-8111-111111111111"));
    private static readonly WorkspaceId Workspace = WorkspaceId.From(new Guid("22222222-2222-4222-8222-222222222222"));
    private static readonly PrincipalId Principal = PrincipalId.From(new Guid("33333333-3333-4333-8333-333333333333"));
    private static readonly ItemId TheItem = ItemId.From(new Guid("44444444-4444-4444-8444-444444444444"));

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Fact]
    public async Task A_valid_rule_is_stored_and_the_stored_shape_comes_back()
    {
        var row = Row(dueDay: "2026-03-01");
        var store = new FakeRecurrenceStore(row);
        var handler = Handler(row, store);

        var result = await handler.HandleAsync(
            new SetItemRecurrence(TheItem, new SetRecurrenceRequest("weekly", 2, ["mo", "we"], null)),
            Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(1, store.SetRuleCalls);
        var stored = RecurrenceRuleJson.Read(store.LastSetRuleJson);
        Assert.NotNull(stored);
        Assert.Equal(RecurrenceFrequency.Weekly, stored!.Frequency);
        Assert.Equal(2, stored.Interval);
        Assert.Equal([IsoDayOfWeek.Monday, IsoDayOfWeek.Wednesday], stored.Weekdays);
        Assert.Equal(RecurrenceRuleJson.Read(store.LastSetRuleJson), RecurrenceRuleJson.Read(result.Value.Recurrence));
    }

    [Fact]
    public async Task A_null_request_clears_the_rule()
    {
        var row = Row(dueDay: "2026-03-01");
        row.RecurrenceJson = RecurrenceRuleJson.Write(Daily(interval: 1));
        var store = new FakeRecurrenceStore(row);
        var handler = Handler(row, store);

        var result = await handler.HandleAsync(new SetItemRecurrence(TheItem, null), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(1, store.SetRuleCalls);
        Assert.Null(store.LastSetRuleJson);
        Assert.Null(result.Value.Recurrence);
    }

    [Fact]
    public async Task An_unrecognised_frequency_is_refused_before_storage_is_touched()
    {
        var row = Row(dueDay: "2026-03-01");
        var store = new FakeRecurrenceStore(row);
        var handler = Handler(row, store);

        var result = await handler.HandleAsync(
            new SetItemRecurrence(TheItem, new SetRecurrenceRequest("fortnightly", 1, null, null)),
            Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal(RecurrenceRequestErrors.InvalidFrequencyCode, result.Error.Code);
        Assert.Equal(0, store.SetRuleCalls);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(367)]
    public async Task An_interval_outside_the_bound_is_refused(int interval)
    {
        var row = Row(dueDay: "2026-03-01");
        var store = new FakeRecurrenceStore(row);
        var handler = Handler(row, store);

        var result = await handler.HandleAsync(
            new SetItemRecurrence(TheItem, new SetRecurrenceRequest("daily", interval, null, null)),
            Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal(RecurrenceRequestErrors.InvalidIntervalCode, result.Error.Code);
        Assert.Equal(0, store.SetRuleCalls);
    }

    [Fact]
    public async Task Weekdays_named_on_a_non_weekly_rule_are_refused()
    {
        var row = Row(dueDay: "2026-03-01");
        var store = new FakeRecurrenceStore(row);
        var handler = Handler(row, store);

        var result = await handler.HandleAsync(
            new SetItemRecurrence(TheItem, new SetRecurrenceRequest("daily", 1, ["mo"], null)),
            Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal(RecurrenceRequestErrors.WeekdaysRequireWeeklyCode, result.Error.Code);
        Assert.Equal(0, store.SetRuleCalls);
    }

    [Fact]
    public async Task An_unrecognised_weekday_name_is_refused()
    {
        var row = Row(dueDay: "2026-03-01");
        var store = new FakeRecurrenceStore(row);
        var handler = Handler(row, store);

        var result = await handler.HandleAsync(
            new SetItemRecurrence(TheItem, new SetRecurrenceRequest("weekly", 1, ["mo", "funday"], null)),
            Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal(RecurrenceRequestErrors.InvalidWeekdayCode, result.Error.Code);
        Assert.Equal(0, store.SetRuleCalls);
    }

    [Fact]
    public async Task A_malformed_until_is_refused()
    {
        var row = Row(dueDay: "2026-03-01");
        var store = new FakeRecurrenceStore(row);
        var handler = Handler(row, store);

        var result = await handler.HandleAsync(
            new SetItemRecurrence(TheItem, new SetRecurrenceRequest("daily", 1, null, "not-a-date")),
            Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal(RecurrenceRequestErrors.InvalidUntilCode, result.Error.Code);
        Assert.Equal(0, store.SetRuleCalls);
    }

    [Fact]
    public async Task Editing_a_rule_keeps_the_watermark_and_drops_completions_the_new_rule_no_longer_lands_on()
    {
        var anchor = new DateOnly(2026, 3, 1);
        var row = Row(dueDay: "2026-03-01");
        row.RecurrenceJson = RecurrenceRuleJson.Write(
            Daily(interval: 1) with
            {
                CompletedThrough = anchor,
                Completed = [anchor.AddDays(2), anchor.AddDays(3)],
            });
        var store = new FakeRecurrenceStore(row);
        var handler = Handler(row, store);

        // Every second day from the anchor: 03-01, 03-03, 03-05, ... - 03-02 is no longer an
        // occurrence of the new rule, but 03-03 still is.
        var result = await handler.HandleAsync(
            new SetItemRecurrence(TheItem, new SetRecurrenceRequest("daily", 2, null, null)),
            Cancellation);

        Assert.True(result.IsSuccess);
        var stored = RecurrenceRuleJson.Read(store.LastSetRuleJson);
        Assert.NotNull(stored);
        Assert.Equal(anchor, stored!.CompletedThrough);
        // 03-03 survives because the new rule still lands on it; 03-04 is dropped because it no
        // longer exists as an occurrence. Keeping it would leave a completion for a day that never
        // happens, which the reader would carry forever and no screen could explain.
        Assert.Equal([anchor.AddDays(2)], stored.Completed);
    }

    [Fact]
    public async Task With_no_anchor_the_previous_completions_are_carried_over_unfiltered()
    {
        // No due date at all: there is nothing to check occurrences against, so the exception list
        // is preserved rather than guessed at - the handler must never invent an answer to "does the
        // new rule still land here" when it cannot compute one.
        var anchor = new DateOnly(2026, 3, 1);
        var row = Row(dueDay: null);
        row.RecurrenceJson = RecurrenceRuleJson.Write(
            Daily(interval: 1) with { Completed = [anchor.AddDays(2), anchor.AddDays(3)] });
        var store = new FakeRecurrenceStore(row);
        var handler = Handler(row, store);

        var result = await handler.HandleAsync(
            new SetItemRecurrence(TheItem, new SetRecurrenceRequest("daily", 5, null, null)),
            Cancellation);

        Assert.True(result.IsSuccess);
        var stored = RecurrenceRuleJson.Read(store.LastSetRuleJson);
        Assert.NotNull(stored);
        Assert.Equal([anchor.AddDays(2), anchor.AddDays(3)], stored!.Completed);
    }

    private static RecurrenceRule Daily(int interval) =>
        new(RecurrenceFrequency.Daily, interval, [], Until: null, CompletedThrough: null, Completed: []);

    private static FakeItemRow Row(string? dueDay) => new()
    {
        Base = new Item
        {
            Id = TheItem,
            TenantId = Tenant,
            WorkspaceId = Workspace,
            Type = "note",
            Seq = 1000,
            DueDay = dueDay,
            LifecycleState = ItemLifecycleState.Active,
            CreatedBy = Principal,
            LastModifiedBy = Principal,
            CreatedAt = DateTimeOffset.UnixEpoch,
            LastModifiedAt = DateTimeOffset.UnixEpoch,
        },
    };

    private static SetItemRecurrenceHandler Handler(FakeItemRow row, FakeRecurrenceStore store) =>
        new(new FakeItemTree(row), store, new AllowWrite());

    /// <summary>The shared row two fakes read and write, the way one database row would.</summary>
    private sealed class FakeItemRow
    {
        public required Item Base { get; init; }

        public string? RecurrenceJson { get; set; }
    }

    private sealed class FakeItemTree(FakeItemRow? row) : IItemTree
    {
        public ValueTask<Item?> FindAsync(ItemId id, CancellationToken cancellationToken) =>
            ValueTask.FromResult(row is not null && row.Base.Id == id ? WithRecurrence(row) : null);

        public ValueTask<Item?> FindStoredAsync(ItemId id, CancellationToken cancellationToken) =>
            FindAsync(id, cancellationToken);

        /// <summary>
        /// A fresh copy of the row's base item carrying its current recurrence JSON. <see cref="Item"/>
        /// is a plain class rather than a record, so this rebuilds it field by field instead of using
        /// a <c>with</c> expression - the same reason every store in production re-reads through SQL
        /// rather than patching an in-memory copy.
        /// </summary>
        private static Item WithRecurrence(FakeItemRow row) => new()
        {
            Id = row.Base.Id,
            TenantId = row.Base.TenantId,
            WorkspaceId = row.Base.WorkspaceId,
            Type = row.Base.Type,
            ParentId = row.Base.ParentId,
            Seq = row.Base.Seq,
            Properties = row.Base.Properties,
            Schema = row.Base.Schema,
            Views = row.Base.Views,
            Recurrence = row.RecurrenceJson,
            DueDay = row.Base.DueDay,
            TemplateSourceId = row.Base.TemplateSourceId,
            LifecycleState = row.Base.LifecycleState,
            PurgeAfter = row.Base.PurgeAfter,
            CreatedBy = row.Base.CreatedBy,
            LastModifiedBy = row.Base.LastModifiedBy,
            CreatedAt = row.Base.CreatedAt,
            LastModifiedAt = row.Base.LastModifiedAt,
        };

        public ValueTask<IReadOnlySet<ItemId>> WithChildrenAsync(
            WorkspaceId workspaceId,
            IReadOnlyList<ItemId> parents,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<IReadOnlyList<Item>> ListChildrenAsync(
            WorkspaceId workspaceId,
            ItemId? parentId,
            bool includeDeleted,
            long? afterSeq,
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
            ItemId parentId,
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

    private sealed class FakeRecurrenceStore(FakeItemRow? row) : IRecurrenceStore
    {
        public int SetRuleCalls { get; private set; }

        public string? LastSetRuleJson { get; private set; }

        public ValueTask<RecurrenceWriteOutcome> SetRuleAsync(
            ItemId itemId,
            string? ruleJson,
            CancellationToken cancellationToken)
        {
            SetRuleCalls++;
            LastSetRuleJson = ruleJson;

            if (row is null || row.Base.Id != itemId)
            {
                return ValueTask.FromResult(RecurrenceWriteOutcome.ItemNotFound);
            }

            row.RecurrenceJson = ruleJson;
            return ValueTask.FromResult(RecurrenceWriteOutcome.Written);
        }

        public ValueTask<string?> ReadRuleAsync(ItemId itemId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(row is not null && row.Base.Id == itemId ? row.RecurrenceJson : null);

        public ValueTask<OccurrenceCompletionOutcome> CompleteOccurrenceAsync(
            ItemId itemId,
            string ruleJson,
            CancellationToken cancellationToken) => throw new NotSupportedException();
    }

    private sealed class AllowWrite : IPermissionResolver
    {
        public ValueTask<bool> CanReadWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(true);

        public ValueTask<bool> CanWriteWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(true);

        public ValueTask<bool> CanCommentWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(false);


        public ValueTask<bool> CanManageWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(false);

        public ValueTask<IReadOnlyList<WorkspaceId>> ReadableWorkspacesAsync(CancellationToken cancellationToken) =>
            ValueTask.FromResult<IReadOnlyList<WorkspaceId>>([Workspace]);

        public ValueTask<bool> IsTenantAdministratorAsync(CancellationToken cancellationToken) =>
            ValueTask.FromResult(false);
    }
}
