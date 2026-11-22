using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Npgsql;
using static Nix.Persistence.Sql.NixParameter;

namespace Nix.Persistence.Sites;

/// <summary>
/// Calls <c>nix_site_hostname_checks</c> straight on the pool with no session context, as the
/// rebuild finder does: the function crosses tenants only because its migrator owner bypasses RLS,
/// and it returns identifiers, hostnames and instants only.
/// </summary>
public sealed class SiteHostnameCheckFinder(NpgsqlDataSource dataSource) : ISiteHostnameCheckCandidates
{
    private readonly PooledSql _db = new(dataSource);

    /// <inheritdoc />
    public async Task<IReadOnlyList<SiteHostnameCheckCandidate>> FindAsync(int limit, CancellationToken cancellationToken)
    {
        if (limit is < 1 or > 500)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }

        return await _db.RowsAsync(
            "SELECT * FROM nix_site_hostname_checks(@limit)",
            static reader => new SiteHostnameCheckCandidate(
                TenantId.From(reader.GetGuid(0)),
                WorkspaceId.From(reader.GetGuid(1)),
                reader.GetGuid(2),
                PrincipalId.From(reader.GetGuid(3)),
                reader.GetString(4),
                reader.GetFieldValue<DateTimeOffset>(5),
                reader.IsDBNull(6) ? null : reader.GetFieldValue<DateTimeOffset>(6),
                reader.IsDBNull(7) ? null : reader.GetFieldValue<DateTimeOffset>(7),
                reader.GetInt32(8)),
            cancellationToken,
            Integer("limit", limit)).ConfigureAwait(false);
    }
}
