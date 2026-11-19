using Nix.Domain.Automations;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions.Automations;

/// <summary>An enabled schedule or date rule, as the cross-tenant planning finder returns it.</summary>
public sealed record PlannedAutomationRule(
    TenantId TenantId,
    Guid RuleId,
    WorkspaceId WorkspaceId,
    PrincipalId OwnerPrincipalId,
    string TriggerType,
    string TriggerJson,
    Guid? ScopeItemId);

/// <summary>One item a date rule may fire for, and its stored value text.</summary>
/// <param name="ItemId">The item.</param>
/// <param name="ValueText">The key's stored value.</param>
/// <param name="CursorDay">The due_day to resume a due_date read after, with <paramref name="ItemId"/>; null for any other key.</param>
public sealed record AutomationDateCandidate(Guid ItemId, string? ValueText, string? CursorDay);

/// <summary>
/// Cross-tenant discovery for the planned automation sources, backed by the SECURITY DEFINER
/// finders in <c>AutomationSecuritySql</c> - called from <c>ITriggerSource.PlanAsync</c>, which runs
/// before any owner's session exists.
/// </summary>
public interface IAutomationCandidateFinder
{
    /// <summary>Enabled schedule and date rules in id order, one keyset page at a time.</summary>
    public Task<IReadOnlyList<PlannedAutomationRule>> FindPlannedRulesAsync(int limit, Guid afterId, CancellationToken cancellationToken);

    /// <summary>
    /// Items one date rule may fire for whose value falls around <c>[firstDay, lastDay]</c> - and so
    /// every rule sharing its tenant, workspace, key and scope. The function reads the key,
    /// workspace and scope from the rule row; callers never pass a key. A due_date rule's items
    /// come in <c>(due_day, id)</c> order and resume after <paramref name="afterDay"/> and
    /// <paramref name="afterId"/>; any other key's come in id order and resume after
    /// <paramref name="afterId"/> alone.
    /// </summary>
    public Task<IReadOnlyList<AutomationDateCandidate>> FindDateCandidatesAsync(
        TenantId tenantId,
        Guid ruleId,
        DateOnly firstDay,
        DateOnly lastDay,
        int limit,
        string? afterDay,
        Guid? afterId,
        CancellationToken cancellationToken);
}

/// <summary>How a rule write ended.</summary>
public enum AutomationRuleWrite
{
    /// <summary>The row was written.</summary>
    Written,

    /// <summary>The rule was not at the expected revision; nothing was written.</summary>
    Conflict,

    /// <summary>The table's size bound refused the row; nothing was written.</summary>
    OutOfBounds,
}

/// <summary>What recording a failed run did to its rule.</summary>
/// <param name="ConsecutiveFailures">The failure count after this one.</param>
/// <param name="Disabled">Whether this failure turned the rule off.</param>
/// <param name="Revision">The rule's revision afterwards.</param>
public sealed record AutomationFailureOutcome(int ConsecutiveFailures, bool Disabled, long Revision);

/// <summary>The session owner's own rules, under row-level security.</summary>
public interface IAutomationRuleStore
{
    /// <summary>The session owner's rules in a workspace, oldest first.</summary>
    public Task<IReadOnlyList<AutomationRule>> ListAsync(WorkspaceId workspaceId, CancellationToken cancellationToken);

    /// <summary>How many rules the session owner keeps in a workspace.</summary>
    public Task<int> CountAsync(WorkspaceId workspaceId, CancellationToken cancellationToken);

    /// <summary>One of the session owner's rules, or <see langword="null"/>.</summary>
    public Task<AutomationRule?> GetAsync(Guid ruleId, CancellationToken cancellationToken);

    /// <summary>Locks an owner-visible rule through the current transaction for a policy decision and effect.</summary>
    public Task<AutomationRule?> GetForUpdateAsync(Guid ruleId, CancellationToken cancellationToken);

