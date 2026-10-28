using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions.Workers;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.ObjectStorage;
using Nix.Persistence.Workers;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>Cross-tenant dispatch reveals only leased work and enforces lease ownership.</summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class WorkerDispatchTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    /// <inheritdoc />
    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    /// <inheritdoc />
    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_dispatch_lease_returns_bounded_work_from_multiple_tenants()
    {
        await using var scope = fixture.Application.CreateUnscopedScope();
        var store = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();

        var jobs = await store.LeaseJobsAsync("import.nix", "worker-one", 10, 60, Cancellation);

        Assert.Equal(2, jobs.Count);
        Assert.Equal(2, jobs.Select(job => job.TenantId).Distinct().Count());
        Assert.All(jobs, job => Assert.Equal(1, job.Attempts));
    }

    [Fact]
    public async Task Outbox_events_are_retried_or_acknowledged_by_their_lease_owner()
    {
        await using var scope = fixture.Application.CreateUnscopedScope();
        var store = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        var first = Assert.Single(await store.LeaseOutboxAsync("item.changed", "outbox-publisher", 1, 60, Cancellation));

        Assert.False(await store.FinishOutboxAsync(first.Id, "other", succeeded: true, failureDetail: null, Cancellation));
        Assert.True(await store.FinishOutboxAsync(first.Id, "outbox-publisher", succeeded: false, failureDetail: "temporary", Cancellation));
    }

    [Fact]
    public async Task A_transient_job_failure_is_backed_off_instead_of_completed()
    {
        await using var scope = fixture.Application.CreateUnscopedScope();
        var store = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        var job = Assert.Single(await store.LeaseJobsAsync("import.nix", "worker-one", 1, 60, Cancellation));

        Assert.True(await store.FinishJobAsync(
            job.Id,
            "worker-one",
            succeeded: false,
            retryable: true,
            result: null,
            errorCode: "import_source_unavailable",
            errorDetail: "temporary",
            Cancellation));
        var next = await store.LeaseJobsAsync("import.nix", "worker-two", 10, 60, Cancellation);
        Assert.DoesNotContain(next, leased => leased.Id == job.Id);
    }

    [Fact]
    public async Task A_broker_command_claims_only_the_exact_job_it_names()
    {
        await using var scope = fixture.Application.CreateUnscopedScope();
        var store = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();

        var claimed = await store.ClaimJobAsync(M0SchemaSeed.Alpha.AclEntryId, "worker-one:alpha", 60, Cancellation);

        Assert.NotNull(claimed);
        Assert.Equal(M0SchemaSeed.Alpha.AclEntryId, claimed.Id);
        Assert.Equal(M0SchemaSeed.Alpha.TenantId, claimed.TenantId);
        Assert.Null(await store.ClaimJobAsync(M0SchemaSeed.Alpha.AclEntryId, "worker-two:alpha", 60, Cancellation));
        Assert.NotNull(await store.ClaimJobAsync(M0SchemaSeed.Beta.AclEntryId, "worker-two:beta", 60, Cancellation));
    }

    [Fact]
    public async Task A_live_execution_can_renew_and_observe_its_control_state()
    {
        await using var scope = fixture.Application.CreateUnscopedScope();
        var store = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        var job = Assert.IsType<DispatchedWorkerJob>(
            await store.ClaimJobAsync(M0SchemaSeed.Alpha.AclEntryId, "worker-one:alpha", 60, Cancellation));

        Assert.False(await store.RenewJobAsync(job.Id, "worker-two:alpha", 60, Cancellation));
        Assert.True(await store.RenewJobAsync(job.Id, "worker-one:alpha", 60, Cancellation));

        var ownerState = Assert.IsType<WorkerExecutionState>(
            await store.GetJobStateAsync(job.Id, "worker-one:alpha", Cancellation));
        var observerState = Assert.IsType<WorkerExecutionState>(
            await store.GetJobStateAsync(job.Id, "worker-two:alpha", Cancellation));
        Assert.Equal("running", ownerState.Status);
        Assert.False(ownerState.CancellationRequested);
        Assert.True(ownerState.LeaseOwned);
        Assert.False(observerState.LeaseOwned);
    }

    [Fact]
    public async Task Only_the_live_execution_for_an_active_actor_receives_a_tenant_scope()
    {
        await using var scope = fixture.Application.CreateUnscopedScope();
        var store = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        var job = Assert.IsType<DispatchedWorkerJob>(
            await store.ClaimJobAsync(M0SchemaSeed.Alpha.AclEntryId, "worker-one:alpha", 60, Cancellation));

        Assert.Null(await store.AuthorizeExecutionAsync(job.Id, "worker-two:alpha", Cancellation));
        var authorization = Assert.IsType<WorkerExecutionAuthorization>(
            await store.AuthorizeExecutionAsync(job.Id, "worker-one:alpha", Cancellation));
        Assert.Equal(M0SchemaSeed.Alpha.TenantId, authorization.TenantId);
        Assert.Equal(M0SchemaSeed.Alpha.WorkspaceId, authorization.WorkspaceId);
        Assert.Equal(M0SchemaSeed.Alpha.PrincipalId, authorization.ActorId);
        Assert.Equal("import.nix", authorization.Kind);

        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var command = new NpgsqlCommand(
                "UPDATE principal SET status = 'suspended' WHERE tenant_id = @tenant_id AND principal_id = @principal_id",
                connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.AddWithValue("tenant_id", M0SchemaSeed.Alpha.TenantId);
                command.Parameters.AddWithValue("principal_id", M0SchemaSeed.Alpha.PrincipalId);
                await command.ExecuteNonQueryAsync(Cancellation);
            }
        }

        Assert.Null(await store.AuthorizeExecutionAsync(job.Id, "worker-one:alpha", Cancellation));
    }

    [Fact]
    public async Task Cleanup_execution_survives_actor_suspension_without_broadening_other_jobs()
    {
        Guid cleanupJobId;
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation))
        {
            var cleanup = await ObjectCleanupJobs.QueueAsync(
                work.Resolve<IWorkerJobStore>(),
                TenantId.From(TestTenants.Alpha),
                PrincipalId.From(TestTenants.AlphaPrincipal),
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                "suspended-actor-cleanup",
                Guid.Parse("30000000-0000-4000-8000-000000000002"),
                DateTimeOffset.UtcNow.AddSeconds(-1),
                [$"imports/staging/{TestTenants.Alpha:D}/orphan"],
                Cancellation);
            cleanupJobId = cleanup.Id;
            await work.CommitAsync(Cancellation);
        }

        await using var scope = fixture.Application.CreateUnscopedScope();
        var store = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        Assert.NotNull(await store.ClaimJobAsync(cleanupJobId, "cleanup-worker", 60, Cancellation));

        await using var connection = await fixture.OpenMigratorConnectionAsync();
        var suspend = new NpgsqlCommand(
            "UPDATE principal SET status = 'suspended' WHERE tenant_id = @tenant_id AND principal_id = @principal_id",
            connection);
        await using (suspend.ConfigureAwait(false))
        {
            suspend.Parameters.AddWithValue("tenant_id", M0SchemaSeed.Alpha.TenantId);
            suspend.Parameters.AddWithValue("principal_id", M0SchemaSeed.Alpha.PrincipalId);
            await suspend.ExecuteNonQueryAsync(Cancellation);
        }

        var authorization = Assert.IsType<WorkerExecutionAuthorization>(
            await store.AuthorizeExecutionAsync(cleanupJobId, "cleanup-worker", Cancellation));
        Assert.Equal("object.cleanup", authorization.Kind);
    }

    [Fact]
    public async Task A_transaction_fence_blocks_job_completion_until_the_mutation_commits()
    {
        await using var dispatchScope = fixture.Application.CreateUnscopedScope();
        var dispatch = dispatchScope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        var job = Assert.IsType<DispatchedWorkerJob>(
            await dispatch.ClaimJobAsync(M0SchemaSeed.Alpha.AclEntryId, "worker-one:alpha", 60, Cancellation));
        var authorization = Assert.IsType<WorkerExecutionAuthorization>(
            await dispatch.AuthorizeExecutionAsync(job.Id, "worker-one:alpha", Cancellation));

        await using var work = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation);
        Assert.True(await work.Resolve<IWorkerExecutionFence>().HoldAsync(
            job.Id,
            "worker-one:alpha",
            authorization,
            Cancellation));

        var completion = dispatch.FinishJobAsync(
            job.Id,
            "worker-one:alpha",
            succeeded: true,
            retryable: false,
            result: "{}",
            errorCode: null,
            errorDetail: null,
            Cancellation).AsTask();
        await Task.Delay(100, Cancellation);
        Assert.False(completion.IsCompleted);

        await work.CommitAsync(Cancellation);
        Assert.True(await completion.WaitAsync(TimeSpan.FromSeconds(5), Cancellation));
    }

    [Fact]
    public async Task A_retryable_broker_result_schedules_a_new_durable_command()
    {
        await using var scope = fixture.Application.CreateUnscopedScope();
        var store = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        var job = Assert.IsType<DispatchedWorkerJob>(
            await store.ClaimJobAsync(M0SchemaSeed.Alpha.AclEntryId, "worker-one:alpha", 60, Cancellation));

        Assert.True(await store.FinishJobAsync(
            job.Id,
            "worker-one:alpha",
            succeeded: false,
            retryable: true,
            result: null,
            errorCode: "object_unavailable",
            errorDetail: "temporary",
            Cancellation));

        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            const string sql = """
                SELECT count(*)
                  FROM worker_outbox_event
                 WHERE kind = 'worker.command'
                   AND payload ->> 'jobId' = @job_id
                   AND processed_at IS NULL
                   AND available_at > now()
                """;
            var command = new NpgsqlCommand(sql, connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.AddWithValue("job_id", job.Id.ToString("D"));
                Assert.Equal(1L, await command.ExecuteScalarAsync(Cancellation));
            }
        }
    }

    [Fact]
    public async Task A_future_object_cleanup_is_not_dispatched_before_its_safety_boundary()
    {
        var notBefore = DateTimeOffset.UtcNow.AddHours(2);
        Guid cleanupJobId;
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation))
        {
            var cleanup = await ObjectCleanupJobs.QueueAsync(
                work.Resolve<IWorkerJobStore>(),
                TenantId.From(TestTenants.Alpha),
                PrincipalId.From(TestTenants.AlphaPrincipal),
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                "retention-test",
                Guid.Parse("30000000-0000-4000-8000-000000000001"),
                notBefore,
                [$"exports/results/{TestTenants.Alpha:D}/30000000-0000-4000-8000-000000000001.pdf"],
                Cancellation);
            cleanupJobId = cleanup.Id;
            await work.CommitAsync(Cancellation);
        }

        await using var connection = await fixture.OpenMigratorConnectionAsync();
        var command = new NpgsqlCommand(
            "SELECT available_at FROM worker_outbox_event WHERE payload ->> 'jobId' = @job_id",
            connection);
        await using (command.ConfigureAwait(false))
        {
            command.Parameters.AddWithValue("job_id", cleanupJobId.ToString("D"));
            var availableAt = Assert.IsType<DateTime>(await command.ExecuteScalarAsync(Cancellation));
            Assert.InRange(
                new DateTimeOffset(availableAt, TimeSpan.Zero),
                notBefore.AddMilliseconds(-1),
                notBefore.AddMilliseconds(1));
        }
    }

    [Fact]
    public async Task A_completed_export_schedules_one_exact_cleanup_after_retention()
    {
        Guid exportId;
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation))
        {
            var payload = JsonSerializer.Serialize(new
            {
                itemId = M0SchemaSeed.Alpha.ItemId,
                workspaceId = M0SchemaSeed.Alpha.WorkspaceId,
                format = "pdf",
                scope = "subtree",
                title = "Retention",
                extension = "pdf",
                mediaType = "application/pdf",
                declaredLoss = Array.Empty<string>(),
            });
            var job = await work.Resolve<IWorkerJobStore>().CreateAsync(
                TenantId.From(TestTenants.Alpha),
                PrincipalId.From(TestTenants.AlphaPrincipal),
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                "export.pdf",
                "export-retention-test",
                payload,
                Cancellation);
            exportId = job.Id;
            await work.CommitAsync(Cancellation);
        }

        await using (var scope = fixture.Application.CreateUnscopedScope())
        {
            var store = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
            var claimed = Assert.IsType<DispatchedWorkerJob>(
                await store.ClaimJobAsync(exportId, "exporter:retention", 60, Cancellation));
            var attemptId = ObjectStorageKeys.ExportAttempt(claimed.Id, "exporter:retention");
            var objectKey = ObjectStorageKeys.ExportResult(
                TenantId.From(claimed.TenantId),
                claimed.Id,
                attemptId,
                "pdf");
            var result = JsonSerializer.Serialize(new
            {
                attemptId,
                format = "pdf",
                objectKey,
                itemCount = 1,
                omittedCount = 0,
                byteLength = 100,
                sha256 = new string('a', 64),
                loss = Array.Empty<string>(),
                omissions = Array.Empty<string>(),
            });
            var application = await store.ApplyResultAsync(
                claimed.Id,
                "exporter:retention",
                succeeded: true,
                retryable: false,
                result,
                errorCode: null,
                errorDetail: null,
                Cancellation);
            Assert.Equal(WorkerResultApplicationOutcome.Completed, application.Outcome);
            Assert.True(application.RequiresExportCleanup);
            Assert.True(await store.ScheduleExportCleanupAsync(exportId, Cancellation));
            var redelivery = await store.ApplyResultAsync(
                claimed.Id,
                "exporter:retention",
                succeeded: true,
                retryable: false,
                result,
                errorCode: null,
                errorDetail: null,
                Cancellation);
            Assert.Equal(WorkerResultApplicationOutcome.AlreadyCompleted, redelivery.Outcome);
            Assert.True(redelivery.RequiresExportCleanup);
            Assert.True(await store.ScheduleExportCleanupAsync(exportId, Cancellation));
        }

        await using var connection = await fixture.OpenMigratorConnectionAsync();
        const string sql = """
            SELECT cleanup.payload,
                   command.available_at,
                   source.completed_at
              FROM worker_job cleanup
              JOIN worker_outbox_event command
                ON command.payload ->> 'jobId' = cleanup.job_id::text
              JOIN worker_job source
                ON source.job_id = @export_id
             WHERE cleanup.idempotency_key = 'object.cleanup:export:' || @export_id::text
            """;
        var query = new NpgsqlCommand(sql, connection);
        await using (query.ConfigureAwait(false))
        {
            query.Parameters.AddWithValue("export_id", exportId);
            var reader = await query.ExecuteReaderAsync(Cancellation);
            await using (reader.ConfigureAwait(false))
            {
                Assert.True(await reader.ReadAsync(Cancellation));
                using var payload = JsonDocument.Parse(reader.GetString(0));
                Assert.Equal("export", payload.RootElement.GetProperty("ownerKind").GetString());
                Assert.Equal(exportId, payload.RootElement.GetProperty("ownerId").GetGuid());
                var key = Assert.Single(payload.RootElement.GetProperty("objectKeys").EnumerateArray()).GetString();
                var attemptId = ObjectStorageKeys.ExportAttempt(exportId, "exporter:retention");
                Assert.Equal(
                    $"exports/results/{TestTenants.Alpha:D}/{exportId:D}/{attemptId:D}.pdf",
                    key);
                var availableAt = await reader.GetFieldValueAsync<DateTimeOffset>(1, Cancellation);
                var completedAt = await reader.GetFieldValueAsync<DateTimeOffset>(2, Cancellation);
                Assert.InRange(availableAt, completedAt.AddHours(24), completedAt.AddHours(24).AddMilliseconds(1));
                Assert.False(await reader.ReadAsync(Cancellation));
            }
        }
    }

    [Fact]
    public async Task Cancellation_terminalizes_a_running_job_and_success_cannot_win()
    {
        await using var scope = fixture.Application.CreateUnscopedScope();
        var dispatch = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        var claimed = Assert.IsType<DispatchedWorkerJob>(
            await dispatch.ClaimJobAsync(
                M0SchemaSeed.Alpha.AclEntryId,
                "worker-one:cancellation",
                60,
                Cancellation));

        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation))
        {
            Assert.True(await work.Resolve<IWorkerJobStore>().CancelAsync(
                TenantId.From(TestTenants.Alpha),
                PrincipalId.From(TestTenants.AlphaPrincipal),
                claimed.Id,
                Cancellation));
            await work.CommitAsync(Cancellation);
        }

        var lateSuccess = await dispatch.ApplyResultAsync(
            claimed.Id,
            "worker-one:cancellation",
            succeeded: true,
            retryable: false,
            result: "{}",
            errorCode: null,
            errorDetail: null,
            Cancellation);
        Assert.Equal(WorkerResultApplicationOutcome.AlreadyTerminal, lateSuccess.Outcome);

        var state = Assert.IsType<WorkerExecutionState>(
            await dispatch.GetJobStateAsync(claimed.Id, "worker-one:cancellation", Cancellation));
        Assert.Equal("cancelled", state.Status);
        Assert.True(state.CancellationRequested);
        Assert.False(state.LeaseOwned);
        Assert.Null(state.LeaseUntil);
    }

    [Fact]
    public async Task An_unchanged_fencing_owner_can_complete_after_lease_expiry()
    {
        await using var scope = fixture.Application.CreateUnscopedScope();
        var dispatch = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        var claimed = Assert.IsType<DispatchedWorkerJob>(
            await dispatch.ClaimJobAsync(
                M0SchemaSeed.Alpha.AclEntryId,
                "worker-one:late-result",
                60,
                Cancellation));
        await ExpireLeaseAsync(claimed.Id);

        var application = await dispatch.ApplyResultAsync(
            claimed.Id,
            "worker-one:late-result",
            succeeded: true,
            retryable: false,
            result: "{}",
            errorCode: null,
            errorDetail: null,
            Cancellation);

        Assert.Equal(WorkerResultApplicationOutcome.Completed, application.Outcome);
        var state = Assert.IsType<WorkerExecutionState>(
            await dispatch.GetJobStateAsync(claimed.Id, "worker-one:late-result", Cancellation));
        Assert.Equal("completed", state.Status);
    }

    [Fact]
    public async Task A_predecessor_result_cannot_complete_after_a_successor_claims_the_job()
    {
        await using var scope = fixture.Application.CreateUnscopedScope();
        var dispatch = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        var first = Assert.IsType<DispatchedWorkerJob>(
            await dispatch.ClaimJobAsync(
                M0SchemaSeed.Alpha.AclEntryId,
                "worker-one:first",
                60,
                Cancellation));
        await ExpireLeaseAsync(first.Id);
        var successor = Assert.IsType<DispatchedWorkerJob>(
            await dispatch.ClaimJobAsync(first.Id, "worker-two:successor", 60, Cancellation));

        var stale = await dispatch.ApplyResultAsync(
            first.Id,
            "worker-one:first",
            succeeded: true,
            retryable: false,
            result: "{}",
            errorCode: null,
            errorDetail: null,
            Cancellation);
        var completed = await dispatch.ApplyResultAsync(
            successor.Id,
            "worker-two:successor",
            succeeded: true,
            retryable: false,
            result: "{}",
            errorCode: null,
            errorDetail: null,
            Cancellation);

        Assert.Equal(WorkerResultApplicationOutcome.StaleExecution, stale.Outcome);
        Assert.Equal(WorkerResultApplicationOutcome.Completed, completed.Outcome);
    }

    [Fact]
    public async Task An_expired_fifth_crashed_attempt_is_terminalized()
    {
        await SetAttemptsAsync(M0SchemaSeed.Alpha.AclEntryId, 4);
        await using var scope = fixture.Application.CreateUnscopedScope();
        var dispatch = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        var fifth = Assert.IsType<DispatchedWorkerJob>(
            await dispatch.ClaimJobAsync(
                M0SchemaSeed.Alpha.AclEntryId,
                "worker-one:fifth",
                60,
                Cancellation));
        Assert.Equal(5, fifth.Attempts);
        await ExpireLeaseAsync(fifth.Id);

        Assert.Null(await dispatch.ClaimJobAsync(
            fifth.Id,
            "worker-two:too-late",
            60,
            Cancellation));
        var state = Assert.IsType<WorkerExecutionState>(
            await dispatch.GetJobStateAsync(fifth.Id, "worker-one:fifth", Cancellation));
        Assert.Equal("failed", state.Status);
        Assert.False(state.LeaseOwned);
        Assert.Null(state.LeaseUntil);

        await using var connection = await fixture.OpenMigratorConnectionAsync();
        var command = new NpgsqlCommand(
            "SELECT error_code FROM worker_job WHERE job_id = @job_id",
            connection);
        await using (command.ConfigureAwait(false))
        {
            command.Parameters.AddWithValue("job_id", fifth.Id);
            Assert.Equal("worker_attempts_exhausted", await command.ExecuteScalarAsync(Cancellation));
        }
    }

    [Fact]
    public async Task A_redelivered_export_result_repairs_failed_cleanup_scheduling()
    {
        var exportId = await CreateExportAsync("cleanup-redelivery-repair");
        await using var scope = fixture.Application.CreateUnscopedScope();
        var dispatch = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        const string owner = "exporter:cleanup-repair";
        var claimed = Assert.IsType<DispatchedWorkerJob>(
            await dispatch.ClaimJobAsync(exportId, owner, 60, Cancellation));
        var result = JsonSerializer.Serialize(ValidExportResult(claimed, owner));
        var completed = await dispatch.ApplyResultAsync(
            exportId,
            owner,
            succeeded: true,
            retryable: false,
            result,
            errorCode: null,
            errorDetail: null,
            Cancellation);
        Assert.Equal(WorkerResultApplicationOutcome.Completed, completed.Outcome);

        await using (var connection = await fixture.OpenMigratorConnectionAsync())
        {
            const string breakCleanup = """
                WITH damaged AS (
                    UPDATE worker_job cleanup
                       SET status = 'failed',
                           attempts = 5,
                           error_code = 'cleanup_failed',
                           error_detail = 'temporary',
                           completed_at = clock_timestamp()
                     WHERE cleanup.idempotency_key = 'object.cleanup:export:' || @export_id::text
                    RETURNING cleanup.job_id)
                UPDATE worker_outbox_event command
                   SET processed_at = clock_timestamp(),
                       lease_owner = NULL,
                       lease_until = NULL
                  FROM damaged
                 WHERE command.payload ->> 'jobId' = damaged.job_id::text
                """;
            var command = new NpgsqlCommand(breakCleanup, connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.AddWithValue("export_id", exportId);
                Assert.NotEqual(0, await command.ExecuteNonQueryAsync(Cancellation));
            }
        }

        var redelivery = await dispatch.ApplyResultAsync(
            exportId,
            owner,
            succeeded: true,
            retryable: false,
            result,
            errorCode: null,
            errorDetail: null,
            Cancellation);
        Assert.Equal(WorkerResultApplicationOutcome.AlreadyCompleted, redelivery.Outcome);
        Assert.True(redelivery.RequiresExportCleanup);
        Assert.True(await dispatch.ScheduleExportCleanupAsync(exportId, Cancellation));

        await using var verification = await fixture.OpenMigratorConnectionAsync();
        const string query = """
            SELECT cleanup.status,
                   cleanup.attempts,
                   cleanup.cancellation_requested,
                   count(*) FILTER (WHERE command.processed_at IS NULL)
              FROM worker_job cleanup
              JOIN worker_outbox_event command
                ON command.payload ->> 'jobId' = cleanup.job_id::text
             WHERE cleanup.idempotency_key = 'object.cleanup:export:' || @export_id::text
             GROUP BY cleanup.status, cleanup.attempts, cleanup.cancellation_requested
            """;
        var verify = new NpgsqlCommand(query, verification);
        await using (verify.ConfigureAwait(false))
        {
            verify.Parameters.AddWithValue("export_id", exportId);
            var reader = await verify.ExecuteReaderAsync(Cancellation);
            await using (reader.ConfigureAwait(false))
            {
                Assert.True(await reader.ReadAsync(Cancellation));
                Assert.Equal("queued", reader.GetString(0));
                Assert.Equal(0, reader.GetInt32(1));
                Assert.False(reader.GetBoolean(2));
                Assert.Equal(1L, reader.GetInt64(3));
                Assert.False(await reader.ReadAsync(Cancellation));
            }
        }
    }

    [Theory]
    [InlineData("attempt")]
    [InlineData("format")]
    [InlineData("object-key")]
    [InlineData("item-count")]
    [InlineData("omitted-count")]
    [InlineData("byte-length")]
    [InlineData("checksum")]
    [InlineData("report-count")]
    [InlineData("report-entry")]
    [InlineData("report-type")]
    [InlineData("unknown-field")]
    [InlineData("missing-result")]
    [InlineData("non-object-result")]
    [InlineData("retryable-success")]
    public async Task A_malformed_active_export_result_is_failed_safely(string defect)
    {
        var exportId = await CreateExportAsync("invalid-result-" + defect);
        await using var scope = fixture.Application.CreateUnscopedScope();
        var dispatch = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        const string owner = "exporter:result-validation";
        var claimed = Assert.IsType<DispatchedWorkerJob>(
            await dispatch.ClaimJobAsync(exportId, owner, 60, Cancellation));
        var result = ValidExportResult(claimed, owner);
        string? resultJson = null;
        var retryable = false;
        switch (defect)
        {
            case "attempt":
                result["attemptId"] = Guid.Parse("40000000-0000-4000-8000-000000000001");
                break;
            case "format":
                result["format"] = "docx";
                break;
            case "object-key":
                result["objectKey"] = "exports/results/another-tenant/result.pdf";
                break;
            case "item-count":
                result["itemCount"] = 0;
                break;
            case "omitted-count":
                result["omittedCount"] = -1;
                break;
            case "byte-length":
                result["byteLength"] = 268_435_457L;
                break;
            case "checksum":
                result["sha256"] = new string('z', 64);
                break;
            case "report-count":
                result["loss"] = Enumerable.Repeat("bounded", 129).ToArray();
                break;
            case "report-entry":
                result["loss"] = new[] { new string('x', 501) };
                break;
            case "report-type":
                result["loss"] = new object[] { new { unexpected = true } };
                break;
            case "unknown-field":
                result["unexpected"] = true;
                break;
            case "missing-result":
                break;
            case "non-object-result":
                resultJson = JsonSerializer.Serialize("not an export result");
                break;
            case "retryable-success":
                retryable = true;
                break;
            default:
                throw new InvalidOperationException("Unknown export result defect.");
        }
        if (defect != "missing-result" && resultJson is null)
        {
            resultJson = JsonSerializer.Serialize(result);
        }

        var application = await dispatch.ApplyResultAsync(
            claimed.Id,
            owner,
            succeeded: true,
            retryable,
            resultJson,
            errorCode: null,
            errorDetail: null,
            Cancellation);

        Assert.Equal(WorkerResultApplicationOutcome.InvalidExportResult, application.Outcome);
        Assert.False(application.RequiresExportCleanup);
        var state = Assert.IsType<WorkerExecutionState>(
            await dispatch.GetJobStateAsync(claimed.Id, owner, Cancellation));
        Assert.Equal("failed", state.Status);
        Assert.False(state.LeaseOwned);
        Assert.Null(state.LeaseUntil);
    }

    private async ValueTask<Guid> CreateExportAsync(string idempotencyKey)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation);
        var payload = JsonSerializer.Serialize(new
        {
            itemId = M0SchemaSeed.Alpha.ItemId,
            workspaceId = M0SchemaSeed.Alpha.WorkspaceId,
            format = "pdf",
            scope = "subtree",
            title = "Result validation",
            extension = "pdf",
            mediaType = "application/pdf",
            declaredLoss = Array.Empty<string>(),
        });
        var job = await work.Resolve<IWorkerJobStore>().CreateAsync(
            TenantId.From(TestTenants.Alpha),
            PrincipalId.From(TestTenants.AlphaPrincipal),
            WorkspaceId.From(TestTenants.AlphaWorkspace),
            "export.pdf",
            idempotencyKey,
            payload,
            Cancellation);
        await work.CommitAsync(Cancellation);
        return job.Id;
    }

    private static Dictionary<string, object?> ValidExportResult(
        DispatchedWorkerJob claimed,
        string owner)
    {
        var attemptId = ObjectStorageKeys.ExportAttempt(claimed.Id, owner);
        return new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["attemptId"] = attemptId,
            ["format"] = "pdf",
            ["objectKey"] = ObjectStorageKeys.ExportResult(
                TenantId.From(claimed.TenantId),
                claimed.Id,
                attemptId,
                "pdf"),
            ["itemCount"] = 1,
            ["omittedCount"] = 0,
            ["byteLength"] = 100L,
            ["sha256"] = new string('a', 64),
            ["loss"] = Array.Empty<string>(),
            ["omissions"] = Array.Empty<string>(),
        };
    }

    private async ValueTask ExpireLeaseAsync(Guid jobId)
    {
        await using var connection = await fixture.OpenMigratorConnectionAsync();
        var command = new NpgsqlCommand(
            "UPDATE worker_job SET lease_until = clock_timestamp() - interval '1 second' WHERE job_id = @job_id",
            connection);
        await using (command.ConfigureAwait(false))
        {
            command.Parameters.AddWithValue("job_id", jobId);
            await command.ExecuteNonQueryAsync(Cancellation);
        }
    }

    private async ValueTask SetAttemptsAsync(Guid jobId, int attempts)
    {
        await using var connection = await fixture.OpenMigratorConnectionAsync();
        var command = new NpgsqlCommand(
            "UPDATE worker_job SET attempts = @attempts WHERE job_id = @job_id",
            connection);
        await using (command.ConfigureAwait(false))
        {
            command.Parameters.AddWithValue("attempts", attempts);
            command.Parameters.AddWithValue("job_id", jobId);
            await command.ExecuteNonQueryAsync(Cancellation);
        }
    }

}
