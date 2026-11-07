using Nix.Domain.Files;
using Nix.Domain.Items;
using Nix.Domain.References;

namespace Nix.Abstractions;

/// <summary>Reads and writes <c>item_reference</c> rows for the current tenant.</summary>
public interface IItemReferenceStore
{
    /// <summary>The state of a version that belongs to the item, or null when there is no such version.</summary>
    public ValueTask<string?> VersionStateAsync(ItemId itemId, FileVersionId versionId, CancellationToken cancellationToken);

    /// <summary>The current state of each named version (a missing one is absent from the result).</summary>
    public ValueTask<IReadOnlyDictionary<FileVersionId, string>> VersionStatesAsync(IReadOnlyCollection<FileVersionId> versionIds, CancellationToken cancellationToken);

    /// <summary>The reference with exactly this edge, or null.</summary>
    public ValueTask<ItemReference?> FindEdgeAsync(ItemId holder, ItemId target, FileVersionId? version, string? role, CancellationToken cancellationToken);

    /// <summary>Stores a new reference.</summary>
    public ValueTask AddAsync(ItemReference reference, CancellationToken cancellationToken);

    /// <summary>Deletes a reference held by the item; false when it was not there.</summary>
    public ValueTask<bool> RemoveAsync(ItemId holder, Guid referenceId, CancellationToken cancellationToken);

    /// <summary>References held by the item, ordered by id, after the cursor.</summary>
    public ValueTask<IReadOnlyList<ItemReference>> ListHeldAsync(ItemId holder, Guid? after, int take, CancellationToken cancellationToken);

    /// <summary>References pointing at the item, ordered by id, after the cursor.</summary>
    public ValueTask<IReadOnlyList<ItemReference>> ListTargetingAsync(ItemId target, Guid? after, int take, CancellationToken cancellationToken);
}
