using System.Collections.Immutable;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Abstractions.Automations;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Automations;
using Nix.Domain.Items;
using Nix.Domain.Notifications;
using Nix.Domain.Primitives;
using Nix.Domain.Scheduling;
using Nix.Features.Items;
using Nix.Features.Properties;
using Nix.Messaging;

namespace Nix.Features.Automations;

/// <summary>One request to run a rule.</summary>
/// <param name="RuleId">The rule.</param>
/// <param name="Origin">How the run started.</param>
/// <param name="TriggerKey">The trigger's dedupe key, or a fresh manual key.</param>
/// <param name="ItemId">The triggering item, when there is one.</param>
/// <param name="Depth">The causation depth the key carries.</param>
/// <param name="Key">The parsed key, whose occurrence re-verification compares against.</param>
public sealed record AutomationExecution(
    Guid RuleId,
    AutomationOrigin Origin,
    string TriggerKey,
    Guid? ItemId,
    int Depth,
    AutomationKey Key);

/// <summary>What running (or dry-running) a rule decided.</summary>
/// <param name="Outcome">The trigger outcome to record.</param>
/// <param name="RunId">The run row written, if any.</param>
public sealed record AutomationExecutionResult(TriggerOutcome Outcome, Guid? RunId);

/// <summary>What a dry run found.</summary>
/// <param name="WouldRun">Whether the actions would run now.</param>
/// <param name="Reason">Why not, as a reason code.</param>
/// <param name="Actions">Each action, rendered.</param>
public sealed record AutomationPreview(bool WouldRun, string? Reason, IReadOnlyList<AutomationPreviewAction> Actions);

/// <summary>One action, rendered without running it.</summary>
public sealed record AutomationPreviewAction(int Index, string Type, Guid? ItemId, string? Key, string? Title, string? Body);

