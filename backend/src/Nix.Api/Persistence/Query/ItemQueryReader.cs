using System.Collections.Immutable;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Query;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using Nix.Persistence.Locks;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Query;

/// <summary>
/// Runs a query - saved or ad hoc, rows or an aggregate - in one statement, filtered by what the
/// caller may see while it runs.
/// </summary>
/// <remarks>
/// <para>
/// The readable workspaces arrive as an array parameter, so the planner evaluates the permission
/// predicate beside the tenant one - <see cref="Calendar.WorkspaceCalendarReader"/>'s rule,
/// because a cross-container query is bulk disclosure and a limit spent on unreadable rows would
/// make a full list come back looking empty.
/// </para>
/// <para>
/// Truncation is detected by asking for one row more than the ceiling: the extra row is dropped
/// and its existence is the flag. Cheaper than a count, and exact.
/// </para>
/// </remarks>
public sealed class ItemQueryReader(
    NixSqlExecutor sql,
    INixSessionContextAccessor session,
    CredentialSessionContext credential,
    TimeProvider clock)
    : IItemQuery
{
    private readonly NixSqlExecutor _sql = sql;
    private readonly INixSessionContextAccessor _session = session;

    private TenantId Tenant => (_session.Current
        ?? throw new InvalidOperationException(
            "No session context has been established for this unit of work. A query runs on "
            + "behalf of a specific principal in a specific tenant; there is no anonymous path."))
        .TenantId;

    /// <summary>
    /// The longest one query statement may run. A query is a read a person or an assistant waits
    /// on, and one that has not answered by now will not be read when it does.
    /// </summary>
    public const string StatementTimeout = "5s";

    /// <summary>The savepoint each query runs inside, so a failed statement leaves the request usable.</summary>
    private const string Savepoint = "nix_item_query";

    /// <inheritdoc />
    public ValueTask<QueryResults> RunAsync(
        QuerySpec spec,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int limit,
        CancellationToken cancellationToken) =>
        GuardedAsync(_sql, () => RunCoreAsync(spec, readableWorkspaces, limit, cancellationToken), cancellationToken);

    /// <inheritdoc />
    public ValueTask<QueryAggregateResults> AggregateAsync(
        QuerySpec spec,
        QueryAggregate aggregate,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int maximumGroups,
        CancellationToken cancellationToken) =>
        GuardedAsync(_sql, () => AggregateCoreAsync(spec, aggregate, readableWorkspaces, maximumGroups, cancellationToken), cancellationToken);

    /// <summary>
    /// Runs one query inside a savepoint with its own statement timeout, and turns any database
    /// refusal into an <see cref="ItemQueryFailedException"/> the handlers map to a stable code.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The timeout is <c>set_config(..., is_local)</c> - <c>SET LOCAL</c> - inside a savepoint</b>,
    /// so it is undone on failure by the rollback to the savepoint, and on success set back to
    /// what the request had, so no later statement in the request inherits it.
    /// </para>
    /// <para>
    /// <b>No database error reaches the caller as a 500.</b> A statement that fails here has failed
    /// on data or time, never on the caller's grammar (which the handler checked); the savepoint
    /// keeps the request's transaction usable, and the caller gets a code it can show. A
    /// cancellation the client asked for stays a cancellation.
    /// </para>
    /// </remarks>
    internal static async ValueTask<T> GuardedAsync<T>(NixSqlExecutor sql, Func<ValueTask<T>> run, CancellationToken cancellationToken)
    {
        await sql.ExecuteAsync($"SAVEPOINT {Savepoint}", cancellationToken: cancellationToken).ConfigureAwait(false);
        var previous = await sql.ScalarOrDefaultAsync<string>(
            "SELECT current_setting('statement_timeout')",
            cancellationToken: cancellationToken).ConfigureAwait(false) ?? "0";
        await SetTimeoutAsync(sql, StatementTimeout, cancellationToken).ConfigureAwait(false);

        T result;
        try
        {
            result = await run().ConfigureAwait(false);
        }
        catch (PostgresException failure) when (!cancellationToken.IsCancellationRequested)
        {
            await sql.ExecuteAsync($"ROLLBACK TO SAVEPOINT {Savepoint}", cancellationToken: CancellationToken.None).ConfigureAwait(false);
            await sql.ExecuteAsync($"RELEASE SAVEPOINT {Savepoint}", cancellationToken: CancellationToken.None).ConfigureAwait(false);
            throw new ItemQueryFailedException(
                timedOut: failure.SqlState == PostgresErrorCodes.QueryCanceled,
                failure.SqlState,
                failure);
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            // Not a database refusal (an I/O fault, a mapper overflow): still undo the savepoint
            // and its timeout so a caller that continues the transaction does not inherit them,
            // then let the failure surface as it is.
            try
            {
                await sql.ExecuteAsync($"ROLLBACK TO SAVEPOINT {Savepoint}", cancellationToken: CancellationToken.None).ConfigureAwait(false);
                await sql.ExecuteAsync($"RELEASE SAVEPOINT {Savepoint}", cancellationToken: CancellationToken.None).ConfigureAwait(false);
            }
            catch (NpgsqlException)
            {
                // The connection itself is gone; the unit of work rolls the transaction back.
            }

            throw;
        }

        await sql.ExecuteAsync($"RELEASE SAVEPOINT {Savepoint}", cancellationToken: cancellationToken).ConfigureAwait(false);
        await SetTimeoutAsync(sql, previous, cancellationToken).ConfigureAwait(false);
        return result;
    }

    /// <summary><c>SET LOCAL statement_timeout</c>, parameterised.</summary>
    private static async ValueTask SetTimeoutAsync(NixSqlExecutor sql, string value, CancellationToken cancellationToken) =>
        await sql.ExecuteAsync(
            "SELECT set_config('statement_timeout', @timeout, true)",
            [new NpgsqlParameter("timeout", NpgsqlDbType.Text) { Value = value }],
            cancellationToken).ConfigureAwait(false);

    private async ValueTask<QueryResults> RunCoreAsync(
        QuerySpec spec,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int limit,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(spec);
        ArgumentNullException.ThrowIfNull(readableWorkspaces);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(limit);

        if (readableWorkspaces.Count == 0)
        {
            // A principal who may read nowhere matches nothing. Returning early keeps that a fact
            // about their membership rather than a round trip that was always going to be empty.
            return QueryResults.Empty;
        }

        var compiled = QuerySql.Compile(spec);
        var parameters = await FixedParametersAsync(compiled, spec, readableWorkspaces, cancellationToken).ConfigureAwait(false);

        // One more than the ceiling: the extra row is the truncation flag, and is never returned.
        parameters.Add(new NpgsqlParameter("limit", NpgsqlDbType.Integer) { Value = limit + 1 });

        var rows = _sql.QueryAsync<QueryRow, QueryRowMapper>(
            compiled.Sql,
            default,
            [.. parameters],
            cancellationToken);

        var items = new List<QueryResultItem>();
        var groups = new List<QueryGroup>();
        var truncated = false;

        await foreach (var row in rows.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            if (items.Count == limit)
            {
                truncated = true;
                break;
            }

            items.Add(new QueryResultItem(
                ItemId.From(row.Id),
                WorkspaceId.From(row.WorkspaceId),
                row.ParentId is { } parent ? ItemId.From(parent) : null,
                row.ContainerTitle,
                row.Title,
                row.Type,
                row.Properties)
            {
                Group = row.GroupKey,
            });

            // Rows arrive grouped, so a new group is always a change from the previous row's.
            if (spec.Grouping is not null
                && (groups.Count == 0 || !string.Equals(groups[^1].Key, row.GroupKey, StringComparison.Ordinal)))
            {
                groups.Add(new QueryGroup(row.GroupKey, row.GroupRows));
            }
        }

        return new QueryResults(items, truncated) { Groups = groups };
    }

    private async ValueTask<QueryAggregateResults> AggregateCoreAsync(
        QuerySpec spec,
        QueryAggregate aggregate,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int maximumGroups,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(spec);
        ArgumentNullException.ThrowIfNull(aggregate);
        ArgumentNullException.ThrowIfNull(readableWorkspaces);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maximumGroups);

        if (readableWorkspaces.Count == 0)
        {
            return QueryAggregateResults.Empty;
        }

        var compiled = QuerySql.CompileAggregate(spec, aggregate);
        var parameters = await FixedParametersAsync(compiled, spec, readableWorkspaces, cancellationToken).ConfigureAwait(false);
        parameters.Add(new NpgsqlParameter("group_limit", NpgsqlDbType.Integer) { Value = maximumGroups });

        var rows = _sql.QueryAsync<AggregateRow, AggregateRowMapper>(
            compiled.Sql,
            default,
            [.. parameters],
            cancellationToken);

        var groups = new List<QueryAggregateGroup>();
        AggregateRow? totals = null;

        await foreach (var row in rows.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            totals ??= row;
            if (spec.Grouping is not null && row.GroupRows is { } groupRows)
            {
                groups.Add(new QueryAggregateGroup(row.GroupKey, row.GroupValue, groupRows, row.GroupSkipped ?? 0));
            }
        }

        return totals is { } total
            ? new QueryAggregateResults(groups, total.Value, total.Rows, total.Skipped, total.GroupCount)
            : QueryAggregateResults.Empty;
    }

    /// <summary>The parameters every compiled query binds besides its own rule parameters.</summary>
    private async ValueTask<List<NpgsqlParameter>> FixedParametersAsync(
        CompiledQuery compiled,
        QuerySpec spec,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        CancellationToken cancellationToken)
    {
        var identifiers = new Guid[readableWorkspaces.Count];
        for (var index = 0; index < readableWorkspaces.Count; index++)
        {
            identifiers[index] = readableWorkspaces[index].Value;
        }

        var parameters = new List<NpgsqlParameter>(compiled.Parameters.Count + 7);
        parameters.AddRange(compiled.Parameters);
        parameters.Add(new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = Tenant.Value });
        parameters.Add(new NpgsqlParameter("workspace_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = identifiers });

        if (spec.ExcludedItemId is { } excluded)
        {
            parameters.Add(new NpgsqlParameter("query_item_id", NpgsqlDbType.Uuid) { Value = excluded.Value });
        }

        if (spec.Scope is { } scope)
        {
            parameters.Add(new NpgsqlParameter("scope_parent_id", NpgsqlDbType.Uuid) { Value = scope.ParentId.Value });
        }

        parameters.Add(await LockFilterParameters.ClosedLocksAsync(_sql, Tenant, credential, clock, cancellationToken).ConfigureAwait(false));
        return parameters;
    }

    /// <summary>One row of the compiled statement.</summary>
    /// <remarks>A struct, so streaming allocates only the records that survive into the result.</remarks>
    private readonly record struct QueryRow(
        Guid Id,
        Guid WorkspaceId,
        Guid? ParentId,
        string? ContainerTitle,
        string? Title,
        string Type,
        string? Properties,
        string? GroupKey,
        long GroupRows);

    /// <summary>Reads the statement's columns, left to right for sequential access.</summary>
    private readonly struct QueryRowMapper : INixRowMapper<QueryRow>
    {
        /// <inheritdoc />
        public QueryRow Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);

            var id = reader.GetGuid(0);
            var workspaceId = reader.GetGuid(1);
            var parentId = reader.IsDBNull(2) ? (Guid?)null : reader.GetGuid(2);
            var containerTitle = reader.IsDBNull(3) ? null : reader.GetString(3);
            var title = reader.IsDBNull(4) ? null : reader.GetString(4);
            var type = reader.GetString(5);
            var properties = reader.IsDBNull(6) ? null : reader.GetString(6);

            // Column 7 is last_modified_at, which orders the recency read and is not carried.
            var groupKey = reader.IsDBNull(8) ? null : reader.GetString(8);
            var groupRows = reader.GetInt64(9);

            return new QueryRow(id, workspaceId, parentId, containerTitle, title, type, properties, groupKey, groupRows);
        }
    }

    /// <summary>One row of the aggregate statement: the totals, and one group or none.</summary>
    private readonly record struct AggregateRow(
        long Rows,
        decimal? Value,
        long Skipped,
        long GroupCount,
        string? GroupKey,
        long? GroupRows,
        decimal? GroupValue,
        long? GroupSkipped);

    /// <summary>Reads the aggregate statement's columns, left to right.</summary>
    private readonly struct AggregateRowMapper : INixRowMapper<AggregateRow>
    {
        /// <inheritdoc />
        public AggregateRow Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);

            var rows = reader.GetInt64(0);
            decimal? value = reader.IsDBNull(1) ? null : reader.GetDecimal(1);
            var skipped = reader.GetInt64(2);
            var groupCount = reader.GetInt64(3);
            var groupKey = reader.IsDBNull(4) ? null : reader.GetString(4);
            long? groupRows = reader.IsDBNull(5) ? null : reader.GetInt64(5);
            decimal? groupValue = reader.IsDBNull(6) ? null : reader.GetDecimal(6);
            long? groupSkipped = reader.IsDBNull(7) ? null : reader.GetInt64(7);

            return new AggregateRow(rows, value, skipped, groupCount, groupKey, groupRows, groupValue, groupSkipped);
        }
    }
}
