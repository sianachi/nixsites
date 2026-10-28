using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Scheduling;

/// <summary>What produced a scheduled trigger, and therefore which <c>ITriggerSource</c> resolves it.</summary>
public enum TriggerKind
{
    /// <summary>A due task, recurring occurrence, habit check-in or explicit reminder.</summary>
    Reminder,

    /// <summary>An automation rule's schedule or date trigger.</summary>
    Automation,

    /// <summary>
    /// Core's own notices (a workspace invitation), and the tests that exercise the plan -&gt; fire
    /// -&gt; notify path end to end.
    /// </summary>
    System,

    /// <summary>A calendar link's planned poll or a write in its container (ADR-0052).</summary>
    Calendar,
}

/// <summary>Where a scheduled trigger is in its lease lifecycle.</summary>
public enum TriggerStatus
{
    /// <summary>Planned and waiting for its <c>fire_at</c> instant.</summary>
    Pending,

    /// <summary>Currently leased by a dispatcher replica.</summary>
    Leased,

    /// <summary>Fired successfully.</summary>
    Fired,

    /// <summary>Re-verified at fire time and found no longer true; never retried.</summary>
    Skipped,

    /// <summary>Superseded by replanning before it fired.</summary>
    Cancelled,
}

/// <summary>
/// The one mapping between <see cref="TriggerKind"/> and its lowercase storage spelling, and
/// between <see cref="TriggerStatus"/> and its lowercase storage spelling.
/// </summary>
public static class TriggerStorage
{
    /// <summary>Converts a trigger kind to its stored spelling.</summary>
    public static string ToText(TriggerKind kind) => kind switch
    {
        TriggerKind.Reminder => "reminder",
        TriggerKind.Automation => "automation",
        TriggerKind.System => "system",
        TriggerKind.Calendar => "calendar",
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "Unknown trigger kind."),
    };

    /// <summary>Parses a trigger kind back from its stored spelling.</summary>
    public static TriggerKind KindFromText(string text) => text switch
    {
        "reminder" => TriggerKind.Reminder,
        "automation" => TriggerKind.Automation,
        "system" => TriggerKind.System,
        "calendar" => TriggerKind.Calendar,
        _ => throw new InvalidOperationException($"Unknown stored trigger kind '{text}'."),
    };

    /// <summary>Converts a trigger status to its stored spelling.</summary>
    public static string ToText(TriggerStatus status) => status switch
    {
        TriggerStatus.Pending => "pending",
        TriggerStatus.Leased => "leased",
        TriggerStatus.Fired => "fired",
        TriggerStatus.Skipped => "skipped",
        TriggerStatus.Cancelled => "cancelled",
        _ => throw new ArgumentOutOfRangeException(nameof(status), status, "Unknown trigger status."),
    };

    /// <summary>Parses a trigger status back from its stored spelling.</summary>
    public static TriggerStatus StatusFromText(string text) => text switch
    {
        "pending" => TriggerStatus.Pending,
        "leased" => TriggerStatus.Leased,
        "fired" => TriggerStatus.Fired,
        "skipped" => TriggerStatus.Skipped,
        "cancelled" => TriggerStatus.Cancelled,
        _ => throw new InvalidOperationException($"Unknown stored trigger status '{text}'."),
    };
}

/// <summary>
/// Derived, rebuildable state: a planned instant at which some source's rule should fire. Never
/// the source of truth - at fire time the dispatcher re-reads the source and skips anything no
/// longer true.
/// </summary>
public sealed class ScheduledTrigger
{
    /// <summary>Gets the tenant, carried for row-level security.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the identity of this trigger.</summary>
    public required Guid Id { get; init; }

    /// <summary>Gets the workspace this trigger is about, or <see langword="null"/> for personal reminders.</summary>
    public WorkspaceId? WorkspaceId { get; init; }

    /// <summary>Gets the principal whose permissions the fired action runs under.</summary>
    public required PrincipalId PrincipalId { get; init; }

    /// <summary>Gets what produced this trigger.</summary>
    public required TriggerKind Kind { get; init; }

    /// <summary>
    /// Gets the unique, stable name of the <c>ITriggerSource</c> that planned this trigger (for
    /// example <c>reminder.due</c>) - what the dispatcher resolves a leased row's fire action by,
    /// never <see cref="Kind"/> alone. <see cref="Kind"/> stays the category for display and
    /// reporting; more than one source shares a kind, and only <see cref="Source"/> tells them
    /// apart.
    /// </summary>
    public required string Source { get; init; }

    /// <summary>Gets the item this trigger is about, or <see langword="null"/> when it is not about one.</summary>
    public Guid? SourceItemId { get; init; }

    /// <summary>Gets the automation rule this trigger is about, or <see langword="null"/> when it is not about one.</summary>
    public Guid? RuleId { get; init; }

    /// <summary>Gets the instant this trigger should fire.</summary>
    public required DateTimeOffset FireAt { get; init; }

    /// <summary>
    /// Gets the key that makes planning idempotent: replanning the same source rule for the same
    /// recipient upserts the row this key already names instead of creating a duplicate.
    /// </summary>
    public required string DedupeKey { get; init; }

    /// <summary>Gets where this trigger is in its lease lifecycle.</summary>
    public required TriggerStatus Status { get; init; }

    /// <summary>Gets the opaque identity of the dispatcher replica currently holding the lease, if any.</summary>
    public string? LeaseOwner { get; init; }

    /// <summary>Gets when the current lease expires, if any.</summary>
    public DateTimeOffset? LeaseUntil { get; init; }

    /// <summary>Gets how many times this trigger has been leased.</summary>
    public required int Attempts { get; init; }

    /// <summary>Gets free-form detail recorded on the last fire attempt (a skip reason, an error class).</summary>
    public string? Detail { get; init; }

    /// <summary>Gets when this trigger was first planned.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets when this trigger was last updated.</summary>
    public required DateTimeOffset UpdatedAt { get; init; }
}
