using Nix.Abstractions;
using Nix.Domain.Bookmarks;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Bookmarks;

/// <summary>
/// Reads and writes one principal's shelf, scoped to the session the unit of work was opened with.
/// </summary>
/// <remarks>
/// The acting principal comes from the session context and is never a parameter. Nothing here
/// resolves permissions for itself either: the readable workspaces arrive as an array parameter so
/// the planner evaluates the permission predicate beside the tenant one, and a second authorization
/// path is the one that eventually disagrees with the first.
/// </remarks>
public sealed class BookmarkShelfStore(
    NixSqlExecutor sql,
    INixSessionContextAccessor session)
    : IBookmarkShelf
{
    private readonly INixSessionContextAccessor _session = session;

    private NixSessionContext Session => _session.Current
        ?? throw new InvalidOperationException(
            "No session context has been established for this unit of work. A shelf belongs to a "
            + "specific principal in a specific tenant; there is no anonymous path.");

    private TenantId Tenant => Session.TenantId;

    private PrincipalId Principal => Session.PrincipalId;

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<KeptItem>> ListAsync(
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(readableWorkspaces);

        if (readableWorkspaces.Count == 0)
        {
            // A principal who may read nowhere has nothing on their shelf they can still open.
            // Returning early keeps that a fact about their membership rather than a round trip
            // that was always going to return no rows.
            return [];
        }

        var rows = sql.QueryAsync<KeptItem, KeptItemMapper>(
            BookmarkSql.ListShelf,
            default,
            [
                new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = Tenant.Value },
                new NpgsqlParameter("principal_id", NpgsqlDbType.Uuid) { Value = Principal.Value },
                new NpgsqlParameter("workspace_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid)
                {
                    Value = Identifiers(readableWorkspaces),
                },
            ],
            cancellationToken);

        var kept = new List<KeptItem>();
        await foreach (var row in rows.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            kept.Add(row);
        }

        return kept;
    }

    /// <inheritdoc />
    public async ValueTask<int> CountAsync(CancellationToken cancellationToken)
    {
        var kept = await sql.ScalarOrDefaultAsync<long>(
            BookmarkSql.CountShelf,
            [
                new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = Tenant.Value },
                new NpgsqlParameter("principal_id", NpgsqlDbType.Uuid) { Value = Principal.Value },
            ],
            cancellationToken).ConfigureAwait(false);

        // The shelf is bounded at five hundred by a database trigger, so this cannot overflow an
        // int - and if the bound is ever raised, the checked conversion is the thing that says so
        // rather than a negative count reaching a reader.
        return checked((int)kept);
    }

    /// <inheritdoc />
    public async ValueTask<bool> KeepAsync(
        ItemId itemId,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(readableWorkspaces);

        if (readableWorkspaces.Count == 0)
        {
            return false;
        }

        var written = await sql.ExecuteAsync(
            BookmarkSql.Keep,
            [
                new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = Tenant.Value },
                new NpgsqlParameter("principal_id", NpgsqlDbType.Uuid) { Value = Principal.Value },
                new NpgsqlParameter("item_id", NpgsqlDbType.Uuid) { Value = itemId.Value },
                new NpgsqlParameter("workspace_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid)
                {
                    Value = Identifiers(readableWorkspaces),
                },
            ],
            cancellationToken).ConfigureAwait(false);

        return written > 0;
    }

    /// <inheritdoc />
    public async ValueTask<bool> ReleaseAsync(ItemId itemId, CancellationToken cancellationToken)
    {
        var removed = await sql.ExecuteAsync(
            BookmarkSql.Release,
            [
                new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = Tenant.Value },
                new NpgsqlParameter("principal_id", NpgsqlDbType.Uuid) { Value = Principal.Value },
                new NpgsqlParameter("item_id", NpgsqlDbType.Uuid) { Value = itemId.Value },
            ],
            cancellationToken).ConfigureAwait(false);

        return removed > 0;
    }

    private static Guid[] Identifiers(IReadOnlyList<WorkspaceId> workspaces)
    {
        var identifiers = new Guid[workspaces.Count];
        for (var index = 0; index < workspaces.Count; index++)
        {
            identifiers[index] = workspaces[index].Value;
        }

        return identifiers;
    }

    /// <summary>Reads the five columns the shelf list projects.</summary>
    /// <remarks>
    /// A struct, so the query loop devirtualises. Columns are read left to right because the reader
    /// is opened with sequential access.
    /// </remarks>
    private readonly struct KeptItemMapper : INixRowMapper<KeptItem>
    {
        /// <inheritdoc />
        public KeptItem Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);

            var itemId = reader.GetGuid(0);
            var title = reader.IsDBNull(1) ? null : reader.GetString(1);

            // The type column is NOT NULL and the statement projects it directly, so a null here is
            // a broken statement rather than an item with no body kind.
            var type = reader.IsDBNull(2)
                ? throw new InvalidOperationException(
                    "A shelf row came back with no type. The column is NOT NULL, so the statement "
                    + "has been edited into returning rows it cannot describe.")
                : reader.GetString(2);

            var workspaceId = reader.GetGuid(3);
            var keptAt = reader.GetFieldValue<DateTimeOffset>(4);

            return new KeptItem(
                ItemId.From(itemId),
                title,
                type,
                WorkspaceId.From(workspaceId),
                keptAt);
        }
    }
}
