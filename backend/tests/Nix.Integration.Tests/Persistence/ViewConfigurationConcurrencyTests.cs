using System.Collections.Immutable;
using System.Data.Common;
using System.Text;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using Nix.Features.Items;
using Nix.Features.Properties;
using Nix.Features.Views;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Integration.Tests.Persistence;

/// <summary>Actual Postgres compare-and-swap, including contention after the handler's last read.</summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class ViewConfigurationConcurrencyTests(NixPostgresFixture fixture, ITestOutputHelper output) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;
    private static ViewDefinition View(string id) => new(id, id, ViewKind.List, ["title"], null, [], null, null, false);

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_concurrent_addition_in_the_final_write_window_is_not_deleted()
    {
        var itemId = await CreateAsync();
        await using (var initial = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            Assert.True((await initial.Resolve<NixDispatcher>().SendAsync<SetContainerViews, ImmutableArray<ViewDefinition>>(
                new(itemId, [View("first"), View("second")], "second", true), Cancellation)).IsSuccess);
            await initial.CommitAsync(Cancellation);
        }

        var gate = new ConditionalWriteInterceptor(pause: true);
        await using var application = NixPersistenceHost.Create(fixture.ApplicationConnectionString, gate);
        await using var editor = await application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var dispatcher = editor.Resolve<NixDispatcher>();
        var read = await dispatcher.QueryAsync<GetContainerViews, Result<ContainerViewSet>>(new(itemId), Cancellation);
        Assert.True(read.IsSuccess);
        var patch = read.Value.Views.Select(view => view.Id == "first" ? view with { Name = "Renamed" } : view).ToImmutableArray();
        var save = dispatcher.SendAsync<SetContainerViews, ImmutableArray<ViewDefinition>>(
            new(itemId, patch, read.Value.Default, read.Value.HideDocument, read.Value.Version), Cancellation).AsTask();
        await gate.Arrived.Task.WaitAsync(TimeSpan.FromSeconds(20), Cancellation);
        try
        {
            await using var concurrent = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            var addition = await concurrent.Resolve<NixDispatcher>().SendAsync<SetContainerViews, ImmutableArray<ViewDefinition>>(
                new(itemId, [View("first"), View("second"), View("added")], "second", true), Cancellation);
            Assert.True(addition.IsSuccess);
            await concurrent.CommitAsync(Cancellation);
        }
        finally
        {
            gate.Release.TrySetResult();
        }
        var rejected = await save;
        Assert.True(rejected.IsFailure);
        Assert.Equal(PropertyErrors.ViewVersionConflictCode, rejected.Error.Code);
        await using var verify = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var saved = await verify.Resolve<NixDispatcher>().QueryAsync<GetContainerViews, Result<ContainerViewSet>>(new(itemId), Cancellation);
        Assert.Equal(["first", "second", "added"], saved.Value.Views.Select(view => view.Id));
        Assert.Equal("first", saved.Value.Views[0].Name);
        Assert.Equal("second", saved.Value.Default);
        Assert.True(saved.Value.HideDocument);
        Assert.NotEqual(read.Value.Version, saved.Value.Version);
    }

    [Fact]
    public async Task A_null_configuration_is_versioned_and_can_only_be_replaced_once()
    {
        var itemId = await CreateAsync();
        string originalVersion;
        await using (var first = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var dispatcher = first.Resolve<NixDispatcher>();
            var read = await dispatcher.QueryAsync<GetContainerViews, Result<ContainerViewSet>>(new(itemId), Cancellation);
            Assert.Empty(read.Value.Views);
            originalVersion = read.Value.Version;
            Assert.Equal(ViewConfigurationVersion.FromStored(null), originalVersion);
            Assert.True((await dispatcher.SendAsync<SetContainerViews, ImmutableArray<ViewDefinition>>(
                new(itemId, [View("first")], "first", false, originalVersion), Cancellation)).IsSuccess);
            await first.CommitAsync(Cancellation);
        }
        await using var stale = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var result = await stale.Resolve<NixDispatcher>().SendAsync<SetContainerViews, ImmutableArray<ViewDefinition>>(
            new(itemId, [View("stale")], "stale", false, originalVersion), Cancellation);
        Assert.True(result.IsFailure);
        Assert.Equal(PropertyErrors.ViewVersionConflictCode, result.Error.Code);
        var tree = stale.Resolve<IItemTree>();
        var observed = await tree.FindAsync(itemId, Cancellation);
        Assert.NotNull(observed);
        // Null equality must be SQL IS NULL, while a wrong original workspace or tenant cannot write.
        Assert.False(await tree.TryUpdateViewsAsync(itemId, observed.WorkspaceId, null, null,
            TestTenants.AlphaContext.PrincipalId, DateTimeOffset.UtcNow, Cancellation));
        Assert.False(await tree.TryUpdateViewsAsync(itemId, WorkspaceId.From(TestTenants.BetaWorkspace), observed.Views, null,
            TestTenants.AlphaContext.PrincipalId, DateTimeOffset.UtcNow, Cancellation));
        await using var foreign = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation);
        Assert.False(await foreign.Resolve<IItemTree>().TryUpdateViewsAsync(itemId, observed.WorkspaceId, observed.Views, null,
            TestTenants.BetaContext.PrincipalId, DateTimeOffset.UtcNow, Cancellation));
    }

    [Fact]
    public async Task The_atomic_update_uses_a_point_index_under_runtime_RLS_on_a_realistic_corpus()
    {
        await SeedCorpusAsync();
        var itemId = await CreateAsync();
        await using (var initial = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var views = Enumerable.Range(0, 10)
                .Select(index => View($"view-{index}") with { Name = $"Quoted \"configuration\" \\ {index}" })
                .ToImmutableArray();
            Assert.True((await initial.Resolve<NixDispatcher>().SendAsync<SetContainerViews, ImmutableArray<ViewDefinition>>(
                new(itemId, views, "view-9", true), Cancellation)).IsSuccess);
            await initial.CommitAsync(Cancellation);
        }
        var capture = new ConditionalWriteInterceptor(pause: false);
        await using var application = NixPersistenceHost.Create(fixture.ApplicationConnectionString, capture);
        await using var work = await application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var tree = work.Resolve<IItemTree>();
        var item = await tree.FindAsync(itemId, Cancellation);
        Assert.NotNull(item);
        var next = ViewDefinitionsJson.Write([View("first")], "first", false);
        Assert.True(await tree.TryUpdateViewsAsync(itemId, item.WorkspaceId, item.Views, next,
            TestTenants.AlphaContext.PrincipalId, DateTimeOffset.UtcNow, Cancellation));
        var plan = Assert.IsType<string>(capture.Plan);
        output.WriteLine("Conditional view update, 3200 other rows per tenant, runtime role:");
        output.WriteLine(plan);
        Assert.Contains("Index Scan", plan, StringComparison.Ordinal);
        // item_native_snapshot (tenant_id, workspace_id, id) is the sync feed's index; with id in its
        // condition it is a point lookup too, and the planner may prefer it.
        Assert.True(plan.Contains("PK_item", StringComparison.Ordinal)
            || plan.Contains("AK_item_tenant_id_id", StringComparison.Ordinal)
            || plan.Contains("Index Scan using item_native_snapshot", StringComparison.Ordinal));
        Assert.DoesNotContain("Seq Scan on item", plan, StringComparison.Ordinal);
        Assert.Contains("actual", plan, StringComparison.Ordinal);
        Assert.Contains("Buffers:", plan, StringComparison.Ordinal);
        // The plan's write is rolled back to a savepoint before the real command runs; disposal
        // then rolls back the real command too, leaving the data proof isolated.
    }

    private async Task<ItemId> CreateAsync()
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var result = await work.Resolve<NixDispatcher>().SendAsync<CreateItem, Item>(
            new(WorkspaceId.From(TestTenants.AlphaWorkspace), "note", "View concurrency fixture", null, null), Cancellation);
        Assert.True(result.IsSuccess);
        await work.CommitAsync(Cancellation);
        return result.Value.Id;
    }

    private async Task SeedCorpusAsync()
    {
        await using var connection = await fixture.OpenMigratorConnectionAsync();
        foreach (var seed in new[] { M0SchemaSeed.Alpha, M0SchemaSeed.Beta })
        {
            await RawSql.ExecuteAsync(connection, null, $$"""
                INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties, views,
                    lifecycle_state, created_by, last_modified_by, created_at, last_modified_at)
                SELECT gen_random_uuid(), '{{seed.TenantId}}'::uuid, '{{seed.WorkspaceId}}'::uuid,
                    'note', NULL, 900000 + n, jsonb_build_object('title', 'CAS corpus ' || n),
                    '{"views":[{"id":"all","name":"Corpus","kind":"list","columns":["title"]}],"default":"all"}'::jsonb,
                    'active', '{{seed.PrincipalId}}'::uuid, '{{seed.PrincipalId}}'::uuid, now(), now()
                FROM generate_series(1, 3200) n;
                """);
        }
        await RawSql.ExecuteAsync(connection, null, "ANALYZE item;");
    }

    private sealed class ConditionalWriteInterceptor(bool pause) : DbCommandInterceptor
    {
        public TaskCompletionSource Arrived { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public string? Plan { get; private set; }

        public override async ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(
            DbCommand command, CommandEventData eventData, InterceptionResult<int> result,
            CancellationToken cancellationToken = default)
        {
            await ObserveAsync(command, cancellationToken);
            return result;
        }

        public override async ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
            DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result,
            CancellationToken cancellationToken = default)
        {
            await ObserveAsync(command, cancellationToken);
            return result;
        }

        private async Task ObserveAsync(DbCommand command, CancellationToken cancellationToken)
        {
            // Bulk-update SQL does not necessarily retain query tags. These hosts perform only
            // the conditional view write, so observe its fixed generated UPDATE shape too.
            var sql = command.CommandText;
            var isViewUpdate = (sql.Contains("UPDATE item", StringComparison.Ordinal)
                    || sql.Contains("UPDATE \"item\"", StringComparison.Ordinal))
                && (sql.Contains("views =", StringComparison.Ordinal)
                    || sql.Contains("\"views\" =", StringComparison.Ordinal));
            if (!sql.Contains("ItemTree.TryUpdateViewsAsync", StringComparison.Ordinal) && !isViewUpdate)
            {
                return;
            }
            if (pause)
            {
                Arrived.TrySetResult();
                await Release.Task.WaitAsync(cancellationToken);
                return;
            }
            var connection = Assert.IsType<NpgsqlConnection>(command.Connection);
            var transaction = Assert.IsType<NpgsqlTransaction>(command.Transaction);
            await transaction.SaveAsync("view_cas_plan", cancellationToken);
            // The captured statement is generated by EF from the fixed CAS expression, not caller SQL.
#pragma warning disable CA2100
            await using (var explain = new NpgsqlCommand("EXPLAIN (ANALYZE, BUFFERS) " + command.CommandText, connection, transaction))
#pragma warning restore CA2100
            {
                foreach (DbParameter parameter in command.Parameters)
                {
                    var source = Assert.IsAssignableFrom<NpgsqlParameter>(parameter);
                    var copy = new NpgsqlParameter { ParameterName = source.ParameterName, Value = source.Value };
                    if (source.NpgsqlDbType != NpgsqlDbType.Unknown)
                    {
                        copy.NpgsqlDbType = source.NpgsqlDbType;
                    }
                    else
                    {
                        copy.DbType = source.DbType;
                    }
                    explain.Parameters.Add(copy);
                }
                var text = new StringBuilder();
                await using var reader = await explain.ExecuteReaderAsync(cancellationToken);
                while (await reader.ReadAsync(cancellationToken))
                {
                    text.AppendLine(reader.GetString(0));
                }
                Plan = text.ToString();
            }
            await transaction.RollbackAsync("view_cas_plan", cancellationToken);
            await transaction.ReleaseAsync("view_cas_plan", cancellationToken);
        }
    }
}
