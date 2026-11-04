using Nix.Abstractions.Workers;

namespace Nix.Workers;

/// <summary>Runs one leased job. Idempotent and stateless: a retry after a crash must be safe.</summary>
public interface IWorkerJobHandler
{
    /// <summary>The exact job kinds this handler runs.</summary>
    public IReadOnlyList<string> Kinds { get; }

    /// <summary>Runs <paramref name="job"/>. Throw <see cref="WorkerJobException"/> for an expected failure; anything else is a retryable fault.</summary>
    public Task<string?> HandleAsync(WorkerExecution job, CancellationToken cancellationToken);
}

/// <summary>A leased job together with the execution identity that owns its lease.</summary>
/// <param name="Job">The leased row.</param>
/// <param name="ExecutionId">The lease owner, sent as <c>x-nix-worker-execution-id</c> on every tenant-scoped call.</param>
public sealed record WorkerExecution(DispatchedWorkerJob Job, string ExecutionId);

/// <summary>An expected job failure with a stable code, the same vocabulary the Go handlers reported.</summary>
public sealed class WorkerJobException : Exception
{
    public WorkerJobException(string code, bool retryable, string detail)
        : base(detail)
    {
        Code = code;
        Retryable = retryable;
    }

    public WorkerJobException()
    {
        Code = "worker_failed";
    }

    public WorkerJobException(string message)
        : base(message)
    {
        Code = "worker_failed";
    }

    public WorkerJobException(string message, Exception innerException)
        : base(message, innerException)
    {
        Code = "worker_failed";
    }

    /// <summary>The error code stored on the job (at most 64 characters).</summary>
    public string Code { get; }

    /// <summary>Whether the job may run again (at most five attempts in total).</summary>
    public bool Retryable { get; }

    /// <summary>A permanent failure.</summary>
    public static WorkerJobException Fail(string code, string detail) => new(code, retryable: false, detail);

    /// <summary>A failure worth another attempt.</summary>
    public static WorkerJobException Retry(string code, string detail) => new(code, retryable: true, detail);
}
