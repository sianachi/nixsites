using System.Globalization;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Recurrence;
using Nix.Domain.Tenancy;
using Nix.Persistence.Locks;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Calendar;

/// <summary>
/// Reads a workspace's repeating items in one statement, filtered by what the caller may see while
/// the statement runs.
/// </summary>
/// <remarks>
/// The readable workspaces arrive as an array parameter so the planner evaluates the permission
/// predicate beside the tenant one - <see cref="WorkspaceCalendarReader"/>'s rule, for its reason.
/// A rule this build cannot interpret comes back as a candidate with a null rule rather than being
/// dropped: the calendar says the item repeats and cannot be placed, which is the honest answer to
/// storage written by a newer build.
/// </remarks>
public sealed class RecurrenceCandidateReader(
    NixSqlExecutor sql,
    INixSessionContextAccessor session,
    CredentialSessionContext credential,
    TimeProvider clock)
    : IRecurrenceCandidates
{
    private readonly INixSessionContextAccessor _session = session;

    private TenantId Tenant => (_session.Current
        ?? throw new InvalidOperationException(
            "No session context has been established for this unit of work. Recurring items are "
            + "read on behalf of a specific principal in a specific tenant; there is no anonymous "
            + "path."))
        .TenantId;

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<RecurringItem>> ReadAsync(
        WorkspaceId workspaceId,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        string firstDay,
        string lastDay,
        int candidateLimit,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(readableWorkspaces);
        ArgumentException.ThrowIfNullOrEmpty(firstDay);
        ArgumentException.ThrowIfNullOrEmpty(lastDay);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(candidateLimit);

        if (readableWorkspaces.Count == 0)
        {
            return [];
        }

        var identifiers = new Guid[readableWorkspaces.Count];
        for (var index = 0; index < readableWorkspaces.Count; index++)
        {
            identifiers[index] = readableWorkspaces[index].Value;
        }

        var rows = sql.QueryAsync<CandidateRow, CandidateRowMapper>(
            RecurrenceSql.WorkspaceRecurrenceCandidates,
            default,
            [
                new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = Tenant.Value },
                new NpgsqlParameter("workspace_id", NpgsqlDbType.Uuid) { Value = workspaceId.Value },
                new NpgsqlParameter("workspace_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = identifiers },
                new NpgsqlParameter("from", NpgsqlDbType.Text) { Value = firstDay },
                new NpgsqlParameter("to", NpgsqlDbType.Text) { Value = lastDay },
                await LockFilterParameters.ClosedLocksAsync(sql, Tenant, credential, clock, cancellationToken).ConfigureAwait(false),
                new NpgsqlParameter("candidate_limit", NpgsqlDbType.Integer) { Value = candidateLimit },
            ],
            cancellationToken);

        var candidates = new List<RecurringItem>();

        await foreach (var row in rows.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            candidates.Add(new RecurringItem(
                ItemId.From(row.ItemId),
                row.ItemTitle,
                ItemId.From(row.ContainerId),
                row.ContainerTitle,
                row.DateProperty,
                ReadAnchor(row.Anchor),
                RecurrenceRuleJson.Read(row.Recurrence)));
        }

        return candidates;
    }

    /// <summary>
    /// The anchor day, or null when the item carries nothing usable on the container's axis.
    /// </summary>
    /// <remarks>
    /// The statement already narrowed the value to its first ten characters, which is a day for a
    /// stored date and for a stored timestamp alike. Text that is not a day is treated as absent
    /// rather than guessed at - the item repeats and cannot be placed, which the caller reports.
    /// </remarks>
    private static DateOnly? ReadAnchor(string? anchor) =>
        anchor is not null
        && DateOnly.TryParseExact(anchor, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day)
            ? day
            : null;

    private readonly record struct CandidateRow(
        Guid ItemId,
        string? ItemTitle,
        Guid ContainerId,
        string? ContainerTitle,
        string DateProperty,
        string? Anchor,
        string? Recurrence);

    /// <summary>Reads the seven columns the candidate statement projects.</summary>
    /// <remarks>
    /// A struct, so the query loop devirtualises. Columns are read left to right because the
    /// reader is opened with sequential access.
    /// </remarks>
    private readonly struct CandidateRowMapper : INixRowMapper<CandidateRow>
    {
        /// <inheritdoc />
        public CandidateRow Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);

            var itemId = reader.GetGuid(0);
            var itemTitle = reader.IsDBNull(1) ? null : reader.GetString(1);
            var containerId = reader.GetGuid(2);
            var containerTitle = reader.IsDBNull(3) ? null : reader.GetString(3);
            var dateProperty = reader.GetString(4);
            var anchor = reader.IsDBNull(5) ? null : reader.GetString(5);
            var recurrence = reader.IsDBNull(6) ? null : reader.GetString(6);

            return new CandidateRow(
                itemId,
                itemTitle,
                containerId,
                containerTitle,
                dateProperty,
                anchor,
                recurrence);
        }
    }
}
