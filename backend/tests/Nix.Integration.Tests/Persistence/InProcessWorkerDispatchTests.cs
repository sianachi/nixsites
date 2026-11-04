using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions.Workers;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.Workers;

namespace Nix.Integration.Tests.Persistence;

/// <summary>The dispatch SQL the in-process hosts rely on: the cleanup delay on the lease and the startup sweep.</summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class InProcessWorkerDispatchTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static readonly string[] ImportAndExportKinds = ["import.nix", "export.pdf"];
    private static readonly string[] OneObjectKey = ["exports/results/x"];
    private static readonly string[] AnotherObjectKey = ["exports/results/y"];
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task An_object_cleanup_is_not_leased_before_its_retention_boundary()
    {
        var notBefore = DateTimeOffset.UtcNow.AddHours(24);
        var early = await SeedJobAsync("object.cleanup", JsonSerializer.Serialize(new { ownerKind = "export", ownerId = Guid.NewGuid(), notBefore, objectKeys = OneObjectKey }));
        var due = await SeedJobAsync("object.cleanup", JsonSerializer.Serialize(new { ownerKind = "export", ownerId = Guid.NewGuid(), notBefore = DateTimeOffset.UtcNow.AddMinutes(-1), objectKeys = AnotherObjectKey }));
        await using var scope = fixture.Application.CreateUnscopedScope();
        var store = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();

        var leased = await store.LeaseJobsAsync("object.cleanup", "nix-api:test:import:1", 10, 60, Cancellation);

        Assert.Contains(leased, job => job.Id == due);
        Assert.DoesNotContain(leased, job => job.Id == early);
    }

    [Fact]
    public async Task The_startup_sweep_fails_only_this_instances_own_running_jobs()
    {
        await using var scope = fixture.Application.CreateUnscopedScope();
        var store = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        var mine = Assert.Single(await store.LeaseJobsAsync("import.nix", "nix-api:host-a:import:1", 1, 60, Cancellation));
        var replicas = Assert.Single(await store.LeaseJobsAsync("import.nix", "nix-api:host-b:import:1", 1, 60, Cancellation));
        var queued = await SeedJobAsync("export.pdf", "{}");

        var interrupted = await store.InterruptJobsAsync("nix-api:host-a:", ImportAndExportKinds, "interrupted_by_restart", Cancellation);

        var only = Assert.Single(interrupted);
        Assert.Equal(mine.Id, only.Id);
        Assert.Equal("failed", (await store.GetJobStateAsync(mine.Id, "nix-api:host-a:import:1", Cancellation))!.Status);
        Assert.Equal("running", (await store.GetJobStateAsync(replicas.Id, "nix-api:host-b:import:1", Cancellation))!.Status);
        Assert.Equal("queued", (await store.GetJobStateAsync(queued, "nobody", Cancellation))!.Status);
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var code = await RawSql.TextListAsync(connection, $"SELECT error_code FROM worker_job WHERE job_id = '{mine.Id}'");
            Assert.Equal("interrupted_by_restart", Assert.Single(code));
        }
    }

    [Fact]
    public async Task A_retry_scheduled_by_the_result_sql_is_not_leased_before_its_delay()
    {
        await using var scope = fixture.Application.CreateUnscopedScope();
        var store = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        var job = Assert.Single(await store.LeaseJobsAsync("import.nix", "nix-api:test:import:1", 1, 60, Cancellation));

        var application = await store.ApplyResultAsync(job.Id, "nix-api:test:import:1", succeeded: false, retryable: true, null, "import_source_unavailable", "temporary", Cancellation);

        Assert.Equal(WorkerResultApplicationOutcome.RetryScheduled, application.Outcome);
        Assert.DoesNotContain(await store.LeaseJobsAsync("import.nix", "nix-api:test:import:2", 10, 60, Cancellation), leased => leased.Id == job.Id);
    }

    private async Task<Guid> SeedJobAsync(string kind, string payload)
    {
        var id = Guid.NewGuid();
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, $"""
                INSERT INTO worker_job (job_id, tenant_id, workspace_id, actor_id, kind, idempotency_key, payload, status, attempts, cancellation_requested, created_at, updated_at)
                VALUES ('{id}', '{M0SchemaSeed.Alpha.TenantId}', '{TestTenants.AlphaWorkspace}', '{TestTenants.AlphaContext.PrincipalId.Value}', '{kind}', 'seed:{id}', '{payload.Replace("'", "''", StringComparison.Ordinal)}'::jsonb, 'queued', 0, false, clock_timestamp(), clock_timestamp())
                """);
        }
        return id;
    }
}
