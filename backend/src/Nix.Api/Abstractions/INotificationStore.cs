using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Notifications;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>One slice of a principal's inbox, and the count still unread.</summary>
/// <param name="Items">The notifications in this slice, newest first.</param>
/// <param name="NextCursor">The cursor for the following slice, or <see langword="null"/> on the last one.</param>
/// <param name="Unread">How many of this principal's notifications are unread, regardless of slice.</param>
/// <param name="Revision">
/// The inbox change counter for this principal, bumped in the same transaction as every new
/// notification and every read. Callers of <c>watch</c> pass back the highest revision they have
/// already seen.
/// </param>
public sealed record NotificationPage(IReadOnlyList<Notification> Items, string? NextCursor, int Unread, long Revision);

/// <summary>Reads and updates only the session owner's inbox.</summary>
public interface INotificationStore
{
    /// <summary>Reads a page of the caller's notifications, newest first.</summary>
    public Task<NotificationPage> ListAsync(TenantId tenantId, PrincipalId principalId, long? afterSeq, bool unreadOnly, int limit, CancellationToken cancellationToken);

    /// <summary>Reads only the revision and unread count, without paging the rows.</summary>
    public Task<(int Unread, long Revision)> SummaryAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken);

    /// <summary>Reads one of the caller's own notifications by id, or <see langword="null"/> when it does not belong to them.</summary>
    public Task<Notification?> GetAsync(TenantId tenantId, PrincipalId principalId, Guid notificationId, CancellationToken cancellationToken);

    /// <summary>Marks one notification read. Returns <see langword="false"/> when it does not belong to this owner.</summary>
    public Task<bool> MarkReadAsync(TenantId tenantId, PrincipalId principalId, Guid notificationId, CancellationToken cancellationToken);

    /// <summary>Marks every unread notification of this owner read.</summary>
    public Task MarkAllReadAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken);

    /// <summary>
    /// Records that this notification's push is being handed to a worker. Returns
    /// <see langword="false"/> when it already was: the second worker must send nothing, so a
    /// job re-run after a crash can never push the same notification twice.
    /// </summary>
    public Task<bool> ClaimPushAsync(TenantId tenantId, PrincipalId principalId, Guid notificationId, CancellationToken cancellationToken);
}

/// <summary>A created or already existing notification, and which of the two it was.</summary>
/// <param name="Notification">The stored notification.</param>
/// <param name="Created">
/// <see langword="true"/> when this call inserted it; <see langword="false"/> when the dedupe key
/// already existed. Only a created notification should be pushed.
/// </param>
public sealed record NotificationWriteResult(Notification Notification, bool Created);

/// <summary>
/// Creates notifications on a recipient's behalf. Used by later lanes' background sources
/// (reminders, automations, calendar sync); the caller's session must already be scoped to the
/// recipient principal, the same way <c>AbandonedObjectReaper</c> scopes a session per row.
/// </summary>
public interface INotificationWriter
{
    /// <summary>
    /// Creates a notification, or returns the one that already exists for the same recipient and
    /// <paramref name="dedupeKey"/>.
    /// </summary>
    /// <remarks>
    /// Dedupe keys are built by server code from identifiers (rule, item, occurrence, recipient)
    /// and never contain user-written text. The session must be scoped to
    /// <paramref name="principal"/>; any other principal is refused.
    /// </remarks>
    public Task<NotificationWriteResult> CreateAsync(
        PrincipalId principal,
        NotificationKind kind,
        string title,
        string body,
        ItemId? itemId,
        WorkspaceId? workspaceId,
        string dedupeKey,
        CancellationToken cancellationToken);
}
