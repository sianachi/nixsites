using Nix.Domain.Comments;
using Nix.Domain.Items;

namespace Nix.Abstractions;

/// <summary>
/// Comment rows for notes, scoped to the session's tenant by row-level security. Who may read or
/// write them is the caller's decision: this port stores, it does not authorize.
/// </summary>
public interface INoteComments
{
    /// <summary>Up to <see cref="NoteComment.MaxPerNote"/> comments on a note, oldest first (the most a note can hold).</summary>
    public Task<IReadOnlyList<NoteComment>> ListAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>One comment on a note, tracked for <see cref="SaveAsync"/>, or <see langword="null"/>.</summary>
    public Task<NoteComment?> FindAsync(ItemId itemId, Guid commentId, CancellationToken cancellationToken);

    /// <summary>How many comments the note holds.</summary>
    public Task<int> CountAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>Writes a new comment.</summary>
    public Task AddAsync(NoteComment comment, CancellationToken cancellationToken);

    /// <summary>Writes the changes made to comments returned by <see cref="FindAsync"/>.</summary>
    public Task SaveAsync(CancellationToken cancellationToken);

    /// <summary>Deletes a comment; deleting a thread's root deletes the thread.</summary>
    public Task DeleteAsync(ItemId itemId, Guid commentId, CancellationToken cancellationToken);

    /// <summary>The note's comment revision, 0 until its first comment.</summary>
    public Task<long> RevisionAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>Display names for principals, omitting any that no longer exist.</summary>
    public Task<IReadOnlyDictionary<Guid, string>> NamesAsync(IReadOnlyCollection<Guid> principalIds, CancellationToken cancellationToken);
}
