using Nix.Domain.Items;
using Nix.Messaging;

namespace Nix.Features.Comments;

/// <summary>
/// One comment. <c>importedAuthor</c> is set when it came from an archive: <c>authorName</c> is then the importer.
/// <c>deleted</c> marks a tombstone: the author deleted a root that others had replied to, so the body is empty
/// and mentions are cleared; show "Comment deleted".
/// </summary>
public sealed record CommentDto(
    Guid Id, Guid AuthorId, string AuthorName, string? ImportedAuthor, string Body,
    IReadOnlyList<Guid> MentionIds, DateTimeOffset CreatedAt, DateTimeOffset? EditedAt, bool Deleted);

/// <summary>
/// A thread: its root comment first (the thread id is the root's id), then replies oldest first.
/// The anchor is two base64 Yjs relative positions plus the quoted text, all <see langword="null"/>
/// for a page-level thread; a quote with no positions is waiting to be anchored by a client.
/// </summary>
public sealed record CommentThreadDto(
    Guid Id, string? AnchorStart, string? AnchorEnd, string? Quote, DateTimeOffset? ResolvedAt,
    Guid? ResolvedBy, string? ResolvedByName, IReadOnlyList<CommentDto> Comments);

/// <summary>Every thread on a note, oldest first, with the revision they were read at.</summary>
public sealed record CommentsResponse(long Revision, IReadOnlyList<CommentThreadDto> Threads);

/// <summary>Where a new thread is anchored. Give a quote, positions, or both.</summary>
public sealed record CommentAnchorRequest(string? Start, string? End, string? Quote);

/// <summary>Starts a thread. With no <c>anchor</c> it is a page-level comment.</summary>
public sealed record AddCommentRequest(string Body, IReadOnlyList<Guid>? MentionIds, CommentAnchorRequest? Anchor);

/// <summary>Replies in a thread.</summary>
public sealed record ReplyCommentRequest(string Body, IReadOnlyList<Guid>? MentionIds);

/// <summary>Changes a comment's text.</summary>
public sealed record EditCommentRequest(string Body);

/// <summary>Moves a thread's anchor to fresh relative positions.</summary>
public sealed record CommentAnchorPositions(string Start, string End);

/// <summary>Resolves or reopens a thread.</summary>
public sealed record CommentResolvedRequest(bool Resolved);

/// <summary>Reads every thread on a note.</summary>
public sealed record ListComments(ItemId ItemId) : IQuery<Nix.Domain.Primitives.Result<CommentsResponse>>;

/// <summary>Long-polls a note's threads for a change past a known revision.</summary>
public sealed record WatchComments(ItemId ItemId, long After) : IQuery<Nix.Domain.Primitives.Result<CommentsResponse>>;

/// <summary>Starts a thread.</summary>
public sealed record AddComment(ItemId ItemId, AddCommentRequest Request) : ICommand<CommentThreadDto>;

/// <summary>Replies in a thread.</summary>
public sealed record ReplyComment(ItemId ItemId, Guid ThreadId, ReplyCommentRequest Request) : ICommand<CommentThreadDto>;

/// <summary>Edits a comment of the caller's own.</summary>
public sealed record EditComment(ItemId ItemId, Guid CommentId, EditCommentRequest Request) : ICommand<CommentThreadDto>;

/// <summary>Re-anchors a thread.</summary>
public sealed record SetCommentAnchor(ItemId ItemId, Guid ThreadId, CommentAnchorPositions Anchor) : ICommand<CommentThreadDto>;

/// <summary>Resolves or reopens a thread.</summary>
public sealed record SetCommentResolved(ItemId ItemId, Guid ThreadId, bool Resolved) : ICommand<CommentThreadDto>;

/// <summary>Deletes a comment of the caller's own; a root with replies from others becomes a tombstone, otherwise deleting a root deletes its thread.</summary>
public sealed record DeleteComment(ItemId ItemId, Guid CommentId) : ICommand<Guid>;
