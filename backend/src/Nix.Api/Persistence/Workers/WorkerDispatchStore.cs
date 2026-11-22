using Nix.Abstractions.Workers;
using Nix.Persistence.ObjectStorage;
using Nix.Persistence.Sql;
using Npgsql;
using static Nix.Persistence.Sql.NixParameter;

namespace Nix.Persistence.Workers;

/// <summary>Calls the exact security-definer queue functions outside tenant-scoped transactions.</summary>
public sealed class WorkerDispatchStore(NpgsqlDataSource dataSource) : IWorkerDispatchStore
{
    private const string LeaseJobsSql = "SELECT * FROM nix_lease_worker_jobs(@kind, @owner, @limit, @lease_seconds)";
    private const string ClaimJobSql = "SELECT * FROM nix_claim_worker_job(@job_id, @owner, @lease_seconds)";
    private const string RenewJobSql = "SELECT nix_renew_worker_job(@job_id, @owner, @lease_seconds)";
    private const string JobStateSql = "SELECT * FROM nix_worker_job_state(@job_id, @owner)";
    private const string AuthorizeExecutionSql = "SELECT * FROM nix_authorize_worker_execution(@job_id, @owner)";
    private const string ApplyResultSql = "SELECT * FROM nix_apply_worker_result(@job_id, @owner, @succeeded, @retryable, @result, @error_code, @error_detail, @expected_attempt_id)";
    private const string ScheduleExportCleanupSql = "SELECT nix_schedule_export_result_cleanup(@job_id)";
    private const string InterruptJobsSql = "SELECT * FROM nix_interrupt_worker_jobs(@owner_prefix, @kinds, @error_code)";

    private readonly PooledSql _db = new(dataSource);

    /// <summary>Atomically leases globally queued jobs without exposing an unbounded tenant read.</summary>
    public async ValueTask<IReadOnlyList<DispatchedWorkerJob>> LeaseJobsAsync(
        string? kind,
        string owner,
        int limit,
        int leaseSeconds,
        CancellationToken cancellationToken) => await _db.RowsAsync(
            LeaseJobsSql,
            ReadJob,
            cancellationToken,
            Text("kind", kind),
            Text("owner", owner),
            Integer("limit", limit),
            Integer("lease_seconds", leaseSeconds)).ConfigureAwait(false);

    /// <summary>Claims the exact job named by a broker command and no other queued work.</summary>
    public async ValueTask<DispatchedWorkerJob?> ClaimJobAsync(
        Guid jobId,
        string owner,
        int leaseSeconds,
        CancellationToken cancellationToken) => (await _db.RowsAsync(
            ClaimJobSql,
            ReadJob,
            cancellationToken,
            Uuid("job_id", jobId),
            Text("owner", owner),
            Integer("lease_seconds", leaseSeconds)).ConfigureAwait(false)).FirstOrDefault();

    /// <summary>Renews only the live execution named by the broker consumer.</summary>
    public async ValueTask<bool> RenewJobAsync(
        Guid jobId,
        string owner,
        int leaseSeconds,
        CancellationToken cancellationToken) => await _db.ScalarAsync<bool?>(
            RenewJobSql,
            cancellationToken,
            Uuid("job_id", jobId),
            Text("owner", owner),
            Integer("lease_seconds", leaseSeconds)).ConfigureAwait(false) is true;

    /// <summary>Reads only execution control state; job payloads remain available solely on claim.</summary>
    public async ValueTask<WorkerExecutionState?> GetJobStateAsync(
        Guid jobId,
        string owner,
        CancellationToken cancellationToken) => (await _db.RowsAsync(
            JobStateSql,
            static reader => new WorkerExecutionState(
                reader.GetString(0),
                reader.GetBoolean(1),
                !reader.IsDBNull(2) && reader.GetBoolean(2),
                reader.IsDBNull(3) ? null : reader.GetFieldValue<DateTimeOffset>(3)),
            cancellationToken,
            Uuid("job_id", jobId),
            Text("owner", owner)).ConfigureAwait(false)).FirstOrDefault();

    /// <summary>Resolves the tenant and actor only for an active principal holding this exact live execution.</summary>
    public async ValueTask<WorkerExecutionAuthorization?> AuthorizeExecutionAsync(
        Guid jobId,
        string owner,
        CancellationToken cancellationToken) => (await _db.RowsAsync(
            AuthorizeExecutionSql,
            static reader => new WorkerExecutionAuthorization(
                reader.GetGuid(0),
                reader.IsDBNull(1) ? null : reader.GetGuid(1),
                reader.GetGuid(2),
                reader.GetString(3),
                reader.GetBoolean(4)),
            cancellationToken,
            Uuid("job_id", jobId),
            Text("owner", owner)).ConfigureAwait(false)).FirstOrDefault();

