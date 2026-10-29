namespace Nix.Abstractions.Workers;

public interface IWorkerDispatchStore
{
    public ValueTask<IReadOnlyList<DispatchedWorkerJob>> LeaseJobsAsync(string? kind, string owner, int limit, int leaseSeconds, CancellationToken cancellationToken);
    public ValueTask<DispatchedWorkerJob?> ClaimJobAsync(Guid jobId, string owner, int leaseSeconds, CancellationToken cancellationToken);
    public ValueTask<bool> RenewJobAsync(Guid jobId, string owner, int leaseSeconds, CancellationToken cancellationToken);
    public ValueTask<WorkerExecutionState?> GetJobStateAsync(Guid jobId, string owner, CancellationToken cancellationToken);
    public ValueTask<WorkerExecutionAuthorization?> AuthorizeExecutionAsync(Guid jobId, string owner, CancellationToken cancellationToken);
    public ValueTask<WorkerResultApplication> ApplyResultAsync(Guid jobId, string owner, bool succeeded, bool retryable, string? result, string? errorCode, string? errorDetail, CancellationToken cancellationToken);
    public ValueTask<bool> FinishJobAsync(Guid jobId, string owner, bool succeeded, bool retryable, string? result, string? errorCode, string? errorDetail, CancellationToken cancellationToken);
    public ValueTask<bool> ScheduleExportCleanupAsync(Guid jobId, CancellationToken cancellationToken);
    public ValueTask<IReadOnlyList<DispatchedOutboxEvent>> LeaseOutboxAsync(string? kind, string owner, int limit, int leaseSeconds, CancellationToken cancellationToken);
    public ValueTask<bool> FinishOutboxAsync(Guid eventId, string owner, bool succeeded, string? failureDetail, CancellationToken cancellationToken);
}

public sealed record DispatchedWorkerJob(Guid Id, Guid TenantId, Guid? WorkspaceId, Guid? ActorId, string Kind, string Payload, int Attempts, bool CancellationRequested);
public sealed record WorkerExecutionState(string Status, bool CancellationRequested, bool LeaseOwned, DateTimeOffset? LeaseUntil);
public sealed record WorkerExecutionAuthorization(Guid TenantId, Guid? WorkspaceId, Guid ActorId, string Kind, bool IncludeComments = false);
public sealed record DispatchedOutboxEvent(
    Guid Id,
    Guid TenantId,
    Guid? WorkspaceId,
    Guid? ItemId,
    string Kind,
    string Payload,
    int Attempts,
    DateTimeOffset AvailableAt,
    long? AggregateVersion = null);

public enum WorkerResultApplicationOutcome
{
    Completed,
    RetryScheduled,
    Failed,
    Cancelled,
    InvalidExportResult,
    AlreadyCompleted,
    AlreadyTerminal,
    StaleExecution,
    NotFound,
    InvalidRequest,
}

public sealed record WorkerResultApplication(
    WorkerResultApplicationOutcome Outcome,
    bool RequiresExportCleanup);
