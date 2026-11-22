using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Sites;
using Npgsql;

namespace Nix.Persistence.Sites;

/// <summary>EF-backed hostname and approval storage, under the unit of work's tenant.</summary>
public sealed class SiteHostnameStore(NixDbContext database, Nix.Persistence.Sql.NixSqlExecutor sql) : ISiteHostnameStore, ISiteTunnelLock
{
    private const string Savepoint = "site_hostname_guard";
    private const string Mark = "site_hostname_mark";

    /// <inheritdoc />
    public async ValueTask<List<SiteHostname>> LoadForUpdateAsync(Guid siteId, CancellationToken cancellationToken) =>
        await database.SiteHostnames.AsTracking()
            .Where(hostname => hostname.SiteId == siteId)
            .OrderBy(hostname => hostname.Kind).ThenBy(hostname => hostname.Hostname)
            .ToListAsync(cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public void Add(SiteHostname hostname) => database.SiteHostnames.Add(hostname);

    /// <inheritdoc />
    public void Remove(SiteHostname hostname) => database.SiteHostnames.Remove(hostname);

    /// <inheritdoc />
    public async ValueTask<bool> TrySaveAsync(CancellationToken cancellationToken)
    {
        var transaction = database.Database.CurrentTransaction
            ?? throw new InvalidOperationException("Hostname writes run inside a unit of work.");
        await transaction.CreateSavepointAsync(Savepoint, cancellationToken).ConfigureAwait(false);
        try
        {
            await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            await transaction.ReleaseSavepointAsync(Savepoint, cancellationToken).ConfigureAwait(false);
            return true;
        }
        catch (DbUpdateException exception) when (exception.InnerException is PostgresException
        {
            SqlState: PostgresErrorCodes.UniqueViolation,
            ConstraintName: "ux_site_hostname_verified" or "pk_site_hostname",
        })
        {
            await transaction.RollbackToSavepointAsync(Savepoint, cancellationToken).ConfigureAwait(false);
            database.ChangeTracker.Clear();
            return false;
        }
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<Site>> ListPendingApprovalsAsync(CancellationToken cancellationToken) =>
        await database.Sites.AsNoTracking()
            .Where(site => site.ApprovalState == "pending")
            .OrderBy(site => site.ApprovalRequestedAt).ThenBy(site => site.Id)
            .Take(200)
            .ToListAsync(cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask MarkAsync(CancellationToken cancellationToken) =>
        await Transaction().CreateSavepointAsync(Mark, cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask RevertToMarkAsync(CancellationToken cancellationToken)
    {
        await Transaction().RollbackToSavepointAsync(Mark, cancellationToken).ConfigureAwait(false);
        database.ChangeTracker.Clear();
    }

    /// <inheritdoc />
    public async ValueTask LockAsync(CancellationToken cancellationToken) =>
        _ = await sql.ScalarAsync<int>(
            "SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended('site.tunnel_config', 0))) AS held",
            [],
            cancellationToken).ConfigureAwait(false);

    private Microsoft.EntityFrameworkCore.Storage.IDbContextTransaction Transaction() =>
        database.Database.CurrentTransaction ?? throw new InvalidOperationException("Hostname writes run inside a unit of work.");
}
