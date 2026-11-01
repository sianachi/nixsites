using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Sync;
using Nix.Domain.Tenancy;
using Nix.Features.Items;
using Nix.Features.Properties;
using Nix.Features.Workspaces;
using Nix.Messaging;

namespace Nix.Features.Sync;

public sealed class NativeReplayHandler(
    INativeReplayStore receipts,
    IWorkspaceSync sync,
    IItemTree tree,
    IItemLocks locks,
    IPermissionResolver permissions,
    AccessTokenSessionContext tokenScope,
    IFinanceLock topology,
    NixDispatcher dispatcher) : ICommandHandler<NativeReplay, NativeReplayResponse>
{
    internal const string InvalidCode = "sync.invalid_replay";
    internal const string ReuseCode = "sync.idempotency_conflict";
    internal const string RefusedCode = "sync.refused";
    internal const string ConflictCode = "sync.revision_conflict";

    public async ValueTask<Result<NativeReplayResponse>> HandleAsync(NativeReplay command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var request = command.Request;
        if (!TryParse(request, out var payload, out var expected))
        {
            return Result.Failure<NativeReplayResponse>(new NixError(InvalidCode, "The replay operation is invalid."));
        }
        if (request.Kind == "move" && !tokenScope.MayAdminister
            || !await permissions.CanWriteWorkspaceAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Success(Refused(request));
        }

        var fingerprint = Fingerprint(command);
        await receipts.LockOperationAsync(request.OperationId, cancellationToken).ConfigureAwait(false);
        var previous = await receipts.FindAsync(request.OperationId, cancellationToken).ConfigureAwait(false);
        if (previous is not null)
        {
            if (previous.WorkspaceId != command.WorkspaceId.Value || previous.Fingerprint != fingerprint)
            {
                return Result.Failure<NativeReplayResponse>(new NixError(ReuseCode, "This operation UUID belongs to a different request."));
            }
            var saved = JsonSerializer.Deserialize(previous.Response, NativeReplayJsonContext.Default.NativeReplayResponse)
                ?? throw new InvalidOperationException("A native replay receipt has no response.");
            // Receipts keep no item data; rebuild it from current state under the usual access check.
            if (saved.Status == "conflict" || saved.Status == "applied" && request.Kind != "archive")
            {
                var current = await CurrentAsync(command.WorkspaceId, saved.ItemId, cancellationToken).ConfigureAwait(false);
                if (current is null || current.Locked || !await locks.MayReadBodyAsync(ItemId.From(saved.ItemId), cancellationToken).ConfigureAwait(false))
                {
                    return Result.Success(Refused(request));
                }
                saved = saved with { Item = current, Revision = current.Revision };
            }
            return Result.Success(saved);
        }

        // Existing commands take topology before item locks, then their mutation trigger takes the sync counter.
        await topology.AcquireWorkspaceTopologyAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false);
        if (request.Kind is not ("create" or "daily-note"))
        {
            var actual = await receipts.LockItemRevisionAsync(command.WorkspaceId, ItemId.From(request.ItemId), cancellationToken).ConfigureAwait(false);
            var current = await CurrentAsync(command.WorkspaceId, request.ItemId, cancellationToken).ConfigureAwait(false);
            if (actual is null || current is null
                || !await locks.MayReadBodyAsync(ItemId.From(request.ItemId), cancellationToken).ConfigureAwait(false))
            {
                return await RememberAsync(command, fingerprint, Refused(request), cancellationToken).ConfigureAwait(false);
            }
            if (actual != expected)
            {
                return await RememberAsync(command, fingerprint,
                    new NativeReplayResponse(request.OperationId, "conflict", request.ItemId, current.Revision, current, ConflictCode),
                    cancellationToken).ConfigureAwait(false);
            }
        }
        if (payload.ParentId is { } parent)
        {
            var parentItem = await tree.FindAsync(ItemId.From(parent), cancellationToken).ConfigureAwait(false);
            if (parentItem is null || parentItem.WorkspaceId != command.WorkspaceId)
            {
                return await RememberAsync(command, fingerprint, Refused(request), cancellationToken).ConfigureAwait(false);
            }
            if (!await locks.MayReadBodyAsync(ItemId.From(parent), cancellationToken).ConfigureAwait(false))
            {
                return await RememberAsync(command, fingerprint, Refused(request, "items.locked"), cancellationToken).ConfigureAwait(false);
            }
        }

        await receipts.BeginMutationAsync(cancellationToken).ConfigureAwait(false);
        var result = await ApplyAsync(command, payload, cancellationToken).ConfigureAwait(false);
        await receipts.EndMutationAsync(result.IsSuccess, cancellationToken).ConfigureAwait(false);
        if (result.IsSuccess)
        {
            await sync.PublishPendingAsync(cancellationToken).ConfigureAwait(false);
        }
        NativeReplayResponse response;
        if (result.IsFailure)
        {
            var conflict = result.Error.Code is "items.move_would_create_cycle" or "items.lifecycle_conflict"
                or "items.idempotency_conflict" or "items.schema_violation";
            var current = conflict ? await CurrentAsync(command.WorkspaceId, request.ItemId, cancellationToken).ConfigureAwait(false) : null;
            response = new NativeReplayResponse(request.OperationId, conflict ? "conflict" : "refused",
                request.ItemId, current?.Revision, current,
                result.Error.Code is "items.not_found" or "items.parent_not_found" ? RefusedCode : result.Error.Code);
        }
        else
        {
            var itemId = result.Value;
            var current = await CurrentAsync(command.WorkspaceId, itemId.Value, cancellationToken).ConfigureAwait(false);
            var revision = current?.Revision;
            if (request.Kind == "archive")
            {
                var archivedRevision = await receipts.LockItemRevisionAsync(command.WorkspaceId, itemId, cancellationToken).ConfigureAwait(false);
                revision = archivedRevision?.ToString(CultureInfo.InvariantCulture);
            }
            response = new NativeReplayResponse(request.OperationId, "applied", itemId.Value,
                revision, current, null);
        }
        return await RememberAsync(command, fingerprint, response, cancellationToken).ConfigureAwait(false);
    }

    private async ValueTask<NativeItemSnapshot?> CurrentAsync(WorkspaceId workspaceId, Guid itemId, CancellationToken cancellationToken)
    {
        var result = await sync.ReconcileAsync(workspaceId, [itemId], cancellationToken).ConfigureAwait(false);
        return result.Items.Count == 0 ? null : result.Items[0];
    }

    private async ValueTask<Result<NativeReplayResponse>> RememberAsync(NativeReplay command, string fingerprint,
        NativeReplayResponse response, CancellationToken cancellationToken)
    {
        await receipts.SaveAsync(command.Request.OperationId, command.WorkspaceId, fingerprint,
            JsonSerializer.Serialize(response with { Item = null }, NativeReplayJsonContext.Default.NativeReplayResponse), cancellationToken).ConfigureAwait(false);
        return Result.Success(response);
    }

    private async ValueTask<Result<ItemId>> ApplyAsync(NativeReplay command, Payload payload, CancellationToken cancellationToken)
    {
        var itemId = ItemId.From(command.Request.ItemId);
        if (command.Request.Kind == "daily-note")
        {
            var opened = await dispatcher.SendAsync<OpenDailyNote, DailyNoteOpened>(
                new OpenDailyNote(command.WorkspaceId, payload.Date!), cancellationToken).ConfigureAwait(false);
            return opened.IsSuccess ? Result.Success(ItemId.From(opened.Value.ItemId)) : Result.Failure<ItemId>(opened.Error);
        }
        if (command.Request.Kind == "archive")
        {
            return await dispatcher.SendAsync<DeleteItem, ItemId>(new DeleteItem(itemId), cancellationToken).ConfigureAwait(false);
        }
        Result<Item> result = command.Request.Kind switch
        {
            "create" => await dispatcher.SendAsync<CreateItem, Item>(new CreateItem(command.WorkspaceId, payload.Type!,
                payload.Title!, payload.ParentId is { } parent ? ItemId.From(parent) : null, payload.Properties)
            { IdempotencyKey = command.Request.OperationId }, cancellationToken).ConfigureAwait(false),
            "rename" => await dispatcher.SendAsync<RenameItem, Item>(new RenameItem(itemId, payload.Title!), cancellationToken).ConfigureAwait(false),
            "move" => await dispatcher.SendAsync<MoveItem, Item>(new MoveItem(itemId,
                payload.ParentId is { } parent ? ItemId.From(parent) : null,
                payload.AfterId is { } after ? ItemId.From(after) : null), cancellationToken).ConfigureAwait(false),
            "properties" => await dispatcher.SendAsync<SetItemProperties, Item>(new SetItemProperties(itemId, payload.Properties!.ToJsonString()), cancellationToken).ConfigureAwait(false),
            _ => throw new InvalidOperationException("An unvalidated replay kind reached dispatch."),
        };
        return result.IsSuccess ? Result.Success(result.Value.Id) : Result.Failure<ItemId>(result.Error);
    }

    private static NativeReplayResponse Refused(NativeReplayRequest request, string code = RefusedCode) =>
        new(request.OperationId, "refused", request.ItemId, null, null, code);

    private sealed record Payload(string? Type, string? Title, Guid? ParentId, Guid? AfterId, JsonObject? Properties, string? Date);

    private static bool TryParse(NativeReplayRequest request, out Payload payload, out long expected)
    {
        payload = new Payload(null, null, null, null, null, null);
        expected = 0;
        if (request.OperationId == Guid.Empty || request.ItemId == Guid.Empty || request.Payload.ValueKind != JsonValueKind.Object
            || request.Kind is not ("create" or "daily-note" or "rename" or "move" or "archive" or "properties")
            || !UniqueProperties(request.Payload))
        {
            return false;
        }
        if (request.Kind is "create" or "daily-note" ? request.ExpectedRevision is not null
            : !long.TryParse(request.ExpectedRevision, NumberStyles.None, CultureInfo.InvariantCulture, out expected)
                || expected.ToString(CultureInfo.InvariantCulture) != request.ExpectedRevision)
        {
            return false;
        }
        var allowed = request.Kind switch
        {
            "create" => new[] { "type", "title", "parentId", "properties" },
            "daily-note" => ["date"],
            "rename" => ["title"],
            "move" => ["parentId", "afterId"],
            "properties" => ["changes"],
            _ => [],
        };
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in request.Payload.EnumerateObject())
        {
            if (!seen.Add(property.Name) || !allowed.Contains(property.Name, StringComparer.Ordinal))
            {
                return false;
            }
        }
        if (request.Kind == "move" && !seen.Contains("parentId"))
        {
            return false;
        }
        string? type = null;
        string? title = null;
        string? date = null;
        if (request.Kind == "create" && (!Text(request.Payload, "type", 64, out type) || string.IsNullOrWhiteSpace(type))
            || request.Kind is "create" or "rename" && !Text(request.Payload, "title", 4096, out title))
        {
            return false;
        }
        if (request.Kind == "daily-note"
            && (!Text(request.Payload, "date", 10, out date)
                || !DateOnly.TryParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day)
                || day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) != date))
        {
            return false;
        }
        if (!Identifier(request.Payload, "parentId", out var parentId) || !Identifier(request.Payload, "afterId", out var afterId))
        {
            return false;
        }
        JsonObject? properties = null;
        var key = request.Kind == "properties" ? "changes" : "properties";
        if (request.Payload.TryGetProperty(key, out var value))
        {
            if (value.ValueKind != JsonValueKind.Object)
            {
                return false;
            }
            properties = JsonNode.Parse(value.GetRawText()) as JsonObject;
        }
        if (request.Kind == "properties" && properties is null)
        {
            return false;
        }
        payload = new Payload(type, title, parentId, afterId, properties, date);
        return true;
    }

    private static bool UniqueProperties(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in element.EnumerateObject())
            {
                if (!names.Add(property.Name) || !UniqueProperties(property.Value))
                {
                    return false;
                }
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (var value in element.EnumerateArray())
            {
                if (!UniqueProperties(value))
                {
                    return false;
                }
            }
        }
        return true;
    }

    private static bool Text(JsonElement payload, string key, int limit, out string? value)
    {
        value = null;
        if (!payload.TryGetProperty(key, out var element) || element.ValueKind != JsonValueKind.String)
        {
            return false;
        }
        value = element.GetString();
        return value is not null && value.Length <= limit;
    }

    private static bool Identifier(JsonElement payload, string key, out Guid? value)
    {
        value = null;
        if (!payload.TryGetProperty(key, out var element) || element.ValueKind == JsonValueKind.Null)
        {
            return true;
        }
        if (element.ValueKind != JsonValueKind.String || !element.TryGetGuid(out var parsed) || parsed == Guid.Empty)
        {
            return false;
        }
        value = parsed;
        return true;
    }

    private static string Fingerprint(NativeReplay command)
    {
        var request = command.Request;
        var canonical = new JsonObject
        {
            ["workspaceId"] = command.WorkspaceId.Value,
            ["operationId"] = request.OperationId,
            ["kind"] = request.Kind,
            ["itemId"] = request.ItemId,
            ["expectedRevision"] = request.ExpectedRevision,
            ["payload"] = Canonical(JsonNode.Parse(request.Payload.GetRawText())),
        }.ToJsonString();
        // The route bounds the request to 64 KiB; hashing needs its bounded UTF-8 representation.
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonical)));
    }

    private static JsonNode? Canonical(JsonNode? node) => node switch
    {
        null => null,
        JsonObject obj => new JsonObject(obj.OrderBy(static entry => entry.Key, StringComparer.Ordinal)
            .Select(static entry => KeyValuePair.Create(entry.Key, Canonical(entry.Value)))),
        JsonArray array => new JsonArray(array.Select(Canonical).ToArray()),
        _ => node.DeepClone(),
    };
}
