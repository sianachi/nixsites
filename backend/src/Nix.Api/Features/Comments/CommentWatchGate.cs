using Nix.Features.Notifications;

namespace Nix.Features.Comments;

/// <summary>
/// The same bounds as <see cref="NotificationWatchGate"/> (2 per principal, 40 per process), counted
/// separately: it is a distinct singleton, so a notifications watch never uses up a comments slot.
/// </summary>
public sealed class CommentWatchGate : NotificationWatchGate;
