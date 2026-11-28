using System.Text.Json.Serialization;

namespace Nix.Features.Messages;

/// <summary>Who wrote a message: a person (with the token they used, if any, by name and id) or one of their pets.</summary>
public sealed record MessageAuthor(Guid Id, string Kind, string Name, string? Via, Guid? TokenId = null);

/// <summary>Someone a stored message names (<c>kind</c> is person, pet or agent). The name is as it was when the message was posted.</summary>
public sealed record MessageRecipient(Guid Id, string Kind, string Name);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(MessageAuthor))]
[JsonSerializable(typeof(IReadOnlyList<MessageRecipient>))]
[JsonSerializable(typeof(PostMessageRequest))]
[JsonSerializable(typeof(MessageDirectoryResponse))]
[JsonSerializable(typeof(PostedMessageResponse))]
[JsonSerializable(typeof(MessagePetStatesResponse))]
[JsonSerializable(typeof(MessagePetState))]
[JsonSerializable(typeof(MessageInboxResponse))]
[JsonSerializable(typeof(MarkMessagesReadRequest))]
[JsonSerializable(typeof(MarkMessagesReadResponse))]
internal sealed partial class MessageJson : JsonSerializerContext;
