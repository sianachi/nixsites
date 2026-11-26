using Nix.Domain.Primitives;

namespace Nix.Domain.Items;

/// <summary>
/// The shape of a message item: the kind, the one server-owned property that carries everything
/// (<c>$message</c>, a JSON string of text, author and addressees) and its bounds.
/// </summary>
/// <remarks>
/// A message is an ordinary item. Replies are its children, so the subtree is the thread. The
/// <c>$</c> key means no generic write can set or change it; only the post-message route can.
/// </remarks>
public static class MessageItem
{
    /// <summary>The item kind.</summary>
    public const string Type = "message";

    /// <summary>The property holding the message JSON.</summary>
    public const string Key = "$message";

    /// <summary>The longest message text, in UTF-16 units.</summary>
    public const int MaxTextLength = 16_000;

    /// <summary>The most addressees one message can name.</summary>
    public const int MaxRecipients = 20;

    /// <summary>The refusal for a generic edit of a posted message.</summary>
    public static NixError Immutable => new("items.read_only", "A posted message cannot be edited.");
}
