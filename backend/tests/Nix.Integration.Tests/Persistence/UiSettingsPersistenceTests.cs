using System.Text.Json;
using Nix.Features.CurrentUser;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresCollectionDefinition.Name)]
public sealed class UiSettingsPersistenceTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private static Dictionary<string, JsonElement> Patch(string json) =>
        JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!;

    [Fact]
    public async Task Settings_are_empty_until_written_merge_per_key_survive_a_new_request_and_stay_private_to_their_owner()
    {
        long revision;
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var empty = await work.Resolve<NixDispatcher>().QueryAsync<GetUiSettings, UiSettingsResponse>(new(), Cancellation);
            Assert.Empty(empty.Settings);

            var first = await work.Resolve<NixDispatcher>().SendAsync<PatchUiSettings, UiSettingsResponse>(
                new(Patch("""{"editor.keyboardMode":"vim","editor.pageGuides":false}""")), Cancellation);
            Assert.True(first.IsSuccess);
            Assert.Equal(empty.Revision + 1, first.Value.Revision);
            revision = first.Value.Revision;
            await work.CommitAsync(Cancellation);
        }

        work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var merged = await dispatcher.SendAsync<PatchUiSettings, UiSettingsResponse>(
                new(Patch("""{"editor.pageGuides":null,"graph.openMode":"tab"}""")), Cancellation);
            Assert.True(merged.IsSuccess);
            Assert.Equal(revision + 1, merged.Value.Revision);
            await work.CommitAsync(Cancellation);
        }

        work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var read = await work.Resolve<NixDispatcher>().QueryAsync<GetUiSettings, UiSettingsResponse>(new(), Cancellation);
            Assert.Equal("vim", read.Settings["editor.keyboardMode"].GetString());
            Assert.Equal("tab", read.Settings["graph.openMode"].GetString());
            Assert.False(read.Settings.ContainsKey("editor.pageGuides"));
        }

        // Another principal in the same tenant, and the other tenant's principal, read nothing (RLS).
        foreach (var other in new[]
        {
            TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, TestTenants.BetaPrincipal),
            TestTenants.BetaContext,
        })
        {
            work = await fixture.Application.BeginUnitOfWorkAsync(other, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                var read = await work.Resolve<NixDispatcher>().QueryAsync<GetUiSettings, UiSettingsResponse>(new(), Cancellation);
                Assert.Empty(read.Settings);
            }
        }
    }
}
