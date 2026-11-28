using Nix.Features.Workspaces;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresCollectionDefinition.Name)]
public sealed class WorkspaceArrangementPersistenceTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task An_arrangement_survives_a_new_request_refuses_stale_writes_and_stays_private_to_its_owner()
    {
        var workspace = TestTenants.AlphaWorkspace;
        var input = new WorkspaceArrangementInput([new(Guid.NewGuid(), "Work", [workspace])], [workspace]);

        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var saved = await work.Resolve<NixDispatcher>().SendAsync<SaveWorkspaceArrangement, WorkspaceArrangementResponse>(new(0, input), Cancellation);
            Assert.True(saved.IsSuccess);
            Assert.Equal(1, saved.Value.Revision);
            await work.CommitAsync(Cancellation);
        }

        work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var read = await dispatcher.QueryAsync<GetWorkspaceArrangement, WorkspaceArrangementResponse>(new(), Cancellation);
            Assert.Equal(1, read.Revision);
            Assert.Equal("Work", Assert.Single(read.Groups).Name);
            Assert.Equal([workspace], read.PinnedWorkspaceIds);

            var conflict = await dispatcher.SendAsync<SaveWorkspaceArrangement, WorkspaceArrangementResponse>(new(0, input), Cancellation);
            Assert.True(conflict.IsFailure);
            Assert.Equal("workspaces.arrangement_conflict", conflict.Error.Code);

            var updated = await dispatcher.SendAsync<SaveWorkspaceArrangement, WorkspaceArrangementResponse>(new(1, WorkspaceArrangementValidation.Empty), Cancellation);
            Assert.True(updated.IsSuccess);
            Assert.Equal(2, updated.Value.Revision);
            await work.CommitAsync(Cancellation);
        }

        // The other tenant's principal reads nothing: the row is the owner's alone (RLS).
        work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var other = await work.Resolve<NixDispatcher>().QueryAsync<GetWorkspaceArrangement, WorkspaceArrangementResponse>(new(), Cancellation);
            Assert.Equal(0, other.Revision);
        }
    }
}
