using Nix.Abstractions;
using Nix.Domain.Notifications;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Notifications;

/// <summary>Reads a page of the session owner's own inbox.</summary>
public sealed class GetNotificationsHandler(INotificationStore store, INixSessionContextAccessor session) : IQueryHandler<GetNotifications, NotificationsPageResponse>
{
    /// <inheritdoc />
    public async ValueTask<NotificationsPageResponse> HandleAsync(GetNotifications query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        var context = session.Current ?? throw new InvalidOperationException("A session is required.");
        var page = await store.ListAsync(context.TenantId, context.PrincipalId, NotificationCursor.Decode(query.Cursor),
            query.UnreadOnly, Nix.Contracts.CursorPaging.DefaultLimit, cancellationToken).ConfigureAwait(false);
        return NotificationsMapping.ToResponse(page);
    }
}

/// <summary>Marks one of the session owner's own notifications read.</summary>
public sealed class MarkNotificationReadHandler(INotificationStore store, INixSessionContextAccessor session) : ICommandHandler<MarkNotificationRead, NotificationReadResponse>
{
    /// <inheritdoc />
    public async ValueTask<Result<NotificationReadResponse>> HandleAsync(MarkNotificationRead command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var context = session.Current ?? throw new InvalidOperationException("A session is required.");
        var found = await store.MarkReadAsync(context.TenantId, context.PrincipalId, command.NotificationId, cancellationToken).ConfigureAwait(false);
        if (!found)
        {
            return Result.Failure<NotificationReadResponse>(new NixError("notifications.not_found", "That notification is unavailable."));
        }

        var (unread, _) = await store.SummaryAsync(context.TenantId, context.PrincipalId, cancellationToken).ConfigureAwait(false);
        return Result.Success(new NotificationReadResponse(unread));
    }
}

/// <summary>Marks every one of the session owner's unread notifications read.</summary>
public sealed class MarkAllNotificationsReadHandler(INotificationStore store, INixSessionContextAccessor session) : ICommandHandler<MarkAllNotificationsRead, NotificationReadResponse>
{
    /// <inheritdoc />
    public async ValueTask<Result<NotificationReadResponse>> HandleAsync(MarkAllNotificationsRead command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var context = session.Current ?? throw new InvalidOperationException("A session is required.");
        await store.MarkAllReadAsync(context.TenantId, context.PrincipalId, cancellationToken).ConfigureAwait(false);
        return Result.Success(new NotificationReadResponse(0));
    }
}

/// <summary>
/// Long-polls the session owner's inbox for a change past a known revision, modelled on the
/// pet runtime watch: the same unit of work stays open for the whole wait (bounded by
/// <see cref="NotificationWatchGate"/>), and each poll is a fresh statement, so
/// PostgreSQL's read-committed default lets it see notifications another connection committed
/// while this one waited.
/// </summary>
public sealed class WatchNotificationsHandler(INotificationStore store, INixSessionContextAccessor session) : IQueryHandler<WatchNotifications, NotificationsPageResponse>
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(750);
    private static readonly TimeSpan MaxWait = TimeSpan.FromSeconds(20);

    /// <inheritdoc />
    public async ValueTask<NotificationsPageResponse> HandleAsync(WatchNotifications query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        var context = session.Current ?? throw new InvalidOperationException("A session is required.");
        var deadline = DateTimeOffset.UtcNow + MaxWait;
        while (true)
        {
            var (_, revision) = await store.SummaryAsync(context.TenantId, context.PrincipalId, cancellationToken).ConfigureAwait(false);
            if (revision > query.After || DateTimeOffset.UtcNow >= deadline)
            {
                var page = await store.ListAsync(context.TenantId, context.PrincipalId, afterSeq: null, unreadOnly: false,
                    Nix.Contracts.CursorPaging.DefaultLimit, cancellationToken).ConfigureAwait(false);
                return NotificationsMapping.ToResponse(page);
            }

            var remaining = deadline - DateTimeOffset.UtcNow;
            await Task.Delay(remaining < PollInterval ? remaining : PollInterval, cancellationToken).ConfigureAwait(false);
        }
    }
}

internal static class NotificationsMapping
{
    internal static NotificationsPageResponse ToResponse(NotificationPage page) => new(
        [.. page.Items.Select(row => new NotificationDto(row.Id, NotificationKindStorage.ToText(row.Kind),
            row.Title, row.Body, row.ItemId?.Value, row.WorkspaceId?.Value, row.CreatedAt, row.ReadAt,
            row.ItemId is not null && row.WorkspaceId is not null && row.PetDecision is { } target
                ? new(target.RunId, target.DecisionId, target.IsQuestion ? "question" : "proposal")
                : null))],
        page.NextCursor, page.Unread, page.Revision);
}