    /// <summary>Atomically validates and applies a fenced worker result.</summary>
    public async ValueTask<WorkerResultApplication> ApplyResultAsync(
        Guid jobId,
        string owner,
        bool succeeded,
        bool retryable,
        string? result,
        string? errorCode,
        string? errorDetail,
        CancellationToken cancellationToken)
    {
        if (jobId == Guid.Empty
            || string.IsNullOrWhiteSpace(owner)
            || owner.Length > 128
            || owner.Any(char.IsControl))
        {
            return new WorkerResultApplication(
                WorkerResultApplicationOutcome.InvalidRequest,
                RequiresExportCleanup: false);
        }

        var rows = await _db.RowsAsync(
            ApplyResultSql,
            static reader => (Outcome: reader.GetString(0), RequiresExportCleanup: reader.GetBoolean(1)),
            cancellationToken,
            Uuid("job_id", jobId),
            Text("owner", owner),
            Boolean("succeeded", succeeded),
            Boolean("retryable", retryable),
            Json("result", result),
            Text("error_code", errorCode),
            Text("error_detail", errorDetail),
            Uuid("expected_attempt_id", ObjectStorageKeys.ExportAttempt(jobId, owner))).ConfigureAwait(false);
        return rows.Count switch
        {
            0 => throw new InvalidOperationException("The worker result application returned no outcome."),
            1 => new WorkerResultApplication(ParseApplicationOutcome(rows[0].Outcome), rows[0].RequiresExportCleanup),
            _ => throw new InvalidOperationException("The worker result application returned multiple outcomes."),
        };
    }

    /// <summary>Compatibility result for the existing internal HTTP completion endpoint.</summary>
    public async ValueTask<bool> FinishJobAsync(
        Guid jobId,
        string owner,
        bool succeeded,
        bool retryable,
        string? result,
        string? errorCode,
        string? errorDetail,
        CancellationToken cancellationToken)
    {
        var application = await ApplyResultAsync(
            jobId,
            owner,
            succeeded,
            retryable,
            result,
            errorCode,
            errorDetail,
            cancellationToken).ConfigureAwait(false);
        return application.Outcome is WorkerResultApplicationOutcome.Completed
            or WorkerResultApplicationOutcome.RetryScheduled
            or WorkerResultApplicationOutcome.Failed
            or WorkerResultApplicationOutcome.Cancelled
            or WorkerResultApplicationOutcome.InvalidExportResult;
    }

    /// <summary>Idempotently schedules deletion of one completed export at the durable retention boundary.</summary>
    public async ValueTask<bool> ScheduleExportCleanupAsync(
        Guid jobId,
        CancellationToken cancellationToken) => await _db.ScalarAsync<bool?>(
            ScheduleExportCleanupSql,
            cancellationToken,
            Uuid("job_id", jobId)).ConfigureAwait(false) is true;

    /// <summary>Fails this instance's own interrupted executions and returns them for per-kind cleanup.</summary>
    public async ValueTask<IReadOnlyList<DispatchedWorkerJob>> InterruptJobsAsync(
        string ownerPrefix,
        IReadOnlyList<string> kinds,
        string errorCode,
        CancellationToken cancellationToken) => await _db.RowsAsync(
            InterruptJobsSql,
            ReadJob,
            cancellationToken,
            Text("owner_prefix", ownerPrefix),
            TextArray("kinds", [.. kinds]),
            Text("error_code", errorCode)).ConfigureAwait(false);

    private static WorkerResultApplicationOutcome ParseApplicationOutcome(string value) => value switch
    {
        "completed" => WorkerResultApplicationOutcome.Completed,
        "retry_scheduled" => WorkerResultApplicationOutcome.RetryScheduled,
        "failed" => WorkerResultApplicationOutcome.Failed,
        "cancelled" => WorkerResultApplicationOutcome.Cancelled,
        "invalid_export_result" => WorkerResultApplicationOutcome.InvalidExportResult,
        "already_completed" => WorkerResultApplicationOutcome.AlreadyCompleted,
        "already_terminal" => WorkerResultApplicationOutcome.AlreadyTerminal,
        "stale_execution" => WorkerResultApplicationOutcome.StaleExecution,
        "not_found" => WorkerResultApplicationOutcome.NotFound,
        "invalid_request" => WorkerResultApplicationOutcome.InvalidRequest,
        _ => throw new InvalidOperationException("The worker result application returned an unknown outcome."),
    };

    private static DispatchedWorkerJob ReadJob(NpgsqlDataReader reader) => new(
        reader.GetGuid(0),
        reader.GetGuid(1),
        reader.IsDBNull(2) ? null : reader.GetGuid(2),
        reader.IsDBNull(3) ? null : reader.GetGuid(3),
        reader.GetString(4),
        reader.GetString(5),
        reader.GetInt32(6),
        reader.GetBoolean(7));
}
