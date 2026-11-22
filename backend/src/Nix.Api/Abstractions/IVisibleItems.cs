using Nix.Domain.Items;
using Nix.Domain.Primitives;

namespace Nix.Abstractions;

/// <summary>The permission a caller needs on an item's workspace.</summary>
public enum ItemAccess
{
    /// <summary>See the item.</summary>
    Read,

    /// <summary>Comment on the item.</summary>
    Comment,

    /// <summary>Change the item.</summary>
    Write,

    /// <summary>Manage the item's workspace.</summary>
    Manage,
}

/// <summary>
/// The one place that decides whether the caller may see an item at an access level.
/// </summary>
/// <remarks>
/// An item that does not exist, is deleted, belongs to a template, or sits in a workspace the caller
/// lacks the access for is the same answer, <c>items.not_found</c>: telling them apart would confirm
/// that the item exists.
/// </remarks>
public interface IVisibleItems
{
    /// <summary>Finds an item the caller may reach at <paramref name="access"/>.</summary>
    /// <param name="id">The item.</param>
    /// <param name="access">The permission the caller needs.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <param name="notFoundDetail">The refusal text for an item that is not visible; the default names the item.</param>
    /// <param name="lockedDetail">
    /// When set, the item's body must be open to the caller (no lock they have not unlocked covers it),
    /// and this is the <c>items.locked</c> refusal text. When <see langword="null"/> no lock is checked.
    /// </param>
    /// <returns>The item, <c>items.not_found</c>, or <c>items.locked</c> (said only to a caller who may see the item).</returns>
    public ValueTask<Result<Item>> FindAsync(
        ItemId id,
        ItemAccess access,
        CancellationToken cancellationToken,
        string? notFoundDetail = null,
        string? lockedDetail = null);
}
