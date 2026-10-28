using System.Globalization;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Abstractions.Automations;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Automations;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Scheduling;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Features.Automations;

/// <summary>The opaque cursor of the automation run log and the calendar sync log: the last entry's instant (UTC ticks) and id.</summary>
internal static class LogCursor
{
    internal static string Encode(DateTimeOffset at, Guid id) =>
        $"{at.UtcTicks.ToString(CultureInfo.InvariantCulture)}_{id:N}";

    /// <summary>An unparseable cursor starts from the newest entry, as every other cursor here does.</summary>
    internal static (DateTimeOffset At, Guid Id)? Decode(string? cursor)
    {
        if (string.IsNullOrEmpty(cursor))
        {
            return null;
        }

        var separator = cursor.IndexOf('_', StringComparison.Ordinal);
        return separator > 0
            && long.TryParse(cursor.AsSpan(0, separator), NumberStyles.None, CultureInfo.InvariantCulture, out var ticks)
            && ticks is > 0 and < 3_155_378_975_999_999_999
            && Guid.TryParseExact(cursor[(separator + 1)..], "N", out var id)
                ? (new DateTimeOffset(ticks, TimeSpan.Zero), id)
                : null;
    }
}

/// <summary>What the rule handlers share: mapping, save-time checks, and inline schedule planning.</summary>
public sealed class AutomationRuleSupport(
    IAutomationRuleStore rules,
    IPermissionResolver permissions,
    IItemTree tree,
    IReminderCandidateFinder preferences,
    IScheduledTriggerStore triggers,
    INixSessionContextAccessor session,
    TimeProvider clock,
    IFinanceLock? topology = null)
{
    /// <summary>The window an inline replan covers, the same 48 hours the planner does.</summary>
    private static readonly TimeSpan PlanWindowSpan = TimeSpan.FromHours(48);

    internal NixSessionContext Context => session.Current ?? throw new InvalidOperationException("A session is required.");

    internal IAutomationRuleStore Rules => rules;

    /// <summary>
    /// One of the caller's rules, only while they can still read its workspace - as listing
    /// requires: someone removed from a workspace no longer reads the rules, or the run log of
    /// the rules, they kept there.
    /// </summary>
    internal async Task<AutomationRule?> ReadableAsync(Guid ruleId, CancellationToken cancellationToken)
    {
        var rule = await rules.GetAsync(ruleId, cancellationToken).ConfigureAwait(false);
        return rule is not null && await permissions.CanReadWorkspaceAsync(rule.WorkspaceId, cancellationToken).ConfigureAwait(false)
            ? rule
            : null;
    }

    /// <summary>
    /// Checks the caller may read the rule's workspace and that the items the rule names are
    /// visible, active and in it. The workspace comes first: someone no longer in it must not
    /// learn, from which ids are refused, which items exist there.
    /// </summary>
    internal async Task<NixError?> CheckItemsAsync(WorkspaceId workspaceId, AutomationDefinition definition, CancellationToken cancellationToken)
    {
        // Saving a scoped rule must not authorize a source item before a workspace transfer,
        // then publish that stale scope after the transfer's active-operation check.
        if (topology is not null)
        {
            await topology.AcquireWorkspaceTopologyAsync(workspaceId, cancellationToken).ConfigureAwait(false);
        }
        if (!await permissions.CanReadWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false))
        {
            return AutomationErrors.NotFound;
        }

        var named = AutomationRuleValidator.NamedItems(definition).ToList();
        if (definition.ScopeItemId is { } scope)
        {
            named.Insert(0, scope);
        }

        foreach (var id in named)
        {
            var item = await tree.FindAsync(ItemId.From(id), cancellationToken).ConfigureAwait(false);
            if (item is null || item.WorkspaceId != workspaceId || item.LifecycleState != ItemLifecycleState.Active)
            {
                return AutomationErrors.Invalid(id == definition.ScopeItemId
                    ? "scopeItemId: must name a visible item in this workspace"
                    : "actions: every named item must be visible in this workspace");
            }
        }

        return null;
    }

    /// <summary>Fills a schedule's start date with the owner's local today when the caller left it out.</summary>
    internal async Task<AutomationDefinition> AnchorAsync(AutomationDefinition definition, CancellationToken cancellationToken)
    {
        if (definition.Trigger is not ScheduleTrigger { StartDate: null } schedule)
        {
            return definition;
        }

        var zone = AutomationSchedule.EffectiveZone(schedule, await OwnerZoneAsync(cancellationToken).ConfigureAwait(false));
        return definition with { Trigger = schedule with { StartDate = AutomationSchedule.LocalDate(clock.GetUtcNow(), zone) } };
    }

    /// <summary>
    /// Cancels the rule's pending triggers and, for an enabled schedule or date rule, plans the next
    /// 48 hours now - so a rule saved or turned back on never waits for the planner (a date rule's
    /// next pass can be 15 minutes away).
    /// </summary>
    internal async Task ReplanAsync(AutomationRule rule, CancellationToken cancellationToken)
    {
        await triggers.CancelForRuleAsync(rule.TenantId, rule.OwnerPrincipalId, rule.Id, null, cancellationToken).ConfigureAwait(false);
        if (!rule.Enabled)
        {
            return;
        }

        var now = clock.GetUtcNow();
        var window = new PlanWindow(now, now + PlanWindowSpan);
        switch (AutomationTriggerJson.ReadStored(rule.Trigger))
        {
            case ScheduleTrigger schedule:
                var scheduled = AutomationPlanning.ScheduleTriggers(
                    rule.TenantId, rule.WorkspaceId, rule.OwnerPrincipalId, rule.Id, schedule,
                    await OwnerZoneAsync(cancellationToken).ConfigureAwait(false), window).ToList();
                await triggers.UpsertPendingAsync(TriggerKind.Automation, AutomationPlanning.ScheduleSource, scheduled, cancellationToken)
                    .ConfigureAwait(false);
                break;
            case DateArrivesTrigger date:
                // The planner's own read, sized the same way; past the cap the planner's next
                // pass finds the rest.
                var (from, to) = AutomationPlanning.DateCandidateDays(window, [date.OffsetMinutes]);
                var candidates = await rules.DateCandidatesAsync(
                    rule.TenantId, rule.Id, from, to, AutomationPlanning.MaxDateCandidatesPerRule, cancellationToken).ConfigureAwait(false);
                var dated = AutomationPlanning.DateTriggers(
                    rule.TenantId, rule.WorkspaceId, rule.OwnerPrincipalId, rule.Id, date,
                    await OwnerZoneAsync(cancellationToken).ConfigureAwait(false), candidates, window).ToList();
                await triggers.UpsertPendingAsync(TriggerKind.Automation, AutomationPlanning.DateSource, dated, cancellationToken)
                    .ConfigureAwait(false);
                break;
        }
    }

    internal static AutomationRule ToRow(
        AutomationDefinition definition,
        Guid id,
        NixSessionContext context,
        WorkspaceId workspaceId,
        long revision,
        int failures,
        string? disabledReason,
        DateTimeOffset createdAt,
        DateTimeOffset updatedAt) => new()
        {
            TenantId = context.TenantId,
            Id = id,
            WorkspaceId = workspaceId,
            OwnerPrincipalId = context.PrincipalId,
            Name = definition.Name,
            Enabled = definition.Enabled,
            ScopeItemId = definition.ScopeItemId is { } scope ? ItemId.From(scope) : null,
            TriggerType = AutomationTriggerJson.TypeText(definition.Trigger.Type),
            WatchKey = definition.Trigger is PropertyChangedTrigger property ? property.Key : null,
            Trigger = AutomationTriggerJson.Write(definition.Trigger).ToJsonString(),
            Conditions = AutomationConditionJson.WriteAll(definition.Conditions).ToJsonString(),
            Actions = AutomationActionJson.WriteAll(definition.Actions).ToJsonString(),
            SchemaVersion = AutomationTriggerJson.SchemaVersion,
            Revision = revision,
            ConsecutiveFailures = failures,
            DisabledReason = disabledReason,
            CreatedAt = createdAt,
            UpdatedAt = updatedAt,
        };

    internal static AutomationRuleResponse ToResponse(AutomationRule rule) => new(
        rule.Id,
        rule.WorkspaceId.Value,
        rule.Name,
        rule.Enabled,
        rule.ScopeItemId?.Value,
        JsonNode.Parse(rule.Trigger)!.AsObject(),
        JsonNode.Parse(rule.Conditions)!.AsArray(),
        JsonNode.Parse(rule.Actions)!.AsArray(),
        rule.Revision,
        rule.ConsecutiveFailures,
        rule.DisabledReason,
        rule.LastRunAt,
        rule.CreatedAt,
        rule.UpdatedAt);

    internal static AutomationRunResponse ToResponse(AutomationRun run)
    {
        string? reason = null;
        if (run.Detail is { } detail && JsonNode.Parse(detail) is JsonObject document)
        {
            reason = document["code"]?.GetValue<string>() ?? document["reason"]?.GetValue<string>();
        }

        return new AutomationRunResponse(
            run.Id, run.RuleId, run.ItemId, AutomationStorage.ToText(run.Origin), run.Depth,
            AutomationStorage.ToText(run.Status), reason, run.CreatedAt);
    }

    private async Task<string> OwnerZoneAsync(CancellationToken cancellationToken)
    {
        var context = Context;
        var found = await preferences.PreferencesForAsync(
            [new ReminderRecipient(context.TenantId, context.PrincipalId)], cancellationToken).ConfigureAwait(false);
        return found.Count > 0 ? found[0].TimeZone : "Etc/UTC";
    }
}

