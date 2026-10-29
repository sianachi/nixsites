using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Comments;

/// <summary>
/// One comment on a note. A thread is a root comment (<see cref="ThreadId"/> equals <see cref="Id"/>)
/// and its replies; the root row holds the thread's anchor and resolved state.
/// </summary>
public sealed class NoteComment
{
    /// <summary>The most comments one note holds; enforced by a database trigger.</summary>
    public const int MaxPerNote = 2000;

    /// <summary>Gets the tenant, carried for row-level security.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the identity of this comment.</summary>
    public required Guid Id { get; init; }

    /// <summary>Gets the note commented on.</summary>
    public required ItemId ItemId { get; init; }

    /// <summary>Gets the root comment of the thread this belongs to; its own <see cref="Id"/> on a root.</summary>
    public required Guid ThreadId { get; init; }

    /// <summary>Gets who wrote it. For an imported comment, the importer.</summary>
    public required PrincipalId AuthorPrincipalId { get; init; }

    /// <summary>Gets the original author's name when the comment came from an archive, otherwise <see langword="null"/>.</summary>
    public string? ImportedAuthor { get; init; }

    /// <summary>Gets or sets the text, at most 10,000 characters; empty once <see cref="DeletedAt"/> is set.</summary>
    public required string Body { get; set; }

    /// <summary>Gets the principals mentioned, at most 20.</summary>
    [System.Diagnostics.CodeAnalysis.SuppressMessage("Performance", "CA1819:Properties should not return arrays", Justification = "Mapped to a uuid[] column.")]
    public required Guid[] MentionIds { get; init; }

    /// <summary>Gets or sets the base64 Yjs relative position of the start of the commented text (roots only).</summary>
    public string? AnchorStart { get; set; }

    /// <summary>Gets or sets the base64 Yjs relative position of the end of the commented text (roots only).</summary>
    public string? AnchorEnd { get; set; }

    /// <summary>Gets the commented text as it was when the thread started, for re-anchoring and detached threads.</summary>
    public string? Quote { get; init; }

    /// <summary>Gets or sets when the thread was resolved (roots only).</summary>
    public DateTimeOffset? ResolvedAt { get; set; }

    /// <summary>Gets or sets who resolved it.</summary>
    public PrincipalId? ResolvedBy { get; set; }

    /// <summary>Gets when it was written.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets or sets when the body last changed.</summary>
    public DateTimeOffset? EditedAt { get; set; }

    /// <summary>
    /// Gets or sets when the author deleted a root that others had replied to. The row stays as a
    /// tombstone (empty body) so the replies are not lost with it.
    /// </summary>
    public DateTimeOffset? DeletedAt { get; set; }
}
