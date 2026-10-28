using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Links;
using Nix.Domain.Tenancy;
using Nix.Persistence.Locks;
using Nix.Persistence.Search;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Links;

/// <summary>
/// Reads <c>item_link</c>: the edges the collaboration service extracts when it materialises a
/// document.
/// </summary>
/// <remarks>
/// Read-only because the grant is. Core holds <c>SELECT</c> on this table and the collaboration
/// service holds the rest, so there is no write path here to leave out.
/// </remarks>
public sealed class ItemLinks(
    NixSqlExecutor sql,
    INixSessionContextAccessor session,
    CredentialSessionContext credential,
    TimeProvider clock)
    : IItemLinks
{
    private readonly INixSessionContextAccessor _session = session;

    private TenantId Tenant => (_session.Current
        ?? throw new InvalidOperationException(
            "No session context has been established for this unit of work. Backlinks are read on "
            + "behalf of a specific principal in a specific tenant; there is no anonymous path."))
        .TenantId;

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<Backlink>> BacklinksAsync(
        ItemId targetId,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int limit,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(readableWorkspaces);

        if (readableWorkspaces.Count == 0)
        {
            return [];
        }

        var identifiers = new Guid[readableWorkspaces.Count];
        for (var index = 0; index < readableWorkspaces.Count; index++)
        {
            identifiers[index] = readableWorkspaces[index].Value;
        }

        var rows = sql.QueryAsync<Backlink, BacklinkMapper>(
            SearchSql.ItemsLinkingTo,
            default,
            [
                new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = Tenant.Value },
                new NpgsqlParameter("target_item_id", NpgsqlDbType.Uuid) { Value = targetId.Value },
                new NpgsqlParameter("workspace_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = identifiers },
                new NpgsqlParameter("limit", NpgsqlDbType.Integer) { Value = limit },
                await LockFilterParameters.AllLocksAsync(sql, Tenant, cancellationToken).ConfigureAwait(false),
            ],
            cancellationToken);

        var backlinks = new List<Backlink>(limit);
        await foreach (var backlink in rows.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            backlinks.Add(backlink);
        }

        return backlinks;
    }

    /// <summary>
    /// The most ranked co-cited items the related statement probes for derived visibility.
    /// </summary>
    /// <remarks>
    /// Eight times the largest related result. It bounds what the planner may assume about the
    /// per-row ancestor probe; <see cref="SearchSql.CoCitedItems"/> records why that matters.
    /// </remarks>
    internal const int RelatedCandidateLimit = 200;

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<RelatedItem>> RelatedAsync(
        ItemId targetId,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int sourceLimit,
        int limit,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(readableWorkspaces);

        if (readableWorkspaces.Count == 0)
        {
            return [];
        }

        var identifiers = new Guid[readableWorkspaces.Count];
        for (var index = 0; index < readableWorkspaces.Count; index++)
        {
            identifiers[index] = readableWorkspaces[index].Value;
        }

        var rows = sql.QueryAsync<RelatedItem, RelatedItemMapper>(
            SearchSql.CoCitedItems,
            default,
            [
                new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = Tenant.Value },
                new NpgsqlParameter("target_item_id", NpgsqlDbType.Uuid) { Value = targetId.Value },
                new NpgsqlParameter("workspace_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = identifiers },
                new NpgsqlParameter("source_limit", NpgsqlDbType.Integer) { Value = sourceLimit },
                new NpgsqlParameter("candidate_limit", NpgsqlDbType.Integer)
                {
                    Value = Math.Max(limit, RelatedCandidateLimit),
                },
                new NpgsqlParameter("limit", NpgsqlDbType.Integer) { Value = limit },
                await LockFilterParameters.AllLocksAsync(sql, Tenant, cancellationToken).ConfigureAwait(false),
                await LockFilterParameters
                    .ClosedLocksAsync(sql, Tenant, credential, clock, cancellationToken)
                    .ConfigureAwait(false),
            ],
            cancellationToken);

        var related = new List<RelatedItem>(limit);
        await foreach (var item in rows.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            related.Add(item);
        }

        return related;
    }

    /// <summary>Reads a referring item and how often it refers.</summary>
    /// <remarks>A struct, so the query loop devirtualises and allocates nothing per row.</remarks>
    private readonly struct BacklinkMapper : INixRowMapper<Backlink>
    {
        /// <inheritdoc />
        public Backlink Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);

            var source = ItemDigestColumns.Read(reader);

            return new Backlink(source, reader.GetInt32(ItemDigestColumns.Count));
        }
    }

    /// <summary>Reads a co-cited item and how many readable sources it shares with the target.</summary>
    /// <remarks>A struct, so the query loop devirtualises and allocates nothing per row.</remarks>
    private readonly struct RelatedItemMapper : INixRowMapper<RelatedItem>
    {
        /// <inheritdoc />
        public RelatedItem Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);

            return new RelatedItem(ItemDigestColumns.Read(reader), reader.GetInt32(ItemDigestColumns.Count));
        }
    }
}
