using Microsoft.Extensions.Options;
using Nix.Abstractions.Workers;
using Nix.Workers;
using Nix.Workers.Queue;

namespace Nix.Tests.Workers;

public sealed class WorkerJobHostTests
{
    private static readonly Guid JobId = Guid.Parse("20000000-0000-4000-8000-000000000001");

    [Fact]
    public async Task A_handler_result_is_applied_as_a_success_under_the_leasing_execution()
    {
        var dispatch = new RecordingDispatch();
        using var host = Host(dispatch, new StubHandler(_ => Task.FromResult<string?>("{\"delivered\":1}")));

        await host.RunAsync(Execution(), slot: null, CancellationToken.None);

        var applied = Assert.Single(dispatch.Applied);
        Assert.Equal((JobId, "nix-api:test:notify:x", true, false, "{\"delivered\":1}", null, null), applied);
    }

    [Fact]
    public async Task An_expected_failure_keeps_its_code_and_retryability()
    {
        var dispatch = new RecordingDispatch();
        using var host = Host(dispatch, new StubHandler(_ => throw WorkerJobException.Retry("notify_delivery_unavailable", "503")));

        await host.RunAsync(Execution(), slot: null, CancellationToken.None);

        var applied = Assert.Single(dispatch.Applied);
        Assert.Equal((JobId, "nix-api:test:notify:x", false, true, null, "notify_delivery_unavailable", "503"), applied);
    }

    [Fact]
    public async Task An_unexpected_fault_is_a_retryable_failure_that_names_only_the_exception_type()
    {
        var dispatch = new RecordingDispatch();
        using var host = Host(dispatch, new StubHandler(_ => throw new InvalidOperationException("secret detail")));

        await host.RunAsync(Execution(), slot: null, CancellationToken.None);

        var applied = Assert.Single(dispatch.Applied);
        Assert.Equal("worker_faulted", applied.ErrorCode);
        Assert.True(applied.Retryable);
        Assert.Equal(nameof(InvalidOperationException), applied.ErrorDetail);
    }

    [Fact]
    public async Task A_completed_export_schedules_its_cleanup()
    {
        var dispatch = new RecordingDispatch { Application = new WorkerResultApplication(WorkerResultApplicationOutcome.Completed, RequiresExportCleanup: true) };
        using var host = Host(dispatch, new StubHandler(_ => Task.FromResult<string?>("{}")));

        await host.RunAsync(Execution(), slot: null, CancellationToken.None);

        Assert.Equal(1, dispatch.CleanupCalls);
    }

    [Fact]
    public async Task A_lost_lease_cancels_the_handler_and_applies_nothing()
    {
        var dispatch = new RecordingDispatch { LeaseOwned = false };
        var started = new TaskCompletionSource();
        using var host = Host(dispatch, new StubHandler(async token =>
        {
            started.SetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, token);
            return null;
        }), renewSeconds: 1);

        var run = host.RunAsync(Execution(), slot: null, CancellationToken.None);
        await started.Task;
        await run;

        Assert.Empty(dispatch.Applied);
    }

    [Fact]
    public async Task The_slot_is_released_whatever_the_outcome()
    {
        var dispatch = new RecordingDispatch();
        using var host = Host(dispatch, new StubHandler(_ => throw WorkerJobException.Fail("x", "y")));
        using var slot = new SemaphoreSlim(0, 1);

        await host.RunAsync(Execution(), slot, CancellationToken.None);

        Assert.Equal(1, slot.CurrentCount);
    }

    private static WorkerJobHost Host(RecordingDispatch dispatch, IWorkerJobHandler handler, int renewSeconds = 15) => new(
        JobFamilies.Notify,
        new InProcessJobQueue(new HashSet<string>(StringComparer.Ordinal) { JobFamilies.Notify }),
        dispatch,
        [handler],
        Options.Create(new WorkerOptions { InstanceId = "test", RenewSeconds = renewSeconds }),
        TimeProvider.System);

    private static WorkerExecution Execution() => new(
        new DispatchedWorkerJob(JobId, Guid.NewGuid(), null, Guid.NewGuid(), "notify.push", "{}", 1, false),
        "nix-api:test:notify:x");

    private sealed class StubHandler(Func<CancellationToken, Task<string?>> run) : IWorkerJobHandler
    {
        public IReadOnlyList<string> Kinds { get; } = ["notify.push"];

        public Task<string?> HandleAsync(WorkerExecution job, CancellationToken cancellationToken) => run(cancellationToken);
    }

    private sealed class RecordingDispatch : IWorkerDispatchStore
    {
        public List<(Guid JobId, string Owner, bool Succeeded, bool Retryable, string? Result, string? ErrorCode, string? ErrorDetail)> Applied { get; } = [];
        public WorkerResultApplication Application { get; init; } = new(WorkerResultApplicationOutcome.Completed, RequiresExportCleanup: false);
        public bool LeaseOwned { get; init; } = true;
        public int CleanupCalls { get; private set; }

        public ValueTask<WorkerResultApplication> ApplyResultAsync(Guid jobId, string owner, bool succeeded, bool retryable, string? result, string? errorCode, string? errorDetail, CancellationToken cancellationToken)
        {
            Applied.Add((jobId, owner, succeeded, retryable, result, errorCode, errorDetail));
            return ValueTask.FromResult(Application);
        }

        public ValueTask<bool> ScheduleExportCleanupAsync(Guid jobId, CancellationToken cancellationToken)
        {
            CleanupCalls++;
            return ValueTask.FromResult(true);
        }

        public ValueTask<WorkerExecutionState?> GetJobStateAsync(Guid jobId, string owner, CancellationToken cancellationToken) =>
            ValueTask.FromResult<WorkerExecutionState?>(new WorkerExecutionState("running", false, LeaseOwned, DateTimeOffset.UtcNow.AddMinutes(1)));

        public ValueTask<bool> RenewJobAsync(Guid jobId, string owner, int leaseSeconds, CancellationToken cancellationToken) => ValueTask.FromResult(LeaseOwned);

        public ValueTask<IReadOnlyList<DispatchedWorkerJob>> LeaseJobsAsync(string? kind, string owner, int limit, int leaseSeconds, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<DispatchedWorkerJob?> ClaimJobAsync(Guid jobId, string owner, int leaseSeconds, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<WorkerExecutionAuthorization?> AuthorizeExecutionAsync(Guid jobId, string owner, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<bool> FinishJobAsync(Guid jobId, string owner, bool succeeded, bool retryable, string? result, string? errorCode, string? errorDetail, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<IReadOnlyList<DispatchedWorkerJob>> InterruptJobsAsync(string ownerPrefix, IReadOnlyList<string> kinds, string errorCode, CancellationToken cancellationToken) => throw new NotSupportedException();
    }
}
