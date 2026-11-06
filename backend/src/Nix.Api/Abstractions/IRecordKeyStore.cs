using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>The holder of a record key and whether it is in Trash.</summary>
/// <param name="ItemId">The item that holds the key.</param>
/// <param name="Trashed">Whether the item is in Trash. A trashed item keeps its key.</param>
public sealed record RecordKeyHolder(ItemId ItemId, bool Trashed);

/// <summary>A lookup match: the item and whether it is in Trash (itself or through an ancestor).</summary>
/// <param name="ItemId">The matching item.</param>
/// <param name="Trashed">Whether it is in Trash.</param>
public sealed record RecordMatch(ItemId ItemId, bool Trashed);

/// <summary>
/// The <c>record_key</c> table: which item holds a unique field's value inside a collection, and
/// the exact-value lookups that read it. Runs on the request's connection and transaction.
/// </summary>
public interface IRecordKeyStore
{
    /// <summary>
    /// Takes the per-key advisory transaction lock for each identity, in sorted order so two callers
    /// locking overlapping sets cannot deadlock. Locks are held until the transaction ends.
    /// </summary>
    /// <param name="scope">The collection.</param>
    /// <param name="keys">The (field, canonical value) pairs.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    public ValueTask LockAsync(ItemId scope, IEnumerable<(string Field, string Value)> keys, CancellationToken cancellationToken);

    /// <summary>Who holds the value, or null. Call under <see cref="LockAsync"/>.</summary>
    /// <param name="scope">The collection.</param>
    /// <param name="field">The unique field.</param>
    /// <param name="value">The canonical value.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    public ValueTask<RecordKeyHolder?> FindHolderAsync(ItemId scope, string field, string value, CancellationToken cancellationToken);

    /// <summary>
    /// Makes the item hold exactly this value for the field (dropping any value it held), or releases
    /// the field when <paramref name="value"/> is null. The unique index is the final guard: a
    /// collision writes nothing and returns false instead of aborting the transaction.
    /// </summary>
    /// <param name="scope">The collection.</param>
    /// <param name="itemId">The item.</param>
    /// <param name="field">The unique field.</param>
    /// <param name="value">The canonical value, or null to release.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>False when another item already holds the value.</returns>
    public ValueTask<bool> SetAsync(ItemId scope, ItemId itemId, string field, string? value, CancellationToken cancellationToken);

    /// <summary>Releases every key the item holds, in any collection.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    public ValueTask ReleaseItemAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>Releases every key the item holds and every key held inside it, for a permanent delete.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    public ValueTask ReleaseForPurgeAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>Drops every key of one field in a collection (the field stopped being unique).</summary>
    /// <param name="scope">The collection.</param>
    /// <param name="field">The field.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    public ValueTask DropFieldAsync(ItemId scope, string field, CancellationToken cancellationToken);

    /// <summary>The string values of one property on the collection's direct children, not purged.</summary>
    /// <param name="scope">The collection.</param>
    /// <param name="field">The property key.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    public ValueTask<IReadOnlyList<(ItemId ItemId, string Value)>> ChildValuesAsync(ItemId scope, string field, CancellationToken cancellationToken);

    /// <summary>Writes many keys of one field at once (the backfill). The caller has checked for duplicates.</summary>
    /// <param name="scope">The collection.</param>
    /// <param name="field">The field.</param>
    /// <param name="keys">Each item and its canonical value.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    public ValueTask BackfillAsync(ItemId scope, string field, IReadOnlyList<(ItemId ItemId, string Value)> keys, CancellationToken cancellationToken);

    /// <summary>
    /// The items whose property equals one of the values exactly, in a workspace and optionally the
    /// direct children of one item, at most <paramref name="limit"/>.
    /// </summary>
    /// <param name="workspaceId">The workspace.</param>
    /// <param name="parentId">Limits to direct children, or null.</param>
    /// <param name="key">The property key.</param>
    /// <param name="values">The accepted exact values.</param>
    /// <param name="limit">The cap.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    public ValueTask<IReadOnlyList<RecordMatch>> FindByPropertyAsync(
        WorkspaceId workspaceId, ItemId? parentId, string key, IReadOnlyList<string> values, int limit, CancellationToken cancellationToken);

    /// <summary>The item holding the key in the collection, filtered like the query path (no closed locks).</summary>
    /// <param name="scope">The collection.</param>
    /// <param name="field">The unique field.</param>
    /// <param name="value">The canonical value.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    public ValueTask<IReadOnlyList<RecordMatch>> FindByKeyAsync(ItemId scope, string field, string value, CancellationToken cancellationToken);
}
