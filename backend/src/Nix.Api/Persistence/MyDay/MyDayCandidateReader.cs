using System.Globalization;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Persistence.Locks;
using Nix.Persistence.Query;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.MyDay;

/// <summary>
/// Reads My Day's task and habit candidates in two sequential statements under the query timeout.
/// </summary>
/// <remarks>
/// Run through <see cref="ItemQueryReader.GuardedAsync{T}"/> so a slow or failing statement leaves
/// the request's transaction usable and surfaces as <see cref="ItemQueryFailedException"/>, the same
/// as a workspace query. One extra row is read per kind and dropped: its presence is the truncation
/// flag.
/// </remarks>
public sealed class MyDayCandidateReader(
    NixSqlExecutor sql,
    INixSessionContextAccessor session,
    CredentialSessionContext credential,
    TimeProvider clock)
    : IMyDayCandidates
{
    private readonly INixSessionContextAccessor _session = session;

    private TenantId Tenant => (_session.Current
        ?? throw new InvalidOperationException(
            "No session context has been established for this unit of work. My Day is read on "
            + "behalf of a specific principal in a specific tenant; there is no anonymous path."))
        .TenantId;

    /// <inheritdoc />
    public ValueTask<MyDayCandidates> ReadAsync(
        WorkspaceId workspaceId,
        PrincipalId principalId,
        DateOnly today,
        int taskLimit,
        int habitLimit,
        CancellationToken cancellationToken)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(taskLimit);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(habitLimit);

        return ItemQueryReader.GuardedAsync(
            sql,
            async () =>
            {
                var closedLocks = await LockFilterParameters
                    .ClosedLocksAsync(sql, Tenant, credential, clock, cancellationToken)
                    .ConfigureAwait(false);

                var tasks = await ReadBatchAsync(
                    MyDaySql.Tasks,
                    taskLimit,
                    workspaceId,
                    closedLocks,
                    cancellationToken,
                    new NpgsqlParameter("today", NpgsqlDbType.Text) { Value = today.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) },
                    new NpgsqlParameter("me", NpgsqlDbType.Text) { Value = principalId.ToString() }).ConfigureAwait(false);

                // A parameter instance belongs to one command, so the lock filter is rebuilt.
                var habits = await ReadBatchAsync(
                    MyDaySql.Habits,
                    habitLimit,
                    workspaceId,
                    new NpgsqlParameter("closed_lock_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = closedLocks.Value },
                    cancellationToken).ConfigureAwait(false);

                return new MyDayCandidates(tasks, habits);
            },
            cancellationToken);
    }

    private async ValueTask<MyDayBatch> ReadBatchAsync(
        string statement,
        int limit,
        WorkspaceId workspaceId,
        NpgsqlParameter closedLocks,
        CancellationToken cancellationToken,
        params NpgsqlParameter[] extra)
    {
        var parameters = new List<NpgsqlParameter>(extra.Length + 4)
        {
            new("tenant_id", NpgsqlDbType.Uuid) { Value = Tenant.Value },
            new("workspace_id", NpgsqlDbType.Uuid) { Value = workspaceId.Value },
            closedLocks,
            new("candidate_limit", NpgsqlDbType.Integer) { Value = limit + 1 },
        };
        parameters.AddRange(extra);

        var rows = sql.QueryAsync<Row, RowMapper>(statement, default, [.. parameters], cancellationToken);
        var found = new List<MyDayCandidate>();
        var truncated = false;

        await foreach (var row in rows.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            if (found.Count == limit)
            {
                truncated = true;
                break;
            }

            found.Add(new MyDayCandidate(
                ItemId.From(row.Id),
                workspaceId,
                row.ParentId is { } parent ? ItemId.From(parent) : null,
                row.ContainerTitle,
                row.Title,
                row.Properties,
                row.Recurrence));
        }

        return new MyDayBatch(found, truncated);
    }

    private readonly record struct Row(
        Guid Id,
        Guid? ParentId,
        string? ContainerTitle,
        string? Title,
        string? Properties,
        string? Recurrence);

    /// <summary>Reads the six columns both statements project, left to right for sequential access.</summary>
    private readonly struct RowMapper : INixRowMapper<Row>
    {
        /// <inheritdoc />
        public Row Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);

            return new Row(
                reader.GetGuid(0),
                reader.IsDBNull(1) ? null : reader.GetGuid(1),
                reader.IsDBNull(2) ? null : reader.GetString(2),
                reader.IsDBNull(3) ? null : reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetString(4),
                reader.IsDBNull(5) ? null : reader.GetString(5));
        }
    }
}
