using System.Text.Json.Serialization;

namespace Nix.Features.Messages;

/// <summary>Who wrote a message: a person (with the token they used, if any) or one of their pets.</summary>
public sealed record MessageAuthor(Guid Id, string Kind, string Name, string? Via);

/// <summary>Someone a stored message names. The name is as it was when the message was posted.</summary>
public sealed record MessageRecipient(Guid Id, string Kind, string Name);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(MessageAuthor))]
[JsonSerializable(typeof(IReadOnlyList<MessageRecipient>))]
[JsonSerializable(typeof(PostMessageRequest))]
[JsonSerializable(typeof(MessageDirectoryResponse))]
internal sealed partial class MessageJson : JsonSerializerContext;
