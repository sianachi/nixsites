using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Nix.Abstractions.Automations;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Automations;
using Nix.Domain.Identity;
using Nix.Domain.Scheduling;
using Nix.Domain.Tenancy;

namespace Nix.Features.Automations;

/// <summary>The planning rules the automation sources and the inline replan share.</summary>
public static class AutomationPlanning
{
    /// <summary>The trigger source name of schedule rules.</summary>
    public const string ScheduleSource = "automation.schedule";

    /// <summary>The trigger source name of date rules.</summary>
    public const string DateSource = "automation.date";

    /// <summary>The trigger source name of the event-fed property rules (written by the database trigger).</summary>
    public const string PropertySource = "automation.property";

    /// <summary>The planned-rule finder's page size.</summary>
    internal const int PageSize = 500;

    /// <summary>A ceiling on planned-rule pages per pass: 100,000 rules.</summary>
    internal const int MaxRulePages = 200;

    /// <summary>The most date candidates one group of date rules contributes per pass.</summary>
    internal const int MaxDateCandidatesPerRule = 2000;

    /// <summary>
    /// How often date rules are planned. Their candidates are a range read over the workspace's
    /// items, the costliest planning read there is, and the 48-hour window leaves ample lead time;
    /// an instant missed in between still fires late, clamped to now, within <see cref="DateLookback"/>.
    /// </summary>
    internal static readonly TimeSpan DatePlanInterval = TimeSpan.FromMinutes(15);

    /// <summary>How far back a missed date instant is still fired (clamped to now), as explicit reminders do.</summary>
    internal static readonly TimeSpan DateLookback = TimeSpan.FromHours(24);

    /// <summary>
    /// The schedule triggers one rule wants in <paramref name="window"/>: every occurrence in it, plus
    /// the single most recent one that is already overdue (within a day), clamped to the window's
    /// start - the same collapsing rule the due-task reminders use, so a cold start fires the one
    /// occurrence still owed rather than a backlog.
    /// </summary>
    public static IEnumerable<DesiredTrigger> ScheduleTriggers(
        TenantId tenantId,
        WorkspaceId workspaceId,
        PrincipalId ownerId,
        Guid ruleId,
        ScheduleTrigger trigger,
        string ownerZone,
        PlanWindow window)
    {
        ArgumentNullException.ThrowIfNull(window);
        var occurrences = AutomationSchedule.Occurrences(trigger, ownerZone, window.Start.AddDays(-1), window.End);
        var overdue = occurrences.Where(occurrence => occurrence.At < window.Start).OrderByDescending(occurrence => occurrence.At).Take(1);
        foreach (var occurrence in overdue.Concat(occurrences.Where(occurrence => occurrence.At >= window.Start)))
        {
            yield return new DesiredTrigger(
                tenantId,
                workspaceId,
                ownerId,
                null,
                ruleId,
                occurrence.At < window.Start ? window.Start : occurrence.At,
                AutomationDedupeKeys.Schedule(ruleId, occurrence.Day));
        }
    }

    /// <summary>
    /// The value days a group of date rules must read to find every instant it may fire in
    /// <paramref name="window"/>, sized by the group's own offsets rather than the widest offset any
    /// rule may have.
    /// </summary>
    /// <remarks>
    /// A rule fires at the value's day, at its time in the owner's zone, plus its offset (positive
    /// is after the day, negative before). That local instant lies between 14 hours before the
    /// value's UTC day starts and 12 hours after it ends, and a missed instant still fires within
    /// <see cref="DateLookback"/> of the window's start. So the earliest day that matters is the
    /// lookback's start less the largest positive offset, less two days; the latest is the
    /// window's end plus the largest negative offset's magnitude, plus one day. A group whose
    /// offsets are all zero reads four or five days, not the seventeen a fixed week either side
    /// did - a cap of candidates filled by items that can no longer fire used to crowd out one that
    /// could.
    /// </remarks>
    internal static (DateOnly From, DateOnly To) DateCandidateDays(PlanWindow window, IEnumerable<int> offsetMinutes)
    {
        ArgumentNullException.ThrowIfNull(window);
        var latestAfter = 0;
        var earliestBefore = 0;
        foreach (var offset in offsetMinutes)
        {
            latestAfter = Math.Max(latestAfter, offset);
            earliestBefore = Math.Max(earliestBefore, -offset);
        }

        var earliest = window.Start - DateLookback - TimeSpan.FromMinutes(latestAfter);
        var latest = window.End + TimeSpan.FromMinutes(earliestBefore);
        return (DateOnly.FromDateTime(earliest.UtcDateTime).AddDays(-2), DateOnly.FromDateTime(latest.UtcDateTime).AddDays(1));
    }