/// <summary>Lists the caller's own rules in a workspace they can read.</summary>
public sealed class ListAutomationsHandler(AutomationRuleSupport support, IPermissionResolver permissions)
    : ICommandHandler<ListAutomations, AutomationListResponse>
{
    /// <inheritdoc />
    public async ValueTask<Result<AutomationListResponse>> HandleAsync(ListAutomations command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (!await permissions.CanReadWorkspaceAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<AutomationListResponse>(AutomationErrors.NotFound);
        }

        var rules = await support.Rules.ListAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false);
        return Result.Success(new AutomationListResponse([.. rules.Select(AutomationRuleSupport.ToResponse)]));
    }
}

/// <summary>Creates a rule owned by the caller in a workspace they can write.</summary>
public sealed class CreateAutomationHandler(AutomationRuleSupport support, IPermissionResolver permissions, IItemTree tree, TimeProvider clock)
    : ICommandHandler<CreateAutomation, AutomationRuleResponse>
{
    /// <inheritdoc />
    public async ValueTask<Result<AutomationRuleResponse>> HandleAsync(CreateAutomation command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (!await tree.WorkspaceExistsAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false)
            || !await permissions.CanWriteWorkspaceAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<AutomationRuleResponse>(AutomationErrors.NotFound);
        }

        var validated = AutomationRuleValidator.Validate(command.Rule);
        if (validated.IsFailure)
        {
            return Result.Failure<AutomationRuleResponse>(validated.Error);
        }

        if (await support.CheckItemsAsync(command.WorkspaceId, validated.Value, cancellationToken).ConfigureAwait(false) is { } refused)
        {
            return Result.Failure<AutomationRuleResponse>(refused);
        }

        // Counted under the owner's quota lock: two concurrent creates at 49 would otherwise
        // both count 49 and both insert.
        var context = support.Context;
        await support.Rules.LockOwnerQuotaAsync(context.TenantId, context.PrincipalId, command.WorkspaceId, cancellationToken).ConfigureAwait(false);
        if (await support.Rules.CountAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false) >= AutomationGuards.MaxRulesPerOwnerPerWorkspace)
        {
            return Result.Failure<AutomationRuleResponse>(AutomationErrors.LimitReached);
        }

        var definition = await support.AnchorAsync(validated.Value, cancellationToken).ConfigureAwait(false);
        var now = clock.GetUtcNow();
        var row = AutomationRuleSupport.ToRow(definition, Guid.CreateVersion7(), context, command.WorkspaceId, 1, 0, null, now, now);
        if (await support.Rules.InsertAsync(row, cancellationToken).ConfigureAwait(false) == AutomationRuleWrite.OutOfBounds)
        {
            return Result.Failure<AutomationRuleResponse>(AutomationErrors.TooLarge);
        }

        await support.ReplanAsync(row, cancellationToken).ConfigureAwait(false);
        return Result.Success(AutomationRuleSupport.ToResponse(row));
    }
}

