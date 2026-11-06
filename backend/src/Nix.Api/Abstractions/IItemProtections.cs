using Nix.Domain.Items;

namespace Nix.Abstractions;

/// <summary>An item that stops a deletion: <c>no_delete</c>, or <c>pinned</c> by an active record.</summary>
/// <param name="Id">The blocking item.</param>
/// <param name="Title">Its stored title; the caller withholds it where a lock covers the item.</param>
/// <param name="Reason"><c>no_delete</c> or <c>pinned</c>.</param>
public sealed record DeleteBlocker(ItemId Id, string Title, string Reason);

/// <summary>
/// Reads and writes the protections an item carries: against deletion and against new children.
/// </summary>
/// <remarks>
/// The flags themselves ride on <see cref="Item"/>, so a handler holding the row already knows the
/// item's own answer. This port exists for the two things the row cannot say: whether anything
/// beneath it is protected, and the write. The only implementation is the Postgres store; the swap
/// plan for tests is a handler constructed without it, which skips the subtree question.
/// </remarks>
public interface IItemProtections
{
    /// <summary>Whether any active item strictly beneath <paramref name="itemId"/> is protected from deletion.</summary>
    /// <param name="itemId">The root of the subtree.</param>
    /// <param name="userOnly">
    /// Whether to count only protections a person set, passing over the ones a system feature
    /// holds on the items it manages.
    /// </param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns><see langword="true"/> when trashing the root would hide a protected item.</returns>
    public ValueTask<bool> AnyDeleteProtectedBelowAsync(ItemId itemId, bool userOnly, CancellationToken cancellationToken);

    /// <summary>
    /// The first five active items at or below <paramref name="itemId"/> that stop it being trashed:
    /// protected from deletion, or holding a file version an active item pins.
    /// </summary>
    /// <param name="itemId">The root of the subtree.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The blockers, shallowest first; empty when nothing blocks.</returns>
    public ValueTask<IReadOnlyList<DeleteBlocker>> FindDeleteBlockersAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>
    /// Whether a file at or below <paramref name="itemId"/> is pinned by a reference whose holder is
    /// in use (neither it nor any ancestor is in the trash).
    /// </summary>
    /// <param name="itemId">The root of the subtree.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns><see langword="true"/> when trashing the root would hide a pinned file.</returns>
    public ValueTask<bool> AnyPinnedAtOrBelowAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>Whether any reference, whatever its holder's state, pins a version of this file. Stops a permanent delete.</summary>
    /// <param name="itemId">The file item.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns><see langword="true"/> when a pin still names it.</returns>
    public ValueTask<bool> IsPinTargetAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>Whether <paramref name="itemId"/> or anything below it holds or is the target of a reference.</summary>
    /// <param name="itemId">The root of the subtree.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns><see langword="true"/> when a reference touches the subtree, in either direction and whatever its state.</returns>
    public ValueTask<bool> AnyReferencedAtOrBelowAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>Deletes every reference the item holds. Purge is a lifecycle flag, so no foreign key does this.</summary>
    /// <param name="itemId">The holder.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>A task that completes when the rows are gone.</returns>
    public ValueTask ReleaseHeldReferencesAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>Writes the protections named, leaving a null one as it stands.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="noDelete">Whether it is protected from deletion, or null to leave it.</param>
    /// <param name="noChildren">Whether it refuses new children, or null to leave it.</param>
    /// <param name="collaboration">Whether several people may edit it at once, or null to leave it.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>
    /// <see langword="false"/> when nothing was written because the deletion protection was named
    /// and the item is managed by a system feature - decided by the statement itself, so a sync
    /// that takes the item over between the caller's read and this write cannot be undone by it.
    /// </returns>
    public ValueTask<bool> SetAsync(ItemId itemId, bool? noDelete, bool? noChildren, bool? collaboration, CancellationToken cancellationToken);
}
