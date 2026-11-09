using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using Nix.Features.Items;
using Nix.Features.Locks;
using Nix.Features.Pets;
using Nix.Features.Workspaces;
using Nix.Messaging;

namespace Nix.Features.Conversations;

/// <summary>Durable conversation state is ordinary item data; private provider sessions are replaceable.</summary>
public sealed class ConversationService(IItemTree tree, IPermissionResolver permissions,
    INixSessionContextAccessor session, IFinanceLock gate, TimeProvider clock, NixDispatcher dispatcher, ISchemaResolver schemas, IIdentityDirectory identities, IItemLocks locks)
{
    internal const string ConfigurationKey = "$chat_config";
    private static NixError Missing => new("conversations.not_found", "The conversation is unavailable.");
    private static NixError Invalid(string message) => new("conversations.invalid_request", message);
    internal static ConversationConfiguration? Configuration(Item item)
    {
        try
        {
            var value = JsonNode.Parse(item.Properties ?? "{}")?[ConfigurationKey]?.GetValue<string>();
            var config = value is null ? null : JsonSerializer.Deserialize(value, ConversationJsonContext.Default.ConversationConfiguration);
            return config is { PetId: var petId, Revision: > 0, SourceWorkspaceIds: { Count: >= 1 and <= 40 } sources }
                && petId != Guid.Empty && sources.All(id => id != Guid.Empty) && sources.Distinct().Count() == sources.Count
                ? config : null;
        }
        catch (Exception exception) when (exception is JsonException or InvalidOperationException) { return null; }
    }

    internal async Task<Result<Item>> Find(Guid id, bool write, CancellationToken cancellationToken)
    {
        if (id == Guid.Empty)
        {
            return Result.Failure<Item>(Missing);
        }

        var item = await tree.FindAsync(new ItemId(id), cancellationToken).ConfigureAwait(false);
        if (item is null || Configuration(item) is null
            || !await permissions.CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false)
            || write && !await permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Item>(Missing);
        }

        var itemLock = await dispatcher.QueryAsync<GetItemLock, Result<ItemLockState>>(new(item.Id), cancellationToken).ConfigureAwait(false);
        if (itemLock.IsFailure || itemLock.Value is { Locked: true, UnlockedUntil: null })
        {
            return Result.Failure<Item>(Missing);
        }

        return Result.Success(item);
    }

    internal async Task<bool> SourcesAvailable(IReadOnlyList<Guid>? ids, CancellationToken cancellationToken)
    {
        var context = session.Current!.Value;
        var actor = await identities.FindPrincipalByIdAsync(context.TenantId, context.PrincipalId, cancellationToken).ConfigureAwait(false);
        if (actor?.Status != PrincipalStatus.Active)
        {
            return false;
        }
        if (ids is null || ids.Count is < 1 or > 40 || ids.Any(id => id == Guid.Empty) || ids.Distinct().Count() != ids.Count)
        {
            return false;
        }

        foreach (var id in ids)
        {
            if (!await tree.WorkspaceExistsAsync(new WorkspaceId(id), cancellationToken).ConfigureAwait(false)
                || !await permissions.CanReadWorkspaceAsync(new WorkspaceId(id), cancellationToken).ConfigureAwait(false))
            {
                return false;
            }
        }

        return true;
    }

    internal async Task<ConversationResponse> Response(Item item, ConversationConfiguration config, CancellationToken cancellationToken)
    {
        var mayEdit = await permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false);
        var maySend = mayEdit && !item.NoChildren && await SourcesAvailable(config.SourceWorkspaceIds, cancellationToken).ConfigureAwait(false);
        var turn = config.Turn;
        return new(item.Id.Value, item.WorkspaceId.Value, ItemProperties.ReadTitle(item.Properties), config.SourceWorkspaceIds,
            config.PetId, config.Revision, maySend, turn is null ? null : new(turn.Id, turn.RequestId, turn.Status, turn.Error, turn.Text), mayEdit);
    }

    internal async Task Save(Item item, ConversationConfiguration config, CancellationToken cancellationToken)
    {
        await tree.UpdateConversationConfigurationAsync(item.Id,
            JsonSerializer.Serialize(config, ConversationJsonContext.Default.ConversationConfiguration),
            session.Current!.Value.PrincipalId, clock.GetUtcNow(), cancellationToken).ConfigureAwait(false);
    }

    internal async Task<Result<ConversationResponse>> Create(Guid workspaceId, CreateConversationRequest request, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.Title) || request.Title.Length > 240 || request.PetId == Guid.Empty
            || request.Messages is { Count: > 1000 } || request.Messages?.Any(message => message is null || message.Role is not ("user" or "assistant" or "system")
                || string.IsNullOrWhiteSpace(message.Text) || message.Text.Length > 32000) == true
            || !await SourcesAvailable(request.SourceWorkspaceIds, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ConversationResponse>(Invalid("Choose accessible source workspaces, a pet, and a title."));
        }

        var settings = await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), cancellationToken).ConfigureAwait(false);
        if (!settings.Settings.Profiles.Any(pet => pet.Id == request.PetId))
        {
            return Result.Failure<ConversationResponse>(Invalid("Choose one of your saved pets."));
        }

        var schema = new PropertySchema
        {
            Inherit = true,
            Properties = [
            new("chat_role", "Role", PropertyType.Select, ["user", "assistant", "system"], false),
            new("chat_text", "Message", PropertyType.Text, [], false),
            new("chat_created_at", "Sent", PropertyType.Date, [], false),
            new("chat_author", "Author", PropertyType.Text, [], false)]
        };
        var view = new ViewDefinition("chat", "Chat", ViewKind.Chat, [], null, [], null, null, false);
        var made = await dispatcher.SendAsync<Nix.Features.Views.CreateStructuredItem, Item>(
            new(new WorkspaceId(workspaceId), "document", request.Title.Trim(), request.ParentId is { } parent ? new ItemId(parent) : null,
                schema, [view], "chat"), cancellationToken).ConfigureAwait(false);
        if (made.IsFailure)
        {
            return Result.Failure<ConversationResponse>(made.Error);
        }

        var config = new ConversationConfiguration(request.SourceWorkspaceIds.ToArray(), request.PetId, 1);
        await Save(made.Value, config, cancellationToken).ConfigureAwait(false);
        foreach (var message in request.Messages ?? [])
        {
            await Append(made.Value, message.Role, message.Text, cancellationToken).ConfigureAwait(false);
        }

        if (request.GroupId is { } groupId)
        {
            var arrangement = await dispatcher.QueryAsync<GetWorkspaceArrangement, WorkspaceArrangementResponse>(new(), cancellationToken).ConfigureAwait(false);
            if (!arrangement.Groups.Any(group => group.Id == groupId))
            {
                return Result.Failure<ConversationResponse>(Invalid("The workspace group no longer exists."));
            }

            var groups = arrangement.Groups.Select(group => group.Id == groupId ? group with
            {
                ConversationItemIds = (group.ConversationItemIds ?? []).Append(made.Value.Id.Value).Distinct().ToArray(),
                LastDestinationWorkspaceId = workspaceId,
                LastDestinationParentId = request.ParentId
            } : group).ToArray();
            var saved = await dispatcher.SendAsync<SaveWorkspaceArrangement, WorkspaceArrangementResponse>(new(arrangement.Revision,
                new WorkspaceArrangementInput(groups, arrangement.PinnedWorkspaceIds)), cancellationToken).ConfigureAwait(false);
            if (saved.IsFailure)
            {
                return Result.Failure<ConversationResponse>(saved.Error);
            }
        }
        return Result.Success(await Response(made.Value, config, cancellationToken).ConfigureAwait(false));
    }

    internal async Task<Result<ConversationResponse>> Configure(Guid id, ConfigureConversationRequest request, CancellationToken cancellationToken)
    {
        await gate.AcquireAsync(new ItemId(id), cancellationToken).ConfigureAwait(false);
        var item = await tree.FindAsync(new ItemId(id), cancellationToken).ConfigureAwait(false);
        if (item is null || !await permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ConversationResponse>(Missing);
        }
        if (Configuration(item) is { } existing)
        {
            return Result.Success(await Response(item, existing, cancellationToken).ConfigureAwait(false));
        }
        var effective = await schemas.ResolveForItemAsync(item.Id, cancellationToken).ConfigureAwait(false);
        if (ChatSchema.Refuse(effective) is not null || !ViewDefinitionsJson.Read(item.Views).Views.Any(view => view.Kind == ViewKind.Chat))
        {
            return Result.Failure<ConversationResponse>(Invalid("Configure a compatible Chat view and message schema first."));
        }
        if (!await SourcesAvailable(request.SourceWorkspaceIds, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ConversationResponse>(Invalid("Choose accessible source workspaces."));
        }
        var settings = await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), cancellationToken).ConfigureAwait(false);
        if (!settings.Settings.Profiles.Any(pet => pet.Id == request.PetId))
        {
            return Result.Failure<ConversationResponse>(Invalid("Choose one of your saved pets."));
        }
        var config = new ConversationConfiguration(request.SourceWorkspaceIds.ToArray(), request.PetId, 1);
        await Save(item, config, cancellationToken).ConfigureAwait(false);
        return Result.Success(await Response(item, config, cancellationToken).ConfigureAwait(false));
    }

    public async Task<Result<ConversationResponse>> Read(Guid id, CancellationToken cancellationToken)
    {
        var found = await Find(id, false, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<ConversationResponse>(found.Error);
        }

        var config = Configuration(found.Value)!;
        if (config.Turn is { Status: "running" } turn && turn.ExpiresAt <= clock.GetUtcNow())
        {
            await gate.AcquireAsync(found.Value.Id, cancellationToken).ConfigureAwait(false);
            var current = await tree.FindAsync(found.Value.Id, cancellationToken).ConfigureAwait(false);
            config = Configuration(current!)!;
            if (config.Turn is { Status: "running" } expired && expired.ExpiresAt <= clock.GetUtcNow())
            {
                config = config with { Revision = config.Revision + 1, Turn = expired with { Status = "interrupted", Error = "The reply was interrupted. Send a new message to continue." } };
                await Save(current!, config, cancellationToken).ConfigureAwait(false);
            }
        }
        return Result.Success(await Response(found.Value, config, cancellationToken).ConfigureAwait(false));
    }

    public async Task<Result<ConversationMessagesResponse>> Messages(Guid id, string? cursor, int limit, CancellationToken cancellationToken)
    {
        var found = await Find(id, false, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<ConversationMessagesResponse>(found.Error);
        }

        long? after = null;
        if (cursor is not null)
        {
            if (!long.TryParse(cursor, NumberStyles.None, CultureInfo.InvariantCulture, out var seq))
            {
                return Result.Failure<ConversationMessagesResponse>(Invalid("Invalid message cursor."));
            }

            after = seq;
        }
        limit = Math.Clamp(limit, 1, 100);
        var messages = new List<ConversationMessageResponse>();
        Guid? currentMessageId = null;
        var currentHidden = false;
        long? lastSequence = after;
        var scanned = 0;
        var parts = 0;
        while (true)
        {
            var rows = await tree.ListChildrenAsync(found.Value.WorkspaceId, found.Value.Id, false, lastSequence, 100, cancellationToken).ConfigureAwait(false);
            var locked = await locks.LockedAmongAsync(rows.Select(row => row.Id).ToArray(), cancellationToken).ConfigureAwait(false);
            foreach (var row in rows)
            {
                var bag = JsonNode.Parse(row.Properties ?? "{}")!;
                var messageId = Guid.TryParse(ReadString(bag, "chat_message_id", ""), out var savedId) ? savedId : row.Id.Value;
                var role = ReadString(bag, "chat_role", "");
                var text = ReadString(bag, "chat_text", "");
                if (messageId != currentMessageId && (messages.Count == limit || scanned >= 500))
                {
                    return Result.Success(new ConversationMessagesResponse(messages, lastSequence?.ToString(CultureInfo.InvariantCulture)));
                }
                parts = messageId == currentMessageId ? parts + 1 : 1;
                if (parts > 512 || text.Length > 1000000
                    || messageId == currentMessageId && !currentHidden && messages[^1].Text.Length + text.Length > 1000000)
                {
                    return Result.Failure<ConversationMessagesResponse>(Invalid("A saved message exceeds the supported history size."));
                }
                var state = locked.Contains(row.Id) ? await locks.GetStateAsync(row.Id, cancellationToken).ConfigureAwait(false) : null;
                var hidden = state is { Locked: true, UnlockedUntil: null }
                    || role is not ("user" or "assistant" or "system") || text.Length == 0;
                if (messageId != currentMessageId)
                {
                    currentMessageId = messageId;
                    currentHidden = hidden;
                    if (!hidden)
                    {
                        messages.Add(new ConversationMessageResponse(messageId, role, text, row.CreatedAt, row.CreatedBy.Value,
                            row.Seq.ToString(CultureInfo.InvariantCulture), Guid.TryParse(ReadString(bag, "chat_turn_id", ""), out var requestId) ? requestId : null,
                            role == "assistant" ? ReadSources(bag) : null));
                    }
                }
                else if (hidden && !currentHidden)
                {
                    messages.RemoveAt(messages.Count - 1);
                    currentHidden = true;
                }
                else if (!currentHidden)
                {
                    var message = messages[^1];
                    messages[^1] = message with { Text = message.Text + text, Seq = row.Seq.ToString(CultureInfo.InvariantCulture) };
                }
                lastSequence = row.Seq;
                scanned++;
            }
            if (rows.Count < 100)
            {
                return Result.Success(new ConversationMessagesResponse(messages, null));
            }
        }
    }

    private static Guid[]? ReadSources(JsonNode bag) =>
        bag is JsonObject { } obj && obj["chat_sources"] is JsonArray array
            ? array.Select(node => node is JsonValue value && value.TryGetValue<string>(out var text) && Guid.TryParse(text, out var id) ? id : Guid.Empty)
                .Where(id => id != Guid.Empty).ToArray()
            : null;

    private static string ReadString(JsonNode bag, string key, string fallback) =>
        bag is JsonObject obj && obj[key] is JsonValue value && value.TryGetValue<string>(out var text) ? text : fallback;

    internal async Task<ItemId> Append(Item parent, string role, string text, CancellationToken cancellationToken, Guid? requestId = null, IReadOnlyList<Guid>? sources = null)
    {
        var now = clock.GetUtcNow();
        var context = session.Current!.Value;
        var messageId = ItemId.Create();
        var offset = 0;
        var part = 0;
        while (offset < text.Length)
        {
            var length = Math.Min(3000, text.Length - offset);
            if (offset + length < text.Length && char.IsHighSurrogate(text[offset + length - 1]))
            {
                length--;
            }
            var bag = new JsonObject
            {
                ["title"] = role == "user" ? "Message" : role == "assistant" ? "Reply" : "Conversation update",
                ["chat_role"] = role,
                ["chat_text"] = text.Substring(offset, length),
                ["chat_created_at"] = now.ToString("O", CultureInfo.InvariantCulture),
                ["chat_author"] = context.PrincipalId.Value.ToString(),
                ["chat_message_id"] = messageId.Value.ToString(),
                ["chat_part"] = part,
                ["chat_turn_id"] = requestId?.ToString()
            };
            if (sources is { Count: > 0 })
            {
                // The workspaces this reply was answered from, so the chat can show them per reply.
                bag["chat_sources"] = new JsonArray(sources.Select(source => (JsonNode)JsonValue.Create(source.ToString())).ToArray());
            }
            await tree.InsertAsync(new Item
            {
                Id = part == 0 ? messageId : ItemId.Create(),
                TenantId = context.TenantId,
                WorkspaceId = parent.WorkspaceId,
                Type = "document",
                ParentId = parent.Id,
                Seq = await tree.NextSiblingSequenceAsync(parent.WorkspaceId, parent.Id, cancellationToken).ConfigureAwait(false),
                Properties = bag.ToJsonString(),
                LifecycleState = ItemLifecycleState.Active,
                CreatedBy = context.PrincipalId,
                LastModifiedBy = context.PrincipalId,
                CreatedAt = now,
                LastModifiedAt = now
            }, cancellationToken).ConfigureAwait(false);
            offset += length;
            part++;
        }
        return messageId;
    }

    public async Task<Result<ConversationResponse>> Begin(Guid id, SendConversationRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.RequestId == Guid.Empty || string.IsNullOrWhiteSpace(request.Text) || request.Text.Length > 8000 || request.Model?.Length > 160)
        {
            return Result.Failure<ConversationResponse>(Invalid("Provide a request UUID and a message of up to 8,000 characters."));
        }

        await gate.AcquireAsync(new ItemId(id), cancellationToken).ConfigureAwait(false);
        var found = await Find(id, true, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<ConversationResponse>(found.Error);
        }

        var config = Configuration(found.Value)!;
        var receiptText = new JsonObject { ["conversationId"] = id, ["text"] = request.Text, ["model"] = request.Model, ["petId"] = request.PetId }.ToJsonString();
        var receipt = await tree.GetCreationReceiptAsync(request.RequestId, receiptText, cancellationToken).ConfigureAwait(false);
        if (receipt is not null)
        {
            return receipt.MatchesRequest
                ? Result.Success(await Response(found.Value, config, cancellationToken).ConfigureAwait(false))
                : Result.Failure<ConversationResponse>(new("conversations.conflict", "This request UUID belongs to another message."));
        }
        if (found.Value.NoChildren || found.Value.ManagedBy is not null)
        {
            return Result.Failure<ConversationResponse>(Invalid("This item does not accept conversation messages."));
        }

        if (config.CompletedRequestIds?.Contains(request.RequestId) == true || config.Turn?.RequestId == request.RequestId)
        {
            return Result.Success(await Response(found.Value, config, cancellationToken).ConfigureAwait(false));
        }

        if (config.Turn is { Status: "running" } active && active.ExpiresAt > clock.GetUtcNow())
        {
            return Result.Failure<ConversationResponse>(new("conversations.busy", "A reply is already in progress."));
        }

        if (!await SourcesAvailable(config.SourceWorkspaceIds, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ConversationResponse>(new("conversations.sources_unavailable", "Remove or replace unavailable source workspaces before sending."));
        }

        var settings = await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), cancellationToken).ConfigureAwait(false);
        var petId = request.PetId ?? (settings.Settings.Profiles.Any(pet => pet.Id == config.PetId) ? config.PetId : settings.Settings.ActivePetId);
        if (petId is null || !settings.Settings.Profiles.Any(pet => pet.Id == petId))
        {
            return Result.Failure<ConversationResponse>(Invalid("Choose one of your saved pets before sending."));
        }
        var messageId = await Append(found.Value, "user", request.Text, cancellationToken, request.RequestId).ConfigureAwait(false);
        await tree.RecordCreationReceiptAsync(request.RequestId, receiptText, messageId, cancellationToken).ConfigureAwait(false);
        config = config with { Revision = config.Revision + 1, Turn = new(Guid.NewGuid(), request.RequestId, "running", session.Current!.Value.PrincipalId.Value, clock.GetUtcNow().AddMinutes(4), PetId: petId) };
        await Save(found.Value, config, cancellationToken).ConfigureAwait(false);
        return Result.Success(await Response(found.Value, config, cancellationToken).ConfigureAwait(false));
    }

    internal async Task<Result<ConversationResponse>> ChangeSources(Guid id, ConversationSourcesRequest request, CancellationToken cancellationToken)
    {
        await gate.AcquireAsync(new ItemId(id), cancellationToken).ConfigureAwait(false);
        var found = await Find(id, true, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<ConversationResponse>(found.Error);
        }

        if (found.Value.NoChildren || found.Value.ManagedBy is not null)
        {
            return Result.Failure<ConversationResponse>(Invalid("This item does not accept conversation messages."));
        }
        var config = Configuration(found.Value)!;
        if (config.Revision != request.ExpectedRevision || config.Turn is { Status: "running" })
        {
            return Result.Failure<ConversationResponse>(new("conversations.conflict", "Reload the conversation after the current reply finishes."));
        }

        if (!await SourcesAvailable(request.SourceWorkspaceIds, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ConversationResponse>(Invalid("Choose accessible source workspaces."));
        }

        config = config with { SourceWorkspaceIds = request.SourceWorkspaceIds.ToArray(), Revision = config.Revision + 1 };
        await Append(found.Value, "system", "Source workspaces changed for future messages: " + string.Join(", ", config.SourceWorkspaceIds), cancellationToken).ConfigureAwait(false);
        await Save(found.Value, config, cancellationToken).ConfigureAwait(false);
        return Result.Success(await Response(found.Value, config, cancellationToken).ConfigureAwait(false));
    }

    public async Task<Result<ConversationResponse>> UpdateTurn(Guid id, Guid? requestId, string status, string text, string? error, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(text);
        await gate.AcquireAsync(new ItemId(id), cancellationToken).ConfigureAwait(false);
        var found = await Find(id, true, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<ConversationResponse>(found.Error);
        }

        var config = Configuration(found.Value)!;
        if (config.Turn is not { Status: "running" } turn || requestId is { } expected && expected != turn.RequestId)
        {
            return Result.Success(await Response(found.Value, config, cancellationToken).ConfigureAwait(false));
        }

        if (found.Value.NoChildren && status == "completed")
        {
            status = "interrupted";
            error = "The conversation stopped accepting new messages.";
        }
        if (status == "completed" && !string.IsNullOrWhiteSpace(text))
        {
            await Append(found.Value, "assistant", text, cancellationToken, sources: config.SourceWorkspaceIds).ConfigureAwait(false);
        }

        var previewStart = Math.Max(0, text.Length - 2000);
        if (previewStart > 0 && char.IsLowSurrogate(text[previewStart]))
        {
            previewStart++;
        }
        var preview = status == "running" ? (previewStart > 0 ? "…" : "") + text[previewStart..] : "";
        var safeError = error is { Length: > 1000 } ? error[..1000] : error;
        config = config with { Revision = config.Revision + 1, Turn = turn with { Status = status, Text = preview, Error = safeError } };
        await Save(found.Value, config, cancellationToken).ConfigureAwait(false);
        return Result.Success(await Response(found.Value, config, cancellationToken).ConfigureAwait(false));
    }
}
