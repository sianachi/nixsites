using Nix.Domain.Items;

namespace Nix.Abstractions;

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
