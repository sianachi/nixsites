using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Comments;
using Nix.Domain.Identity;
using Nix.Domain.Items;

namespace Nix.Persistence.Comments;

/// <inheritdoc />
public sealed class NoteCommentStore(NixDbContext db, INixSessionContextAccessor session) : INoteComments
{
    /// <inheritdoc />
    public async Task<IReadOnlyList<NoteComment>> ListAsync(ItemId itemId, CancellationToken cancellationToken) =>
        await db.Set<NoteComment>().AsNoTracking()
            .Where(comment => comment.ItemId == itemId)
            .OrderBy(comment => comment.CreatedAt).ThenBy(comment => comment.Id)
            .ToListAsync(cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async Task<NoteComment?> FindAsync(ItemId itemId, Guid commentId, CancellationToken cancellationToken) =>
        await db.Set<NoteComment>().AsTracking()
            .SingleOrDefaultAsync(comment => comment.ItemId == itemId && comment.Id == commentId, cancellationToken)
            .ConfigureAwait(false);

    /// <inheritdoc />
    public async Task AddAsync(NoteComment comment, CancellationToken cancellationToken)
    {
        db.Set<NoteComment>().Add(comment);
        await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task SaveAsync(CancellationToken cancellationToken) =>
        await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async Task DeleteAsync(ItemId itemId, Guid commentId, CancellationToken cancellationToken) =>
        await db.Set<NoteComment>().Where(comment => comment.ItemId == itemId && comment.Id == commentId)
            .ExecuteDeleteAsync(cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async Task<long> RevisionAsync(ItemId itemId, CancellationToken cancellationToken) =>
        await db.Set<NoteCommentRevision>().AsNoTracking()
            .Where(row => row.ItemId == itemId)
            .Select(row => row.Revision)
            .SingleOrDefaultAsync(cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async Task<IReadOnlyDictionary<Guid, string>> NamesAsync(IReadOnlyCollection<Guid> principalIds, CancellationToken cancellationToken)
    {
        var ids = principalIds.Select(PrincipalId.From).ToList();
        var tenant = (session.Current ?? throw new InvalidOperationException("A session is required.")).TenantId;
        var rows = await db.Set<Principal>().AsNoTracking()
            .Where(principal => principal.TenantId == tenant && ids.Contains(principal.Id))
            .Select(principal => new { principal.Id, principal.DisplayName })
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        return rows.ToDictionary(row => row.Id.Value, row => row.DisplayName);
    }
}
