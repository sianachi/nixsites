using System.Data.Common;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Tenancy;
using Nix.Features.Items;
using Nix.Features.Properties;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>The schema base check is atomic with its write, and a lost race leaves no unique-key claims behind.</summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class SchemaBaseConcurrencyTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static PropertySchema Schema(bool unique, params string[] extra) => new()
    {
        Inherit = true,
        Properties =
        [
            new PropertyDefinition("k", "K", PropertyType.Text, [], false, Unique: unique),
            .. extra.Select(key => new PropertyDefinition(key, key, PropertyType.Text, [], false)),
        ],
    };

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_schema_written_between_the_base_check_and_the_update_is_a_conflict_and_its_unique_keys_roll_back()
    {
        ItemId collection;
        await using (var setup = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var dispatcher = setup.Resolve<NixDispatcher>();
            var created = await dispatcher.SendAsync<CreateItem, Item>(
                new(WorkspaceId.From(TestTenants.AlphaWorkspace), "note", "Keys", null, null), Cancellation);
            collection = created.Value.Id;
            foreach (var value in new[] { "one", "two" })
            {
                var child = await dispatcher.SendAsync<CreateItem, Item>(
                    new(WorkspaceId.From(TestTenants.AlphaWorkspace), "note", value, collection, new JsonObject { ["k"] = value }), Cancellation);
                Assert.True(child.IsSuccess);
            }
            Assert.True((await dispatcher.SendAsync<SetItemSchema, PropertySchema>(new(collection, Schema(false)), Cancellation)).IsSuccess);
            await setup.CommitAsync(Cancellation);
        }

        var gate = new SchemaWriteGate();
        await using var application = NixPersistenceHost.Create(fixture.ApplicationConnectionString, gate);
        await using var replay = await application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var store = replay.Resolve<INativeReplayStore>();
        await store.BeginMutationAsync(Cancellation);
        // The base is the schema the device saw; the new one makes "k" unique, which claims keys first.
        var save = replay.Resolve<NixDispatcher>().SendAsync<SetItemSchema, PropertySchema>(
            new(collection, Schema(true), new SchemaBase(Schema(false))), Cancellation).AsTask();
        await gate.Arrived.Task.WaitAsync(TimeSpan.FromSeconds(20), Cancellation);
        try
        {
            await using var other = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            Assert.True((await other.Resolve<NixDispatcher>().SendAsync<SetItemSchema, PropertySchema>(
                new(collection, Schema(false, "added")), Cancellation)).IsSuccess);
            await other.CommitAsync(Cancellation);
        }
        finally
        {
            gate.Release.TrySetResult();
        }

        var result = await save;
        Assert.True(result.IsFailure);
        Assert.Equal(PropertyErrors.SchemaBaseChangedCode, result.Error.Code);
        await store.EndMutationAsync(accepted: false, Cancellation);
        await replay.CommitAsync(Cancellation);

        await using var connection = await fixture.OpenMigratorConnectionAsync();
        await using var keys = new NpgsqlCommand("SELECT count(*) FROM record_key WHERE scope_item_id = @item", connection);
        keys.Parameters.AddWithValue("item", collection.Value);
        Assert.Equal(0L, await keys.ExecuteScalarAsync(Cancellation));
        await using var stored = new NpgsqlCommand("SELECT schema::text FROM item WHERE id = @item", connection);
        stored.Parameters.AddWithValue("item", collection.Value);
        var text = (string)(await stored.ExecuteScalarAsync(Cancellation))!;
        Assert.Contains("added", text, StringComparison.Ordinal);
        Assert.DoesNotContain("\"unique\"", text, StringComparison.Ordinal);
    }

    private sealed class SchemaWriteGate : DbCommandInterceptor
    {
        public TaskCompletionSource Arrived { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override async ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(
            DbCommand command, CommandEventData eventData, InterceptionResult<int> result,
            CancellationToken cancellationToken = default)
        {
            var sql = command.CommandText;
            if ((sql.Contains("UPDATE item", StringComparison.Ordinal) || sql.Contains("UPDATE \"item\"", StringComparison.Ordinal))
                && (sql.Contains("schema =", StringComparison.Ordinal) || sql.Contains("\"schema\" =", StringComparison.Ordinal)))
            {
                Arrived.TrySetResult();
                await Release.Task.WaitAsync(cancellationToken);
            }
            return result;
        }
    }
}
