using System.Text.Json.Nodes;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Features.Automations;

/// <summary>A rule as a caller writes it.</summary>
/// <param name="Name">What the owner calls it, 1..200 characters.</param>
/// <param name="Enabled">Whether it fires.</param>
/// <param name="ScopeItemId">The subtree it watches and may create under, or null for the whole workspace.</param>
/// <param name="Trigger">
/// The trigger document: <c>schedule</c> (<c>freq</c>, <c>interval</c>, <c>weekdays</c>, <c>time</c>,
/// <c>timeZone</c>, <c>startDate</c>), <c>date_arrives</c> (<c>key</c>, <c>offsetMinutes</c>,
/// <c>time</c>) or <c>property_changed</c> (<c>key</c>, optional <c>from</c>/<c>to</c> as
/// <c>{"value": ...}</c>).
/// </param>
/// <param name="Conditions">Up to five <c>{key, op, value?}</c> checks on the triggering item.</param>
/// <param name="Actions">
/// One to five of <c>set_property</c>, <c>create_item</c> and <c>notify</c>. Pet routines use a
/// sole <c>start_pet_run</c> or <c>poll_pet_mailbox</c> action on a schedule with an exact task scope.
/// </param>
public sealed record AutomationRuleInput(
    string Name,
    bool Enabled,
    Guid? ScopeItemId,
    JsonObject Trigger,
    JsonArray? Conditions,
    JsonArray Actions);

/// <summary>Replaces a rule at the revision the caller read.</summary>
public sealed record UpdateAutomationRequest(long ExpectedRevision, AutomationRuleInput Rule);

/// <summary>Runs or dry-runs a rule, optionally against one item.</summary>
public sealed record AutomationItemRequest(Guid? ItemId);

/// <summary>A stored rule.</summary>
public sealed record AutomationRuleResponse(
    Guid Id,
    Guid WorkspaceId,
    string Name,
    bool Enabled,
    Guid? ScopeItemId,
    JsonObject Trigger,
    JsonArray Conditions,
    JsonArray Actions,
    long Revision,
    int ConsecutiveFailures,
    string? DisabledReason,
    DateTimeOffset? LastRunAt,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);

/// <summary>The caller's own rules in one workspace.</summary>
public sealed record AutomationListResponse(IReadOnlyList<AutomationRuleResponse> Items);

/// <summary>One run of a rule.</summary>
/// <param name="Reason">A reason code (such as <c>throttled</c> or <c>set_property.not_found</c>), never a message.</param>
public sealed record AutomationRunResponse(
    Guid Id,
    Guid RuleId,
    Guid? ItemId,
    string Origin,
    int Depth,
    string Status,
    string? Reason,
    DateTimeOffset CreatedAt);

/// <summary>A page of a rule's runs, newest first.</summary>
public sealed record AutomationRunsPageResponse(IReadOnlyList<AutomationRunResponse> Items, string? NextCursor);

/// <summary>What one action would do, rendered, without doing it.</summary>
public sealed record AutomationActionPreview(int Index, string Type, Guid? ItemId, string? Key, string? Title, string? Body);

/// <summary>The outcome of a dry run.</summary>
/// <param name="WouldRun">Whether the rule would run its actions now.</param>
/// <param name="Reason">Why it would not, as a reason code.</param>
public sealed record AutomationTestResponse(bool WouldRun, string? Reason, IReadOnlyList<AutomationActionPreview> Actions);

/// <summary>Lists the caller's own rules in a workspace.</summary>
public sealed record ListAutomations(WorkspaceId WorkspaceId) : ICommand<AutomationListResponse>;

/// <summary>Creates a rule owned by the caller.</summary>
public sealed record CreateAutomation(WorkspaceId WorkspaceId, AutomationRuleInput Rule) : ICommand<AutomationRuleResponse>
{
    internal bool VerifiedBrowserOwner { get; init; }
}

/// <summary>Reads one of the caller's rules.</summary>
public sealed record GetAutomation(Guid RuleId) : ICommand<AutomationRuleResponse>;

/// <summary>Replaces one of the caller's rules at a revision.</summary>
public sealed record UpdateAutomation(Guid RuleId, long ExpectedRevision, AutomationRuleInput Rule) : ICommand<AutomationRuleResponse>
{
    internal bool VerifiedBrowserOwner { get; init; }
}

/// <summary>Deletes one of the caller's rules and cancels its pending triggers.</summary>
public sealed record DeleteAutomation(Guid RuleId) : ICommand<bool>;

/// <summary>Reads a page of one of the caller's rules' runs.</summary>
public sealed record ListAutomationRuns(Guid RuleId, string? Cursor) : ICommand<AutomationRunsPageResponse>;

/// <summary>Runs one of the caller's rules now.</summary>
public sealed record RunAutomation(Guid RuleId, Guid? ItemId) : ICommand<AutomationRunResponse>;

/// <summary>Dry-runs one of the caller's rules, writing nothing.</summary>
public sealed record TestAutomation(Guid RuleId, Guid? ItemId) : ICommand<AutomationTestResponse>;
