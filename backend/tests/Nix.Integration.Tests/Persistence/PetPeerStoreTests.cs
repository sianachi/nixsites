using System.Text.Json;
using Nix.Abstractions;
using Nix.Abstractions.PetPeers;
using Nix.Abstractions.PetRuns;
using Nix.Domain.Items;
using Nix.Integration.Tests.Harness;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresCollectionDefinition.Name)]
public sealed class PetPeerStoreTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Only_the_registered_runner_can_claim_and_finish_the_exact_work_once()
    {
        var now = DateTimeOffset.UtcNow;
        var itemId = M0SchemaSeed.Alpha.ItemId;
        var parentRun = await CreateParentAsync(TestTenants.AlphaContext, itemId, now);
        var otherTenantRun = await CreateParentAsync(TestTenants.BetaContext, M0SchemaSeed.Beta.ItemId, now);
        var peer = new PetPeerRegistration(Guid.NewGuid(), Guid.NewGuid(), TestTenants.AlphaWorkspace, itemId,
            "Test runner", "codex", now.AddDays(1), RevokedAt: null);
        var queued = new PetPeerWork(Guid.NewGuid(), peer.Id, parentRun, "outbound", "queued",
            "Summarize the approved task", Result: null, LeaseId: null, LeaseExpiresAt: null, now);
        await InSessionAsync(TestTenants.AlphaContext, async store =>
        {
            await store.InsertAsync(peer, Cancellation);
            Assert.False(await store.SaveWorkAsync(queued with { RunId = otherTenantRun }, Cancellation));
            Assert.True(await store.SaveWorkAsync(queued, Cancellation));
            Assert.False(await store.SaveWorkAsync(queued, Cancellation));
            return true;
        });

        var lease = Guid.NewGuid();
        Assert.Null(await InSessionAsync(TestTenants.BetaContext,
            store => store.GetAsync(peer.Id, lockGrant: false, Cancellation)));
        Assert.Null(await InSessionAsync(TestTenants.BetaContext,
            store => store.ClaimAsync(peer.Id, lease, now.AddMinutes(10), Cancellation)));

        var locked = await InSessionAsync(TestTenants.AlphaContext,
            store => store.ClaimAsync(peer.Id, lease, now.AddMinutes(10), Cancellation));
        Assert.NotNull(locked);
        Assert.Equal(queued.Id, locked.Id);
        Assert.Equal(lease, locked.LeaseId);

        await InSessionAsync(TestTenants.AlphaContext, async store =>
        {
            Assert.Null(await store.ClaimAsync(peer.Id, Guid.NewGuid(), now.AddMinutes(10), Cancellation));
            Assert.False(await store.FinishAsync(peer.Id, queued.Id, Guid.NewGuid(), "completed", "Wrong lease", now, Cancellation));
            Assert.False(await store.FinishAsync(peer.Id, queued.Id, lease, "completed", "Expired", now.AddMinutes(11), Cancellation));
            Assert.True(await store.FinishAsync(peer.Id, queued.Id, lease, "completed", "Approved summary", now, Cancellation));
            Assert.False(await store.FinishAsync(peer.Id, queued.Id, lease, "completed", "Replay", now, Cancellation));
            var completed = await store.GetWorkAsync(peer.Id, queued.Id, Cancellation);
            Assert.NotNull(completed);
            Assert.Equal("Approved summary", completed.Result);
            Assert.Equal("completed", completed.Status);
            Assert.True(await store.RevokeAsync(itemId, peer.Id, now, Cancellation));
            Assert.False(await store.SaveWorkAsync(queued with { Id = Guid.NewGuid() }, Cancellation));
            return true;
        });
    }

    private async Task<Guid> CreateParentAsync(NixSessionContext context, Guid itemId, DateTimeOffset now)
    {
        using var checkpoint = JsonDocument.Parse("{}");
        var run = new PetRunRecord(Guid.NewGuid(), ItemId.From(itemId),
            context.WorkspaceId ?? throw new InvalidOperationException("The parent run requires a workspace."),
            context.TenantId, context.PrincipalId, "Review the task", [], false, ["peer.delegate"],
            "queued", 1, checkpoint.RootElement, now, now);
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        Assert.True(await work.Resolve<IPetRunStore>().CreateAsync(run, Cancellation));
        await work.CommitAsync(Cancellation);
        return run.Id;
    }

    private async Task<T> InSessionAsync<T>(NixSessionContext context, Func<IPetPeerStore, Task<T>> operation)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        var result = await operation(work.Resolve<IPetPeerStore>());
        await work.CommitAsync(Cancellation);
        return result;
    }
}
