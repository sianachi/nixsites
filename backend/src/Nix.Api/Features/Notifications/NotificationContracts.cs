using Nix.Messaging;

namespace Nix.Features.Notifications;

/// <summary>One inbox entry, as the client sees it.</summary>
public sealed record NotificationDto(Guid Id, string Kind, string Title, string Body,
    Guid? ItemId, Guid? WorkspaceId, DateTimeOffset CreatedAt, DateTimeOffset? ReadAt,
    NotificationPetDecisionDto? PetDecision = null);

/// <summary>An exact question or proposal in the item pet dialog.</summary>
public sealed record NotificationPetDecisionDto(Guid RunId, Guid DecisionId, string Kind);

/// <summary>One slice of the caller's inbox.</summary>
public sealed record NotificationsPageResponse(IReadOnlyList<NotificationDto> Items, string? NextCursor, int Unread, long Revision);

/// <summary>Reads a page of the caller's own inbox, newest first.</summary>
public sealed record GetNotifications(string? Cursor, bool UnreadOnly) : IQuery<NotificationsPageResponse>;

/// <summary>The result of a read action: the inbox's unread count afterwards.</summary>
public sealed record NotificationReadResponse(int Unread);

/// <summary>Marks one of the caller's own notifications read.</summary>
public sealed record MarkNotificationRead(Guid NotificationId) : ICommand<NotificationReadResponse>;

/// <summary>Marks every one of the caller's unread notifications read.</summary>
public sealed record MarkAllNotificationsRead : ICommand<NotificationReadResponse>;

/// <summary>Long-polls the caller's own inbox for a change past a known revision.</summary>
public sealed record WatchNotifications(long After) : IQuery<NotificationsPageResponse>;
