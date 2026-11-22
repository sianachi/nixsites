using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Integration.Tests.Harness;
using Nix.Persistence;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>Two real transactions: the second must wait for the first to finish, on exactly the same key.</summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class AdvisoryLocksTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static readonly Guid Tenant = new("5e7c0a00-4444-4444-8444-5e7c0a000001");
    private static readonly Guid Principal = new("5e7c0a00-4444-4444-8444-5e7c0a000002");
    private static readonly Guid Target = new("5e7c0a00-4444-4444-8444-5e7c0a000003");
    private static readonly Guid Second = new("5e7c0a00-4444-4444-8444-5e7c0a000004");

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    public static TheoryData<string> Purposes() => new()
    {
        "topology", "item", "habit", "files", "scope", "keys", "daily", "creation", "replay", "tunnel", "site",
        "quota", "import", "importKey", "upload", "uploadKey", "push", "worker",
        "tplWorkspace", "tplStages", "tpl", "tplApplication", "tplIdempotency",
    };

    [Theory]
    [MemberData(nameof(Purposes))]
    public async Task A_second_transaction_waits_for_the_first(string purpose)
    {
        await using var first = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await Acquire(new AdvisoryLocks(first.DbContext), purpose);
        await AssertSecondWaitsAsync(first, locks => Acquire(locks, purpose));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task A_workspace_transfer_waits_for_file_publication_in_either_workspace(bool heldIsSource)
    {
        var source = WorkspaceId.From(Target);
        var destination = WorkspaceId.From(Second);
        await using var first = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await new AdvisoryLocks(first.DbContext).LockWorkspaceFilesAsync(heldIsSource ? source : destination, Cancellation);
        await AssertSecondWaitsAsync(first, locks => locks.LockWorkspaceTransferAsync(source, destination, Cancellation));
    }

    [Fact]
    public async Task Opposite_workspace_transfers_cannot_deadlock()
    {
        var one = WorkspaceId.From(Target);
        var two = WorkspaceId.From(Second);
        await using var first = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using var other = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await new AdvisoryLocks(first.DbContext).LockWorkspaceTransferAsync(one, two, Cancellation);
        var pending = new AdvisoryLocks(other.DbContext).LockWorkspaceTransferAsync(two, one, Cancellation).AsTask();
        await WaitForDatabaseLockAsync(other);
        await first.CommitAsync(Cancellation);
        await pending.WaitAsync(TimeSpan.FromSeconds(10), Cancellation);
    }

    // apps/collab takes this key in shared mode before it writes a document; Core's topology lock must exclude it.
    [Fact]
    public async Task The_topology_lock_waits_for_collab_s_shared_lock()
    {
        var workspace = WorkspaceId.From(Target);
        await using var collab = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await collab.DbContext.Database.ExecuteSqlRawAsync(
            "SELECT pg_advisory_xact_lock_shared(hashtextextended({0}, 0))",
            [$"finance-workspace:{Target:D}"], Cancellation);
        await AssertSecondWaitsAsync(collab, locks => locks.AcquireWorkspaceTopologyAsync(workspace, Cancellation));
    }

    [Fact]
    public async Task A_shared_record_scope_does_not_block_another_shared_one_but_blocks_an_exclusive_one()
    {
        await using var first = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await new AdvisoryLocks(first.DbContext).LockRecordScopeAsync(Tenant, Target, exclusive: false, Cancellation);
        await using (var reader = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            await new AdvisoryLocks(reader.DbContext).LockRecordScopeAsync(Tenant, Target, exclusive: false, Cancellation)
                .AsTask().WaitAsync(TimeSpan.FromSeconds(10), Cancellation);
        }
        await AssertSecondWaitsAsync(first, locks => locks.LockRecordScopeAsync(Tenant, Target, exclusive: true, Cancellation));
    }

    private static ValueTask Acquire(AdvisoryLocks locks, string purpose)
    {
        var token = Cancellation;
        return purpose switch
        {
            "topology" => locks.AcquireWorkspaceTopologyAsync(WorkspaceId.From(Target), token),
            "item" => locks.LockItemStateAsync(ItemId.From(Target), token),
            "habit" => ((IHabitLock)locks).AcquireAsync(ItemId.From(Target), token),
            "files" => locks.LockWorkspaceFilesAsync(WorkspaceId.From(Target), token),
            "scope" => locks.LockRecordScopeAsync(Tenant, Target, true, token),
            "keys" => locks.LockRecordKeysAsync(Tenant, Target, [("f", "v"), ("a", "b")], token),
            "daily" => locks.LockDailyNoteAsync(Target, token),
            "creation" => locks.LockItemCreationAsync(Tenant, Principal, Target, token),
            "replay" => locks.LockNativeReplayAsync(Tenant, Principal, Target, token),
            "tunnel" => locks.LockSiteTunnelConfigAsync(token),
            "site" => locks.LockSiteCreationAsync(Tenant, token),
            "quota" => locks.LockAutomationQuotaAsync(Tenant, Principal, Target, token),
            "import" => locks.LockDocumentImportAsync(Tenant, Target, token),
            "importKey" => locks.LockDocumentImportKeyAsync(Tenant, Principal, "k", token),
            "upload" => locks.LockFileUploadAsync(Tenant, Target, token),
            "uploadKey" => locks.LockFileUploadKeyAsync(Tenant, Principal, "k", token),
            "push" => locks.LockPushSubscriptionAsync(Tenant, Principal, token),
            "worker" => locks.LockWorkerJobKeyAsync(Tenant, Principal, "k", token),
            "tplWorkspace" => locks.LockTemplateWorkspaceAsync(Tenant, Target, token),
            "tplStages" => locks.LockTemplateStagesAsync(Tenant, token),
            "tpl" => locks.LockTemplateAsync(Tenant, Target, token),
            "tplApplication" => locks.LockTemplateApplicationAsync(Tenant, Target, Second, token),
            "tplIdempotency" => locks.LockTemplateIdempotencyAsync(Tenant, Principal, "k", token),
            _ => throw new ArgumentOutOfRangeException(nameof(purpose)),
        };
    }

    private async Task AssertSecondWaitsAsync(NixUnitOfWork first, Func<AdvisoryLocks, ValueTask> acquire)
    {
        await using var second = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var pending = acquire(new AdvisoryLocks(second.DbContext)).AsTask();
        await WaitForDatabaseLockAsync(second);
        Assert.False(pending.IsCompleted);
        await first.CommitAsync(Cancellation);
        await pending.WaitAsync(TimeSpan.FromSeconds(10), Cancellation);
    }

    private async Task WaitForDatabaseLockAsync(NixUnitOfWork waiter)
    {
        var processId = ((NpgsqlConnection)waiter.DbContext.Database.GetDbConnection()).ProcessID;
        await using var connection = await fixture.OpenMigratorConnectionAsync();
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (DateTime.UtcNow < deadline)
        {
            var waiting = await RawSql.CountAsync(connection, null,
                $"SELECT count(*) FROM pg_locks WHERE pid = {processId} AND NOT granted");
            if (waiting > 0)
            {
                return;
            }
            await Task.Delay(10, Cancellation);
        }
        Assert.Fail("The second transaction did not wait for the advisory lock.");
    }
}
