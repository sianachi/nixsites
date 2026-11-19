using Microsoft.EntityFrameworkCore;
using Nix.Abstractions.Automations;
using Nix.Domain.Automations;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Npgsql;

namespace Nix.Persistence.Automations;

/// <summary>
/// Backs <see cref="IAutomationRuleStore"/> with row-level-security-scoped EF reads and plain SQL
/// writes: every call runs inside a session already scoped to the rule's owner (a request, or the
/// dispatcher's per-trigger session), so the owner policy alone decides what is visible.
/// </summary>
public sealed class AutomationRuleStore(NixDbContext database) : IAutomationRuleStore
{
    private const string RuleWriteSavepoint = "automation_rule_write";
    private const string BoundedConstraint = "automation_rule_bounded";

    public async Task<IReadOnlyList<AutomationRule>> ListAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
        await database.Set<AutomationRule>()
            .AsNoTracking()
            .Where(rule => rule.WorkspaceId == workspaceId)
            .OrderBy(rule => rule.CreatedAt)
            .ThenBy(rule => rule.Id)
            .Take(AutomationGuards.MaxRulesPerOwnerPerWorkspace * 2)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

    public Task<int> CountAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
        database.Set<AutomationRule>()
            .AsNoTracking()
            .CountAsync(rule => rule.WorkspaceId == workspaceId, cancellationToken);

    public Task<AutomationRule?> GetAsync(Guid ruleId, CancellationToken cancellationToken) =>
        database.Set<AutomationRule>()
            .AsNoTracking()
            .SingleOrDefaultAsync(rule => rule.Id == ruleId, cancellationToken);

    public async Task<AutomationRule?> GetForUpdateAsync(Guid ruleId, CancellationToken cancellationToken)
    {
        var rows = await database.Set<AutomationRule>()
            .FromSqlInterpolated($"SELECT * FROM automation_rule WHERE id = {ruleId} FOR NO KEY UPDATE")
            .AsNoTracking()
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        return rows.SingleOrDefault();
    }

