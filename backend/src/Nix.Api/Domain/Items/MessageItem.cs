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

    /// <summary>The refusal for creating a message any way but the post-message route.</summary>
    public static NixError Reserved => new("items.reserved_type", "Post a message with the messages route.");

    /// <summary>The refusal for moving a message out of its thread or an item into one.</summary>
    public static NixError Fixed => new("items.read_only", "A message stays where it was posted.");

    /// <summary>The refusal for removing somebody else's message.</summary>
    public static NixError NotYours => new("items.read_only", "Only the person who posted a message can delete it.");
}
