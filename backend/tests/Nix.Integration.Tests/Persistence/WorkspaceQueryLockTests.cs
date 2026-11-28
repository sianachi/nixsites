using System.Collections.Immutable;
using System.Globalization;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Query;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using Nix.Features.Items;
using Nix.Features.Locks;
using Nix.Features.Query;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The ad-hoc query and aggregate under an item lock, on real Postgres: what a lock withholds
/// (the subtree) never appears in rows, counts or totals for a credential that has not opened it;
/// it reappears once that credential unlocks; a scope on the lock or anything beneath it answers
/// 423; and the locked item's own row, which a lock does not withhold, is returned.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class WorkspaceQueryLockTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private const string Password = "hunter22";
    private const string TodayText = "2026-08-15";
    private const int LockedTasks = 3;

    /// <summary>The browser session that sets the lock, and so has it open.</summary>
    private static readonly Guid Locker = new("6c8f1d00-2222-4222-8222-6c8f1d000001");

    /// <summary>Another browser, which has not unlocked anything.</summary>
    private static readonly Guid OtherBrowser = new("6c8f1d00-2222-4222-8222-6c8f1d000002");

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static WorkspaceId Workspace => WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);

    private ItemId _vault;
    private ItemId _inner;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);

        // Outside the lock: two tasks. Inside: a folder holding three tasks, one of them a folder
        // of its own, so a scope can name a child of the lock as well as the lock itself.
        await CreateAsync("task", "Outside one", null);
        await CreateAsync("task", "Outside two", null);
        _vault = await CreateAsync("note", "Vault", null);
        _inner = await CreateAsync("task", "Inner", _vault);
        for (var index = 1; index < LockedTasks; index++)
        {
            await CreateAsync("task", $"Locked {index.ToString(CultureInfo.InvariantCulture)}", _inner);
        }

        var locked = await SendAsync<LockItem, bool>(Locker, new LockItem(_vault, Password, null));
        Assert.True(locked.IsSuccess, locked.IsFailure ? locked.Error.Message : string.Empty);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_count_by_type_leaves_out_everything_under_a_closed_lock()
    {
        var closed = await AggregateAsync(OtherBrowser, Input([]) with { GroupBy = "$type" });
        var open = await AggregateAsync(Locker, Input([]) with { GroupBy = "$type" });

        // Seed folder, Vault (its own row stays), and the two outside tasks.
        Assert.Equal(4m, closed.Value.Results.Total);
        Assert.Equal(3, closed.Value.Results.GroupCount);
        Assert.Equal(
            [new QueryAggregateGroup("folder", 1m, 1, 0), new QueryAggregateGroup("note", 1m, 1, 0), new QueryAggregateGroup("task", 2m, 2, 0)],
            closed.Value.Results.Groups);

        Assert.Equal(4m + LockedTasks, open.Value.Results.Total);
    }

    [Fact]
    public async Task Inside_a_locked_folder_is_empty_until_the_credential_unlocks_it()
    {
        var rule = new FilterRule("$inside", "equals", _vault.ToString());

        Assert.Empty((await RunAsync(OtherBrowser, Input([rule]))).Value.Results.Items);

        var unlocked = await SendAsync<UnlockItem, DateTimeOffset>(OtherBrowser, new UnlockItem(_vault, Password));
        Assert.True(unlocked.IsSuccess, unlocked.IsFailure ? unlocked.Error.Message : string.Empty);

        Assert.Equal(LockedTasks, (await RunAsync(OtherBrowser, Input([rule]))).Value.Results.Items.Count);
    }

    [Fact]
    public async Task A_scope_on_the_lock_or_on_anything_beneath_it_is_refused_with_423()
    {
        var onLock = await RunAsync(OtherBrowser, Input([], parent: _vault));
        var onChild = await RunAsync(OtherBrowser, Input([], parent: _inner));
        var folded = await AggregateAsync(OtherBrowser, Input([], parent: _inner));

        Assert.Equal("items.locked", onLock.Error.Code);
        Assert.Equal("items.locked", onChild.Error.Code);
        Assert.Equal("items.locked", folded.Error.Code);
    }

    [Fact]
    public async Task The_locked_items_own_row_is_returned_and_its_subtree_is_not()
    {
        var all = await RunAsync(OtherBrowser, Input([]));
        var ids = all.Value.Results.Items.Select(item => item.Id).ToHashSet();

        Assert.Contains(_vault, ids);
        Assert.DoesNotContain(_inner, ids);
        Assert.Equal(4, ids.Count);
    }

    private static WorkspaceQueryInput Input(ImmutableArray<FilterRule> filters, ItemId? parent = null) =>
        new(Workspace, parent, true, null, filters, null, false, null, [], TodayText);

    private async Task<ItemId> CreateAsync(string type, string title, ItemId? parent)
    {
        var created = await SendAsync<CreateItem, Item>(Locker, new CreateItem(Workspace, type, title, parent, null));
        Assert.True(created.IsSuccess, created.IsFailure ? created.Error.Message : string.Empty);
        return created.Value.Id;
    }

    private async Task<Result<WorkspaceQueryResults>> RunAsync(Guid credential, WorkspaceQueryInput input)
    {
        var work = await BeginAsync(credential);
        await using (work.ConfigureAwait(false))
        {
            return await work.Resolve<NixDispatcher>()
                .QueryAsync<RunWorkspaceQuery, Result<WorkspaceQueryResults>>(new RunWorkspaceQuery(input, null), Cancellation);
        }
    }

    private async Task<Result<WorkspaceAggregateResults>> AggregateAsync(Guid credential, WorkspaceQueryInput input)
    {
        var work = await BeginAsync(credential);
        await using (work.ConfigureAwait(false))
        {
            return await work.Resolve<NixDispatcher>()
                .QueryAsync<AggregateWorkspaceQuery, Result<WorkspaceAggregateResults>>(
                    new AggregateWorkspaceQuery(input, "count", null),
                    Cancellation);
        }
    }

    private async Task<Result<TResult>> SendAsync<TCommand, TResult>(Guid credential, TCommand command)
        where TCommand : ICommand<TResult>
    {
        var work = await BeginAsync(credential);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>().SendAsync<TCommand, TResult>(command, Cancellation);
            await work.CommitAsync(Cancellation);
            return result;
        }
    }

    private async Task<NixUnitOfWork> BeginAsync(Guid credential)
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        work.Resolve<CredentialSessionContext>().Set(credential);
        return work;
    }
}
