using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Content;

/// <inheritdoc />
public sealed class PetUsageStore(NixDbContext db, INixSessionContextAccessor session) : IPetUsageStore
{
    /// <inheritdoc />
    public async Task RecordAsync(PetUsageRow row, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(row);
        var caller = session.Current ?? throw new InvalidOperationException("A tenant transaction is required.");
        _ = await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO pet_usage (id, tenant_id, principal_id, pet_id, workspace_id, provider, model, source,
                input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd, started_at, duration_ms)
            VALUES ({Guid.NewGuid()}, {caller.TenantId.Value}, {caller.PrincipalId.Value}, {row.PetId}, {row.WorkspaceId},
                {row.Provider}, {row.Model}, {row.Source}, {row.InputTokens}, {row.CacheReadTokens}, {row.CacheWriteTokens},
                {row.OutputTokens}, {row.CostUsd}, {row.StartedAt}, {row.DurationMs})
            """, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task<IReadOnlyList<PetUsageGroup>> GroupAsync(TenantId tenantId, PrincipalId principalId, string by,
        DateTimeOffset from, DateTimeOffset until, string timeZone, CancellationToken cancellationToken) =>
        await db.Database.SqlQuery<PetUsageGroup>($"""
            SELECT CASE {by} WHEN 'pet' THEN pet_id::text WHEN 'model' THEN model WHEN 'source' THEN source
                       ELSE to_char(started_at AT TIME ZONE {timeZone}, 'YYYY-MM-DD') END AS "Key",
                   COUNT(*)::int AS "Turns",
                   COALESCE(SUM(input_tokens), 0)::bigint AS "InputTokens",
                   COALESCE(SUM(cache_read_tokens), 0)::bigint AS "CacheReadTokens",
                   COALESCE(SUM(cache_write_tokens), 0)::bigint AS "CacheWriteTokens",
                   COALESCE(SUM(output_tokens), 0)::bigint AS "OutputTokens",
                   COALESCE(SUM(cost_usd), 0)::numeric AS "CostUsd"
              FROM pet_usage
             WHERE tenant_id = {tenantId.Value} AND principal_id = {principalId.Value}
               AND started_at >= {from} AND started_at < {until}
             GROUP BY 1
             ORDER BY 1
            """).ToListAsync(cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async Task<decimal> SpentAsync(TenantId tenantId, PrincipalId principalId, DateTimeOffset from, DateTimeOffset until,
        CancellationToken cancellationToken) =>
        await db.Database.SqlQuery<decimal>($"""
            SELECT COALESCE(SUM(cost_usd), 0)::numeric AS "Value"
              FROM pet_usage
             WHERE tenant_id = {tenantId.Value} AND principal_id = {principalId.Value}
               AND started_at >= {from} AND started_at < {until}
            """).SingleAsync(cancellationToken).ConfigureAwait(false);
}
