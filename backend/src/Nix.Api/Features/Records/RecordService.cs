using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Tenancy;
using Nix.Features.Items;
using Nix.Features.Properties;
using Nix.Messaging;

namespace Nix.Features.Records;

/// <summary>Lookup, upsert and batch over unique record keys, built on the ordinary create and write commands.</summary>
/// <remarks>
/// Every write goes through <see cref="CreateItem"/>, <see cref="SetItemProperties"/> or
/// <see cref="RenameItem"/>, so permissions, locks, protections, automations and the key claim are
/// the same as for a plain request. The workspace topology lock is taken first and the key locks
/// after, the order plain creates already use, so the two cannot deadlock.
/// </remarks>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes", Justification = "Created by the container.")]
internal sealed class RecordService(
    IItemTree tree,
    IPermissionResolver permissions,
    IRecordKeyStore store,
    IFinanceLock topology,
    INativeReplayStore receipts,
    NixDispatcher dispatcher)
{
    /// <summary>The most rows one batch may carry.</summary>
    public const int MaximumBatchRows = 100;

    /// <summary>The most matches a lookup returns.</summary>
    public const int MaximumLookupMatches = 500;

    private const string CreatedOutcome = "created";
    private const string UpdatedOutcome = "updated";
    private const string UnchangedOutcome = "unchanged";

    /// <summary>Finds items by the exact value of one property.</summary>
    /// <param name="workspaceId">The workspace.</param>
    /// <param name="request">The key, value and optional parent.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The matches, readable ones only.</returns>
    public async ValueTask<Result<LookupItemsResponse>> LookupAsync(WorkspaceId workspaceId, LookupItemsRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (!await permissions.CanReadWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<LookupItemsResponse>(ItemErrors.WorkspaceNotFound($"No workspace {workspaceId} is visible."));
        }

        // '$' keys belong to the server; reading them here would expose what the query path hides.
        if (string.IsNullOrEmpty(request.Key) || request.Key.StartsWith('$') || request.Value is null)
        {
            return Result.Failure<LookupItemsResponse>(RecordErrors.KeyInvalid(request.Key ?? string.Empty, "needs a property key that does not start with '$' and a value."));
        }

        Item? parent = null;
        if (request.ParentId is { } parentId)
        {
            parent = await tree.FindAsync(ItemId.From(parentId), cancellationToken).ConfigureAwait(false);
            if (parent is null || parent.WorkspaceId != workspaceId)
            {
                return Result.Failure<LookupItemsResponse>(ItemErrors.ParentNotFound($"No parent {parentId} is visible in this workspace."));
            }
        }

        IReadOnlyList<RecordMatch> matches;
        var unique = RecordKeys.UniqueFields(parent).FirstOrDefault(field => field.Key == request.Key);
        if (unique is not null)
        {
            var key = RecordKeyCanonical.Canonicalize(unique.Type, request.Value, out var refusal);
            if (key is null)
            {
                return Result.Failure<LookupItemsResponse>(RecordErrors.KeyInvalid(request.Key, refusal!));
            }

            matches = await store.FindByKeyAsync(parent!.Id, request.Key, key, cancellationToken).ConfigureAwait(false);
        }
        else
        {
            if (request.Value.Length > RecordKeyCanonical.MaximumCharacters
                || Encoding.UTF8.GetByteCount(request.Value) > RecordKeyCanonical.MaximumBytes)
            {
                return Result.Failure<LookupItemsResponse>(RecordErrors.KeyInvalid(request.Key, "is too long to look up."));
            }

            // Exact equality on the stored value. A non-unique field stores whatever was written, so
            // the value is tried as given, trimmed, and (for an address) in canonical form.
            var trimmed = request.Value.Trim();
            var values = new[] { request.Value, trimmed, RecordKeyCanonical.CanonicalUrl(trimmed) }
                .OfType<string>().Distinct(StringComparer.Ordinal).ToArray();
            matches = await store.FindByPropertyAsync(workspaceId, parent?.Id, request.Key, values, MaximumLookupMatches, cancellationToken).ConfigureAwait(false);
        }

        var found = new List<LookupMatch>(matches.Count);
        var items = new List<Item>(matches.Count);
        foreach (var match in matches)
        {
            if (await tree.FindStoredAsync(match.ItemId, cancellationToken).ConfigureAwait(false) is { } item)
            {
                items.Add(item);
            }
        }

        IReadOnlySet<ItemId> withChildren = items.Count == 0
            ? new HashSet<ItemId>()
            : await tree.WithChildrenAsync(workspaceId, [.. items.Select(item => item.Id)], cancellationToken).ConfigureAwait(false);
        foreach (var item in items)
        {
            found.Add(new LookupMatch(
                ItemMapping.ToResponse(item, withChildren.Contains(item.Id)),
                matches.First(match => match.ItemId == item.Id).Trashed));
        }

        return Result.Success(new LookupItemsResponse(found));
    }

    /// <summary>Creates or updates the child of a collection whose unique field equals a value.</summary>
    /// <param name="parentId">The collection.</param>
    /// <param name="request">The key and values.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The outcome and the persisted item.</returns>
    public async ValueTask<Result<(string Outcome, Item Item)>> UpsertAsync(ItemId parentId, UpsertRecordRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var parent = await tree.FindAsync(parentId, cancellationToken).ConfigureAwait(false);
        if (parent is null || !await permissions.CanWriteWorkspaceAsync(parent.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<(string, Item)>(ItemErrors.NotFound($"No item {parentId} is visible."));
        }

        await topology.AcquireWorkspaceTopologyAsync(parent.WorkspaceId, cancellationToken).ConfigureAwait(false);
        return await WithReceiptAsync(
            parent,
            request.IdempotencyKey,
            new JsonObject
            {
                ["keyField"] = request.KeyField,
                ["keyValue"] = request.KeyValue,
                ["title"] = request.Title,
                ["properties"] = request.Properties?.DeepClone(),
                ["type"] = request.Type,
                ["strict"] = request.Strict,
            },
            () => UpsertCoreAsync(parent, request.KeyField, request.KeyValue, request.Title, request.Properties, request.Type, request.Strict, cancellationToken),
            cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Applies up to 100 rows, each in its own savepoint.</summary>
    /// <param name="workspaceId">The workspace.</param>
    /// <param name="request">The rows.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>Per-row results and counts, or the refusal of the whole request.</returns>
    public async ValueTask<Result<BatchRecordsResponse>> BatchAsync(WorkspaceId workspaceId, BatchRecordsRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (!await permissions.CanWriteWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<BatchRecordsResponse>(ItemErrors.WorkspaceNotFound($"No workspace {workspaceId} is visible."));
        }

        var rows = request.Rows ?? [];
        if (rows.Count is 0 or > MaximumBatchRows)
        {
            return Result.Failure<BatchRecordsResponse>(new NixError(RecordErrors.BatchInvalidCode, $"A batch carries 1 to {MaximumBatchRows} rows."));
        }

        // A create is the one row that could duplicate on retry, so the request is refused before
        // anything is written if any create lacks the key that makes it safe to repeat.
        for (var i = 0; i < rows.Count; i++)
        {
            if (rows[i].ItemId is null && rows[i].KeyField is null && rows[i].KeyValue is null && string.IsNullOrWhiteSpace(rows[i].IdempotencyKey))
            {
                return Result.Failure<BatchRecordsResponse>(new NixError(RecordErrors.BatchInvalidCode, $"Row {i} creates a record and needs an idempotencyKey so a retry cannot duplicate it."));
            }
        }

        await topology.AcquireWorkspaceTopologyAsync(workspaceId, cancellationToken).ConfigureAwait(false);

        // Every key the batch will claim, locked up front in sorted order, so two overlapping
        // batches wait on each other instead of deadlocking.
        var parents = new Dictionary<Guid, Item?>();
        foreach (var parentId in rows.Select(row => row.ParentId).Distinct().Order())
        {
            parents[parentId] = await tree.FindAsync(ItemId.From(parentId), cancellationToken).ConfigureAwait(false);
        }

        foreach (var (parentId, parent) in parents.OrderBy(pair => pair.Key))
        {
            if (parent is null || parent.WorkspaceId != workspaceId)
            {
                continue;
            }

            var keys = new List<(string, string)>();
            foreach (var row in rows.Where(row => row.ParentId == parentId))
            {
                var field = RecordKeys.UniqueFields(parent).FirstOrDefault(candidate => candidate.Key == (row.KeyField ?? string.Empty));
                if (field is not null
                    && row.KeyValue is not null
                    && RecordKeyCanonical.Canonicalize(field.Type, row.KeyValue, out _) is { Length: > 0 } key)
                {
                    keys.Add((field.Key, key));
                }
            }

            await store.LockAsync(parent.Id, keys, cancellationToken).ConfigureAwait(false);
        }

        var results = new List<BatchRecordResult>(rows.Count);
        for (var index = 0; index < rows.Count; index++)
        {
            var row = rows[index];
            await receipts.BeginMutationAsync(cancellationToken).ConfigureAwait(false);
            var outcome = await ApplyRowAsync(workspaceId, parents.GetValueOrDefault(row.ParentId), row, request.Strict, cancellationToken).ConfigureAwait(false);
            await receipts.EndMutationAsync(outcome.IsSuccess, cancellationToken).ConfigureAwait(false);

            if (outcome.IsFailure)
            {
                var error = outcome.Error;
                results.Add(new BatchRecordResult(
                    index,
                    "error",
                    null,
                    new BatchRecordError(error.Code, error.Message, error.Violations?.ToArray(), error.ExistingItemId)));
                continue;
            }

            results.Add(new BatchRecordResult(
                index,
                outcome.Value.Outcome,
                await ItemMapping.RespondAsync(outcome.Value.Item, dispatcher, cancellationToken).ConfigureAwait(false),
                null));
        }

        return Result.Success(new BatchRecordsResponse(
            results,
            results.Count(row => row.Status == CreatedOutcome),
            results.Count(row => row.Status == UpdatedOutcome),
            results.Count(row => row.Status == UnchangedOutcome),
            results.Count(row => row.Status == "error")));
    }

    private async ValueTask<Result<(string Outcome, Item Item)>> ApplyRowAsync(
        WorkspaceId workspaceId, Item? parent, BatchRecordRow row, bool strict, CancellationToken cancellationToken)
    {
        if (parent is null || parent.WorkspaceId != workspaceId)
        {
            return Result.Failure<(string, Item)>(ItemErrors.ParentNotFound($"No parent {row.ParentId} is visible in this workspace."));
        }

        if ((row.KeyField is null) != (row.KeyValue is null))
        {
            return Result.Failure<(string, Item)>(new NixError(RecordErrors.BatchInvalidCode, "A row names both keyField and keyValue, or neither."));
        }

        if (row.ItemId is { } itemId)
        {
            return await UpdateAsync(parent, ItemId.From(itemId), row.Title, row.Properties, strict, cancellationToken).ConfigureAwait(false);
        }

        // An upsert is naturally repeatable; a create is made repeatable by its idempotency key.
        return await WithReceiptAsync(
            parent,
            row.IdempotencyKey,
            new JsonObject
            {
                ["keyField"] = row.KeyField,
                ["keyValue"] = row.KeyValue,
                ["title"] = row.Title,
                ["properties"] = row.Properties?.DeepClone(),
                ["type"] = row.Type,
                ["strict"] = strict,
            },
            () => row.KeyField is { } keyField
                ? UpsertCoreAsync(parent, keyField, row.KeyValue!, row.Title, row.Properties, row.Type, strict, cancellationToken)
                : CreateAsync(parent, row.Title ?? string.Empty, row.Properties, row.Type, strict, cancellationToken),
            cancellationToken).ConfigureAwait(false);
    }

    private async ValueTask<Result<(string Outcome, Item Item)>> UpsertCoreAsync(
        Item parent, string keyField, string keyValue, string? title, JsonObject? properties, string? type, bool strict, CancellationToken cancellationToken)
    {
        var definition = RecordKeys.UniqueFields(parent).FirstOrDefault(field => field.Key == keyField);
        if (definition is null)
        {
            return Result.Failure<(string, Item)>(new NixError(
                RecordErrors.NotUniqueCode,
                $"'{keyField}' is not declared unique on this collection. Mark a text or url field unique in its schema first."));
        }

        var key = RecordKeyCanonical.Canonicalize(definition.Type, keyValue, out var refusal);
        if (key is null || key.Length == 0)
        {
            return Result.Failure<(string, Item)>(RecordErrors.KeyInvalid(keyField, refusal ?? "needs a value."));
        }

        var values = (JsonObject?)properties?.DeepClone() ?? new JsonObject();
        if (values.TryGetPropertyValue(keyField, out var given)
            && given is JsonValue givenValue && givenValue.TryGetValue(out string? givenText)
            && RecordKeyCanonical.Canonicalize(definition.Type, givenText, out _) != key)
        {
            return Result.Failure<(string, Item)>(RecordErrors.KeyInvalid(keyField, "differs between keyValue and properties."));
        }

        values[keyField] = key;
        await store.LockAsync(parent.Id, [(keyField, key)], cancellationToken).ConfigureAwait(false);
        var holder = await store.FindHolderAsync(parent.Id, keyField, key, cancellationToken).ConfigureAwait(false);
        if (holder is null)
        {
            return await CreateAsync(parent, title ?? key, values, type, strict, cancellationToken).ConfigureAwait(false);
        }

        var visible = await tree.FindAsync(holder.ItemId, cancellationToken).ConfigureAwait(false);
        if (holder.Trashed)
        {
            return Result.Failure<(string, Item)>(RecordErrors.Trashed(keyField, holder.ItemId.Value));
        }

        return visible is null
            ? Result.Failure<(string, Item)>(RecordErrors.KeyConflict(keyField, null))
            : await UpdateAsync(parent, visible.Id, title, values, strict, cancellationToken).ConfigureAwait(false);
    }

    private async ValueTask<Result<(string Outcome, Item Item)>> CreateAsync(
        Item parent, string title, JsonObject? properties, string? type, bool strict, CancellationToken cancellationToken)
    {
        var created = await dispatcher.SendAsync<CreateItem, Item>(
            new CreateItem(parent.WorkspaceId, string.IsNullOrWhiteSpace(type) ? "note" : type, title, parent.Id, properties) { Strict = strict },
            cancellationToken).ConfigureAwait(false);
        return created.IsSuccess ? Result.Success((CreatedOutcome, created.Value)) : Result.Failure<(string, Item)>(created.Error);
    }

    private async ValueTask<Result<(string Outcome, Item Item)>> UpdateAsync(
        Item parent, ItemId itemId, string? title, JsonObject? properties, bool strict, CancellationToken cancellationToken)
    {
        var current = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (current is null || current.ParentId != parent.Id)
        {
            return Result.Failure<(string, Item)>(ItemErrors.NotFound($"No record {itemId} is visible in this collection."));
        }

        var stored = current.Properties is null ? new JsonObject() : JsonNode.Parse(current.Properties) as JsonObject ?? new JsonObject();
        var changes = new JsonObject();
        foreach (var (name, value) in properties ?? [])
        {
            // A write that sets a key to what it already holds, or clears one that is absent, writes nothing.
            if (!JsonNode.DeepEquals(stored[name], value))
            {
                changes[name] = value?.DeepClone();
            }
        }

        var written = current;
        var changed = false;
        if (changes.Count > 0)
        {
            var result = await dispatcher.SendAsync<SetItemProperties, Item>(
                new SetItemProperties(itemId, changes.ToJsonString()) { Strict = strict },
                cancellationToken).ConfigureAwait(false);
            if (result.IsFailure)
            {
                return Result.Failure<(string, Item)>(result.Error);
            }

            written = result.Value;
            changed = true;
        }

        if (title is not null && title != ItemProperties.ReadTitle(written.Properties))
        {
            var renamed = await dispatcher.SendAsync<RenameItem, Item>(new RenameItem(itemId, title), cancellationToken).ConfigureAwait(false);
            if (renamed.IsFailure)
            {
                return Result.Failure<(string, Item)>(renamed.Error);
            }

            written = renamed.Value;
            changed = true;
        }

        return Result.Success((changed ? UpdatedOutcome : UnchangedOutcome, written));
    }

    /// <summary>
    /// Runs a write at most once per idempotency key. A repeat of the same request returns the
    /// outcome stored the first time with the item as it is now (a newer write is never undone); the
    /// same key with a different request is a 409. The receipt keeps ids and the outcome, never item data.
    /// </summary>
    private async ValueTask<Result<(string Outcome, Item Item)>> WithReceiptAsync(
        Item parent,
        string? idempotencyKey,
        JsonObject requestShape,
        Func<ValueTask<Result<(string Outcome, Item Item)>>> write,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(idempotencyKey))
        {
            return await write().ConfigureAwait(false);
        }

        // The route is part of the identity, so one key reused on another collection is another operation.
        var operationId = DeriveOperationId(parent.Id, idempotencyKey);
        requestShape["parentId"] = parent.Id.Value;
        var fingerprint = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(requestShape.ToJsonString())));
        await receipts.LockOperationAsync(operationId, cancellationToken).ConfigureAwait(false);
        if (await receipts.FindAsync(operationId, cancellationToken).ConfigureAwait(false) is { } previous)
        {
            if (previous.WorkspaceId != parent.WorkspaceId.Value || previous.Fingerprint != fingerprint)
            {
                return Result.Failure<(string, Item)>(new NixError(RecordErrors.IdempotencyConflictCode, "This idempotency key belongs to a different request."));
            }

            var saved = JsonNode.Parse(previous.Response)!;
            var replayed = await tree.FindAsync(ItemId.From(saved["itemId"]!.GetValue<Guid>()), cancellationToken).ConfigureAwait(false);
            return replayed is not null && await permissions.CanWriteWorkspaceAsync(replayed.WorkspaceId, cancellationToken).ConfigureAwait(false)
                ? Result.Success((saved["outcome"]!.GetValue<string>(), replayed))
                : Result.Failure<(string, Item)>(ItemErrors.NotFound("The record this key created is no longer available."));
        }

        var result = await write().ConfigureAwait(false);
        if (result.IsSuccess)
        {
            await receipts.SaveAsync(
                operationId,
                parent.WorkspaceId,
                fingerprint,
                new JsonObject { ["outcome"] = result.Value.Outcome, ["itemId"] = result.Value.Item.Id.Value }.ToJsonString(),
                cancellationToken).ConfigureAwait(false);
        }

        return result;
    }

    // A stable name-based UUID of the key and the collection, because the receipt table is keyed by
    // a UUID and a caller's key is free text.
    private static Guid DeriveOperationId(ItemId parentId, string idempotencyKey)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes($"nix-record-idempotency:{parentId.Value:D}:{idempotencyKey}"));
        var bytes = hash[..16];
        bytes[6] = (byte)((bytes[6] & 0x0F) | 0x50);
        bytes[8] = (byte)((bytes[8] & 0x3F) | 0x80);
        return new Guid(bytes, bigEndian: true);
    }
}
