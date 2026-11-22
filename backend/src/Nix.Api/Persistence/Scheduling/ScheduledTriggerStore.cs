using Microsoft.EntityFrameworkCore;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Identity;
using Nix.Domain.Scheduling;
using Nix.Domain.Tenancy;
using Npgsql;
using NpgsqlTypes;
using Nix.Persistence.Sql;

namespace Nix.Persistence.Scheduling;

/// <summary>
/// Backs <see cref="IScheduledTriggerStore"/> with plain, row-level-security-scoped SQL. Every
/// call here runs inside a session already scoped to the trigger's own tenant and principal (the
/// planner opens one per recipient before upserting or cancelling; the dispatcher's retry backoff
/// reuses the session it scoped to fire the trigger), so no SECURITY DEFINER elevation is needed.
/// </summary>
public sealed class ScheduledTriggerStore(NixDbContext database) : IScheduledTriggerStore
{
    public async Task<int> UpsertPendingAsync(
        TriggerKind kind,
        string source,
        IReadOnlyCollection<DesiredTrigger> triggers,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(source);
        ArgumentNullException.ThrowIfNull(triggers);
        if (triggers.Count == 0)
        {
            return 0;
        }

        // One row per conflict key: a single INSERT ... ON CONFLICT DO UPDATE may not touch the
        // same row twice.
        var rows = triggers
            .GroupBy(trigger => (trigger.TenantId, trigger.PrincipalId, trigger.DedupeKey))
            .Select(group => group.Last())
            .ToArray();
        foreach (var row in rows)
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(row.DedupeKey, nameof(triggers));
        }

        var now = DateTimeOffset.UtcNow;

        // ON CONFLICT touches the row only when it belongs to this same source and is either
        // cancelled or pending-and-never-retried with something actually different:
        //
        // - Another source's row is never overwritten (ADR-0051 Amendment 3: a source only
        //   manages its own rows), even if two sources ever produced the same dedupe key.
        // - A trigger already leased, fired or skipped must never be resurrected or rescheduled by
        //   replanning, but a cancelled one must be revivable - a due date moved away and back is
        //   exactly the same dedupe key becoming desired again. Reviving resets attempts and any
        //   stale lease fields so it is indistinguishable from a fresh row.
        // - A pending row with attempts > 0 is excluded on purpose (ADR-0051 Amendment 2): the
        //   dispatcher pushed its fire_at out by backoff, and replanning must not overwrite that
        //   backoff with "now" before it elapses.
        // - A pending row already exactly as desired is left alone: every 60-second pass
        //   re-desires every trigger in the 48-hour window, and rewriting unchanged rows would
        //   churn dead tuples and WAL for nothing.
        const string sql = """
            INSERT INTO scheduled_trigger
                (tenant_id, id, workspace_id, principal_id, kind, source, source_item_id, rule_id,
                 fire_at, dedupe_key, status, attempts, created_at, updated_at)
            SELECT desired.tenant_id, desired.id, desired.workspace_id, desired.principal_id, @kind,
                   @source, desired.source_item_id, desired.rule_id, desired.fire_at, desired.dedupe_key,
                   'pending', 0, @now, @now
              FROM unnest(@tenant_ids, @ids, @workspace_ids, @principal_ids, @source_item_ids,
                          @rule_ids, @fire_ats, @dedupe_keys)
                   AS desired(tenant_id, id, workspace_id, principal_id, source_item_id, rule_id,
                              fire_at, dedupe_key)
            ON CONFLICT (tenant_id, principal_id, dedupe_key) DO UPDATE SET
                fire_at = EXCLUDED.fire_at,
                workspace_id = EXCLUDED.workspace_id,
                source_item_id = EXCLUDED.source_item_id,
                rule_id = EXCLUDED.rule_id,
                status = 'pending',
                attempts = 0,
                lease_owner = NULL,
                lease_until = NULL,
                detail = NULL,
                updated_at = EXCLUDED.updated_at
            WHERE scheduled_trigger.source = EXCLUDED.source
              AND (scheduled_trigger.status = 'cancelled'
                   OR (scheduled_trigger.status = 'pending'
                       AND scheduled_trigger.attempts = 0
                       AND (scheduled_trigger.fire_at, scheduled_trigger.workspace_id,
                            scheduled_trigger.source_item_id, scheduled_trigger.rule_id)
                           IS DISTINCT FROM
                           (EXCLUDED.fire_at, EXCLUDED.workspace_id,
                            EXCLUDED.source_item_id, EXCLUDED.rule_id)))
            """;

