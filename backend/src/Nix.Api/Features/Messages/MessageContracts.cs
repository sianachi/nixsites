using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Messages;

/// <summary>One addressee: a person, one of the poster's own pets, or one of the poster's agent tokens. <c>kind</c> is <c>person</c>, <c>pet</c> or <c>agent</c>.</summary>
public sealed record MessageAddress(Guid Id, string Kind);

/// <summary>
/// Posts a message under an item, or a reply under a message. <c>to</c> is explicit; the text is never
/// parsed for mentions. The author is the session, never the body.
/// </summary>
public sealed record PostMessageRequest(string Text, IReadOnlyList<MessageAddress>? To);

/// <summary>Someone a message under an item can address.</summary>
public sealed record MessageAddressee(Guid Id, string Name, string Kind);

/// <summary>Who a message under an item can address: the caller's pets and agents, and the people who can read the item.</summary>
public sealed record MessageDirectoryResponse(IReadOnlyList<MessageAddressee> Addressees);

/// <summary>
/// Where one pet's turn for a message stands: <c>pending</c> (waits for its owner), <c>working</c>, <c>answered</c>,
/// <c>failed</c>, <c>declined</c> or <c>expired</c>. <paramref name="Reason"/> says why a turn failed or was declined.
/// <paramref name="Code"/> is the stable error code of a failed turn that could not start (<c>pets.no_provider_key</c>).
/// <paramref name="Memory"/> is a fact the pet wants to remember from the message, waiting for its owner to approve or dismiss it.
/// </summary>
public sealed record MessagePetState(Guid PetId, string Name, string Status, string? Reason, DateTimeOffset? ExpiresAt, string? Memory = null, string? Code = null);

/// <summary>One unread message in an agent's inbox: the message, its thread's first message, the item the thread sits under, who wrote it and what it says.</summary>
public sealed record MessageInboxEntry(Guid MessageId, Guid ThreadId, Guid? ParentId, Guid WorkspaceId, MessageAuthor Author, string Text, DateTimeOffset CreatedAt);

/// <summary>An agent's unread messages, newest first. <paramref name="Next"/> is the cursor (<c>after</c>) for the next page, null at the end.</summary>
public sealed record MessageInboxResponse(IReadOnlyList<MessageInboxEntry> Messages, Guid? Next);

/// <summary>Messages of the caller's inbox to mark read.</summary>
public sealed record MarkMessagesReadRequest(IReadOnlyList<Guid> MessageIds);

/// <summary>How many of the named messages were unread and are now read.</summary>
public sealed record MarkMessagesReadResponse(int Marked);

/// <summary>A posted message, where each pet it addressed stands, and (when it addressed a pet) the poster's monthly pet budget.</summary>
public sealed record PostedMessage(Item Message, IReadOnlyList<MessagePetState> Pets, Nix.Features.Pets.PetBudgetStatus? Budget);

/// <summary>The pets a message addressed and where each one's turn stands.</summary>
public sealed record MessagePetStatesResponse(IReadOnlyList<MessagePetState> Pets);

/// <summary>Posts a message under <paramref name="ParentId"/>.</summary>
public sealed record PostMessage(ItemId ParentId, PostMessageRequest Request) : ICommand<PostedMessage>;

/// <summary>Lists who a message under <paramref name="ItemId"/> can address.</summary>
public sealed record GetMessageDirectory(ItemId ItemId, string? Search) : IQuery<Result<MessageDirectoryResponse>>;

/// <summary>The response to posting a message: the message as an item, where each addressed pet's turn stands, and the poster's pet budget when a pet was addressed.</summary>
internal sealed record PostedMessageResponse(Nix.Features.Items.ItemResponse Message, IReadOnlyList<MessagePetState> Pets, Nix.Features.Pets.PetBudgetStatus? Budget);
