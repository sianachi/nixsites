using System.Collections.Immutable;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Features.Properties;

namespace Nix.Features.Records;

/// <summary>One unique field's value an item is about to hold, or null when the write releases it.</summary>
/// <param name="Definition">The unique field's declaration.</param>
/// <param name="Value">The canonical value, or null to release.</param>
public sealed record RecordClaim(PropertyDefinition Definition, string? Value);

/// <summary>
/// Claims, checks and releases the unique-field keys of a collection's records. The one place
/// <c>CreateItem</c>, <c>SetItemProperties</c>, <c>MoveItem</c>, <c>SetItemSchema</c> and upsert
/// share, so no write path can disagree about what counts as the same record.
/// </summary>
/// <remarks>
/// Scope is the declaring collection's own direct children. A claim takes a per-key advisory
/// transaction lock, looks for another holder under it, and only then writes; the unique index is
/// the backstop, written with ON CONFLICT so a collision is a refusal rather than an aborted
/// transaction. `shortcut: nested folders are separate scopes, widen if records need to live in subfolders.`
/// </remarks>
public sealed class RecordKeys(IRecordKeyStore store, IItemLocks locks, IFinanceLock topology)
{
    /// <summary>The key fields the collection itself declares unique.</summary>
    /// <param name="collection">The collection, or null for a workspace root.</param>
    /// <returns>The unique declarations, usually none.</returns>
    public static ImmutableArray<PropertyDefinition> UniqueFields(Item? collection) =>
        collection?.Schema is { } json && json.Contains("\"unique\"", StringComparison.Ordinal)
            ? [.. PropertySchemaJson.Read(json).Properties.Where(IsKeyField)]
            : [];

    /// <summary>Holds off a schema change turning a field unique until this property write commits.</summary>
    /// <param name="collection">The parent whose schema the write is about to read.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>A task that completes once the lock is held.</returns>
    public ValueTask EnterScopeAsync(ItemId collection, CancellationToken cancellationToken) =>
        store.LockScopeAsync(collection, exclusive: false, cancellationToken);

    /// <summary>Whether a stored schema declares any unique field (for paths that must refuse rather than claim).</summary>
    /// <param name="schemaJson">The stored schema.</param>
    /// <returns>True when at least one key field is unique.</returns>
    public static bool DeclaresUnique(string? schemaJson) =>
        schemaJson is not null && PropertySchemaJson.Read(schemaJson).Properties.Any(IsKeyField);

    /// <summary>
    /// Rewrites the unique fields named in a write to their canonical form and says which keys the
    /// write claims or releases. Fields the write does not name are not touched.
    /// </summary>
    /// <param name="collection">The parent the item sits in.</param>
    /// <param name="changes">The property values being written.</param>
    /// <returns>The canonical copy of the values and the claims, or the refusal.</returns>
    public static Result<(JsonObject Canonical, ImmutableArray<RecordClaim> Claims)> Prepare(Item? collection, JsonObject changes)
    {
        ArgumentNullException.ThrowIfNull(changes);
        var fields = UniqueFields(collection);
        if (fields.IsEmpty)
        {
            return Result.Success((changes, ImmutableArray<RecordClaim>.Empty));
        }

        var canonical = (JsonObject)changes.DeepClone();
        var claims = ImmutableArray.CreateBuilder<RecordClaim>();
        foreach (var field in fields)
        {
            if (!canonical.TryGetPropertyValue(field.Key, out var node))
            {
                continue;
            }

            if (node is null)
            {
                claims.Add(new RecordClaim(field, null));
                continue;
            }

            if (node is not JsonValue value || !value.TryGetValue(out string? text))
            {
                continue; // The schema validator reports a value of the wrong shape.
            }

            var key = RecordKeyCanonical.Canonicalize(field.Type, text, out var refusal);
            if (key is null)
            {
                return Result.Failure<(JsonObject, ImmutableArray<RecordClaim>)>(RecordErrors.KeyInvalid(field.Key, refusal!));
            }

            canonical[field.Key] = key;
            claims.Add(new RecordClaim(field, key.Length == 0 ? null : key));
        }

        return Result.Success((canonical, claims.ToImmutable()));
    }

