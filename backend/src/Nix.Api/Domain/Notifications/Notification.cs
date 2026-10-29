using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Notifications;

/// <summary>What produced a notification, for grouping and icon choice in the inbox.</summary>
public enum NotificationKind
{
    /// <summary>A due task, recurring occurrence, habit check-in or explicit reminder.</summary>
    Reminder,

    /// <summary>An automation rule's <c>notify</c> action.</summary>
    Automation,

    /// <summary>A calendar sync event.</summary>
    Calendar,

    /// <summary>Anything else Core itself needs to tell the principal.</summary>
    System,

    /// <summary>An invitation to join a workspace, waiting for the recipient to accept or decline.</summary>
    Invitation,

    /// <summary>A reply or mention in a note's comment thread.</summary>
    Comment,
}

/// <summary>One entry in a principal's inbox. Never shared with anyone else, even in the same workspace.</summary>
public sealed class Notification
{
    /// <summary>Gets the tenant, carried for row-level security.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the identity of this notification.</summary>
    public required Guid Id { get; init; }

    /// <summary>Gets the recipient. Never anyone other than the principal who reads it.</summary>
    public required PrincipalId PrincipalId { get; init; }

    /// <summary>Gets what produced this notification.</summary>
    public required NotificationKind Kind { get; init; }

    /// <summary>Gets the headline shown in the inbox and the push payload, at most 200 characters.</summary>
    public required string Title { get; init; }

    /// <summary>Gets the supporting text, at most 1000 characters.</summary>
    public required string Body { get; init; }

    /// <summary>Gets the item this notification is about, or <see langword="null"/> when it is not about one.</summary>
    public ItemId? ItemId { get; init; }

    /// <summary>Gets the workspace this notification is about, or <see langword="null"/> when it is not about one.</summary>
    public WorkspaceId? WorkspaceId { get; init; }

    /// <summary>Gets when this notification was created. Also the newest-first ordering key.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets the position in this principal's inbox, for keyset paging.</summary>
    public required long Seq { get; init; }

    /// <summary>Gets when this notification was read, or <see langword="null"/> while unread.</summary>
    public DateTimeOffset? ReadAt { get; init; }

    /// <summary>
    /// Gets the key that makes creating this notification idempotent: a duplicate create with the
    /// same key returns the row that already exists instead of writing a second one.
    /// </summary>
    public required string DedupeKey { get; init; }
}