/// <summary>Reads one of the caller's rules, in a workspace they can still read.</summary>
public sealed class GetAutomationHandler(AutomationRuleSupport support) : ICommandHandler<GetAutomation, AutomationRuleResponse>
{
    /// <inheritdoc />
    public async ValueTask<Result<AutomationRuleResponse>> HandleAsync(GetAutomation command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var rule = await support.ReadableAsync(command.RuleId, cancellationToken).ConfigureAwait(false);
        return rule is null
            ? Result.Failure<AutomationRuleResponse>(AutomationErrors.NotFound)
            : Result.Success(AutomationRuleSupport.ToResponse(rule));
    }
}

/// <summary>Replaces one of the caller's rules at the revision they read.</summary>
public sealed class UpdateAutomationHandler(AutomationRuleSupport support, IPermissionResolver permissions, TimeProvider clock)
    : ICommandHandler<UpdateAutomation, AutomationRuleResponse>
{
    /// <inheritdoc />
    public async ValueTask<Result<AutomationRuleResponse>> HandleAsync(UpdateAutomation command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        // Read access first, as Get and Runs require, even to turn a rule off: a member removed
        // from the workspace must not be able to probe it through a rule they kept there.
        var existing = await support.ReadableAsync(command.RuleId, cancellationToken).ConfigureAwait(false);
        if (existing is null)
        {
            return Result.Failure<AutomationRuleResponse>(AutomationErrors.NotFound);
        }

        if (existing.Revision != command.ExpectedRevision)
        {
            return Result.Failure<AutomationRuleResponse>(AutomationErrors.Conflict);
        }

        var validated = AutomationRuleValidator.Validate(command.Rule);
        if (validated.IsFailure)
        {
            return Result.Failure<AutomationRuleResponse>(validated.Error);
        }

        // Turning a rule on (or keeping it on) is granting it the owner's write access again.
        if (validated.Value.Enabled
            && !await permissions.CanWriteWorkspaceAsync(existing.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<AutomationRuleResponse>(AutomationErrors.NotFound);
        }

        if (await support.CheckItemsAsync(existing.WorkspaceId, validated.Value, cancellationToken).ConfigureAwait(false) is { } refused)
        {
            return Result.Failure<AutomationRuleResponse>(refused);
        }

        var definition = await support.AnchorAsync(validated.Value, cancellationToken).ConfigureAwait(false);

        // Turning a rule back on starts its failure count afresh.
        var reenabled = definition.Enabled && !existing.Enabled;
        var row = AutomationRuleSupport.ToRow(
            definition,
            existing.Id,
            support.Context,
            existing.WorkspaceId,
            existing.Revision + 1,
            reenabled ? 0 : existing.ConsecutiveFailures,
            reenabled || definition.Enabled ? null : existing.DisabledReason,
            existing.CreatedAt,
            clock.GetUtcNow());
        switch (await support.Rules.ReplaceAsync(row, command.ExpectedRevision, cancellationToken).ConfigureAwait(false))
        {
            case AutomationRuleWrite.Conflict:
                return Result.Failure<AutomationRuleResponse>(AutomationErrors.Conflict);
            case AutomationRuleWrite.OutOfBounds:
                return Result.Failure<AutomationRuleResponse>(AutomationErrors.TooLarge);
        }

        await support.ReplanAsync(row, cancellationToken).ConfigureAwait(false);
        var saved = await support.Rules.GetAsync(row.Id, cancellationToken).ConfigureAwait(false);
        return Result.Success(AutomationRuleSupport.ToResponse(saved ?? row));
    }
}

/// <summary>Deletes one of the caller's rules; pending triggers are cancelled, runs and state cascade.</summary>
public sealed class DeleteAutomationHandler(AutomationRuleSupport support, IScheduledTriggerStore triggers)
    : ICommandHandler<DeleteAutomation, bool>
{
    /// <inheritdoc />
    public async ValueTask<Result<bool>> HandleAsync(DeleteAutomation command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var rule = await support.Rules.GetAsync(command.RuleId, cancellationToken).ConfigureAwait(false);
        if (rule is null)
        {
            return Result.Failure<bool>(AutomationErrors.NotFound);
        }

        await triggers.CancelForRuleAsync(rule.TenantId, rule.OwnerPrincipalId, rule.Id, null, cancellationToken).ConfigureAwait(false);
        await support.Rules.DeleteAsync(rule.Id, cancellationToken).ConfigureAwait(false);
        return Result.Success(true);
    }
}

/// <summary>Reads a page of one of the caller's rules' runs, newest first.</summary>
public sealed class ListAutomationRunsHandler(AutomationRuleSupport support, IAutomationRunStore runs)
    : ICommandHandler<ListAutomationRuns, AutomationRunsPageResponse>
{
    private const int PageSize = 50;

    /// <inheritdoc />
    public async ValueTask<Result<AutomationRunsPageResponse>> HandleAsync(ListAutomationRuns command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var rule = await support.ReadableAsync(command.RuleId, cancellationToken).ConfigureAwait(false);
        if (rule is null)
        {
            return Result.Failure<AutomationRunsPageResponse>(AutomationErrors.NotFound);
        }

        var page = await runs.PageAsync(rule.TenantId, rule.Id, LogCursor.Decode(command.Cursor), PageSize + 1, cancellationToken).ConfigureAwait(false);
        var items = page.Take(PageSize).ToList();
        var next = page.Count > PageSize ? LogCursor.Encode(items[^1].CreatedAt, items[^1].Id) : null;
        return Result.Success(new AutomationRunsPageResponse([.. items.Select(AutomationRuleSupport.ToResponse)], next));
    }
}

/// <summary>Runs one of the caller's rules now, in this request, with the throttles applied.</summary>
public sealed class RunAutomationHandler(AutomationRuleSupport support, AutomationExecutor executor, IAutomationRunStore runs)
    : ICommandHandler<RunAutomation, AutomationRunResponse>
{
    /// <inheritdoc />
    public async ValueTask<Result<AutomationRunResponse>> HandleAsync(RunAutomation command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var rule = await support.Rules.GetAsync(command.RuleId, cancellationToken).ConfigureAwait(false);
        if (rule is null)
        {
            return Result.Failure<AutomationRunResponse>(AutomationErrors.NotFound);
        }

        var key = AutomationDedupeKeys.Manual();
        _ = AutomationDedupeKeys.TryParse(key, out var parsed);
        var result = await executor.ExecuteAsync(
            new AutomationExecution(rule.Id, AutomationOrigin.Manual, key, command.ItemId, 0, parsed), cancellationToken).ConfigureAwait(false);
        var run = result.RunId is { } runId ? await runs.GetAsync(rule.TenantId, runId, cancellationToken).ConfigureAwait(false) : null;
        return run is null
            ? Result.Failure<AutomationRunResponse>(AutomationErrors.Invalid($"The automation did not run: {result.Outcome.Reason}."))
            : Result.Success(AutomationRuleSupport.ToResponse(run));
    }
}

/// <summary>Dry-runs one of the caller's rules: verifies and renders, writes nothing.</summary>
public sealed class TestAutomationHandler(AutomationRuleSupport support, AutomationExecutor executor)
    : ICommandHandler<TestAutomation, AutomationTestResponse>
{
    /// <inheritdoc />
    public async ValueTask<Result<AutomationTestResponse>> HandleAsync(TestAutomation command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var rule = await support.Rules.GetAsync(command.RuleId, cancellationToken).ConfigureAwait(false);
        if (rule is null)
        {
            return Result.Failure<AutomationTestResponse>(AutomationErrors.NotFound);
        }

        var key = AutomationDedupeKeys.Manual();
        _ = AutomationDedupeKeys.TryParse(key, out var parsed);
        var preview = await executor.PreviewAsync(
            new AutomationExecution(rule.Id, AutomationOrigin.Manual, key, command.ItemId, 0, parsed), cancellationToken).ConfigureAwait(false);
        return Result.Success(new AutomationTestResponse(
            preview.WouldRun,
            preview.Reason,
            [.. preview.Actions.Select(action => new AutomationActionPreview(action.Index, action.Type, action.ItemId, action.Key, action.Title, action.Body))]));
    }
}