    /// <summary>
    /// Locks the claimed keys (sorted) and refuses when another item already holds one. Call before
    /// writing the item; follow with <see cref="ApplyAsync"/> once it exists.
    /// </summary>
    /// <param name="collection">The parent.</param>
    /// <param name="itemId">The item claiming, or null for one not yet created.</param>
    /// <param name="claims">What <see cref="Prepare"/> returned.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The conflict, or null when the keys are free.</returns>
    public async ValueTask<NixError?> CheckAsync(Item? collection, ItemId? itemId, ImmutableArray<RecordClaim> claims, CancellationToken cancellationToken)
    {
        if (collection is null || claims.IsDefaultOrEmpty)
        {
            return null;
        }

        var held = claims.Where(claim => claim.Value is not null).ToArray();
        await store.LockAsync(collection.Id, held.Select(claim => (claim.Definition.Key, claim.Value!)), cancellationToken).ConfigureAwait(false);
        foreach (var claim in held)
        {
            var holder = await store.FindHolderAsync(collection.Id, claim.Definition.Key, claim.Value!, cancellationToken).ConfigureAwait(false);
            if (holder is not null && holder.ItemId != itemId)
            {
                return await ConflictAsync(claim.Definition.Key, holder, cancellationToken).ConfigureAwait(false);
            }
        }

        return null;
    }

    /// <summary>Writes the claims once the item exists.</summary>
    /// <param name="collection">The parent.</param>
    /// <param name="itemId">The item.</param>
    /// <param name="claims">What <see cref="Prepare"/> returned.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The conflict if the unique index refused (it should not, under the lock), or null.</returns>
    public async ValueTask<NixError?> ApplyAsync(Item? collection, ItemId itemId, ImmutableArray<RecordClaim> claims, CancellationToken cancellationToken)
    {
        if (collection is null || claims.IsDefaultOrEmpty)
        {
            return null;
        }

        foreach (var claim in claims)
        {
            if (!await store.SetAsync(collection.Id, itemId, claim.Definition.Key, claim.Value, cancellationToken).ConfigureAwait(false))
            {
                return RecordErrors.KeyConflict(claim.Definition.Key, null);
            }
        }

        return null;
    }

