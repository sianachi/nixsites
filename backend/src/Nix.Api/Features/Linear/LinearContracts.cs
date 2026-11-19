using System.Text.Json;
using System.Text.Json.Serialization;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Features.Linear;

internal sealed record LinearConnectionResponse(bool Connected);
internal sealed record AuthorizeLinearConnectionRequest(string? ReturnTo);
internal sealed record LinearAuthorizationResponse(string AuthorizationUrl);
internal sealed record LinearIssueResponse(string Id, string Title, string Status, string Url);
internal sealed record RequestLinearIssueRequest(string IssueId);
internal sealed record HandToPetRequest(Guid PetId, string IssueId);
internal sealed record DecideLinearIssueRequest(bool Approve);
internal sealed record LinearRequestResponse(
    Guid Id, Guid ItemId, string IssueId, string Status, string RequestedBy,
    DateTimeOffset CreatedAt, DateTimeOffset ExpiresAt, bool CanDecide, LinearIssueResponse? Result,
    Guid? PetId, Guid? CommentId);
internal sealed record LinearRequestsResponse(IReadOnlyList<LinearRequestResponse> Requests, bool CanHandToPet);
internal sealed record LinkLinearIssueRequest(Guid ConnectionId, string Issue);
internal sealed record CopyLinearStatusRequest(Guid Revision, string? LocalStatus);
internal sealed record LinearLinkConnection(Guid Id, string TeamId);
internal sealed record LinearLinkedIssue(
    Guid Revision, bool Connected, string? Identifier, string? Url, string? RemoteStatus, DateTimeOffset? CheckedAt,
    string? LocalStatus, string? Change, bool CanCopyStatus);
internal sealed record LinearLinkResponse(LinearLinkedIssue? Link, IReadOnlyList<LinearLinkConnection> Connections);
internal sealed record LinearRemoteIssue(Guid Id, string Identifier, Guid TeamId, Guid StatusId, string Status, DateTimeOffset UpdatedAt, string Url);

internal sealed record ReadLinearConnection(WorkspaceId WorkspaceId) : IQuery<Result<LinearConnectionResponse>>;
internal sealed record AuthorizeLinearConnection(WorkspaceId WorkspaceId, Guid BrowserSessionId, Uri Callback, string ReturnTo)
    : ICommand<LinearAuthorizationResponse>;
internal sealed record DisconnectLinearConnection(WorkspaceId WorkspaceId) : ICommand<bool>;
internal sealed record ListLinearRequests(ItemId ItemId, Guid? TokenId) : IQuery<Result<LinearRequestsResponse>>;
internal sealed record GetLinearIssueRequest(ItemId ItemId, Guid RequestId, Guid? TokenId)
    : IQuery<Result<LinearRequestResponse>>;
internal sealed record RequestLinearIssue(ItemId ItemId, string IssueId, Guid? TokenId) : ICommand<LinearRequestResponse>;
internal sealed record HandToPetCommand(ItemId ItemId, Guid PetId, string IssueId) : ICommand<LinearRequestResponse>;
internal sealed record DecideLinearIssueRequestCommand(ItemId ItemId, Guid RequestId, bool Approve, Uri Callback)
    : ICommand<LinearRequestResponse>;
internal sealed record ReadLinearLink(ItemId ItemId) : IQuery<Result<LinearLinkResponse>>;
internal sealed record CreateLinearLink(ItemId ItemId, Guid ConnectionId, string Issue) : ICommand<LinearLinkResponse>;
internal sealed record RefreshLinearLink(ItemId ItemId) : ICommand<LinearLinkResponse>;
internal sealed record ApplyLinearLinkStatus(ItemId ItemId, Guid Revision, string? LocalStatus) : ICommand<LinearLinkResponse>;
internal sealed record DeleteLinearLink(ItemId ItemId, Guid Revision) : ICommand<bool>;

internal sealed record LinearWorkerRequest(
    string Operation, [property: JsonPropertyName("oauthState")] JsonElement OAuthState, string CallbackUrl,
    string? State = null, string? Code = null, string? IssueId = null);
internal sealed record LinearWorkerResponse(
    [property: JsonPropertyName("oauthState")] JsonElement OAuthState, string? AuthorizationUrl, LinearIssueResponse? Issue, string? Failure, bool? Sent);
internal sealed record LinearPendingOAuth(JsonElement OAuthState, string ReturnTo);

[JsonSourceGenerationOptions(JsonSerializerDefaults.Web, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(LinearConnectionResponse))]
[JsonSerializable(typeof(AuthorizeLinearConnectionRequest))]
[JsonSerializable(typeof(LinearAuthorizationResponse))]
[JsonSerializable(typeof(LinearRequestResponse))]
[JsonSerializable(typeof(LinearRequestsResponse))]
[JsonSerializable(typeof(RequestLinearIssueRequest))]
[JsonSerializable(typeof(DecideLinearIssueRequest))]
[JsonSerializable(typeof(HandToPetRequest))]
[JsonSerializable(typeof(LinearIssueResponse))]
[JsonSerializable(typeof(LinearWorkerRequest))]
[JsonSerializable(typeof(LinearWorkerResponse))]
[JsonSerializable(typeof(LinearPendingOAuth))]
[JsonSerializable(typeof(LinkLinearIssueRequest))]
[JsonSerializable(typeof(CopyLinearStatusRequest))]
[JsonSerializable(typeof(LinearLinkResponse))]
[JsonSerializable(typeof(LinearRemoteIssue))]
internal sealed partial class LinearJsonContext : JsonSerializerContext;
