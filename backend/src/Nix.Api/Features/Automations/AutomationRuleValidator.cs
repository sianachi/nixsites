using System.Collections.Immutable;
using System.Text;
using Nix.Domain.Automations;
using Nix.Domain.Primitives;

namespace Nix.Features.Automations;

/// <summary>
/// Validates a whole rule document: the three JSON readers, then the checks that need more than
/// one part at once - a name, which references a trigger can supply, and which refusal code a
/// caller receives.
/// </summary>
/// <remarks>
/// Every violation is reported at once (joined into the problem's detail, the way
/// <c>PropertyErrors.InvalidProperties</c> does), so a form can show them all. Reasons are fixed
/// English, never an echo of the caller's value.
/// </remarks>
public static class AutomationRuleValidator
{
    /// <summary>The longest name a rule may have.</summary>
    public const int MaximumNameLength = 200;

    /// <summary>Validates <paramref name="input"/>.</summary>
    public static Result<AutomationDefinition> Validate(AutomationRuleInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        var violations = new List<AutomationViolation>();

        if (string.IsNullOrWhiteSpace(input.Name) || input.Name.Length > MaximumNameLength || input.Name.Any(char.IsControl))
        {
            violations.Add(new AutomationViolation("name", "must be 1 to 200 characters"));
        }

        var trigger = AutomationTriggerJson.Read(input.Trigger);
        violations.AddRange(trigger.Violations);
        var conditions = AutomationConditionJson.ReadAll(input.Conditions);
        violations.AddRange(conditions.Violations);
        var actions = AutomationActionJson.ReadAll(input.Actions);
        violations.AddRange(actions.Violations);
        if (!actions.Value.IsDefaultOrEmpty
            && Encoding.UTF8.GetByteCount(AutomationActionJson.WriteAll(actions.Value).ToJsonString()) > AutomationActionJson.MaximumTotalBytes)
        {
            violations.Add(new AutomationViolation("actions", "must be at most 12 KiB together"));
        }

        if (input.ScopeItemId == Guid.Empty)
        {
            violations.Add(new AutomationViolation("scopeItemId", "must be an item id or null"));
        }

        if (actions.Value.Any(action => action is StartPetRunAction or PollPetMailboxAction)
            && (actions.Value.Length != 1 || trigger.Value is not ScheduleTrigger || input.ScopeItemId is null))
        {
            violations.Add(new AutomationViolation("actions", "a pet routine must be the only action on a schedule with a scoped task"));
        }

        if (actions.Value.OfType<StartPetRunAction>().Any(action =>
            action.AutoRename is not null && !action.Abilities.Contains("task.rename", StringComparer.Ordinal)))
        {
            violations.Add(new AutomationViolation("actions", "an automatic rename requires the task.rename ability"));
        }

        if (trigger.Value is ScheduleTrigger)
        {
            if (!conditions.Value.IsDefaultOrEmpty)
            {
                violations.Add(new AutomationViolation("conditions", "are not allowed on a schedule rule, which has no triggering item"));
            }

            for (var index = 0; index < actions.Value.Length; index++)
            {
                if (References(actions.Value[index], AutomationItemReferenceKind.TriggeringItem))
                {
                    violations.Add(new AutomationViolation($"actions[{index}]", "cannot use the triggering item on a schedule rule"));
                }
            }
        }

        if (input.ScopeItemId is null)
        {
            for (var index = 0; index < actions.Value.Length; index++)
            {
                if (References(actions.Value[index], AutomationItemReferenceKind.Scope))
                {
                    violations.Add(new AutomationViolation($"actions[{index}].parent", "needs the rule to have a scope item"));
                }
            }
        }

        if (violations.Count > 0)
        {
            var message = string.Join("; ", violations.Select(violation => violation.ToString()));
            return Result.Failure<AutomationDefinition>(violations.Any(violation => violation.Unavailable)
                ? AutomationErrors.ActionUnavailable(message)
                : AutomationErrors.Invalid(message));
        }

        return Result.Success(new AutomationDefinition(
            input.Name.Trim(),
            input.Enabled,
            input.ScopeItemId,
            trigger.Value!,
            conditions.Value.IsDefault ? [] : conditions.Value,
            actions.Value));
    }

    /// <summary>The explicitly named items a rule's actions reference, for the visibility check at save time.</summary>
    public static ImmutableArray<Guid> NamedItems(AutomationDefinition definition)
    {
        ArgumentNullException.ThrowIfNull(definition);
        return [.. definition.Actions
            .Select(action => action switch
            {
                SetPropertyAction set => set.Target,
                CreateItemAction create => create.Parent,
                _ => null,
            })
            .Where(reference => reference is { Kind: AutomationItemReferenceKind.Item })
            .Select(reference => reference!.ItemId!.Value)
            .Concat(definition.Actions.OfType<StartPetRunAction>().SelectMany(action => action.SourceItemIds))
            .Distinct()];
    }

    private static bool References(AutomationAction action, AutomationItemReferenceKind kind) => action switch
    {
        SetPropertyAction set => set.Target.Kind == kind,
        CreateItemAction create => create.Parent.Kind == kind,
        _ => false,
    };
}
