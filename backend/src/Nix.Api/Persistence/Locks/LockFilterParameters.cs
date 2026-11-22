using Nix.Abstractions;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Locks;

/// <summary>
/// Reads the lock ids a bulk statement filters by, once, and hands them over as one array
/// parameter: <c>@closed_lock_ids</c> for the views, <c>@lock_ids</c> for search and the graph.
/// </summary>
/// <remarks>
/// <para>
/// A tenant has few locks, so reading them first costs one index-only scan, and it turns the
/// filter in the statement that follows into a point probe per row with no join size for the
/// planner to misjudge. <see cref="ItemLockSql.ContainerIsOpen"/> records why that matters.
/// </para>
/// <para>
/// The credential is the request's own, never a caller's argument, for the reason
/// <see cref="ItemLockStore"/> gives: nobody can ask what somebody else has unlocked.
/// </para>
/// </remarks>
internal static class LockFilterParameters
{
    /// <summary>The locks this credential has not opened, as <c>@closed_lock_ids</c>.</summary>
    /// <param name="sql">The executor sharing this unit of work's connection and transaction.</param>
    /// <param name="tenant">The tenant the request runs in.</param>
    /// <param name="credential">The credential this request authenticated with.</param>
    /// <param name="clock">Judges grant expiry.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The parameter.</returns>
    internal static async ValueTask<NpgsqlParameter> ClosedLocksAsync(
        NixSqlExecutor sql,
        TenantId tenant,
        CredentialSessionContext credential,
        TimeProvider clock,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(sql);
        ArgumentNullException.ThrowIfNull(credential);
        ArgumentNullException.ThrowIfNull(clock);

        var ids = await sql.ScalarRefAsync<Guid[]>(
            ItemLockSql.ClosedLockIds,
            [
                Tenant(tenant),
                NixParameter.Uuid("credential_id", credential.CredentialId),
                NixParameter.Timestamp("now", clock.GetUtcNow()),
            ],
            cancellationToken).ConfigureAwait(false);

        return Ids("closed_lock_ids", ids);
    }

    /// <summary>Every lock in the tenant, whoever has it open, as <c>@lock_ids</c>.</summary>
    /// <param name="sql">The executor sharing this unit of work's connection and transaction.</param>
    /// <param name="tenant">The tenant the request runs in.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The parameter.</returns>
    internal static async ValueTask<NpgsqlParameter> AllLocksAsync(
        NixSqlExecutor sql,
        TenantId tenant,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(sql);

        var ids = await sql.ScalarRefAsync<Guid[]>(
            ItemLockSql.AllLockIds,
            [Tenant(tenant)],
            cancellationToken).ConfigureAwait(false);

        return Ids("lock_ids", ids);
    }

    private static NpgsqlParameter Tenant(TenantId tenant) =>
        new("tenant_id", NpgsqlDbType.Uuid) { Value = tenant.Value };

    private static NpgsqlParameter Ids(string name, Guid[]? ids) =>
        new(name, NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = ids ?? [] };
}
