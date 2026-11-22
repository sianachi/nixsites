using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Npgsql;
using static Nix.Persistence.Sql.NixParameter;

namespace Nix.Persistence.Sites;

/// <summary>
/// Calls <c>nix_site_rebuild_candidates</c> directly against the connection pool, with no session
/// context: FORCE ROW LEVEL SECURITY binds even a table owner, and the function crosses tenants only
/// because the migrator role that owns it bypasses it. Same reasoning as the reminder finder.
/// </summary>
public sealed class SiteRebuildCandidateFinder(NpgsqlDataSource dataSource) : ISiteRebuildCandidates
{
    private readonly PooledSql _db = new(dataSource);

    /// <inheritdoc />
    public async Task<IReadOnlyList<SiteRebuildCandidate>> FindAsync(
        DateTimeOffset notBefore, int limit, CancellationToken cancellationToken)
    {
        if (limit is < 1 or > 500)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }

        return await _db.RowsAsync(
            "SELECT * FROM nix_site_rebuild_candidates(@now, @limit)",
            static reader => new SiteRebuildCandidate(
                TenantId.From(reader.GetGuid(0)),
                WorkspaceId.From(reader.GetGuid(1)),
                reader.GetGuid(2),
                PrincipalId.From(reader.GetGuid(3)),
                reader.GetFieldValue<DateTimeOffset>(4),
                reader.GetFieldValue<DateTimeOffset>(5),
                reader.GetInt32(6)),
            cancellationToken,
            Timestamp("now", notBefore),
            Integer("limit", limit)).ConfigureAwait(false);
    }
}