    /// <summary>
    /// Serialises rule creation for one owner in one workspace until the calling transaction
    /// ends, so two concurrent creates cannot both pass the per-owner ceiling's count.
    /// </summary>
    public Task LockOwnerQuotaAsync(TenantId tenantId, PrincipalId ownerId, WorkspaceId workspaceId, CancellationToken cancellationToken);

    /// <summary>Stores a new rule; <see cref="AutomationRuleWrite.OutOfBounds"/> when the table's size bound refuses it.</summary>
    public Task<AutomationRuleWrite> InsertAsync(AutomationRule rule, CancellationToken cancellationToken);

    /// <summary>
    /// Replaces a rule only if it is still at <paramref name="expectedRevision"/>
    /// (<see cref="AutomationRuleWrite.Conflict"/> otherwise), or
    /// <see cref="AutomationRuleWrite.OutOfBounds"/> when the table's size bound refuses it.
    /// </summary>
    public Task<AutomationRuleWrite> ReplaceAsync(AutomationRule rule, long expectedRevision, CancellationToken cancellationToken);

    /// <summary>Deletes a rule; its runs and state go with it.</summary>
    public Task<bool> DeleteAsync(Guid ruleId, CancellationToken cancellationToken);

    /// <summary>Resets the failure count after a run that did not fail.</summary>
    public Task RecordSuccessAsync(TenantId tenantId, Guid ruleId, DateTimeOffset at, CancellationToken cancellationToken);

    /// <summary>Counts a failed run and turns the rule off at the bound, atomically.</summary>
    public Task<AutomationFailureOutcome?> RecordFailureAsync(TenantId tenantId, Guid ruleId, DateTimeOffset at, CancellationToken cancellationToken);

    /// <summary>
    /// One date rule's first candidates, from the same finder the planner calls but inside the
    /// calling transaction, so a rule saved a moment ago - turned on, or given a new key or scope -
    /// is read as saved rather than as last committed.
    /// </summary>
    public Task<IReadOnlyList<AutomationDateCandidate>> DateCandidatesAsync(
        TenantId tenantId, Guid ruleId, DateOnly firstDay, DateOnly lastDay, int limit, CancellationToken cancellationToken);
}

/// <summary>A rule's run log and per-item state, under the owner's row-level security.</summary>
public interface IAutomationRunStore
{
    /// <summary>Inserts a run unless one already exists for its rule and trigger key.</summary>
    public Task<bool> TryInsertAsync(AutomationRun run, CancellationToken cancellationToken);

    /// <summary>Moves a run to its final status.</summary>
    public Task UpdateStatusAsync(TenantId tenantId, Guid runId, AutomationRunStatus status, string? detailJson, CancellationToken cancellationToken);

    /// <summary>A page of a rule's runs, newest first, after an optional <c>(created_at, id)</c> cursor.</summary>
    public Task<IReadOnlyList<AutomationRun>> PageAsync(
        TenantId tenantId, Guid ruleId, (DateTimeOffset CreatedAt, Guid Id)? before, int limit, CancellationToken cancellationToken);

    /// <summary>One run.</summary>
    public Task<AutomationRun?> GetAsync(TenantId tenantId, Guid runId, CancellationToken cancellationToken);

    /// <summary>Counts runs that did work (succeeded, noop, failed) since an instant.</summary>
    public Task<int> CountWorkingRunsSinceAsync(TenantId tenantId, Guid ruleId, DateTimeOffset since, CancellationToken cancellationToken);

    /// <summary>Deletes every run of a rule beyond the newest <paramref name="keep"/>.</summary>
    public Task<int> TrimAsync(TenantId tenantId, Guid ruleId, int keep, CancellationToken cancellationToken);

    /// <summary>What the rule last saw on an item, or <see langword="null"/>.</summary>
    public Task<AutomationItemState?> GetItemStateAsync(TenantId tenantId, Guid ruleId, ItemId itemId, CancellationToken cancellationToken);

    /// <summary>Records what the rule saw on an item and when it fired.</summary>
    public Task UpsertItemStateAsync(AutomationItemState state, CancellationToken cancellationToken);
}
