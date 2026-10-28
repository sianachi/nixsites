using Nix.Abstractions;
using Nix.Domain.Calendar;
using Nix.Domain.Items;
using Nix.Domain.Provisioning;
using Nix.Domain.Tenancy;
using Nix.Persistence.Locks;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Calendar;

/// <summary>
/// Collates a workspace's calendars in one statement, filtered by what the caller may see while the
/// statement runs.
/// </summary>
/// <remarks>
/// <para>
/// The readable workspaces arrive as an array parameter, so the planner evaluates the permission
/// predicate beside the tenant one. Nothing here resolves permissions for itself: a second
/// authorization path is the one that eventually disagrees with the first.
/// </para>
/// <para>
/// Results are materialised rather than streamed, because a calendar is drawn all at once and the
/// caller has nothing to do with a partial one. The bound is the ceiling the handler applies, which
/// keeps the materialisation a fixed cost rather than a workspace-sized one.
/// </para>
/// </remarks>
public sealed class WorkspaceCalendarReader(
    NixSqlExecutor sql,
    INixSessionContextAccessor session,
    CredentialSessionContext credential,
    TimeProvider clock)
    : IWorkspaceCalendar
{
    private readonly INixSessionContextAccessor _session = session;

    private TenantId Tenant => (_session.Current
        ?? throw new InvalidOperationException(
            "No session context has been established for this unit of work. A calendar is read on "
            + "behalf of a specific principal in a specific tenant; there is no anonymous path."))
        .TenantId;

    /// <inheritdoc />
    public async ValueTask<WorkspaceCalendar> ReadAsync(
        WorkspaceId workspaceId,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        string firstDay,
        string lastDay,
        int entryLimit,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(readableWorkspaces);
        ArgumentException.ThrowIfNullOrEmpty(firstDay);
        ArgumentException.ThrowIfNullOrEmpty(lastDay);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(entryLimit);

        if (readableWorkspaces.Count == 0)
        {
            // A principal who may read nowhere has nothing scheduled. Returning early keeps that a
            // fact about their membership rather than a round trip that was always going to return
            // no rows.
            return WorkspaceCalendar.Empty;
        }

        var identifiers = new Guid[readableWorkspaces.Count];
        for (var index = 0; index < readableWorkspaces.Count; index++)
        {
            identifiers[index] = readableWorkspaces[index].Value;
        }

        var rows = sql.QueryAsync<CalendarRow, CalendarRowMapper>(
            CalendarSql.WorkspaceCalendar,
            default,
            [
                new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = Tenant.Value },
                new NpgsqlParameter("workspace_id", NpgsqlDbType.Uuid) { Value = workspaceId.Value },
                new NpgsqlParameter("workspace_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = identifiers },
                // Every root generation: a purged root is replaced, and the notes under its successor
                // are as much the workspace's daily notes as those under the original.
                new NpgsqlParameter("daily_root_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid)
                {
                    Value = DeterministicProvisioningId.DailyNotesRootGenerations(workspaceId),
                },
                new NpgsqlParameter("from", NpgsqlDbType.Text) { Value = firstDay },
                new NpgsqlParameter("to", NpgsqlDbType.Text) { Value = lastDay },
                await LockFilterParameters.ClosedLocksAsync(sql, Tenant, credential, clock, cancellationToken).ConfigureAwait(false),
                new NpgsqlParameter("entry_limit", NpgsqlDbType.Integer) { Value = entryLimit },
            ],
            cancellationToken);

        // Not sized to the ceiling. Pre-allocating for the worst case would cost on every read of a
        // workspace holding nine dated items, and the ceiling bounds the worst case rather than
        // describing the ordinary one. Growth doubles into arrays that stay inside the 85 KB budget.
        var entries = new List<CalendarEntry>();
        var unplaceable = new List<UnplaceableCalendar>();

        await foreach (var row in rows.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            if (row.Kind == CalendarRowKind.Entry)
            {
                // The entry arm filters on both of these being non-null, so a null here is a broken
                // statement rather than an undated item. Skipping it quietly would turn an edited
                // statement into a calendar that is merely thinner than it should be.
                entries.Add(new CalendarEntry(
                    ItemId.From(row.ItemId ?? throw new InvalidOperationException(
                        "An entry row came back with no item. The calendar statement projects the "
                        + "child's identifier directly, so this is a statement that has been "
                        + "edited into returning rows it cannot describe.")),
                    row.ItemTitle,
                    ItemId.From(row.ContainerId),
                    row.ContainerTitle,
                    row.DateProperty ?? throw new InvalidOperationException(
                        "An entry row came back with no date property. The calendar statement "
                        + "filters on it being present, so this is a statement that has been "
                        + "edited into returning rows it cannot describe."),
                    row.Value ?? throw new InvalidOperationException(
                        "An entry row came back with no value. The calendar statement filters on "
                        + "it being present, so this is a statement that has been edited into "
                        + "returning rows it cannot describe."))
                {
                    EndProperty = row.EndProperty,
                    EndValue = row.EndValue,
                });
            }
            else
            {
                unplaceable.Add(new UnplaceableCalendar(ItemId.From(row.ContainerId), row.ContainerTitle));
            }
        }

        return new WorkspaceCalendar(entries, unplaceable);
    }

    /// <summary>Which of the two shapes a row of the calendar statement carries.</summary>
    private enum CalendarRowKind
    {
        /// <summary>A dated item.</summary>
        Entry = 0,

        /// <summary>A container offering a calendar that places nothing.</summary>
        Unplaceable = 1,
    }

    /// <summary>
    /// One row of the calendar statement, before it is sorted into an entry or an explanation.
    /// </summary>
    /// <remarks>
    /// A struct, so streaming the window's rows through the mapper allocates only the records that
    /// survive into the result.
    /// </remarks>
    private readonly record struct CalendarRow(
        CalendarRowKind Kind,
        Guid? ItemId,
        string? ItemTitle,
        Guid ContainerId,
        string? ContainerTitle,
        string? DateProperty,
        string? Value,
        string? EndProperty,
        string? EndValue);

    /// <summary>Reads the seven columns both row kinds share.</summary>
    /// <remarks>
    /// A struct, so the query loop devirtualises. Columns are read left to right because the reader
    /// is opened with sequential access.
    /// </remarks>
    private readonly struct CalendarRowMapper : INixRowMapper<CalendarRow>
    {
        /// <inheritdoc />
        public CalendarRow Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);

            var kind = reader.GetInt32(0) == 0 ? CalendarRowKind.Entry : CalendarRowKind.Unplaceable;
            var itemId = reader.IsDBNull(1) ? (Guid?)null : reader.GetGuid(1);
            var itemTitle = reader.IsDBNull(2) ? null : reader.GetString(2);
            var containerId = reader.GetGuid(3);
            var containerTitle = reader.IsDBNull(4) ? null : reader.GetString(4);
            var dateProperty = reader.IsDBNull(5) ? null : reader.GetString(5);
            var value = reader.IsDBNull(6) ? null : reader.GetString(6);
            var endProperty = reader.IsDBNull(7) ? null : reader.GetString(7);
            var endValue = reader.IsDBNull(8) ? null : reader.GetString(8);

            return new CalendarRow(
                kind,
                itemId,
                itemTitle,
                containerId,
                containerTitle,
                dateProperty,
                value,
                endProperty,
                endValue);
        }
    }
}