    /// <summary>
    /// The date triggers one rule wants in <paramref name="window"/> from its candidates: every
    /// instant in it, plus any missed within <see cref="DateLookback"/>, clamped to the window's start.
    /// </summary>
    internal static IEnumerable<DesiredTrigger> DateTriggers(
        TenantId tenantId,
        WorkspaceId workspaceId,
        PrincipalId ownerId,
        Guid ruleId,
        DateArrivesTrigger trigger,
        string ownerZone,
        IEnumerable<AutomationDateCandidate> candidates,
        PlanWindow window)
    {
        ArgumentNullException.ThrowIfNull(window);
        var earliest = window.Start - DateLookback;
        foreach (var candidate in candidates)
        {
            var at = AutomationDateInstant.Resolve(candidate.ValueText, trigger.Time, trigger.OffsetMinutes, ownerZone);
            if (at is { } instant && instant >= earliest && instant < window.End)
            {
                yield return new DesiredTrigger(
                    tenantId,
                    workspaceId,
                    ownerId,
                    candidate.ItemId,
                    ruleId,
                    instant < window.Start ? window.Start : instant,
                    AutomationDedupeKeys.Date(ruleId, candidate.ItemId, instant));
            }
        }
    }

    /// <summary>Reads every planned rule, up to <see cref="MaxRulePages"/> pages.</summary>
    internal static async Task<(List<PlannedAutomationRule> Rules, bool Complete)> ReadPlannedRulesAsync(
        IAutomationCandidateFinder finder, CancellationToken cancellationToken)
    {
        var rules = new List<PlannedAutomationRule>();
        var after = Guid.Empty;
        for (var page = 0; page < MaxRulePages; page++)
        {
            var batch = await finder.FindPlannedRulesAsync(PageSize, after, cancellationToken).ConfigureAwait(false);
            rules.AddRange(batch);
            if (batch.Count < PageSize)
            {
                return (rules, true);
            }

            after = batch[^1].RuleId;
        }

        return (rules, false);
    }

    /// <summary>Owner zones for every distinct owner, defaulted to UTC.</summary>
    internal static async Task<Dictionary<ReminderRecipient, string>> OwnerZonesAsync(
        IReminderCandidateFinder preferences, IEnumerable<PlannedAutomationRule> rules, CancellationToken cancellationToken)
    {
        var owners = rules.Select(rule => new ReminderRecipient(rule.TenantId, rule.OwnerPrincipalId)).Distinct().ToArray();
        if (owners.Length == 0)
        {
            return [];
        }

        var found = await preferences.PreferencesForAsync(owners, cancellationToken).ConfigureAwait(false);
        return found.ToDictionary(entry => entry.Recipient, entry => entry.TimeZone);
    }

    /// <summary>Reads a stored trigger defensively: a row that no longer reads plans nothing.</summary>
    internal static AutomationTrigger? TryRead(string json)
    {
        try
        {
            return AutomationTriggerJson.Read(System.Text.Json.Nodes.JsonNode.Parse(json)).Value;
        }
        catch (System.Text.Json.JsonException)
        {
            return null;
        }
    }

    /// <summary>Runs the executor for a leased trigger whose key names its rule.</summary>
    internal static async Task<TriggerOutcome> FireAsync(
        AutomationExecutor executor, DueTrigger trigger, AutomationOrigin origin, AutomationKeyKind expected, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(trigger);
        if (!AutomationDedupeKeys.TryParse(trigger.DedupeKey, out var key) || key.Kind != expected
            || trigger.RuleId is not { } ruleId || key.RuleId != ruleId)
        {
            return TriggerOutcome.Skipped("malformed_key");
        }

        var result = await executor.ExecuteAsync(
            new AutomationExecution(ruleId, origin, trigger.DedupeKey, key.ItemId, key.Depth, key), cancellationToken).ConfigureAwait(false);
        return result.Outcome;
    }
}

