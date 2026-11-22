using Nix.Abstractions.Automations;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Npgsql;
using static Nix.Persistence.Sql.NixParameter;

namespace Nix.Persistence.Automations;

/// <summary>
/// Calls the SECURITY DEFINER finders in <c>AutomationSecuritySql</c> directly against the pool,
/// exactly like <see cref="Nix.Persistence.Scheduling.ReminderCandidateFinder"/>: no session is
/// established, and the functions cross row security only because the migrator role owns them.
/// </summary>
public sealed class AutomationCandidateFinder(NpgsqlDataSource dataSource) : IAutomationCandidateFinder
{
    private readonly PooledSql _db = new(dataSource);

    /// <summary>The function's own bound on one date-candidate read.</summary>
    public const int MaximumDateCandidates = 5000;

    public async Task<IReadOnlyList<PlannedAutomationRule>> FindPlannedRulesAsync(int limit, Guid afterId, CancellationToken cancellationToken)
    {
        if (limit is < 1 or > 500)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }

        return await _db.RowsAsync(
            "SELECT * FROM nix_find_planned_automation_rules(@limit, @after_id)",
            static reader => new PlannedAutomationRule(
                TenantId.From(reader.GetGuid(0)),
                reader.GetGuid(1),
                WorkspaceId.From(reader.GetGuid(2)),
                PrincipalId.From(reader.GetGuid(3)),
                reader.GetString(4),
                reader.GetString(5),
                reader.IsDBNull(6) ? null : reader.GetGuid(6)),
            cancellationToken,
            Integer("limit", limit),
            Uuid("after_id", afterId)).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<AutomationDateCandidate>> FindDateCandidatesAsync(
        TenantId tenantId,
        Guid ruleId,
        DateOnly firstDay,
        DateOnly lastDay,
        int limit,
        string? afterDay,
        Guid? afterId,
        CancellationToken cancellationToken)
    {
        if (limit is < 1 or > MaximumDateCandidates)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }

        return await _db.RowsAsync(
            "SELECT * FROM nix_find_automation_date_candidates(@tenant_id, @rule_id, @from, @to, @limit, @after_day, @after_id)",
            static reader => new AutomationDateCandidate(
                reader.GetGuid(0),
                reader.IsDBNull(1) ? null : reader.GetString(1),
                reader.IsDBNull(2) ? null : reader.GetString(2)),
            cancellationToken,
            Uuid("tenant_id", tenantId.Value),
            Uuid("rule_id", ruleId),
            Date("from", firstDay),
            Date("to", lastDay),
            Integer("limit", limit),
            Text("after_day", afterDay),
            Uuid("after_id", afterId)).ConfigureAwait(false);
    }
}
