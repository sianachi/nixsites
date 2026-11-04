using System.Text.Json;
using Nix.Abstractions.Workers;
using Nix.Persistence.RabbitMq;

namespace Nix.Tests.Persistence;

public sealed class RabbitResultConsumerTests
{
    [Fact]
    public void An_identified_success_reaches_authoritative_application_validation()
    {
        var valid = SuccessfulResult();

        Assert.True(RabbitResultConsumer.IsValid(valid));
        Assert.True(RabbitResultConsumer.IsValid(valid with { Result = null }));
        Assert.True(RabbitResultConsumer.IsValid(valid with { Retryable = true }));
        Assert.True(RabbitResultConsumer.IsValid(valid with { ErrorCode = "unexpected" }));
        Assert.True(RabbitResultConsumer.IsValid(valid with { ErrorDetail = new string('x', 2001) }));
        Assert.True(RabbitResultConsumer.IsValid(valid with
        {
            Result = JsonSerializer.SerializeToElement("not an object"),
        }));
    }

    [Fact]
    public void A_failed_result_requires_bounded_error_details_and_no_success_payload()
    {
        var failed = SuccessfulResult() with
        {
            Succeeded = false,
            Result = null,
            ErrorCode = "export_failed",
            ErrorDetail = "The export could not be written.",
        };

        Assert.True(RabbitResultConsumer.IsValid(failed));
        Assert.False(RabbitResultConsumer.IsValid(failed with
        {
            Result = JsonSerializer.SerializeToElement(new { partial = true }),
        }));
        Assert.False(RabbitResultConsumer.IsValid(failed with { ErrorCode = "bad code" }));
        Assert.False(RabbitResultConsumer.IsValid(failed with { ErrorDetail = "   " }));
    }

    [Fact]
    public void A_result_requires_a_timestamp_and_a_clean_exact_execution_identity()
    {
        var valid = SuccessfulResult();

        Assert.False(RabbitResultConsumer.IsValid(valid with { OccurredAt = default }));
        Assert.False(RabbitResultConsumer.IsValid(valid with { ExecutionId = " worker:one" }));
        Assert.False(RabbitResultConsumer.IsValid(valid with { ExecutionId = "worker:\n" }));
        Assert.False(RabbitResultConsumer.IsValid(valid with { TraceParent = new string('a', 513) }));
    }

    [Fact]
    public async Task A_completed_export_is_not_acknowledgeable_until_cleanup_is_durable()
    {
        var dispatch = new ResultDispatch(
            new WorkerResultApplication(
                WorkerResultApplicationOutcome.Completed,
                RequiresExportCleanup: true))
        {
            CleanupScheduled = false,
        };

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            RabbitResultConsumer.ApplyResultAsync(
                dispatch,
                SuccessfulResult(),
                TestContext.Current.CancellationToken).AsTask());

        Assert.Equal(1, dispatch.ApplyCalls);
        Assert.Equal(1, dispatch.CleanupCalls);
    }

    [Fact]
    public async Task A_redelivered_completed_export_repairs_cleanup_before_acknowledgement()
    {
        var dispatch = new ResultDispatch(
            new WorkerResultApplication(
                WorkerResultApplicationOutcome.AlreadyCompleted,
                RequiresExportCleanup: true));

        var application = await RabbitResultConsumer.ApplyResultAsync(
            dispatch,
            SuccessfulResult(),
            TestContext.Current.CancellationToken);

        Assert.Equal(WorkerResultApplicationOutcome.AlreadyCompleted, application.Outcome);
        Assert.Equal(1, dispatch.ApplyCalls);
        Assert.Equal(1, dispatch.CleanupCalls);
    }

    [Fact]
    public async Task An_application_outage_propagates_so_the_delivery_remains_unacknowledged()
    {
        var dispatch = new ResultDispatch(
            new WorkerResultApplication(
                WorkerResultApplicationOutcome.Completed,
                RequiresExportCleanup: false))
        {
            ApplyException = new TimeoutException("database unavailable"),
        };

        await Assert.ThrowsAsync<TimeoutException>(() =>
            RabbitResultConsumer.ApplyResultAsync(
                dispatch,
                SuccessfulResult(),
                TestContext.Current.CancellationToken).AsTask());

        Assert.Equal(0, dispatch.CleanupCalls);
    }

    [Fact]
    public async Task An_invalid_application_outcome_is_not_acknowledgeable()
    {
        var dispatch = new ResultDispatch(
            new WorkerResultApplication(
                WorkerResultApplicationOutcome.InvalidRequest,
                RequiresExportCleanup: false));

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            RabbitResultConsumer.ApplyResultAsync(
                dispatch,
                SuccessfulResult(),
                TestContext.Current.CancellationToken).AsTask());
    }

    private static WorkerResultEnvelope SuccessfulResult() => new(
        SchemaVersion: 1,
        MessageId: Guid.Parse("10000000-0000-4000-8000-000000000001"),
        MessageType: "worker.result.v1",
        OccurredAt: new DateTimeOffset(2026, 9, 1, 12, 0, 0, TimeSpan.Zero),
        JobId: Guid.Parse("20000000-0000-4000-8000-000000000001"),
        ExecutionId: "exporter:30000000-0000-4000-8000-000000000001",
        Succeeded: true,
        Retryable: false,
        Result: JsonSerializer.SerializeToElement(new { value = "bounded" }));

    private sealed class ResultDispatch(WorkerResultApplication application) : IWorkerDispatchStore
    {
        public int ApplyCalls { get; private set; }
        public int CleanupCalls { get; private set; }
        public bool CleanupScheduled { get; init; } = true;
        public Exception? ApplyException { get; init; }

        public ValueTask<WorkerResultApplication> ApplyResultAsync(
            Guid jobId,
            string owner,
            bool succeeded,
            bool retryable,
            string? result,
            string? errorCode,
            string? errorDetail,
            CancellationToken cancellationToken)
        {
            ApplyCalls++;
            return ApplyException is null
                ? ValueTask.FromResult(application)
                : ValueTask.FromException<WorkerResultApplication>(ApplyException);
        }

        public ValueTask<bool> ScheduleExportCleanupAsync(
            Guid jobId,
            CancellationToken cancellationToken)
        {
            CleanupCalls++;
            return ValueTask.FromResult(CleanupScheduled);
        }

        public ValueTask<IReadOnlyList<DispatchedWorkerJob>> LeaseJobsAsync(string? kind, string owner, int limit, int leaseSeconds, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<DispatchedWorkerJob?> ClaimJobAsync(Guid jobId, string owner, int leaseSeconds, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<bool> RenewJobAsync(Guid jobId, string owner, int leaseSeconds, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<WorkerExecutionState?> GetJobStateAsync(Guid jobId, string owner, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<WorkerExecutionAuthorization?> AuthorizeExecutionAsync(Guid jobId, string owner, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<bool> FinishJobAsync(Guid jobId, string owner, bool succeeded, bool retryable, string? result, string? errorCode, string? errorDetail, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<IReadOnlyList<DispatchedOutboxEvent>> LeaseOutboxAsync(string? kind, string owner, int limit, int leaseSeconds, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<IReadOnlyList<DispatchedWorkerJob>> InterruptJobsAsync(string ownerPrefix, IReadOnlyList<string> kinds, string errorCode, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<bool> FinishOutboxAsync(Guid eventId, string owner, bool succeeded, string? failureDetail, CancellationToken cancellationToken) => throw new NotSupportedException();
    }
}