/// <summary>Plans and fires schedule rules (ADR-0051 section 6).</summary>
public sealed class AutomationScheduleSource(
    PlannedAutomationRules planned,
    IReminderCandidateFinder preferences,
    AutomationExecutor executor) : ITriggerSource
{
    /// <inheritdoc />
    public string Name => AutomationPlanning.ScheduleSource;

    /// <inheritdoc />
    public TriggerKind Kind => TriggerKind.Automation;

    /// <inheritdoc />
    public async Task<TriggerPlan> PlanAsync(PlanWindow window, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(window);
        var (rules, complete) = await planned.ReadAsync(cancellationToken).ConfigureAwait(false);
        var schedules = rules.Where(rule => rule.TriggerType == "schedule").ToList();
        var zones = await AutomationPlanning.OwnerZonesAsync(preferences, schedules, cancellationToken).ConfigureAwait(false);
        var desired = new List<DesiredTrigger>();
        foreach (var rule in schedules)
        {
            if (AutomationPlanning.TryRead(rule.TriggerJson) is not ScheduleTrigger trigger)
            {
                continue;
            }

            var zone = zones.GetValueOrDefault(new ReminderRecipient(rule.TenantId, rule.OwnerPrincipalId), "Etc/UTC");
            desired.AddRange(AutomationPlanning.ScheduleTriggers(
                rule.TenantId, rule.WorkspaceId, rule.OwnerPrincipalId, rule.RuleId, trigger, zone, window));
        }

        return new TriggerPlan(desired, complete);
    }

    /// <inheritdoc />
    public Task<TriggerOutcome> FireAsync(DueTrigger trigger, CancellationToken cancellationToken) =>
        AutomationPlanning.FireAsync(executor, trigger, AutomationOrigin.Schedule, AutomationKeyKind.Schedule, cancellationToken);
}

/// <summary>Plans and fires date_arrives rules over the items in their scope.</summary>
/// <remarks>
/// Rules sharing a tenant, workspace, key and scope read their candidates once between them: one
/// finder call per group per pass, of up to <see cref="AutomationPlanning.MaxDateCandidatesPerRule"/>
/// items over the days its members' offsets can reach (<see cref="AutomationPlanning.DateCandidateDays"/>),
/// whose instants each rule then resolves with its own time, offset and owner zone. A group cut
/// short at that cap marks only its own rules incomplete, so the planner still cancels every other
/// rule's stale triggers, and is logged by ids, key and counts. Planned every
/// <see cref="AutomationPlanning.DatePlanInterval"/>.
/// </remarks>
public sealed class AutomationDateSource(
    PlannedAutomationRules planned,
    IAutomationCandidateFinder finder,
    IReminderCandidateFinder preferences,
    AutomationExecutor executor,
    ILogger<AutomationDateSource>? logger = null) : ITriggerSource
{
    private readonly ILogger<AutomationDateSource> _logger = logger ?? NullLogger<AutomationDateSource>.Instance;

    /// <inheritdoc />
    public string Name => AutomationPlanning.DateSource;

    /// <inheritdoc />
    public TriggerKind Kind => TriggerKind.Automation;

    /// <inheritdoc />
    public TimeSpan PlanInterval => AutomationPlanning.DatePlanInterval;

    /// <inheritdoc />
    public async Task<TriggerPlan> PlanAsync(PlanWindow window, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(window);
        var (rules, complete) = await planned.ReadAsync(cancellationToken).ConfigureAwait(false);
        var dateRules = new List<(PlannedAutomationRule Rule, DateArrivesTrigger Trigger)>();
        foreach (var rule in rules)
        {
            if (rule.TriggerType == "date_arrives" && AutomationPlanning.TryRead(rule.TriggerJson) is DateArrivesTrigger trigger)
            {
                dateRules.Add((rule, trigger));
            }
        }

        var zones = await AutomationPlanning.OwnerZonesAsync(preferences, dateRules.Select(entry => entry.Rule), cancellationToken).ConfigureAwait(false);

        var desired = new List<DesiredTrigger>();
        var incomplete = new HashSet<Guid>();
        var groups = dateRules.GroupBy(entry => (entry.Rule.TenantId, entry.Rule.WorkspaceId, entry.Trigger.Key, entry.Rule.ScopeItemId));
        foreach (var group in groups)
        {
            var members = group.OrderBy(entry => entry.Rule.RuleId).ToList();
            var (from, to) = AutomationPlanning.DateCandidateDays(window, members.Select(entry => entry.Trigger.OffsetMinutes));
            var candidates = await finder.FindDateCandidatesAsync(
                group.Key.TenantId, members[0].Rule.RuleId, from, to, AutomationPlanning.MaxDateCandidatesPerRule + 1,
                null, null, cancellationToken).ConfigureAwait(false);
            if (candidates.Count > AutomationPlanning.MaxDateCandidatesPerRule)
            {
                incomplete.UnionWith(members.Select(entry => entry.Rule.RuleId));
                candidates = [.. candidates.Take(AutomationPlanning.MaxDateCandidatesPerRule)];
                AutomationPlanningLog.DateGroupTruncated(
                    _logger, group.Key.TenantId.Value, group.Key.WorkspaceId.Value, group.Key.Key, members.Count,
                    AutomationPlanning.MaxDateCandidatesPerRule);
            }

            foreach (var (rule, trigger) in members)
            {
                var zone = zones.GetValueOrDefault(new ReminderRecipient(rule.TenantId, rule.OwnerPrincipalId), "Etc/UTC");
                desired.AddRange(AutomationPlanning.DateTriggers(
                    rule.TenantId, rule.WorkspaceId, rule.OwnerPrincipalId, rule.RuleId, trigger, zone, candidates, window));
            }
        }

        return new TriggerPlan(desired, complete, incomplete);
    }

    /// <inheritdoc />
    public Task<TriggerOutcome> FireAsync(DueTrigger trigger, CancellationToken cancellationToken) =>
        AutomationPlanning.FireAsync(executor, trigger, AutomationOrigin.Date, AutomationKeyKind.Date, cancellationToken);
}