    /// <summary>
    /// Moves an item's keys with it: releases the old collection's, claims the new one's. Call
    /// before the item is reparented.
    /// </summary>
    /// <param name="item">The item being moved.</param>
    /// <param name="newParent">The destination parent, or null for a workspace root.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The conflict, or null.</returns>
    public async ValueTask<NixError?> MoveAsync(Item item, Item? newParent, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(item);
        if (newParent?.Id == item.ParentId)
        {
            return null;
        }

        var fields = UniqueFields(newParent);
        var bag = item.Properties is null ? new JsonObject() : JsonNode.Parse(item.Properties) as JsonObject ?? new JsonObject();
        var prepared = Prepare(newParent, bag);
        if (prepared.IsFailure)
        {
            return prepared.Error;
        }

        // Only fields the item actually has a value for are claimed in the destination.
        var claims = prepared.Value.Claims.Where(claim => claim.Value is not null).ToImmutableArray();
        var conflict = await CheckAsync(newParent, item.Id, claims, cancellationToken).ConfigureAwait(false);
        if (conflict is not null)
        {
            return conflict;
        }

        await store.ReleaseItemAsync(item.Id, cancellationToken).ConfigureAwait(false);
        return fields.IsEmpty ? null : await ApplyAsync(newParent, item.Id, claims, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Releases everything a permanently deleted item held or contained.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>A task that completes when the keys are gone.</returns>
    public ValueTask ReleaseForPurgeAsync(ItemId itemId, CancellationToken cancellationToken) =>
        store.ReleaseForPurgeAsync(itemId, cancellationToken);

    /// <summary>
    /// Brings the keys in line with a collection's new schema: drops the keys of fields that stopped
    /// being unique and backfills fields that became unique, refusing with the duplicates listed.
    /// </summary>
    /// <param name="collection">The collection, with its schema as stored before the change.</param>
    /// <param name="next">The schema being declared, or null for none.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The refusal, or null.</returns>
    public async ValueTask<NixError?> ApplySchemaAsync(Item collection, PropertySchema? next, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(collection);
        var before = UniqueFields(collection).ToDictionary(field => field.Key, StringComparer.Ordinal);
        var after = (next?.Properties ?? []).Where(IsKeyField).ToDictionary(field => field.Key, StringComparer.Ordinal);

        // Creates and moves hold the topology lock and property writes hold the scope lock shared,
        // so nothing can write a value the backfill below would miss.
        if (after.Keys.Any(key => !before.ContainsKey(key)))
        {
            await topology.AcquireWorkspaceTopologyAsync(collection.WorkspaceId, cancellationToken).ConfigureAwait(false);
            await store.LockScopeAsync(collection.Id, exclusive: true, cancellationToken).ConfigureAwait(false);
        }

        foreach (var field in before.Keys.Where(key => !after.ContainsKey(key)))
        {
            await store.DropFieldAsync(collection.Id, field, cancellationToken).ConfigureAwait(false);
        }

        foreach (var field in after.Values.Where(field => !before.ContainsKey(field.Key)))
        {
            var rows = await store.ChildValuesAsync(collection.Id, field.Key, cancellationToken).ConfigureAwait(false);
            var byValue = new Dictionary<string, List<ItemId>>(StringComparer.Ordinal);
            var bad = new List<PropertyViolation>();
            foreach (var (itemId, raw) in rows)
            {
                var key = RecordKeyCanonical.Canonicalize(field.Type, raw, out var refusal);
                if (key is null)
                {
                    bad.Add(new PropertyViolation(field.Key, $"Item {itemId.Value} has a value that cannot be a key: {refusal}"));
                }
                else if (key.Length > 0)
                {
                    if (!byValue.TryGetValue(key, out var ids))
                    {
                        byValue[key] = ids = [];
                    }

                    ids.Add(itemId);
                }
            }

            // Listed, capped: enough to fix by hand, not an unbounded response.
            var duplicates = byValue.Where(pair => pair.Value.Count > 1).Take(20)
                .Select(pair => new PropertyViolation(field.Key, $"'{pair.Key}' is held by items {string.Join(", ", pair.Value.Select(id => id.Value))}"));
            var problems = bad.Take(20).Concat(duplicates).ToArray();
            if (problems.Length > 0)
            {
                return new NixError(
                    RecordErrors.DuplicateValuesCode,
                    $"'{field.Key}' cannot be unique yet: {string.Join("; ", problems.Select(problem => problem.Reason))}")
                { Violations = problems };
            }

            await store.BackfillAsync(
                collection.Id,
                field.Key,
                [.. byValue.Select(pair => (pair.Value[0], pair.Key))],
                cancellationToken).ConfigureAwait(false);
        }

        return null;
    }

    private async ValueTask<NixError> ConflictAsync(string field, RecordKeyHolder holder, CancellationToken cancellationToken)
    {
        // The holder's id is only offered when the caller could open the item anyway: a locked
        // record's existence is not something a conflict should reveal.
        var visible = await locks.MayReadBodyAsync(holder.ItemId, cancellationToken).ConfigureAwait(false);
        return RecordErrors.KeyConflict(field, visible ? holder.ItemId.Value : null);
    }

    private static bool IsKeyField(PropertyDefinition definition) =>
        definition.Unique && definition.Type is PropertyType.Text or PropertyType.Url;
}
