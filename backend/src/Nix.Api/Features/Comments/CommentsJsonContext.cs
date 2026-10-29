using System.Text.Json.Serialization;
using Nix.Features.Comments;

namespace Nix.Serialization;

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(AddCommentRequest))]
[JsonSerializable(typeof(ReplyCommentRequest))]
[JsonSerializable(typeof(EditCommentRequest))]
[JsonSerializable(typeof(CommentAnchorPositions))]
[JsonSerializable(typeof(CommentResolvedRequest))]
[JsonSerializable(typeof(CommentThreadDto))]
[JsonSerializable(typeof(CommentsResponse))]
internal sealed partial class CommentsJsonContext : JsonSerializerContext;
