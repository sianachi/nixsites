using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Properties;
using Nix.Domain.Tenancy;
using Nix.Features.Items;

namespace Nix.Tests.Features.Items;

public sealed class CreateItemIdempotencyTests
{
    private static readonly TenantId Tenant = TenantId.From(Guid.NewGuid());
    private static readonly WorkspaceId Workspace = WorkspaceId.From(Guid.NewGuid());
    private static readonly PrincipalId Principal = PrincipalId.From(Guid.NewGuid());
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Retrying_creation_returns_the_current_item_without_reapplying_its_original_title()
    {
        var tree = new RecordingTree();
        var handler = Handler(tree, new Permissions());
        var command = Command();
        var created = await handler.HandleAsync(command, Cancellation);
        Assert.True(created.IsSuccess);
        await tree.UpdatePropertiesAsync(created.Value.Id, """{"title":"Renamed later"}""", Principal,
            DateTimeOffset.UtcNow, Cancellation);

        var retried = await handler.HandleAsync(command, Cancellation);

        Assert.True(retried.IsSuccess);
        Assert.Equal(created.Value.Id, retried.Value.Id);
        Assert.Equal("Renamed later", JsonNode.Parse(retried.Value.Properties!)!["title"]!.GetValue<string>());
        Assert.Equal(1, tree.InsertCalls);
    }

