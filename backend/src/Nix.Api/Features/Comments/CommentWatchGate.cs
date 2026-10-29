using Nix.Features.Notifications;

namespace Nix.Features.Comments;

/// <summary>
/// Its own 2 slots per principal, but the 40-per-process total is the notifications gate's, so the
/// two long-poll routes together never hold more than 40 pooled connections.
/// </summary>
public sealed class CommentWatchGate(NotificationWatchGate notifications) : NotificationWatchGate(notifications);