        return await database.Database.ExecuteSqlRawAsync(
            sql,
            [
                NixParameter.Text("kind", TriggerStorage.ToText(kind)),
                NixParameter.Text("source", source),
                NixParameter.Timestamp("now", now),
                UuidArray("tenant_ids", rows.Select(row => (Guid?)row.TenantId.Value)),
                UuidArray("ids", rows.Select(_ => (Guid?)Guid.CreateVersion7())),
                UuidArray("workspace_ids", rows.Select(row => row.WorkspaceId?.Value)),
                UuidArray("principal_ids", rows.Select(row => (Guid?)row.PrincipalId.Value)),
                UuidArray("source_item_ids", rows.Select(row => row.SourceItemId)),
                UuidArray("rule_ids", rows.Select(row => row.RuleId)),
                NixParameter.TimestampArray("fire_ats", rows.Select(row => row.FireAt.ToUniversalTime()).ToArray()),
                NixParameter.TextArray("dedupe_keys", rows.Select(row => row.DedupeKey).ToArray()),
            ],
            cancellationToken).ConfigureAwait(false);
    }

    private static NpgsqlParameter<Guid?[]> UuidArray(string name, IEnumerable<Guid?> values) =>
        new(name, NpgsqlDbType.Array | NpgsqlDbType.Uuid) { TypedValue = values.ToArray() };

    public async Task<int> CancelStaleAsync(
        TenantId tenantId,
        WorkspaceId? workspaceId,
        PrincipalId principalId,
        TriggerKind kind,
        string source,
        DateTimeOffset windowStart,
        DateTimeOffset windowEnd,
        IReadOnlyCollection<string> desiredDedupeKeys,
        IReadOnlyCollection<Guid> preservedRuleIds,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(source);
        ArgumentNullException.ThrowIfNull(desiredDedupeKeys);
        ArgumentNullException.ThrowIfNull(preservedRuleIds);
        var kindText = TriggerStorage.ToText(kind);
        var now = DateTimeOffset.UtcNow;
        var keys = desiredDedupeKeys.ToArray();
        var preserved = preservedRuleIds.ToArray();
        Guid? workspaceIdValue = workspaceId?.Value;
        return await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE scheduled_trigger
               SET status = 'cancelled', updated_at = {now}
             WHERE tenant_id = {tenantId.Value}
               AND principal_id = {principalId.Value}
               AND workspace_id IS NOT DISTINCT FROM {workspaceIdValue}
               AND kind = {kindText}
               AND source = {source}
               AND status = 'pending'
               AND fire_at >= {windowStart}
               AND fire_at < {windowEnd}
               AND NOT (dedupe_key = ANY({keys}))
               AND (rule_id IS NULL OR NOT (rule_id = ANY({preserved})))
            """, cancellationToken).ConfigureAwait(false);
    }

    public Task<int> CancelForRuleAsync(
        TenantId tenantId,
        PrincipalId principalId,
        Guid ruleId,
        string? source,
        CancellationToken cancellationToken) =>
        database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE scheduled_trigger
               SET status = 'cancelled', updated_at = {DateTimeOffset.UtcNow}
             WHERE tenant_id = {tenantId.Value}
               AND principal_id = {principalId.Value}
               AND kind = 'automation'
               AND ({source}::text IS NULL OR source = {source})
               AND rule_id = {ruleId}
               AND status = 'pending'
            """, cancellationToken);

    public Task RescheduleAsync(TenantId tenantId, Guid id, DateTimeOffset fireAt, CancellationToken cancellationToken) =>
        database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE scheduled_trigger
               SET fire_at = {fireAt}, updated_at = {DateTimeOffset.UtcNow}
             WHERE tenant_id = {tenantId.Value} AND id = {id} AND status = 'pending'
            """, cancellationToken);
}
