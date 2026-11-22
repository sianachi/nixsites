using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Features.Locks;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The visible-item gate against real Postgres: a deleted, template, locked or foreign-tenant item
/// is refused the way the tree's visibility rules and the lock rules say it must be.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class VisibleItemsTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static readonly Guid Locker = new("10c10c00-1111-4111-8111-10c10c000011");
    private static readonly Guid OtherBrowser = new("10c10c00-1111-4111-8111-10c10c000012");

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static ItemId Item => ItemId.From(M0SchemaSeed.Alpha.ItemId);

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task An_active_item_is_returned_at_every_access_the_caller_holds()
    {
        Assert.True((await FindAsync(Item, ItemAccess.Read)).IsSuccess);
        Assert.True((await FindAsync(Item, ItemAccess.Write)).IsSuccess);
    }

    [Fact]
    public async Task An_item_of_another_tenant_is_not_found()
    {
        var result = await FindAsync(ItemId.From(M0SchemaSeed.Beta.ItemId), ItemAccess.Read);

        Assert.Equal("items.not_found", result.Error.Code);
    }

    [Fact]
    public async Task A_deleted_item_is_not_found()
    {
        await ExecuteAsMigratorAsync(
            $"UPDATE item SET lifecycle_state = 'deleted' WHERE id = {RawSql.Literal(M0SchemaSeed.Alpha.ItemId)}");

        var result = await FindAsync(Item, ItemAccess.Read);

        Assert.Equal("items.not_found", result.Error.Code);
    }

    [Fact]
    public async Task A_template_item_is_not_found()
    {
        await ExecuteAsMigratorAsync(
            $"UPDATE item SET template_id = {RawSql.Literal(M0SchemaSeed.Alpha.TemplateId)}, "
            + $"template_source_id = {RawSql.Literal(Guid.NewGuid())} WHERE id = {RawSql.Literal(M0SchemaSeed.Alpha.ItemId)}");

        var result = await FindAsync(Item, ItemAccess.Read);

        Assert.Equal("items.not_found", result.Error.Code);
    }

    [Fact]
    public async Task A_locked_body_is_refused_to_a_session_that_has_not_unlocked_it_and_only_when_asked_for_an_open_body()
    {
        await LockAsync();

        var closed = await FindAsync(Item, ItemAccess.Read, OtherBrowser, lockedDetail: "Locked.");
        var ignoredLock = await FindAsync(Item, ItemAccess.Read, OtherBrowser);
        var open = await FindAsync(Item, ItemAccess.Read, Locker, lockedDetail: "Locked.");

        Assert.Equal("items.locked", closed.Error.Code);
        Assert.True(ignoredLock.IsSuccess);
        Assert.True(open.IsSuccess);
    }

    private async Task<Result<Item>> FindAsync(
        ItemId id, ItemAccess access, Guid? credential = null, string? lockedDetail = null)
    {
        var work = await BeginAsync(credential);
        await using (work.ConfigureAwait(false))
        {
            return await work.Resolve<IVisibleItems>().FindAsync(id, access, Cancellation, lockedDetail: lockedDetail);
        }
    }

    private async Task LockAsync()
    {
        var work = await BeginAsync(Locker);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>().SendAsync<LockItem, bool>(new LockItem(Item, "hunter22", null), Cancellation);
            Assert.True(result.IsSuccess);
            await work.CommitAsync(Cancellation);
        }
    }

    private async Task<NixUnitOfWork> BeginAsync(Guid? credential)
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        if (credential is { } id)
        {
            work.Resolve<CredentialSessionContext>().Set(id);
        }

        return work;
    }

    private async Task ExecuteAsMigratorAsync(string sql)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }
}