/// <summary>Structured logs of the automation planning sources: ids, keys and counts, never item text.</summary>
internal static partial class AutomationPlanningLog
{
    [LoggerMessage(5320, LogLevel.Warning,
        "Date rules on key {Key} in workspace {WorkspaceId} of tenant {TenantId} reached the {Cap}-candidate cap; {RuleCount} rules keep their stale triggers this pass")]
    internal static partial void DateGroupTruncated(ILogger logger, Guid tenantId, Guid workspaceId, string key, int ruleCount, int cap);
}

/// <summary>
/// The enabled schedule and date rules, read once per planning scope and shared by both planned
/// automation sources, which the planner resolves from one scope per pass.
/// </summary>
public sealed class PlannedAutomationRules(IAutomationCandidateFinder finder)
{
    private Task<(List<PlannedAutomationRule> Rules, bool Complete)>? _read;

    /// <summary>Every planned rule, up to the page cap, and whether that is all of them.</summary>
    public Task<(List<PlannedAutomationRule> Rules, bool Complete)> ReadAsync(CancellationToken cancellationToken) =>
        _read ??= AutomationPlanning.ReadPlannedRulesAsync(finder, cancellationToken);
}

/// <summary>
/// Fires property_changed rules. Event-fed: the <c>item_automation_property_changed</c> database
/// trigger inserts its rows as writes happen, so the planner never reconciles it
/// (<see cref="IsPlanned"/> is <see langword="false"/>).
/// </summary>
public sealed class AutomationPropertySource(AutomationExecutor executor) : ITriggerSource
{
    /// <inheritdoc />
    public string Name => AutomationPlanning.PropertySource;

    /// <inheritdoc />
    public TriggerKind Kind => TriggerKind.Automation;

    /// <inheritdoc />
    public bool IsPlanned => false;

    /// <inheritdoc />
    public Task<TriggerPlan> PlanAsync(PlanWindow window, CancellationToken cancellationToken) =>
        Task.FromResult(TriggerPlan.Empty);

    /// <inheritdoc />
    public Task<TriggerOutcome> FireAsync(DueTrigger trigger, CancellationToken cancellationToken) =>
        AutomationPlanning.FireAsync(executor, trigger, AutomationOrigin.Property, AutomationKeyKind.Property, cancellationToken);
}
