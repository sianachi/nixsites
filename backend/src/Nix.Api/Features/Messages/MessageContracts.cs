using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Messages;

/// <summary>One addressee: a person or one of the poster's own pets. <c>kind</c> is <c>person</c> or <c>pet</c>.</summary>
public sealed record MessageAddress(Guid Id, string Kind);

/// <summary>
/// Posts a message under an item, or a reply under a message. <c>to</c> is explicit; the text is never
/// parsed for mentions. The author is the session, never the body.
/// </summary>
public sealed record PostMessageRequest(string Text, IReadOnlyList<MessageAddress>? To);

/// <summary>Someone a message under an item can address.</summary>
public sealed record MessageAddressee(Guid Id, string Name, string Kind);

/// <summary>Who a message under an item can address: the caller's pets, and the people who can read the item.</summary>
public sealed record MessageDirectoryResponse(IReadOnlyList<MessageAddressee> Addressees);

/// <summary>Posts a message under <paramref name="ParentId"/>.</summary>
public sealed record PostMessage(ItemId ParentId, PostMessageRequest Request) : ICommand<Item>;

/// <summary>Lists who a message under <paramref name="ItemId"/> can address.</summary>
public sealed record GetMessageDirectory(ItemId ItemId, string? Search) : IQuery<Result<MessageDirectoryResponse>>;