    [Theory]
    [InlineData("workspace")]
    [InlineData("type")]
    [InlineData("title")]
    [InlineData("parent")]
    [InlineData("properties")]
    public async Task A_reused_key_with_changed_creation_input_refuses_a_second_item(string field)
    {
        var tree = new RecordingTree();
        var handler = Handler(tree, new Permissions());
        var command = Command();
        Assert.True((await handler.HandleAsync(command, Cancellation)).IsSuccess);
        var changed = field switch
        {
            "workspace" => command with { WorkspaceId = WorkspaceId.From(Guid.NewGuid()) },
            "type" => command with { Type = "canvas" },
            "title" => command with { Title = "Another note" },
            "parent" => command with { ParentId = ItemId.Create() },
            _ => command with { Properties = new JsonObject { ["status"] = "done" } },
        };

        var result = await handler.HandleAsync(changed, Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("items.idempotency_conflict", result.Error.Code);
        Assert.Equal(1, tree.InsertCalls);
    }

    [Fact]
    public async Task Reordered_properties_are_the_same_creation_request()
    {
        var tree = new RecordingTree();
        var handler = Handler(tree, new Permissions());
        var command = Command() with { Properties = new JsonObject { ["status"] = "open", ["colour"] = "blue" } };
        var created = await handler.HandleAsync(command, Cancellation);

        var result = await handler.HandleAsync(command with
        {
            Properties = new JsonObject { ["colour"] = "blue", ["status"] = "open" },
        }, Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(created.Value.Id, result.Value.Id);
        Assert.Equal(1, tree.InsertCalls);
    }

    [Fact]
    public async Task A_missing_receipt_target_is_refused_without_recreating_it()
    {
        var tree = new RecordingTree();
        var handler = Handler(tree, new Permissions());
        var command = Command();
        Assert.True((await handler.HandleAsync(command, Cancellation)).IsSuccess);
        tree.Items.Clear();

        var result = await handler.HandleAsync(command, Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("items.not_found", result.Error.Code);
        Assert.Equal(1, tree.InsertCalls);
    }

    [Fact]
    public async Task Retry_rechecks_write_permission_instead_of_treating_the_receipt_as_authority()
    {
        var tree = new RecordingTree();
        var permissions = new Permissions();
        var handler = Handler(tree, permissions);
        var command = Command();
        Assert.True((await handler.HandleAsync(command, Cancellation)).IsSuccess);
        permissions.Writable = false;

        var result = await handler.HandleAsync(command, Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("workspaces.not_found", result.Error.Code);
        Assert.Equal(1, tree.InsertCalls);
    }

    [Fact]
    public async Task Retry_refuses_a_note_moved_into_a_workspace_the_caller_cannot_write()
    {
        var tree = new RecordingTree();
        var permissions = new Permissions();
        var handler = Handler(tree, permissions);
        var command = Command();
        var created = await handler.HandleAsync(command, Cancellation);
        Assert.True(created.IsSuccess);
        var item = created.Value;
        var destination = WorkspaceId.From(Guid.NewGuid());
        tree.Items[item.Id] = new Item
        {
            Id = item.Id,
            TenantId = item.TenantId,
            WorkspaceId = destination,
            Type = item.Type,
            Seq = item.Seq,
            Properties = item.Properties,
            LifecycleState = item.LifecycleState,
            CreatedBy = item.CreatedBy,
            CreatedAt = item.CreatedAt,
            LastModifiedBy = item.LastModifiedBy,
            LastModifiedAt = item.LastModifiedAt,
        };
        permissions.RefusedWorkspace = destination;

        var result = await handler.HandleAsync(command, Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("items.not_found", result.Error.Code);
        Assert.Equal(1, tree.InsertCalls);
    }

    [Fact]
    public async Task Unkeyed_requests_keep_creating_distinct_items()
    {
        var tree = new RecordingTree();
        var handler = Handler(tree, new Permissions());
        var command = Command() with { IdempotencyKey = null };

        var first = await handler.HandleAsync(command, Cancellation);
        var second = await handler.HandleAsync(command, Cancellation);

        Assert.True(first.IsSuccess);
        Assert.True(second.IsSuccess);
        Assert.NotEqual(first.Value.Id, second.Value.Id);
        Assert.Equal(2, tree.InsertCalls);
        Assert.Empty(tree.Receipts);
    }

    [Fact]
    public async Task An_empty_idempotency_key_is_refused_before_any_item_is_inserted()
    {
        var tree = new RecordingTree();

        var result = await Handler(tree, new Permissions()).HandleAsync(Command() with { IdempotencyKey = Guid.Empty }, Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal("items.invalid_idempotency_key", result.Error.Code);
        Assert.Equal(0, tree.InsertCalls);
    }

    private static CreateItem Command() => new(Workspace, "note", "Offline capture", null, null)
    {
        IdempotencyKey = Guid.NewGuid(),
    };

    private static CreateItemHandler Handler(RecordingTree tree, Permissions permissions) =>
        new(tree, permissions, new EmptySchema(), new Session(), TimeProvider.System);

    private sealed class Session : INixSessionContextAccessor
    {
        public NixSessionContext? Current => NixSessionContext.ForTenant(Tenant, Principal);
    }

    private sealed class EmptySchema : ISchemaResolver
    {
        public ValueTask<PropertySchema> ResolveForItemAsync(ItemId itemId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(PropertySchema.Empty);
        public ValueTask<PropertySchema> ResolveForChildrenAsync(ItemId? parentId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(PropertySchema.Empty);
    }

    private sealed class Permissions : IPermissionResolver
    {
        public bool Writable { get; set; } = true;
        public WorkspaceId? RefusedWorkspace { get; set; }
        public ValueTask<bool> CanReadWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(true);
        public ValueTask<bool> CanWriteWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(Writable && workspaceId != RefusedWorkspace);
        public ValueTask<bool> CanCommentWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(false);

        public ValueTask<bool> CanManageWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(false);
        public ValueTask<IReadOnlyList<WorkspaceId>> ReadableWorkspacesAsync(CancellationToken cancellationToken) => ValueTask.FromResult<IReadOnlyList<WorkspaceId>>([Workspace]);
        public ValueTask<bool> IsTenantAdministratorAsync(CancellationToken cancellationToken) => ValueTask.FromResult(false);
    }

    private sealed class RecordingTree : IItemTree
    {
        public Dictionary<ItemId, Item> Items { get; } = [];
        public Dictionary<Guid, (string Request, ItemId ItemId)> Receipts { get; } = [];
        public int InsertCalls { get; private set; }

        public ValueTask<ItemCreationReceipt?> GetCreationReceiptAsync(Guid key, string request, CancellationToken cancellationToken) =>
            ValueTask.FromResult(Receipts.TryGetValue(key, out var receipt)
                ? new ItemCreationReceipt(receipt.ItemId, JsonNode.DeepEquals(JsonNode.Parse(receipt.Request), JsonNode.Parse(request)))
                : null);

        public ValueTask RecordCreationReceiptAsync(Guid key, string request, ItemId itemId, CancellationToken cancellationToken)
        {
            Receipts.Add(key, (request, itemId));
            return ValueTask.CompletedTask;
        }

        public ValueTask<Item?> FindAsync(ItemId id, CancellationToken cancellationToken) => ValueTask.FromResult(Items.GetValueOrDefault(id));
        public ValueTask<Item?> FindStoredAsync(ItemId id, CancellationToken cancellationToken) => FindAsync(id, cancellationToken);
        public ValueTask<bool> WorkspaceExistsAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(true);
        public ValueTask<long> NextSiblingSequenceAsync(WorkspaceId workspaceId, ItemId? parentId, CancellationToken cancellationToken) => ValueTask.FromResult(1000L * (InsertCalls + 1));

        public ValueTask InsertAsync(Item item, CancellationToken cancellationToken)
        {
            Items.Add(item.Id, item);
            InsertCalls++;
            return ValueTask.CompletedTask;
        }

        public ValueTask UpdatePropertiesAsync(ItemId id, string properties, PrincipalId actor, DateTimeOffset at, CancellationToken cancellationToken)
        {
            var item = Items[id];
            Items[id] = new Item
            {
                Id = id,
                TenantId = item.TenantId,
                WorkspaceId = item.WorkspaceId,
                Type = item.Type,
                ParentId = item.ParentId,
                Seq = item.Seq,
                Properties = properties,
                LifecycleState = item.LifecycleState,
                CreatedBy = item.CreatedBy,
                CreatedAt = item.CreatedAt,
                LastModifiedBy = actor,
                LastModifiedAt = at,
            };
            return ValueTask.CompletedTask;
        }

        public ValueTask<IReadOnlySet<ItemId>> WithChildrenAsync(WorkspaceId workspaceId, IReadOnlyList<ItemId> parents, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<IReadOnlyList<Item>> ListChildrenAsync(WorkspaceId workspaceId, ItemId? parentId, bool includeDeleted, long? afterSeq, int limit, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<long> AllocateSiblingSequenceAsync(WorkspaceId workspaceId, ItemId? parentId, ItemId movingId, ItemId? afterId, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask UpdateSchemaAsync(ItemId id, string? schema, PrincipalId actor, DateTimeOffset at, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask UpdateViewsAsync(ItemId id, string? views, PrincipalId actor, DateTimeOffset at, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask TouchAsync(ItemId id, PrincipalId actor, DateTimeOffset at, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<bool> WouldCreateCycleAsync(ItemId id, ItemId parentId, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask ReparentAsync(ItemId id, ItemId? newParentId, long seq, PrincipalId actor, DateTimeOffset at, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask SetLifecycleAsync(ItemId id, ItemLifecycleState state, PrincipalId actor, DateTimeOffset at, CancellationToken cancellationToken) => throw new NotSupportedException();
    }
}
