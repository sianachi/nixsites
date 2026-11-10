using System.Text.Json.Nodes;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Features.Items;
using Nix.Features.Properties;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The '$' property prefix belongs to the server and the structural query fields (queries plan,
/// decision D2): a generic write may not set a '$' key, may still clear one stored before the rule
/// existed. The trusted dispatches keep writing their own prefixes (<c>$habit_</c> and <c>$cal_</c>);
/// the habit and calendar sync suites exercise those paths end to end.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class ReservedPropertyKeyTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Theory]
    [InlineData("$type")]
    [InlineData("$anything")]
    public async Task A_generic_create_or_write_cannot_set_a_dollar_key(string key)
    {
        var context = TestTenants.AlphaContext;
        var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();

            var forgedCreate = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(context.WorkspaceId!.Value, "note", "Forged", null, new JsonObject { [key] = "task" }),
                Cancellation);
            Assert.True(forgedCreate.IsFailure);
            Assert.Equal("properties.invalid", forgedCreate.Error.Code);

            var created = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(context.WorkspaceId!.Value, "note", "Real", null, null),
                Cancellation);
            Assert.True(created.IsSuccess);

            var forgedWrite = await dispatcher.SendAsync<SetItemProperties, Item>(
                new SetItemProperties(created.Value.Id, $$"""{"{{key}}": "task"}"""),
                Cancellation);
            Assert.True(forgedWrite.IsFailure);
            Assert.Equal("properties.invalid", forgedWrite.Error.Code);

            // Clearing one is always allowed, so a key stored before the rule never strands data.
            var cleared = await dispatcher.SendAsync<SetItemProperties, Item>(
                new SetItemProperties(created.Value.Id, $$"""{"{{key}}": null}"""),
                Cancellation);
            Assert.True(cleared.IsSuccess, cleared.IsFailure ? cleared.Error.Message : null);
        }
    }
}
