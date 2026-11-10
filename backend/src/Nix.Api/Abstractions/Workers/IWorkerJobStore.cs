using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions.Workers;

public interface IWorkerJobStore
{
    public ValueTask<WorkerJobRecord> CreateAsync(TenantId tenantId, PrincipalId actorId, WorkspaceId? workspaceId, string kind, string idempotencyKey, string payload, CancellationToken cancellationToken);
    public ValueTask<WorkerJobRecord?> GetAsync(TenantId tenantId, PrincipalId actorId, Guid jobId, CancellationToken cancellationToken);
    public ValueTask<bool> CancelAsync(TenantId tenantId, PrincipalId actorId, Guid jobId, CancellationToken cancellationToken);
    public ValueTask<IReadOnlyList<WorkerJobRecord>> LeaseAsync(TenantId tenantId, string owner, string? kind, int limit, int leaseSeconds, CancellationToken cancellationToken);
    public ValueTask<bool> CompleteAsync(TenantId tenantId, Guid jobId, bool succeeded, string? result, string? errorCode, string? errorDetail, CancellationToken cancellationToken);
}

public sealed record WorkerJobRecord(
    Guid Id,
    string Kind,
    string Status,
    string Payload,
    string? Result,
    string? ErrorCode,
    string? ErrorDetail,
    int Attempts,
    bool CancellationRequested,
    DateTimeOffset CreatedAt,
    DateTimeOffset? CompletedAt,
    WorkspaceId? WorkspaceId = null);

/// <summary>An idempotency key was already bound to a different durable job request.</summary>
public sealed class WorkerJobIdempotencyConflictException : InvalidOperationException
{
    public WorkerJobIdempotencyConflictException()
        : base("The worker job idempotency key is already bound to different work.")
    {
    }

    public WorkerJobIdempotencyConflictException(string message)
        : base(message)
    {
    }

    public WorkerJobIdempotencyConflictException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
