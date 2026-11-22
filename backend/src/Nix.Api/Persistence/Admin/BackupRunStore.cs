using Nix.Abstractions;
using Nix.Persistence.Sql;
using Npgsql;

namespace Nix.Persistence.Admin;

/// <summary>
/// Calls <c>nix_backup_runs</c> straight on the pool with no session context, as
/// <c>SiteHostnameCheckFinder</c> does: the table is capability-only, reachable by this one
/// definer function and nothing else.
/// </summary>
public sealed class BackupRunStore(NpgsqlDataSource dataSource) : IBackupRunStore
{
    private readonly PooledSql _db = new(dataSource);

    /// <inheritdoc />
    public async Task<IReadOnlyList<BackupRun>> ListAsync(int limit, CancellationToken cancellationToken) => await _db.RowsAsync(
        "SELECT * FROM nix_backup_runs(@limit)",
        static reader => new BackupRun(
            reader.GetGuid(0),
            reader.GetFieldValue<DateTimeOffset>(1),
            reader.GetFieldValue<DateTimeOffset>(2),
            reader.GetString(3),
            reader.GetString(4),
            reader.IsDBNull(5) ? null : reader.GetString(5),
            reader.IsDBNull(6) ? null : reader.GetInt64(6),
            reader.IsDBNull(7) ? null : reader.GetString(7)),
        cancellationToken,
        NixParameter.Integer("limit", limit)).ConfigureAwait(false);
}