/// <summary>
/// Runs one automation rule in the caller's transaction, under the owner's session (ADR-0051
/// section 6): re-verifies everything at fire time, applies the loop and blast-radius guards, runs
/// the actions all-or-nothing behind a savepoint with the causation depth raised, and records the
/// run. Expected failures (an action refused, access lost) are recorded and counted; unexpected
/// exceptions propagate to the dispatcher's retry path, which rolls the whole fire back.
/// </summary>
public sealed class AutomationExecutor(
    IAutomationRuleStore rules,
    IAutomationRunStore runs,
    IItemTree tree,
    IPermissionResolver permissions,
    IPrincipalStatusChecker principalStatus,
    IReminderCandidateFinder preferences,
    IScheduledTriggerStore triggers,
    INotificationWriter notifications,
    INixSessionContextAccessor session,
    NixDispatcher dispatcher,
    IAutomationActionScope actionScope,
    IItemLocks locks,
    IWorkspaceMembershipIgnoringLock membership,
    TimeProvider clock)
{
    /// <summary>
    /// Reasons decided before the triggering item is known to be readable by the owner: a run
    /// recorded for one of these never names the item (its id is withheld from the run log).
    /// </summary>
    private static readonly HashSet<string> UnverifiedItemReasons = new(StringComparer.Ordinal)
    {
        "rule_disabled", "owner_inactive", "access_lost", "item_gone", "scope_gone", "out_of_scope",
        "item_locked", "scope_locked",
    };

    /// <summary>
    /// Reasons that record no run at all, only a skipped trigger. A run row - even one without an
    /// item id - would tell the owner that something under a lock changed, or reached the value a
    /// rule watches for.
    /// </summary>
    private static readonly HashSet<string> LockedReasons = new(StringComparer.Ordinal) { "item_locked", "scope_locked" };

    /// <summary>
    /// Reasons a manual run records nothing for: the caller named the item, so a missing one must
    /// read exactly as a locked one - no run either way, and the same public reason.
    /// </summary>
    private static readonly HashSet<string> ManualUnrecordedReasons = new(StringComparer.Ordinal)
    {
        "item_gone", "scope_gone", "item_locked", "scope_locked",
    };

    /// <summary>Reasons that count as a failed run and move the rule toward auto-disable.</summary>
    private static readonly HashSet<string> FailingReasons = new(StringComparer.Ordinal) { "access_lost", "owner_inactive" };

    /// <summary>The internal reason for the per-rule hourly cap; recorded as <c>throttled</c>.</summary>
    private const string HourlyCapReason = "hourly_cap";

    /// <summary>Runs a rule.</summary>
    public async Task<AutomationExecutionResult> ExecuteAsync(AutomationExecution execution, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(execution);
        var evaluation = await EvaluateAsync(execution, cancellationToken).ConfigureAwait(false);
        if (evaluation.Rule is null)
        {
            return new AutomationExecutionResult(TriggerOutcome.Skipped(evaluation.Reason!), null);
        }

        var context = evaluation.Context!;
        var rule = evaluation.Rule;
        var now = clock.GetUtcNow();

        if (evaluation.Reason is { } failing && FailingReasons.Contains(failing))
        {
            var failedRun = NewRun(rule, execution, AutomationRunStatus.Failed, Detail(failing, null, null), now, itemId: null);
            if (!await TryRecordAsync(failedRun, cancellationToken).ConfigureAwait(false))
            {
                return new AutomationExecutionResult(TriggerOutcome.Skipped("duplicate"), null);
            }

            await RecordFailureAsync(rule, now, cancellationToken).ConfigureAwait(false);
            return new AutomationExecutionResult(TriggerOutcome.Skipped(failing), failedRun.Id);
        }

        if (evaluation.Reason == HourlyCapReason)
        {
            // One run per rule per hour, whatever the burst, and the burst's queued property
            // triggers go with it: each would only be refused the same way.
            var throttledRun = NewRun(rule, execution, AutomationRunStatus.Throttled, Detail(HourlyCapReason, null, null), now, itemId: null,
                triggerKey: AutomationDedupeKeys.HourlyThrottle(rule.Id, now));
            var noted = await TryRecordAsync(throttledRun, cancellationToken).ConfigureAwait(false);
            await triggers.CancelForRuleAsync(rule.TenantId, rule.OwnerPrincipalId, rule.Id, AutomationPlanning.PropertySource, cancellationToken)
                .ConfigureAwait(false);
            return new AutomationExecutionResult(TriggerOutcome.Skipped("throttled"), noted ? throttledRun.Id : null);
        }

        if (evaluation.Reason is { } unrecorded
            && (LockedReasons.Contains(unrecorded)
                || (execution.Origin == AutomationOrigin.Manual && ManualUnrecordedReasons.Contains(unrecorded))))
        {
            return new AutomationExecutionResult(
                TriggerOutcome.Skipped(execution.Origin == AutomationOrigin.Manual ? PublicReason(unrecorded)! : unrecorded), null);
        }

        if (evaluation.Reason is { } skipReason)
        {
            var status = skipReason == "throttled" ? AutomationRunStatus.Throttled : AutomationRunStatus.Skipped;
            var itemId = UnverifiedItemReasons.Contains(skipReason) ? null : execution.ItemId;
            var skipped = NewRun(rule, execution, status, Detail(skipReason, null, null), now, itemId);
            var recorded = await TryRecordAsync(skipped, cancellationToken).ConfigureAwait(false);
            return new AutomationExecutionResult(TriggerOutcome.Skipped(recorded ? skipReason : "duplicate"), recorded ? skipped.Id : null);
        }

        // Provisionally succeeded, so a redelivered trigger racing this one finds the key taken.
        var run = NewRun(rule, execution, AutomationRunStatus.Succeeded, null, now, execution.ItemId);
        if (!await TryRecordAsync(run, cancellationToken).ConfigureAwait(false))
        {
            return new AutomationExecutionResult(TriggerOutcome.Skipped("duplicate"), null);
        }

        await actionScope.BeginAsync(execution.Depth + 1, cancellationToken).ConfigureAwait(false);

        var result = await RunActionsAsync(context, run.Id, cancellationToken).ConfigureAwait(false);
        if (result.Failure is { } failure)
        {
            // Everything the actions wrote goes; the run, the failure count and the notice stay.
            await actionScope.RollbackAsync(cancellationToken).ConfigureAwait(false);
            await runs.UpdateStatusAsync(rule.TenantId, run.Id, AutomationRunStatus.Failed,
                Detail("action_failed", failure.Code, failure.Index), cancellationToken).ConfigureAwait(false);
            await RecordFailureAsync(rule, now, cancellationToken).ConfigureAwait(false);
            return new AutomationExecutionResult(TriggerOutcome.Skipped("action_failed"), run.Id);
        }

        await actionScope.CompleteAsync(cancellationToken).ConfigureAwait(false);

        var finalStatus = result.Changed ? AutomationRunStatus.Succeeded : AutomationRunStatus.Noop;
        if (finalStatus != AutomationRunStatus.Succeeded)
        {
            await runs.UpdateStatusAsync(rule.TenantId, run.Id, finalStatus, null, cancellationToken).ConfigureAwait(false);
        }

        await rules.RecordSuccessAsync(rule.TenantId, rule.Id, now, cancellationToken).ConfigureAwait(false);
        if (context.Item is { } item)
        {
            // What the watched value is now, after the actions: a rule that just wrote its own
            // watched key sees that value as "no change" when its own write comes back round.
            string? hash = null;
            if (context.Trigger is PropertyChangedTrigger property)
            {
                var written = await tree.FindAsync(item.Id, cancellationToken).ConfigureAwait(false);
                hash = AutomationValueHash.Of(ReadValue(written?.Properties, property.Key));
            }

            await runs.UpsertItemStateAsync(new AutomationItemState
            {
                TenantId = rule.TenantId,
                RuleId = rule.Id,
                ItemId = item.Id,
                OwnerPrincipalId = rule.OwnerPrincipalId,
                LastValueHash = hash,
                LastFiredAt = now,
            }, cancellationToken).ConfigureAwait(false);
        }

        return new AutomationExecutionResult(
            TriggerOutcome.Fired(finalStatus == AutomationRunStatus.Succeeded ? "automation_succeeded" : "automation_noop"),
            run.Id);
    }

    /// <summary>Evaluates steps one to six and renders every action, writing nothing.</summary>
    /// <remarks>
    /// A rule stopped before its triggering item or scope is known to be readable - a lock covers
    /// it, it is gone, the owner lost access - renders nothing: the preview must not show text
    /// the run itself would never have used.
    /// </remarks>
    public async Task<AutomationPreview> PreviewAsync(AutomationExecution execution, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(execution);
        var evaluation = await EvaluateAsync(execution, cancellationToken).ConfigureAwait(false);
        if (evaluation.Context is not { } context
            || (evaluation.Reason is { } stopped && (UnverifiedItemReasons.Contains(stopped) || FailingReasons.Contains(stopped))))
        {
            return new AutomationPreview(false, PublicReason(evaluation.Reason), []);
        }

        var previews = new List<AutomationPreviewAction>(context.Actions.Length);
        for (var index = 0; index < context.Actions.Length; index++)
        {
            previews.Add(context.Actions[index] switch
            {
                SetPropertyAction set => new AutomationPreviewAction(index, set.TypeText, Resolve(context, set.Target), set.Key, null, null),
                CreateItemAction create => new AutomationPreviewAction(index, create.TypeText, Resolve(context, create.Parent), null,
                    RenderTitle(create.Title, context, AutomationActionJson.MaximumItemTitle), null),
                NotifyAction notify => new AutomationPreviewAction(index, notify.TypeText, context.Item?.Id.Value, null,
                    RenderTitle(notify.Title, context, AutomationActionJson.MaximumNotifyTitle),
                    AutomationTitleTemplate.Render(notify.Body, context.LocalDate, context.ItemTitle, AutomationActionJson.MaximumNotifyBody)),
                _ => new AutomationPreviewAction(index, context.Actions[index].TypeText, null, null, null, null),
            });
        }

        return new AutomationPreview(evaluation.Reason is null, PublicReason(evaluation.Reason), previews);
    }

    /// <summary>
    /// The reason a caller is shown. A lock reads as absence: whoever names an item cannot tell a
    /// locked one from one that does not exist.
    /// </summary>
    private static string? PublicReason(string? reason) => reason switch
    {
        HourlyCapReason => "throttled",
        "item_locked" => "item_gone",
        "scope_locked" => "scope_gone",
        _ => reason,
    };

    /// <summary>Records a run and keeps the rule's log to its newest runs; <see langword="false"/> when the key was taken.</summary>
    private async Task<bool> TryRecordAsync(AutomationRun run, CancellationToken cancellationToken)
    {
        if (!await runs.TryInsertAsync(run, cancellationToken).ConfigureAwait(false))
        {
            return false;
        }

        await runs.TrimAsync(run.TenantId, run.RuleId, AutomationGuards.RunsKeptPerRule, cancellationToken).ConfigureAwait(false);
        return true;
    }

    private async Task<Evaluation> EvaluateAsync(AutomationExecution execution, CancellationToken cancellationToken)
    {
        // 1. The rule, as its owner sees it.
        var rule = await rules.GetAsync(execution.RuleId, cancellationToken).ConfigureAwait(false);
        if (rule is null)
        {
            return Evaluation.Stop("rule_gone");
        }

        if (!rule.Enabled)
        {
            return Evaluation.Skip(rule, null, "rule_disabled");
        }

        var trigger = AutomationTriggerJson.ReadStored(rule.Trigger);
        var conditions = AutomationConditionJson.ReadAll(JsonNode.Parse(rule.Conditions)).Value;
        var actions = AutomationActionJson.ReadStored(rule.Actions);

        // 2. The owner is still active and may still read the workspace. Either failing counts
        // toward auto-disable: a departed owner's rule must stop, not skip forever.
        if (!await principalStatus.IsActiveAsync(rule.OwnerPrincipalId, cancellationToken).ConfigureAwait(false))
        {
            return Evaluation.Skip(rule, null, "owner_inactive");
        }

        var ownerPreferences = await preferences.PreferencesForAsync(
            [new ReminderRecipient(rule.TenantId, rule.OwnerPrincipalId)], cancellationToken).ConfigureAwait(false);
        var ownerZone = ownerPreferences.Count > 0 ? ownerPreferences[0].TimeZone : "Etc/UTC";
        var now = clock.GetUtcNow();
        var zone = trigger is ScheduleTrigger schedule ? AutomationSchedule.EffectiveZone(schedule, ownerZone) : ownerZone;
        var context = new ExecutionContext(rule, trigger, conditions.IsDefault ? [] : conditions, actions, null, null,
            ownerZone, AutomationSchedule.LocalDate(now, zone));

        if (!await permissions.CanReadWorkspaceAsync(rule.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            // A workspace password closes it to the dispatcher, which holds no credential, so the
            // rule waits rather than counting a failed run toward auto-disable. Recorded as a lock
            // skip: no run row, so nothing says that something changed inside a closed workspace.
            return Evaluation.Skip(
                rule,
                context,
                await membership.RoleIgnoringLockAsync(rule.WorkspaceId, cancellationToken).ConfigureAwait(false) is not null
                    ? "scope_locked"
                    : "access_lost");
        }

        // 3. The triggering item and the scope: not under any lock, then present, active and in
        // the workspace. Locks bind whoever is asking - the dispatcher holds no credential, and a
        // grant one browser holds must not let a rule carry an item's text into a notification,
        // a created item or a run that every device of the owner sees. Asked of the ids as given,
        // before either row is read: whether a lock sits on the item or any ancestor.
        var lockCandidates = new List<ItemId>(2);
        if (execution.ItemId is { } candidateId)
        {
            lockCandidates.Add(ItemId.From(candidateId));
        }

        if (rule.ScopeItemId is { } candidateScope)
        {
            lockCandidates.Add(candidateScope);
        }

        if (lockCandidates.Count > 0)
        {
            var locked = await locks.LockedAmongAsync(lockCandidates, cancellationToken).ConfigureAwait(false);
            if (execution.ItemId is { } lockedItem && locked.Contains(ItemId.From(lockedItem)))
            {
                return Evaluation.Skip(rule, context, "item_locked");
            }

            if (rule.ScopeItemId is { } coveredScope && locked.Contains(coveredScope))
            {
                return Evaluation.Skip(rule, context, "scope_locked");
            }
        }

        Item? item = null;
        if (execution.ItemId is { } itemId)
        {
            item = await tree.FindAsync(ItemId.From(itemId), cancellationToken).ConfigureAwait(false);
            if (item is null || item.LifecycleState != ItemLifecycleState.Active || item.WorkspaceId != rule.WorkspaceId)
            {
                return Evaluation.Skip(rule, context, "item_gone");
            }
        }

        if (rule.ScopeItemId is { } scopeId)
        {
            var scope = await tree.FindAsync(scopeId, cancellationToken).ConfigureAwait(false);
            if (scope is null || scope.LifecycleState != ItemLifecycleState.Active || scope.WorkspaceId != rule.WorkspaceId)
            {
                return Evaluation.Skip(rule, context, "scope_gone");
            }
        }

        if (item is not null && rule.ScopeItemId is { } scopeItem && item.Id != scopeItem
            && !await tree.IsVisibleSubtreeMemberAsync(rule.WorkspaceId, scopeItem, item.Id, cancellationToken).ConfigureAwait(false))
        {
            return Evaluation.Skip(rule, context, "out_of_scope");
        }

        if (item is not null)
        {
            context = context with { Item = item, ItemTitle = ItemProperties.ReadTitle(item.Properties) };
        }

        if (item is null && (!context.Conditions.IsEmpty || actions.Any(UsesTriggeringItem)))
        {
            return Evaluation.Skip(rule, context, "item_required");
        }

        var bag = ParseBag(item?.Properties);

        // 4. The trigger still holds on current data.
        AutomationItemState? state = null;
        if (item is not null)
        {
            state = await runs.GetItemStateAsync(rule.TenantId, rule.Id, item.Id, cancellationToken).ConfigureAwait(false);
        }

        switch (execution.Origin)
        {
            case AutomationOrigin.Schedule when trigger is ScheduleTrigger scheduled:
                if (execution.Key.Day is not { } day || !AutomationSchedule.ProducesDay(scheduled, day))
                {
                    return Evaluation.Skip(rule, context, "schedule_changed");
                }

                break;
            case AutomationOrigin.Date when trigger is DateArrivesTrigger date:
                var instant = AutomationDateInstant.Resolve(ReadValue(bag, date.Key), date.Time, date.OffsetMinutes, ownerZone);
                if (instant is null || instant != execution.Key.Instant)
                {
                    return Evaluation.Skip(rule, context, "date_changed");
                }

                break;
            case AutomationOrigin.Property when trigger is PropertyChangedTrigger property:
                var current = ReadValue(bag, property.Key);
                if (property.To is { } to && !JsonNode.DeepEquals(current, to.Value))
                {
                    return Evaluation.Skip(rule, context, "condition_changed");
                }

                if (state?.LastValueHash is { } lastHash && lastHash == AutomationValueHash.Of(current))
                {
                    return Evaluation.Skip(rule, context, "no_change");
                }

                break;
            case AutomationOrigin.Manual:
                break;
            default:
                return Evaluation.Skip(rule, context, "trigger_changed");
        }

        // 5. Conditions.
        if (!context.Conditions.All(condition => condition.IsMet(bag)))
        {
            return Evaluation.Skip(rule, context, "conditions_unmet");
        }

        // 6. Throttles.
        if (state is not null && state.LastFiredAt > now - AutomationGuards.PerItemMinInterval)
        {
            return Evaluation.Skip(rule, context, "throttled");
        }

        var recent = await runs.CountWorkingRunsSinceAsync(rule.TenantId, rule.Id, now.AddHours(-1), cancellationToken).ConfigureAwait(false);
        if (recent >= AutomationGuards.PerRuleHourly)
        {
            return Evaluation.Skip(rule, context, HourlyCapReason);
        }

        return new Evaluation(rule, context, null);
    }

    private async Task<ActionsResult> RunActionsAsync(ExecutionContext context, Guid runId, CancellationToken cancellationToken)
    {
        var changed = false;
        for (var index = 0; index < context.Actions.Length; index++)
        {
            var step = context.Actions[index] switch
            {
                SetPropertyAction set => await SetPropertyAsync(context, set, cancellationToken).ConfigureAwait(false),
                CreateItemAction create => await CreateItemAsync(context, create, cancellationToken).ConfigureAwait(false),
                NotifyAction notify => await NotifyAsync(context, notify, runId, index, cancellationToken).ConfigureAwait(false),
                _ => ActionStep.Failed("action.unavailable"),
            };
            if (step.FailureCode is { } code)
            {
                return ActionsResult.Failed(index, code);
            }

            changed |= step.Changed;
        }

        return new ActionsResult(changed, null);
    }

    private async Task<ActionStep> SetPropertyAsync(ExecutionContext context, SetPropertyAction set, CancellationToken cancellationToken)
    {
        var targetId = Resolve(context, set.Target);
        var target = targetId is { } id ? await tree.FindAsync(ItemId.From(id), cancellationToken).ConfigureAwait(false) : null;
        if (target is null || target.WorkspaceId != context.Rule.WorkspaceId || target.LifecycleState != ItemLifecycleState.Active)
        {
            return ActionStep.Failed("set_property.target_not_found");
        }

        if (await IsLockedAsync(target.Id, cancellationToken).ConfigureAwait(false))
        {
            return ActionStep.Failed("set_property.target_locked");
        }

        // Writing the value already there is a no-op: nothing is written, so nothing refires.
        if (JsonNode.DeepEquals(ReadValue(ParseBag(target.Properties), set.Key), set.Value))
        {
            return ActionStep.Unchanged;
        }

        var changes = new JsonObject { [set.Key] = set.Value?.DeepClone() };
        var written = await dispatcher.SendAsync<SetItemProperties, Item>(
            new SetItemProperties(target.Id, changes.ToJsonString()), cancellationToken).ConfigureAwait(false);
        return written.IsFailure ? ActionStep.Failed(written.Error.Code) : ActionStep.Done;
    }

    private async Task<ActionStep> CreateItemAsync(ExecutionContext context, CreateItemAction create, CancellationToken cancellationToken)
    {
        if (Resolve(context, create.Parent) is not { } parentId)
        {
            return ActionStep.Failed("create_item.parent_not_found");
        }

        if (await IsLockedAsync(ItemId.From(parentId), cancellationToken).ConfigureAwait(false))
        {
            return ActionStep.Failed("create_item.parent_locked");
        }

        var title = RenderTitle(create.Title, context, AutomationActionJson.MaximumItemTitle);
        var created = await dispatcher.SendAsync<CreateItem, Item>(
            new CreateItem(context.Rule.WorkspaceId, create.ItemType, title, ItemId.From(parentId), create.Properties?.DeepClone().AsObject()),
            cancellationToken).ConfigureAwait(false);
        return created.IsFailure ? ActionStep.Failed(created.Error.Code) : ActionStep.Done;
    }

    private async Task<ActionStep> NotifyAsync(ExecutionContext context, NotifyAction notify, Guid runId, int index, CancellationToken cancellationToken)
    {
        // The writer refuses any recipient but the session's principal; say so plainly here too.
        if (session.Current?.PrincipalId != context.Rule.OwnerPrincipalId)
        {
            return ActionStep.Failed("notify.not_owner");
        }

        await notifications.CreateAsync(
            context.Rule.OwnerPrincipalId,
            NotificationKind.Automation,
            RenderTitle(notify.Title, context, AutomationActionJson.MaximumNotifyTitle),
            AutomationTitleTemplate.Render(notify.Body, context.LocalDate, context.ItemTitle, AutomationActionJson.MaximumNotifyBody),
            context.Item?.Id,
            context.Rule.WorkspaceId,
            $"automation:{runId:D}:{index.ToString(CultureInfo.InvariantCulture)}",
            cancellationToken).ConfigureAwait(false);
        return ActionStep.Done;
    }

    private async Task<bool> IsLockedAsync(ItemId itemId, CancellationToken cancellationToken) =>
        (await locks.LockedAmongAsync([itemId], cancellationToken).ConfigureAwait(false)).Contains(itemId);

    private async Task RecordFailureAsync(AutomationRule rule, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var outcome = await rules.RecordFailureAsync(rule.TenantId, rule.Id, now, cancellationToken).ConfigureAwait(false);
        if (outcome is not { Disabled: true })
        {
            return;
        }

        await triggers.CancelForRuleAsync(rule.TenantId, rule.OwnerPrincipalId, rule.Id, null, cancellationToken).ConfigureAwait(false);
        if (session.Current?.PrincipalId == rule.OwnerPrincipalId)
        {
            var name = rule.Name.Length > 120 ? rule.Name[..120] : rule.Name;
            await notifications.CreateAsync(
                rule.OwnerPrincipalId,
                NotificationKind.Automation,
                "Automation turned off",
                $"\"{name}\" failed {AutomationGuards.DisableAfterFailures} times in a row and was turned off. Check it, then turn it back on.",
                null,
                rule.WorkspaceId,
                $"automation-disabled:{rule.Id:D}:{outcome.Revision.ToString(CultureInfo.InvariantCulture)}",
                cancellationToken).ConfigureAwait(false);
        }
    }

    private static AutomationRun NewRun(
        AutomationRule rule,
        AutomationExecution execution,
        AutomationRunStatus status,
        string? detail,
        DateTimeOffset now,
        Guid? itemId,
        string? triggerKey = null) => new()
        {
            TenantId = rule.TenantId,
            Id = Guid.CreateVersion7(),
            RuleId = rule.Id,
            OwnerPrincipalId = rule.OwnerPrincipalId,
            WorkspaceId = rule.WorkspaceId,
            ItemId = itemId,
            TriggerKey = triggerKey ?? execution.TriggerKey,
            Origin = execution.Origin,
            Depth = (short)Math.Clamp(execution.Depth, 0, short.MaxValue),
            Status = status,
            Detail = detail,
            CreatedAt = now,
        };

    /// <summary>Reason codes only - never an exception message or any user text.</summary>
    private static string Detail(string reason, string? code, int? action)
    {
        var detail = new JsonObject { ["reason"] = reason };
        if (code is not null)
        {
            detail["code"] = code.Length > 100 ? code[..100] : code;
        }

        if (action is not null)
        {
            detail["action"] = action.Value;
        }

        return detail.ToJsonString();
    }

    private static string RenderTitle(string template, ExecutionContext context, int maximum)
    {
        var rendered = AutomationTitleTemplate.Render(template, context.LocalDate, context.ItemTitle, maximum);
        if (!string.IsNullOrWhiteSpace(rendered))
        {
            return rendered;
        }

        return context.Rule.Name.Length > maximum ? context.Rule.Name[..maximum] : context.Rule.Name;
    }

    private static Guid? Resolve(ExecutionContext context, AutomationItemReference reference) => reference.Kind switch
    {
        AutomationItemReferenceKind.TriggeringItem => context.Item?.Id.Value,
        AutomationItemReferenceKind.Scope => context.Rule.ScopeItemId?.Value,
        _ => reference.ItemId,
    };

    private static bool UsesTriggeringItem(AutomationAction action) => action switch
    {
        SetPropertyAction set => set.Target.Kind == AutomationItemReferenceKind.TriggeringItem,
        CreateItemAction create => create.Parent.Kind == AutomationItemReferenceKind.TriggeringItem,
        _ => false,
    };

    private static JsonObject? ParseBag(string? properties)
    {
        if (string.IsNullOrWhiteSpace(properties))
        {
            return null;
        }

        try
        {
            return JsonNode.Parse(properties) as JsonObject;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static JsonNode? ReadValue(string? properties, string key) => ReadValue(ParseBag(properties), key);

    private static JsonNode? ReadValue(JsonObject? bag, string key) =>
        bag is not null && bag.TryGetPropertyValue(key, out var value) ? value : null;

    private sealed record ExecutionContext(
        AutomationRule Rule,
        AutomationTrigger Trigger,
        ImmutableArray<AutomationCondition> Conditions,
        ImmutableArray<AutomationAction> Actions,
        Item? Item,
        string? ItemTitle,
        string OwnerZone,
        DateOnly LocalDate);

    private sealed record Evaluation(AutomationRule? Rule, ExecutionContext? Context, string? Reason)
    {
        public static Evaluation Stop(string reason) => new(null, null, reason);

        public static Evaluation Skip(AutomationRule rule, ExecutionContext? context, string reason) => new(rule, context, reason);
    }

    private sealed record ActionStep(bool Changed, string? FailureCode)
    {
        public static ActionStep Done { get; } = new(true, null);

        public static ActionStep Unchanged { get; } = new(false, null);

        public static ActionStep Failed(string code) => new(false, code);
    }

    private sealed record ActionsResult(bool Changed, (int Index, string Code)? Failure)
    {
        public static ActionsResult Failed(int index, string code) => new(false, (index, code));
    }
}
