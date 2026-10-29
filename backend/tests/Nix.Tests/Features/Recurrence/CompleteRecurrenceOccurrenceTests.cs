using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Recurrence;
using Nix.Domain.Tenancy;
using Nix.Features.Recurrence;

namespace Nix.Tests.Features.Recurrence;

/// <summary>
/// <see cref="CompleteRecurrenceOccurrenceHandler"/>: completing an occurrence writes exactly once,
/// completing it again is success without a second write, and each of the reasons this handler
/// cannot even ask the domain guard the question - no rule, no anchor, an unreadable rule, no item -
/// gets its own stable refusal.
/// </summary>
public sealed class CompleteRecurrenceOccurrenceTests
{
    private static readonly TenantId Tenant = TenantId.From(new Guid("11111111-1111-4111-8111-111111111111"));
    private static readonly WorkspaceId Workspace = WorkspaceId.From(new Guid("22222222-2222-4222-8222-222222222222"));
    private static readonly PrincipalId Principal = PrincipalId.From(new Guid("33333333-3333-4333-8333-333333333333"));
    private static readonly ItemId TheItem = ItemId.From(new Guid("44444444-4444-4444-8444-444444444444"));
    private static readonly DateOnly Anchor = new(2026, 3, 1);

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Completing_an_occurrence_writes_once_and_returns_success()
    {
        var row = Row(dueDay: "2026-03-01", rule: Daily(interval: 1));
        var store = new FakeRecurrenceStore(row);
        var handler = Handler(row, store);

        var result = await handler.HandleAsync(
            new CompleteRecurrenceOccurrence(TheItem, Anchor.AddDays(3)),
            Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(1, store.CompleteOccurrenceCalls);
        var stored = RecurrenceRuleJson.Read(result.Value.Recurrence);
        Assert.NotNull(stored);
        Assert.True(stored!.IsCompleted(Anchor.AddDays(3)));
        Assert.False(stored.IsCompleted(Anchor.AddDays(4)));
    }

    [Fact]
    public async Task Completing_the_same_occurrence_twice_is_success_without_a_second_write()
    {
        var row = Row(dueDay: "2026-03-01", rule: Daily(interval: 1));
        var store = new FakeRecurrenceStore(row);
        var handler = Handler(row, store);

        var first = await handler.HandleAsync(
            new CompleteRecurrenceOccurrence(TheItem, Anchor.AddDays(3)),
            Cancellation);
        var second = await handler.HandleAsync(
            new CompleteRecurrenceOccurrence(TheItem, Anchor.AddDays(3)),
            Cancellation);

        Assert.True(first.IsSuccess);
        Assert.True(second.IsSuccess);
        // Caught by RecurrenceWrites.ApplyCompletion's own AlreadyComplete outcome, before this
        // handler ever calls the store a second time.
        Assert.Equal(1, store.CompleteOccurrenceCalls);
    }

    [Fact]
    public async Task An_item_with_no_stored_rule_is_refused_as_not_recurring()
    {
        var row = Row(dueDay: "2026-03-01", rule: null);
        var store = new FakeRecurrenceStore(row);
        var handler = Handler(row, store);

        var result = await handler.HandleAsync(
            new CompleteRecurrenceOccurrence(TheItem, Anchor),
            Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal(RecurrenceRequestErrors.NotRecurringCode, result.Error.Code);
        Assert.Equal(0, store.CompleteOccurrenceCalls);
    }

    [Fact]
    public async Task An_item_with_no_due_date_is_refused_as_having_no_anchor()
    {
        var row = Row(dueDay: null, rule: Daily(interval: 1));
        var store = new FakeRecurrenceStore(row);
        var handler = Handler(row, store);

        var result = await handler.HandleAsync(
            new CompleteRecurrenceOccurrence(TheItem, Anchor),
            Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal(RecurrenceRequestErrors.NoAnchorCode, result.Error.Code);
        Assert.Equal(0, store.CompleteOccurrenceCalls);
    }

    [Fact]
    public async Task A_stored_rule_this_build_cannot_read_is_refused_as_unreadable()
    {
        var row = Row(dueDay: "2026-03-01", rule: null);
        row.RecurrenceJson = "{ not json ";
        var store = new FakeRecurrenceStore(row);
        var handler = Handler(row, store);

        var result = await handler.HandleAsync(
            new CompleteRecurrenceOccurrence(TheItem, Anchor),
            Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal(RecurrenceRequestErrors.UnreadableRuleCode, result.Error.Code);
        Assert.Equal(0, store.CompleteOccurrenceCalls);
    }

    [Fact]
    public async Task A_missing_item_is_refused_as_not_found()
    {
        var handler = Handler(row: null, new FakeRecurrenceStore(null));

        var result = await handler.HandleAsync(
            new CompleteRecurrenceOccurrence(TheItem, Anchor),
            Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("items.not_found", result.Error.Code);
    }

    [Fact]
    public async Task A_day_the_series_does_not_land_on_surfaces_the_domain_guards_refusal()
    {
        var row = Row(dueDay: "2026-03-01", rule: Daily(interval: 2));
        var store = new FakeRecurrenceStore(row);
        var handler = Handler(row, store);

        var result = await handler.HandleAsync(
            new CompleteRecurrenceOccurrence(TheItem, Anchor.AddDays(1)),
            Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("recurrence.not_an_occurrence", result.Error.Code);
        Assert.Equal(0, store.CompleteOccurrenceCalls);
    }

    private static RecurrenceRule Daily(int interval) =>
        new(RecurrenceFrequency.Daily, interval, [], Until: null, CompletedThrough: null, Completed: []);

    private static FakeItemRow Row(string? dueDay, RecurrenceRule? rule) => new()
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
        RecurrenceJson = rule is null ? null : RecurrenceRuleJson.Write(rule),
    };

    private static CompleteRecurrenceOccurrenceHandler Handler(FakeItemRow? row, FakeRecurrenceStore store) =>
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
        /// a <c>with</c> expression.
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
        public int CompleteOccurrenceCalls { get; private set; }

        public ValueTask<RecurrenceWriteOutcome> SetRuleAsync(
            ItemId itemId,
            string? ruleJson,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<string?> ReadRuleAsync(ItemId itemId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(row is not null && row.Base.Id == itemId ? row.RecurrenceJson : null);

        public ValueTask<OccurrenceCompletionOutcome> CompleteOccurrenceAsync(
            ItemId itemId,
            string ruleJson,
            CancellationToken cancellationToken)
        {
            CompleteOccurrenceCalls++;

            if (row is null || row.Base.Id != itemId)
            {
                return ValueTask.FromResult(OccurrenceCompletionOutcome.ItemNotFound);
            }

            if (row.RecurrenceJson is null)
            {
                return ValueTask.FromResult(OccurrenceCompletionOutcome.NotRecurring);
            }

            if (string.Equals(row.RecurrenceJson, ruleJson, StringComparison.Ordinal))
            {
                return ValueTask.FromResult(OccurrenceCompletionOutcome.AlreadyComplete);
            }

            row.RecurrenceJson = ruleJson;
            return ValueTask.FromResult(OccurrenceCompletionOutcome.Completed);
        }
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