    public async Task LockOwnerQuotaAsync(TenantId tenantId, PrincipalId ownerId, WorkspaceId workspaceId, CancellationToken cancellationToken)
    {
        // Transaction-scoped: held until the creating transaction commits or rolls back, so a
        // concurrent create for the same owner and workspace counts only after this one's insert
        // is visible.
        var key = $"nix.automation_rule.quota:{tenantId.Value:D}:{ownerId.Value:D}:{workspaceId.Value:D}";
        await database.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({key}, 0))", cancellationToken).ConfigureAwait(false);
    }

    public async Task<AutomationRuleWrite> InsertAsync(AutomationRule rule, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(rule);
        Guid? scope = rule.ScopeItemId?.Value;
        return await BoundedAsync(() => database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO automation_rule
                (id, tenant_id, workspace_id, owner_principal_id, name, enabled, scope_item_id, trigger_type,
                 watch_key, trigger, conditions, actions, schema_version, revision, consecutive_failures,
                 disabled_reason, last_run_at, created_at, updated_at)
            VALUES ({rule.Id}, {rule.TenantId.Value}, {rule.WorkspaceId.Value}, {rule.OwnerPrincipalId.Value},
                    {rule.Name}, {rule.Enabled}, {scope}, {rule.TriggerType}, {rule.WatchKey},
                    {rule.Trigger}::jsonb, {rule.Conditions}::jsonb, {rule.Actions}::jsonb, {rule.SchemaVersion},
                    {rule.Revision}, 0, NULL, NULL, {rule.CreatedAt}, {rule.UpdatedAt})
            """, cancellationToken), cancellationToken).ConfigureAwait(false);
    }

    public async Task<AutomationRuleWrite> ReplaceAsync(AutomationRule rule, long expectedRevision, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(rule);
        Guid? scope = rule.ScopeItemId?.Value;
        return await BoundedAsync(() => database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE automation_rule
               SET name = {rule.Name},
                   enabled = {rule.Enabled},
                   scope_item_id = {scope},
                   trigger_type = {rule.TriggerType},
                   watch_key = {rule.WatchKey},
                   trigger = {rule.Trigger}::jsonb,
                   conditions = {rule.Conditions}::jsonb,
                   actions = {rule.Actions}::jsonb,
                   schema_version = {rule.SchemaVersion},
                   revision = {rule.Revision},
                   consecutive_failures = {rule.ConsecutiveFailures},
                   disabled_reason = {rule.DisabledReason},
                   updated_at = {rule.UpdatedAt}
             WHERE tenant_id = {rule.TenantId.Value}
               AND id = {rule.Id}
               AND revision = {expectedRevision}
            """, cancellationToken), cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Runs one rule write behind a savepoint and maps the table's own size bound
    /// (<c>automation_rule_bounded</c>) to <see cref="AutomationRuleWrite.OutOfBounds"/>: the
    /// validator's limits are meant to keep a rule well inside it, and this is the backstop for
    /// anything they missed. The savepoint keeps the caller's transaction usable afterwards.
    /// </summary>
    private async Task<AutomationRuleWrite> BoundedAsync(Func<Task<int>> write, CancellationToken cancellationToken)
    {
        await database.Database.ExecuteSqlRawAsync($"SAVEPOINT {RuleWriteSavepoint}", cancellationToken).ConfigureAwait(false);
        int written;
        try
        {
            written = await write().ConfigureAwait(false);
        }
        catch (PostgresException exception) when (exception.SqlState == PostgresErrorCodes.CheckViolation
            && exception.ConstraintName == BoundedConstraint)
        {
            await database.Database.ExecuteSqlRawAsync($"ROLLBACK TO SAVEPOINT {RuleWriteSavepoint}", cancellationToken).ConfigureAwait(false);
            return AutomationRuleWrite.OutOfBounds;
        }

        await database.Database.ExecuteSqlRawAsync($"RELEASE SAVEPOINT {RuleWriteSavepoint}", cancellationToken).ConfigureAwait(false);
        return written == 1 ? AutomationRuleWrite.Written : AutomationRuleWrite.Conflict;
    }

    public async Task<bool> DeleteAsync(Guid ruleId, CancellationToken cancellationToken) =>
        await database.Database.ExecuteSqlInterpolatedAsync(
            $"DELETE FROM automation_rule WHERE id = {ruleId}", cancellationToken).ConfigureAwait(false) == 1;

    public Task RecordSuccessAsync(TenantId tenantId, Guid ruleId, DateTimeOffset at, CancellationToken cancellationToken) =>
        database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE automation_rule
               SET consecutive_failures = 0, last_run_at = {at}
             WHERE tenant_id = {tenantId.Value} AND id = {ruleId}
            """, cancellationToken);

    public async Task<AutomationFailureOutcome?> RecordFailureAsync(TenantId tenantId, Guid ruleId, DateTimeOffset at, CancellationToken cancellationToken)
    {
        // One statement: two failures racing each other still count twice, and only the one that
        // crosses the bound sees the rule turn off (the WHERE enabled keeps a later failure on an
        // already-disabled rule from reporting a second transition).
        var rows = await database.Database.SqlQuery<FailureRow>($"""
            UPDATE automation_rule
               SET consecutive_failures = consecutive_failures + 1,
                   last_run_at = {at},
                   enabled = CASE WHEN consecutive_failures + 1 >= {AutomationGuards.DisableAfterFailures} THEN false ELSE enabled END,
                   disabled_reason = CASE WHEN consecutive_failures + 1 >= {AutomationGuards.DisableAfterFailures} THEN 'repeated_failures' ELSE disabled_reason END,
                   revision = CASE WHEN consecutive_failures + 1 >= {AutomationGuards.DisableAfterFailures} THEN revision + 1 ELSE revision END,
                   updated_at = CASE WHEN consecutive_failures + 1 >= {AutomationGuards.DisableAfterFailures} THEN {at} ELSE updated_at END
             WHERE tenant_id = {tenantId.Value} AND id = {ruleId} AND enabled
            RETURNING consecutive_failures AS "Failures", NOT enabled AS "Disabled", revision AS "Revision"
            """).ToListAsync(cancellationToken).ConfigureAwait(false);
        return rows.Count == 0 ? null : new AutomationFailureOutcome(rows[0].Failures, rows[0].Disabled, rows[0].Revision);
    }

    public async Task<IReadOnlyList<AutomationDateCandidate>> DateCandidatesAsync(
        TenantId tenantId, Guid ruleId, DateOnly firstDay, DateOnly lastDay, int limit, CancellationToken cancellationToken)
    {
        if (limit is < 1 or > AutomationCandidateFinder.MaximumDateCandidates)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }

        var rows = await database.Database.SqlQuery<DateCandidateRow>($"""
            SELECT found.item_id AS "ItemId", found.value_text AS "ValueText", found.cursor_day AS "CursorDay"
              FROM nix_find_automation_date_candidates({tenantId.Value}, {ruleId}, {firstDay}, {lastDay}, {limit}) found
            """).ToListAsync(cancellationToken).ConfigureAwait(false);
        return [.. rows.Select(row => new AutomationDateCandidate(row.ItemId, row.ValueText, row.CursorDay))];
    }

    [System.Diagnostics.CodeAnalysis.SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes", Justification = "EF Core materialises SqlQuery rows through reflection.")]
    private sealed record FailureRow(int Failures, bool Disabled, long Revision);

    [System.Diagnostics.CodeAnalysis.SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes", Justification = "EF Core materialises SqlQuery rows through reflection.")]
    private sealed record DateCandidateRow(Guid ItemId, string? ValueText, string? CursorDay);
}

/// <summary>Backs <see cref="IAutomationRunStore"/> under the owner's row-level security.</summary>
public sealed class AutomationRunStore(NixDbContext database) : IAutomationRunStore
{
    public async Task<bool> TryInsertAsync(AutomationRun run, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(run);
        var origin = AutomationStorage.ToText(run.Origin);
        var status = AutomationStorage.ToText(run.Status);
        var inserted = await database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO automation_run
                (id, tenant_id, rule_id, owner_principal_id, workspace_id, item_id, trigger_key, origin,
                 depth, status, detail, created_at)
            VALUES ({run.Id}, {run.TenantId.Value}, {run.RuleId}, {run.OwnerPrincipalId.Value}, {run.WorkspaceId.Value},
                    {run.ItemId}, {run.TriggerKey}, {origin}, {run.Depth}, {status}, {run.Detail}::jsonb, {run.CreatedAt})
            ON CONFLICT (tenant_id, rule_id, trigger_key) DO NOTHING
            """, cancellationToken).ConfigureAwait(false);
        return inserted == 1;
    }

    public Task UpdateStatusAsync(TenantId tenantId, Guid runId, AutomationRunStatus status, string? detailJson, CancellationToken cancellationToken)
    {
        var text = AutomationStorage.ToText(status);
        return database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE automation_run SET status = {text}, detail = {detailJson}::jsonb
             WHERE tenant_id = {tenantId.Value} AND id = {runId}
            """, cancellationToken);
    }

    public async Task<IReadOnlyList<AutomationRun>> PageAsync(
        TenantId tenantId, Guid ruleId, (DateTimeOffset CreatedAt, Guid Id)? before, int limit, CancellationToken cancellationToken)
    {
        var query = database.Set<AutomationRun>()
            .AsNoTracking()
            .Where(run => run.TenantId == tenantId && run.RuleId == ruleId);
        if (before is { } cursor)
        {
            query = query.Where(run => run.CreatedAt < cursor.CreatedAt
                || (run.CreatedAt == cursor.CreatedAt && run.Id.CompareTo(cursor.Id) < 0));
        }

        return await query
            .OrderByDescending(run => run.CreatedAt)
            .ThenByDescending(run => run.Id)
            .Take(limit)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    public Task<AutomationRun?> GetAsync(TenantId tenantId, Guid runId, CancellationToken cancellationToken) =>
        database.Set<AutomationRun>()
            .AsNoTracking()
            .SingleOrDefaultAsync(run => run.TenantId == tenantId && run.Id == runId, cancellationToken);

    public async Task<int> CountWorkingRunsSinceAsync(TenantId tenantId, Guid ruleId, DateTimeOffset since, CancellationToken cancellationToken)
    {
        // Literal statuses, stated exactly as ix_automation_run_rule_working's predicate states
        // them, so the planner can prove the partial index applies; capped one past the bound,
        // since only "at the bound or not" matters.
        var rows = await database.Database.SqlQuery<int>($"""
            SELECT count(*)::integer AS "Value"
              FROM (SELECT 1
                      FROM automation_run run
                     WHERE run.tenant_id = {tenantId.Value}
                       AND run.rule_id = {ruleId}
                       AND run.created_at >= {since}
                       AND run.status IN ('succeeded', 'noop', 'failed')
                     LIMIT {AutomationGuards.PerRuleHourly + 1}) working
            """).ToListAsync(cancellationToken).ConfigureAwait(false);
        return rows.Count == 0 ? 0 : rows[0];
    }

    public Task<int> TrimAsync(TenantId tenantId, Guid ruleId, int keep, CancellationToken cancellationToken)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(keep, 1);

        // Index-backed on every recorded run: the cutoff is the keep-th newest run's instant, read
        // by walking ix_automation_run_rule_created from the newest end, and everything strictly
        // older goes by a range on the same index. A rule within its bound finds no cutoff row and
        // deletes nothing. Runs sharing the cutoff instant are all kept.
        return database.Database.ExecuteSqlInterpolatedAsync($"""
            DELETE FROM automation_run doomed
             USING (SELECT run.created_at
                      FROM automation_run run
                     WHERE run.tenant_id = {tenantId.Value} AND run.rule_id = {ruleId}
                     ORDER BY run.created_at DESC
                    OFFSET {keep - 1}
                     LIMIT 1) cutoff
             WHERE doomed.tenant_id = {tenantId.Value}
               AND doomed.rule_id = {ruleId}
               AND doomed.created_at < cutoff.created_at
            """, cancellationToken);
    }

    public Task<AutomationItemState?> GetItemStateAsync(TenantId tenantId, Guid ruleId, ItemId itemId, CancellationToken cancellationToken) =>
        database.Set<AutomationItemState>()
            .AsNoTracking()
            .SingleOrDefaultAsync(state => state.TenantId == tenantId && state.RuleId == ruleId && state.ItemId == itemId, cancellationToken);

    public Task UpsertItemStateAsync(AutomationItemState state, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(state);
        return database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO automation_item_state (tenant_id, rule_id, item_id, owner_principal_id, last_value_hash, last_fired_at)
            VALUES ({state.TenantId.Value}, {state.RuleId}, {state.ItemId.Value}, {state.OwnerPrincipalId.Value},
                    {state.LastValueHash}, {state.LastFiredAt})
            ON CONFLICT (tenant_id, rule_id, item_id) DO UPDATE
               SET last_value_hash = EXCLUDED.last_value_hash, last_fired_at = EXCLUDED.last_fired_at
            """, cancellationToken);
    }
}
