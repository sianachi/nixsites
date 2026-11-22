using Nix.Abstractions.Scheduling;
using Nix.Domain.Identity;
using Nix.Domain.Scheduling;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Npgsql;

namespace Nix.Persistence.Scheduling;

/// <summary>
/// Calls the exact <c>nix_lease_due_triggers</c> and <c>nix_finish_trigger</c> SECURITY DEFINER
/// functions directly against the connection pool, the same way
/// <see cref="Nix.Persistence.ObjectStorage.AbandonedObjectOperationStore"/> calls its own finder:
/// no <see cref="NixDbContext"/> session context is established, and none is needed, because
/// FORCE ROW LEVEL SECURITY on <c>scheduled_trigger</c> binds even a table owner, and these
/// functions cross every tenant only because they are owned by the migrator role, which holds
/// BYPASSRLS - SECURITY DEFINER alone would not be enough.
/// </summary>
public sealed class ScheduledTriggerLeaseStore(NpgsqlDataSource dataSource) : IScheduledTriggerLeaseStore
{
    private readonly PooledSql _db = new(dataSource);

    private const string LeaseSql = "SELECT * FROM nix_lease_due_triggers(@limit, @owner, @lease_seconds, @max_attempts, @sources)";
    private const string FinishSql = "SELECT nix_finish_trigger(@tenant_id, @id, @owner, @status, @detail::jsonb)";

    public async Task<IReadOnlyList<DueTrigger>> LeaseDueAsync(
        int limit,
        string owner,
        int leaseSeconds,
        int maxAttempts,
        IReadOnlyList<string>? sources,
        CancellationToken cancellationToken)
    {
        if (limit is < 1 or > 100)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }
        ArgumentException.ThrowIfNullOrWhiteSpace(owner);
        if (leaseSeconds is < 5 or > 300)
        {
            throw new ArgumentOutOfRangeException(nameof(leaseSeconds));
        }
        if (maxAttempts is < 1 or > 20)
        {
            throw new ArgumentOutOfRangeException(nameof(maxAttempts));
        }

        return await _db.RowsAsync(
            LeaseSql,
            static reader => new DueTrigger(
                TenantId.From(reader.GetGuid(0)),
                reader.GetGuid(1),
                reader.IsDBNull(2) ? null : WorkspaceId.From(reader.GetGuid(2)),
                PrincipalId.From(reader.GetGuid(3)),
                TriggerStorage.KindFromText(reader.GetString(4)),
                reader.GetString(5),
                reader.IsDBNull(6) ? null : reader.GetGuid(6),
                reader.IsDBNull(7) ? null : reader.GetGuid(7),
                reader.GetFieldValue<DateTimeOffset>(8),
                reader.GetString(9),
                reader.GetInt32(10)),
            cancellationToken,
            NixParameter.Integer("limit", limit),
            NixParameter.Text("owner", owner),
            NixParameter.Integer("lease_seconds", leaseSeconds),
            NixParameter.Integer("max_attempts", maxAttempts),
            NixParameter.TextArray("sources", sources?.ToArray())).ConfigureAwait(false);
    }

    public async Task<bool> FinishAsync(TenantId tenantId, Guid id, string owner, TriggerStatus status, string? detailJson, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(owner);
        return await _db.ScalarAsync<bool>(
            FinishSql,
            cancellationToken,
            NixParameter.Uuid("tenant_id", tenantId.Value),
            NixParameter.Uuid("id", id),
            NixParameter.Text("owner", owner),
            NixParameter.Text("status", TriggerStorage.ToText(status)),
            NixParameter.Text("detail", detailJson)).ConfigureAwait(false) == true;
    }
}
