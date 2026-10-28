using Nix.Abstractions.Workers;
using Nix.Persistence.ObjectStorage;
using Npgsql;
using NpgsqlTypes;

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
    private const string LeaseOutboxSql = "SELECT * FROM nix_lease_worker_outbox(@kind, @owner, @limit, @lease_seconds)";
    private const string FinishOutboxSql = "SELECT nix_finish_worker_outbox(@event_id, @owner, @succeeded, @error)";

    /// <summary>Atomically leases globally queued jobs without exposing an unbounded tenant read.</summary>
    public async ValueTask<IReadOnlyList<DispatchedWorkerJob>> LeaseJobsAsync(
        string? kind,
        string owner,
        int limit,
        int leaseSeconds,
        CancellationToken cancellationToken)
    {
        var results = new List<DispatchedWorkerJob>(limit);
        var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
            var command = new NpgsqlCommand(LeaseJobsSql, connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.Add(Text("kind", kind));
                command.Parameters.Add(Text("owner", owner));
                command.Parameters.Add(new NpgsqlParameter<int>("limit", NpgsqlDbType.Integer) { TypedValue = limit });
                command.Parameters.Add(new NpgsqlParameter<int>("lease_seconds", NpgsqlDbType.Integer) { TypedValue = leaseSeconds });
                var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                await using (reader.ConfigureAwait(false))
                {
                    while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    {
                        results.Add(new DispatchedWorkerJob(
                            reader.GetGuid(0),
                            reader.GetGuid(1),
                            await reader.IsDBNullAsync(2, cancellationToken).ConfigureAwait(false) ? null : reader.GetGuid(2),
                            await reader.IsDBNullAsync(3, cancellationToken).ConfigureAwait(false) ? null : reader.GetGuid(3),
                            reader.GetString(4),
                            reader.GetString(5),
                            reader.GetInt32(6),
                            reader.GetBoolean(7)));
                    }
                }
            }
        }
        return results;
    }

    /// <summary>Claims the exact job named by a broker command and no other queued work.</summary>
    public async ValueTask<DispatchedWorkerJob?> ClaimJobAsync(
        Guid jobId,
        string owner,
        int leaseSeconds,
        CancellationToken cancellationToken)
    {
        var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
            var command = new NpgsqlCommand(ClaimJobSql, connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.Add(Uuid("job_id", jobId));
                command.Parameters.Add(Text("owner", owner));
                command.Parameters.Add(new NpgsqlParameter<int>("lease_seconds", NpgsqlDbType.Integer) { TypedValue = leaseSeconds });
                var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                await using (reader.ConfigureAwait(false))
                {
                    if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    {
                        return null;
                    }

                    return await ReadJobAsync(reader, cancellationToken).ConfigureAwait(false);
                }
            }
        }
    }

    /// <summary>Renews only the live execution named by the broker consumer.</summary>
    public ValueTask<bool> RenewJobAsync(
        Guid jobId,
        string owner,
        int leaseSeconds,
        CancellationToken cancellationToken) => ExecuteBooleanAsync(
            RenewJobSql,
            [
                Uuid("job_id", jobId),
                Text("owner", owner),
                new NpgsqlParameter<int>("lease_seconds", NpgsqlDbType.Integer) { TypedValue = leaseSeconds },
            ],
            cancellationToken);

    /// <summary>Reads only execution control state; job payloads remain available solely on claim.</summary>
    public async ValueTask<WorkerExecutionState?> GetJobStateAsync(
        Guid jobId,
        string owner,
        CancellationToken cancellationToken)
    {
        var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
            var command = new NpgsqlCommand(JobStateSql, connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.Add(Uuid("job_id", jobId));
                command.Parameters.Add(Text("owner", owner));
                var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                await using (reader.ConfigureAwait(false))
                {
                    if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    {
                        return null;
                    }

                    return new WorkerExecutionState(
                        reader.GetString(0),
                        reader.GetBoolean(1),
                        !await reader.IsDBNullAsync(2, cancellationToken).ConfigureAwait(false)
                            && reader.GetBoolean(2),
                        await reader.IsDBNullAsync(3, cancellationToken).ConfigureAwait(false)
                            ? null
                            : await reader.GetFieldValueAsync<DateTimeOffset>(3, cancellationToken).ConfigureAwait(false));
                }
            }
        }
    }

    /// <summary>Resolves the tenant and actor only for an active principal holding this exact live execution.</summary>
    public async ValueTask<WorkerExecutionAuthorization?> AuthorizeExecutionAsync(
        Guid jobId,
        string owner,
        CancellationToken cancellationToken)
    {
        var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
            var command = new NpgsqlCommand(AuthorizeExecutionSql, connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.Add(Uuid("job_id", jobId));
                command.Parameters.Add(Text("owner", owner));
                var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                await using (reader.ConfigureAwait(false))
                {
                    if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    {
                        return null;
                    }

                    return new WorkerExecutionAuthorization(
                        reader.GetGuid(0),
                        await reader.IsDBNullAsync(1, cancellationToken).ConfigureAwait(false)
                            ? null
                            : reader.GetGuid(1),
                        reader.GetGuid(2),
                        reader.GetString(3));
                }
            }
        }
    }

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

        var expectedAttemptId = ObjectStorageKeys.ExportAttempt(jobId, owner);
        var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
            var command = new NpgsqlCommand(ApplyResultSql, connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.Add(Uuid("job_id", jobId));
                command.Parameters.Add(Text("owner", owner));
                command.Parameters.Add(Boolean("succeeded", succeeded));
                command.Parameters.Add(Boolean("retryable", retryable));
                command.Parameters.Add(Json("result", result));
                command.Parameters.Add(Text("error_code", errorCode));
                command.Parameters.Add(Text("error_detail", errorDetail));
                command.Parameters.Add(Uuid("expected_attempt_id", expectedAttemptId));
                var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                await using (reader.ConfigureAwait(false))
                {
                    if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    {
                        throw new InvalidOperationException("The worker result application returned no outcome.");
                    }

                    var application = new WorkerResultApplication(
                        ParseApplicationOutcome(reader.GetString(0)),
                        reader.GetBoolean(1));
                    if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    {
                        throw new InvalidOperationException("The worker result application returned multiple outcomes.");
                    }
                    return application;
                }
            }
        }
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
    public ValueTask<bool> ScheduleExportCleanupAsync(
        Guid jobId,
        CancellationToken cancellationToken) => ExecuteBooleanAsync(
            ScheduleExportCleanupSql,
            [Uuid("job_id", jobId)],
            cancellationToken);

    /// <summary>Atomically leases globally queued derived-data events.</summary>
    public async ValueTask<IReadOnlyList<DispatchedOutboxEvent>> LeaseOutboxAsync(
        string? kind,
        string owner,
        int limit,
        int leaseSeconds,
        CancellationToken cancellationToken)
    {
        var results = new List<DispatchedOutboxEvent>(limit);
        var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
            var command = new NpgsqlCommand(LeaseOutboxSql, connection);
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.Add(Text("kind", kind));
                command.Parameters.Add(Text("owner", owner));
                command.Parameters.Add(new NpgsqlParameter<int>("limit", NpgsqlDbType.Integer) { TypedValue = limit });
                command.Parameters.Add(new NpgsqlParameter<int>("lease_seconds", NpgsqlDbType.Integer) { TypedValue = leaseSeconds });
                var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                await using (reader.ConfigureAwait(false))
                {
                    while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    {
                        results.Add(new DispatchedOutboxEvent(
                            reader.GetGuid(0),
                            reader.GetGuid(1),
                            await reader.IsDBNullAsync(2, cancellationToken).ConfigureAwait(false) ? null : reader.GetGuid(2),
                            await reader.IsDBNullAsync(3, cancellationToken).ConfigureAwait(false) ? null : reader.GetGuid(3),
                            reader.GetString(4),
                            reader.GetString(5),
                            reader.GetInt32(6),
                            await reader.GetFieldValueAsync<DateTimeOffset>(7, cancellationToken).ConfigureAwait(false),
                            await reader.IsDBNullAsync(8, cancellationToken).ConfigureAwait(false)
                                ? null
                                : reader.GetInt64(8)));
                    }
                }
            }
        }
        return results;
    }

    /// <summary>Acknowledges or retries an event only while the caller owns its live lease.</summary>
    public ValueTask<bool> FinishOutboxAsync(
        Guid eventId,
        string owner,
        bool succeeded,
        string? failureDetail,
        CancellationToken cancellationToken) => ExecuteBooleanAsync(
            FinishOutboxSql,
            [Uuid("event_id", eventId), Text("owner", owner), Boolean("succeeded", succeeded), Text("error", failureDetail)],
            cancellationToken);

    private async ValueTask<bool> ExecuteBooleanAsync(
        string sql,
        NpgsqlParameter[] parameters,
        CancellationToken cancellationToken)
    {
        var connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using (connection.ConfigureAwait(false))
        {
#pragma warning disable CA2100 // Review SQL queries for security vulnerabilities
            // Justification: every caller passes one of the four constants declared above; values are bound.
            var command = new NpgsqlCommand(sql, connection);
#pragma warning restore CA2100
            await using (command.ConfigureAwait(false))
            {
                command.Parameters.AddRange(parameters);
                var value = await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
                return value is true;
            }
        }
    }

    private static NpgsqlParameter Text(string name, string? value) =>
        new(name, NpgsqlDbType.Text) { Value = value is null ? DBNull.Value : value };

    private static NpgsqlParameter Json(string name, string? value) =>
        new(name, NpgsqlDbType.Jsonb) { Value = value is null ? DBNull.Value : value };

    private static NpgsqlParameter Uuid(string name, Guid value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value };

    private static NpgsqlParameter Boolean(string name, bool value) =>
        new(name, NpgsqlDbType.Boolean) { Value = value };

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

    private static async ValueTask<DispatchedWorkerJob> ReadJobAsync(
        NpgsqlDataReader reader,
        CancellationToken cancellationToken) => new(
            reader.GetGuid(0),
            reader.GetGuid(1),
            await reader.IsDBNullAsync(2, cancellationToken).ConfigureAwait(false) ? null : reader.GetGuid(2),
            await reader.IsDBNullAsync(3, cancellationToken).ConfigureAwait(false) ? null : reader.GetGuid(3),
            reader.GetString(4),
            reader.GetString(5),
            reader.GetInt32(6),
            reader.GetBoolean(7));
}
