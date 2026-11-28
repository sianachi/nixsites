using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Recurrence;
using Nix.Domain.Tenancy;
using Nix.Features.Items;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The recurrence write path against real Postgres: what one tenant can reach, what a repeated
/// completion does, and which of three silences a zero-row update turns out to be.
/// </summary>
/// <remarks>
/// Two tenants throughout, per the standing rule for anything that touches row-level security -
/// a store that filtered correctly against a database holding one tenant's rows would prove
/// nothing at all.
/// </remarks>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class RecurrenceStoreTests : IAsyncLifetime
{
    private static readonly DateOnly Anchor = new(2026, 3, 2);

    private readonly NixPostgresFixture _fixture;

    public RecurrenceStoreTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_rule_written_is_a_rule_read_back()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var item = await NewItemAsync(work, TestTenants.AlphaWorkspace, "Standup");
            var store = work.Resolve<IRecurrenceStore>();
            var json = RecurrenceRuleJson.Write(Daily());

            var written = await store.SetRuleAsync(item.Id, json, Cancellation);
            var read = await store.ReadRuleAsync(item.Id, Cancellation);

            Assert.Equal(RecurrenceWriteOutcome.Written, written);
            // Through the reader, not by string comparison: what matters is that the rule survived,
            // not that Postgres preserved the byte order of a jsonb document.
            Assert.Equal(Daily(), RecurrenceRuleJson.Read(read));
        }
    }

    [Fact]
    public async Task A_rule_can_be_cleared_and_the_item_stops_recurring()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var item = await NewItemAsync(work, TestTenants.AlphaWorkspace, "Standup");
            var store = work.Resolve<IRecurrenceStore>();
            await store.SetRuleAsync(item.Id, RecurrenceRuleJson.Write(Daily()), Cancellation);

            var cleared = await store.SetRuleAsync(item.Id, null, Cancellation);

            Assert.Equal(RecurrenceWriteOutcome.Written, cleared);
            Assert.Null(await store.ReadRuleAsync(item.Id, Cancellation));
        }
    }

    [Fact]
    public async Task Writing_a_rule_to_an_item_that_is_not_there_says_so_rather_than_succeeding_quietly()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<IRecurrenceStore>();

            var written = await store.SetRuleAsync(
                ItemId.From(Guid.NewGuid()),
                RecurrenceRuleJson.Write(Daily()),
                Cancellation);

            Assert.Equal(RecurrenceWriteOutcome.ItemNotFound, written);
        }
    }

    [Fact]
    public async Task Completing_an_occurrence_advances_the_stored_rule()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var item = await NewItemAsync(work, TestTenants.AlphaWorkspace, "Standup");
            var store = work.Resolve<IRecurrenceStore>();
            await store.SetRuleAsync(item.Id, RecurrenceRuleJson.Write(Daily()), Cancellation);

            var prepared = RecurrenceWrites.ApplyCompletion(Daily(), Anchor, Anchor.AddDays(2));
            var outcome = await store.CompleteOccurrenceAsync(
                item.Id,
                prepared.Value.RuleJson!,
                Cancellation);

            Assert.Equal(OccurrenceCompletionOutcome.Completed, outcome);

            var stored = RecurrenceRuleJson.Read(await store.ReadRuleAsync(item.Id, Cancellation));
            Assert.NotNull(stored);
            Assert.True(stored!.IsCompleted(Anchor.AddDays(2)));
            // The series itself is untouched: completing one instance must not end or shift it.
            Assert.Equal(RecurrenceFrequency.Daily, stored.Frequency);
            Assert.Null(stored.Until);
        }
    }

    [Fact]
    public async Task Completing_the_same_occurrence_twice_changes_nothing_the_second_time()
    {
        // The idempotency the statement's IS DISTINCT FROM predicate buys: a retry, or two clients
        // pressing the same tick, must not be an error and must not write twice.
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var item = await NewItemAsync(work, TestTenants.AlphaWorkspace, "Standup");
            var store = work.Resolve<IRecurrenceStore>();
            await store.SetRuleAsync(item.Id, RecurrenceRuleJson.Write(Daily()), Cancellation);

            var prepared = RecurrenceWrites.ApplyCompletion(Daily(), Anchor, Anchor.AddDays(2));

            var first = await store.CompleteOccurrenceAsync(item.Id, prepared.Value.RuleJson!, Cancellation);
            var second = await store.CompleteOccurrenceAsync(item.Id, prepared.Value.RuleJson!, Cancellation);

            Assert.Equal(OccurrenceCompletionOutcome.Completed, first);
            Assert.Equal(OccurrenceCompletionOutcome.AlreadyComplete, second);
        }
    }

    [Fact]
    public async Task Completing_an_occurrence_of_an_item_that_does_not_recur_says_which_silence_it_was()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var item = await NewItemAsync(work, TestTenants.AlphaWorkspace, "Plain note");
            var store = work.Resolve<IRecurrenceStore>();

            var prepared = RecurrenceWrites.ApplyCompletion(Daily(), Anchor, Anchor.AddDays(2));

            var outcome = await store.CompleteOccurrenceAsync(item.Id, prepared.Value.RuleJson!, Cancellation);

            // Zero rows affected, but for a reason the caller can act on rather than a shrug.
            Assert.Equal(OccurrenceCompletionOutcome.NotRecurring, outcome);
        }
    }

    [Fact]
    public async Task Completing_an_occurrence_of_an_item_that_is_gone_says_that_instead()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<IRecurrenceStore>();
            var prepared = RecurrenceWrites.ApplyCompletion(Daily(), Anchor, Anchor.AddDays(2));

            var outcome = await store.CompleteOccurrenceAsync(
                ItemId.From(Guid.NewGuid()),
                prepared.Value.RuleJson!,
                Cancellation);

            Assert.Equal(OccurrenceCompletionOutcome.ItemNotFound, outcome);
        }
    }

    [Fact]
    public async Task One_tenant_can_neither_read_nor_write_another_tenant_s_rule()
    {
        // The crown-jewel assertion. Beta knows Alpha's item identifier - which is the worst case
        // and the one the policies exist for, because an identifier is not a secret.
        ItemId alphaItem;

        var alpha = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (alpha.ConfigureAwait(false))
        {
            var item = await NewItemAsync(alpha, TestTenants.AlphaWorkspace, "Alpha standup");
            alphaItem = item.Id;
            var store = alpha.Resolve<IRecurrenceStore>();
            await store.SetRuleAsync(alphaItem, RecurrenceRuleJson.Write(Daily()), Cancellation);

            // Committed on purpose: this is the only test here that spans units of work, and the
            // harness rolls back on dispose, so an uncommitted rule would make the cross-tenant
            // assertions below pass against a database where nothing was ever written.
            await alpha.CommitAsync(Cancellation);
        }

        var beta = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation);
        await using (beta.ConfigureAwait(false))
        {
            var store = beta.Resolve<IRecurrenceStore>();

            Assert.Null(await store.ReadRuleAsync(alphaItem, Cancellation));

            var written = await store.SetRuleAsync(alphaItem, null, Cancellation);
            Assert.Equal(RecurrenceWriteOutcome.ItemNotFound, written);

            var prepared = RecurrenceWrites.ApplyCompletion(Daily(), Anchor, Anchor.AddDays(2));
            var completed = await store.CompleteOccurrenceAsync(
                alphaItem,
                prepared.Value.RuleJson!,
                Cancellation);
            Assert.Equal(OccurrenceCompletionOutcome.ItemNotFound, completed);
        }

        // And Alpha's rule is exactly as Alpha left it - a refusal that had quietly cleared the
        // rule would pass every assertion above.
        var verify = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (verify.ConfigureAwait(false))
        {
            var store = verify.Resolve<IRecurrenceStore>();
            Assert.Equal(Daily(), RecurrenceRuleJson.Read(await store.ReadRuleAsync(alphaItem, Cancellation)));
        }
    }

    [Fact]
    public void The_guard_refuses_an_oversized_rule_before_the_column_s_check_ever_fires()
    {
        // The CHECK is a backstop, not the guard - so the guard has to be what says no. If this
        // ever fails by throwing instead, an oversized rule has become a 500 rather than a
        // problem detail, which is the failure the constraint's remark warns about.
        var oversized = Daily() with
        {
            Completed =
            [
                .. Enumerable
                    .Range(0, 400)
                    .Select(offset => new DateOnly(2026, 1, 1).AddDays(offset * 2)),
            ],
        };

        var prepared = RecurrenceWrites.PrepareRule(oversized);

        Assert.True(prepared.IsFailure);
        Assert.Equal("recurrence.rule_too_large", prepared.Error.Code);
    }

    private static RecurrenceRule Daily() =>
        new(
            RecurrenceFrequency.Daily,
            Interval: 1,
            Weekdays: [],
            Until: null,
            CompletedThrough: null,
            Completed: []);

    private static async Task<Item> NewItemAsync(NixUnitOfWork work, Guid workspaceId, string title)
    {
        var dispatcher = work.Resolve<NixDispatcher>();
        var created = await dispatcher.SendAsync<CreateItem, Item>(
            new CreateItem(WorkspaceId.From(workspaceId), "note", title, null, null),
            Cancellation);

        Assert.True(created.IsSuccess, created.IsSuccess ? "" : created.Error.Message);
        return created.Value;
    }
}
