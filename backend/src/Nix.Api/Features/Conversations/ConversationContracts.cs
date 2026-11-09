using System.Text.Json.Serialization;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Conversations;

public sealed record ConversationImportMessage(string Role, string Text);
public sealed record CreateConversationRequest(string Title, Guid? ParentId, IReadOnlyList<Guid> SourceWorkspaceIds,
    Guid PetId, Guid? GroupId = null, IReadOnlyList<ConversationImportMessage>? Messages = null);
public sealed record ConfigureConversationRequest(IReadOnlyList<Guid> SourceWorkspaceIds, Guid PetId);
public sealed record ConfigureConversation(Guid ItemId, ConfigureConversationRequest Request) : ICommand<ConversationResponse>;
public sealed record SendConversationRequest(Guid RequestId, string Text, string? Model = null, Guid? PetId = null);
public sealed record ConversationSourcesRequest(IReadOnlyList<Guid> SourceWorkspaceIds, long ExpectedRevision);
public sealed record ConversationTurnResponse(Guid Id, Guid RequestId, string Status, string? Error, string Text = "");
public sealed record ConversationResponse(Guid ItemId, Guid WorkspaceId, string Title, IReadOnlyList<Guid> SourceWorkspaceIds,
    Guid PetId, long Revision, bool CanSend, ConversationTurnResponse? Turn, bool CanEdit = false);
public sealed record ConversationMessageResponse(Guid Id, string Role, string Text, DateTimeOffset CreatedAt, Guid? AuthorId, string Seq = "", Guid? RequestId = null,
    IReadOnlyList<Guid>? SourceWorkspaceIds = null);
public sealed record ConversationMessagesResponse(IReadOnlyList<ConversationMessageResponse> Items, string? NextCursor);
internal sealed record ConversationTurn(Guid Id, Guid RequestId, string Status, Guid ActorId, DateTimeOffset ExpiresAt,
    string? Error = null, string Text = "", Guid? PetId = null);
internal sealed record ConversationConfiguration(IReadOnlyList<Guid> SourceWorkspaceIds, Guid PetId, long Revision,
    ConversationTurn? Turn = null, IReadOnlyList<Guid>? CompletedRequestIds = null);
public sealed record CreateConversation(Guid WorkspaceId, CreateConversationRequest Request) : ICommand<ConversationResponse>;
public sealed record GetConversation(Guid ItemId) : IQuery<Result<ConversationResponse>>;
public sealed record GetConversationMessages(Guid ItemId, string? Cursor, int Limit) : IQuery<Result<ConversationMessagesResponse>>;
public sealed record SendConversation(Guid ItemId, SendConversationRequest Request) : ICommand<ConversationResponse>;
public sealed record CancelConversation(Guid ItemId) : ICommand<ConversationResponse>;
public sealed record ChangeConversationSources(Guid ItemId, ConversationSourcesRequest Request) : ICommand<ConversationResponse>;
public sealed record ConversationToolRequest(Guid TenantId, Guid PrincipalId, Guid RequestId, Dictionary<string, System.Text.Json.JsonElement> Arguments);
public sealed record ConversationToolResponse(bool Success, string Result, bool LockedContent = false);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(CreateConversationRequest))]
[JsonSerializable(typeof(SendConversationRequest))]
[JsonSerializable(typeof(ConfigureConversationRequest))]
[JsonSerializable(typeof(ConversationSourcesRequest))]
[JsonSerializable(typeof(ConversationResponse))]
[JsonSerializable(typeof(ConversationMessagesResponse))]
[JsonSerializable(typeof(ConversationConfiguration))]
[JsonSerializable(typeof(ConversationToolRequest))]
[JsonSerializable(typeof(ConversationToolResponse))]
internal sealed partial class ConversationJsonContext : JsonSerializerContext;
