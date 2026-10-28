using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Items;
using Nix.Features.Locks;
using Nix.Features.Workspaces;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Conversations;

public static class ConversationTools
{
    internal static async Task<Ok<ConversationToolResponse>> Handle(Guid itemId, ConversationToolRequest request,
        [FromServices] IIsolatedUnitOfWork units, HttpContext context)
    {
        if (request.TenantId == Guid.Empty || request.PrincipalId == Guid.Empty || request.RequestId == Guid.Empty || request.Arguments is null)
        {
            return TypedResults.Ok(new ConversationToolResponse(false, "Invalid conversation capability."));
        }

        var result = await units.RunAsync(NixSessionContext.ForTenant(new TenantId(request.TenantId), new PrincipalId(request.PrincipalId)),
            async (services, token) => new IsolatedOutcome<ConversationToolResponse>(await Execute(itemId, request, services, token).ConfigureAwait(false), false), context.RequestAborted).ConfigureAwait(false);
        return TypedResults.Ok(result);
    }

    public static async Task<ConversationToolResponse> Execute(Guid conversationId, ConversationToolRequest request, IServiceProvider services, CancellationToken token)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(services);
        var service = services.GetRequiredService<ConversationService>();
        var found = await service.Find(conversationId, true, token).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return new(false, "The conversation is unavailable.");
        }

        var config = ConversationService.Configuration(found.Value)!;
        var turn = config.Turn;
        if (turn is not { Status: "running" } || turn.RequestId != request.RequestId || turn.ActorId != request.PrincipalId
            || turn.ExpiresAt <= services.GetRequiredService<TimeProvider>().GetUtcNow()
            || !await service.SourcesAvailable(config.SourceWorkspaceIds, token).ConfigureAwait(false))
        {
            return new(false, "The turn is inactive or source access changed.");
        }

        string Arg(string key) => request.Arguments.TryGetValue(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";
        if (!Guid.TryParse(Arg("workspaceId"), out var workspaceId) || !config.SourceWorkspaceIds.Contains(workspaceId))
        {
            return new(false, "Choose a source workspace in this conversation.");
        }

        var identity = await services.GetRequiredService<IIdentityDirectory>().FindPrincipalByIdAsync(new TenantId(request.TenantId), new PrincipalId(request.PrincipalId), token).ConfigureAwait(false);
        if (identity?.Status != PrincipalStatus.Active)
        {
            return new(false, "The sender can no longer act.");
        }
        var workspace = await services.GetRequiredService<NixDispatcher>().QueryAsync<GetWorkspace, WorkspaceSnapshot?>(new(new WorkspaceId(workspaceId)), token).ConfigureAwait(false);
        var operation = Arg("operation");
        var tree = services.GetRequiredService<IItemTree>();
        async Task<bool> Unlocked(Item row)
        {
            var state = await services.GetRequiredService<NixDispatcher>().QueryAsync<GetItemLock, Result<ItemLockState>>(new(row.Id), token).ConfigureAwait(false);
            return state.IsSuccess && !state.Value.Locked;
        }
        JsonObject Envelope(Item row) => new()
        {
            ["id"] = row.Id.Value,
            ["workspaceId"] = row.WorkspaceId.Value,
            ["workspaceName"] = workspace?.Name,
            ["url"] = $"/w/{row.WorkspaceId.Value}?item={row.Id.Value}",
            ["title"] = ItemProperties.ReadTitle(row.Properties),
            ["type"] = row.Type,
            ["parentId"] = row.ParentId?.Value,
            ["properties"] = JsonNode.Parse(row.Properties ?? "{}"),
            ["schema"] = JsonNode.Parse(row.Schema ?? "{}"),
            ["views"] = JsonNode.Parse(row.Views ?? "{}")
        };
        if (operation == "search")
        {
            var query = Arg("query");
            if (query.Length is < 3 or > 1000)
            {
                return new(false, "Search needs 3 to 1000 characters.");
            }

            var hits = await services.GetRequiredService<IItemSearch>().FindAsync(query, [new WorkspaceId(workspaceId)], 30, token).ConfigureAwait(false);
            var rows = new JsonArray();
            foreach (var hit in hits)
            {
                var row = await tree.FindAsync(hit.Id, token).ConfigureAwait(false);
                if (row is not null && await Unlocked(row).ConfigureAwait(false))
                {
                    rows.Add(Envelope(row));
                }
            }
            return new(true, new JsonObject { ["workspaceId"] = workspaceId, ["items"] = rows, ["partial"] = hits.Count >= 30 || rows.Count != hits.Count }.ToJsonString());
        }
        Item? item = null;
        if (Guid.TryParse(Arg("itemId"), out var id))
        {
            item = await tree.FindAsync(new ItemId(id), token).ConfigureAwait(false);
        }

        if (operation == "list_items")
        {
            ItemId? parent = Guid.TryParse(Arg("parentId"), out var parentId) ? new ItemId(parentId) : null;
            if (parent is { } parentKey)
            {
                item = await tree.FindAsync(parentKey, token).ConfigureAwait(false);
                if (item is null || item.WorkspaceId.Value != workspaceId || !await Unlocked(item).ConfigureAwait(false))
                {
                    return new(false, "The parent is unavailable.");
                }
            }
            var rows = await tree.ListChildrenAsync(new WorkspaceId(workspaceId), parent, false, null, 31, token).ConfigureAwait(false);
            var visible = new JsonArray();
            foreach (var row in rows.Take(30))
            {
                if (await Unlocked(row).ConfigureAwait(false))
                {
                    visible.Add(Envelope(row));
                }
            }
            return new(true, new JsonObject
            {
                ["workspaceId"] = workspaceId,
                ["items"] = visible,
                ["partial"] = rows.Count > 30 || visible.Count != Math.Min(rows.Count, 30)
            }.ToJsonString());
        }
        if (item is null || item.WorkspaceId.Value != workspaceId)
        {
            return new(false, "The item is unavailable.");
        }

        var locked = await services.GetRequiredService<NixDispatcher>().QueryAsync<GetItemLock, Result<ItemLockState>>(new(item.Id), token).ConfigureAwait(false);
        // Background turns never inherit a browser's temporary lock-unlock consent.
        if (locked.IsFailure || locked.Value.Locked)
        {
            return new(false, "Locked content is unavailable to this turn.");
        }

        if (operation == "authorize_body")
        {
            return new(true, new JsonObject
            {
                ["tenantId"] = request.TenantId,
                ["principalId"] = request.PrincipalId,
                ["workspaceId"] = workspaceId,
                ["bodyKind"] = item.Type
            }.ToJsonString());
        }

        if (operation is "read_item" or "read_structure" or "read_view")
        {
            var envelope = Envelope(item);
            if (operation != "read_item")
            {
                envelope["partial"] = true;
                envelope["detail"] = "This is the stored schema and view metadata. Read children with list_items; this response does not execute queries or aggregate views.";
            }
            return new(true, envelope.ToJsonString());
        }

        if (operation == "read_note")
        {
            var body = await services.GetRequiredService<ConversationBodyReader>().ReadAsync(conversationId, request.RequestId, workspaceId, item.Id.Value, token).ConfigureAwait(false);
            if (body.IsFailure)
            {
                return new(false, body.Error.Message);
            }

            var envelope = Envelope(item);
            envelope["text"] = body.Value.Text;
            envelope["partial"] = body.Value.Truncated;
            envelope["unsupported"] = body.Value.Unsupported;
            return new(true, envelope.ToJsonString());
        }
        if (operation == "search_note")
        {
            var query = Arg("query").Trim();
            if (query.Length is < 1 or > 1000)
            {
                return new(false, "Search needs 1 to 1000 characters.");
            }

            var passages = await services.GetRequiredService<IItemSearch>().FindPassagesAsync(item.Id, query, [new WorkspaceId(workspaceId)], 8, token).ConfigureAwait(false);
            var rows = new JsonArray();
            foreach (var passage in passages)
            {
                rows.Add(new JsonObject
                {
                    ["itemId"] = passage.ItemId.Value,
                    ["title"] = passage.Title,
                    ["heading"] = passage.Heading,
                    ["ord"] = passage.Ord,
                    ["text"] = passage.Text
                });
            }
            return new(true, new JsonObject { ["id"] = item.Id.Value, ["title"] = ItemProperties.ReadTitle(item.Properties), ["passages"] = rows }.ToJsonString());
        }
        return new(false, "Only read operations are available in this conversation.");
    }
}
