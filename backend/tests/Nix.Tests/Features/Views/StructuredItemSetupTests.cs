using System.Collections.Immutable;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Properties;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using Nix.Features.Properties;
using Nix.Features.Views;

namespace Nix.Tests.Features.Views;

public sealed class StructuredItemSetupTests
{
    private static readonly TenantId Tenant = TenantId.From(
        new Guid("11111111-1111-4111-8111-111111111111"));
    private static readonly WorkspaceId Workspace = WorkspaceId.From(
        new Guid("22222222-2222-4222-8222-222222222222"));
    private static readonly PrincipalId Principal = PrincipalId.From(
        new Guid("33333333-3333-4333-8333-333333333333"));

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Creation_inserts_the_item_with_schema_and_views_already_attached()
    {
        var tree = new RecordingTree(null);
        var schema = Schema(Property("status"));
        var views = ImmutableArray.Create(View("board"));
        var handler = new CreateStructuredItemHandler(
            tree,
            new WritablePermissions(),
            new Session(),
            TimeProvider.System,
            new FixedSchemas(PropertySchema.Empty));

        var result = await handler.HandleAsync(
            new CreateStructuredItem(Workspace, "note", "Launch board", null, schema, views, "board"),
            Cancellation);

        Assert.True(result.IsSuccess);
        Assert.NotNull(tree.Inserted);
        Assert.Equal("Launch board", ItemProperties.ReadTitle(tree.Inserted.Properties));
        Assert.Equal("status", PropertySchemaJson.Read(tree.Inserted.Schema).Properties.Single().Key);
        Assert.Equal("board", ViewDefinitionsJson.Read(tree.Inserted.Views).Views.Single().Id);
    }

    [Fact]
    public async Task Appending_refuses_a_field_identifier_that_now_exists()
    {
        var schema = Schema(Property("status"));
        var item = Container(schema, ImmutableArray.Create(View("existing")));
        var tree = new RecordingTree(item);
        var handler = new AppendViewSetupHandler(
            tree,
            new FixedSchemas(schema),
            new WritablePermissions(),
            new Session(),
            TimeProvider.System);

        var result = await handler.HandleAsync(
            new AppendViewSetup(item.Id, [Property("status")], [View("new")], true),
            Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal(PropertyErrors.SetupCollisionCode, result.Error.Code);
        Assert.Null(tree.WrittenSchema);
        Assert.Null(tree.WrittenViews);
    }

    [Fact]
    public async Task Appending_a_view_merges_it_and_honours_make_default()
    {
        var schema = Schema(Property("status"));
        var item = Container(schema, ImmutableArray.Create(View("existing")));
        var tree = new RecordingTree(item);
        var handler = new AppendViewSetupHandler(
            tree,
            new FixedSchemas(schema),
            new WritablePermissions(),
            new Session(),
            TimeProvider.System);

        var result = await handler.HandleAsync(
            new AppendViewSetup(item.Id, [], [View("new")], true),
            Cancellation);

        Assert.True(result.IsSuccess);
        Assert.NotNull(tree.WrittenSchema);
        Assert.Equal(["status"], PropertySchemaJson.Read(tree.WrittenSchema).Properties.Select(property => property.Key));
        Assert.NotNull(tree.WrittenViews);
        var savedViews = ViewDefinitionsJson.Read(tree.WrittenViews);
        Assert.Equal(["existing", "new"], savedViews.Views.Select(view => view.Id));
        Assert.Equal("new", savedViews.Default);
    }

    [Fact]
    public async Task Append_with_properties_and_no_views_merges_the_schema_only()
    {
        var schema = Schema(Property("status"));
        var item = Container(schema, ImmutableArray.Create(View("existing")));
        var tree = new RecordingTree(item);
        var handler = new AppendViewSetupHandler(
            tree,
            new FixedSchemas(schema),
            new WritablePermissions(),
            new Session(),
            TimeProvider.System);

        var result = await handler.HandleAsync(
            new AppendViewSetup(item.Id, [Property("rating")], [], false),
            Cancellation);

        Assert.True(result.IsSuccess);
        Assert.NotNull(tree.WrittenSchema);
        var savedSchema = PropertySchemaJson.Read(tree.WrittenSchema);
        Assert.Equal(["status", "rating"], savedSchema.Properties.Select(property => property.Key));
        Assert.Equal(0, tree.ViewsWrites);
        Assert.Null(tree.WrittenViews);
    }

    [Fact]
    public async Task Append_with_neither_properties_nor_views_is_refused()
    {
        var schema = Schema(Property("status"));
        var item = Container(schema, ImmutableArray.Create(View("existing")));
        var tree = new RecordingTree(item);
        var handler = new AppendViewSetupHandler(
            tree,
            new FixedSchemas(schema),
            new WritablePermissions(),
            new Session(),
            TimeProvider.System);

        var result = await handler.HandleAsync(
            new AppendViewSetup(item.Id, [], [], false),
            Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal(PropertyErrors.InvalidViewsCode, result.Error.Code);
        Assert.Null(tree.WrittenSchema);
        Assert.Null(tree.WrittenViews);
    }

    [Fact]
    public async Task Append_with_no_views_never_changes_the_default_view()
    {
        var schema = Schema(Property("status"));
        var item = Container(schema, ImmutableArray.Create(View("existing")));
        var tree = new RecordingTree(item);
        var handler = new AppendViewSetupHandler(
            tree,
            new FixedSchemas(schema),
            new WritablePermissions(),
            new Session(),
            TimeProvider.System);

        var result = await handler.HandleAsync(
            new AppendViewSetup(item.Id, [Property("rating")], [], true),
            Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(0, tree.ViewsWrites);
        Assert.Null(tree.WrittenViews);
    }

    [Fact]
    public async Task Replacing_preserves_a_field_added_after_the_studio_opened()
    {
        var original = Property("owner");
        var concurrent = Property("priority");
        var currentSchema = Schema(original, concurrent);
        var item = Container(currentSchema, ImmutableArray.Create(View("list")));
        var tree = new RecordingTree(item);
        var handler = new ReplaceViewSetupHandler(
            tree,
            new FixedSchemas(currentSchema),
            new WritablePermissions(),
            new Session(),
            TimeProvider.System);
        var renamed = original with { Label = "Assignee" };

        var result = await handler.HandleAsync(
            new ReplaceViewSetup(item.Id, "list", Schema(renamed), ["owner"], [View("list")]),
            Cancellation);

        Assert.True(result.IsSuccess);
        var saved = PropertySchemaJson.Read(tree.WrittenSchema);
        Assert.Equal(["priority", "owner"], saved.Properties.Select(property => property.Key));
        Assert.Equal("Assignee", saved.Find("owner")?.Label);
    }

    [Fact]
    public async Task Replacing_refuses_a_new_identifier_that_collides_with_inherited_schema()
    {
        var original = Property("owner");
        var inherited = Property("status");
        var declared = Schema(original);
        var effective = Schema(original, inherited);
        var item = Container(declared, ImmutableArray.Create(View("list")));
        var tree = new RecordingTree(item);
        var handler = new ReplaceViewSetupHandler(
            tree,
            new FixedSchemas(effective),
            new WritablePermissions(),
            new Session(),
            TimeProvider.System);

        var result = await handler.HandleAsync(
            new ReplaceViewSetup(
                item.Id,
                "list",
                Schema(original, inherited),
                ["owner"],
                [View("list")]),
            Cancellation);

        Assert.True(result.IsFailure);
        Assert.Equal(PropertyErrors.SetupCollisionCode, result.Error.Code);
        Assert.Null(tree.WrittenSchema);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Chat_creation_requires_compatible_declared_or_inherited_fields(bool inherited)
    {
        var tree = new RecordingTree(null);
        var messageSchema = ChatFields();
        var handler = new CreateStructuredItemHandler(tree, new WritablePermissions(), new Session(), TimeProvider.System,
            new FixedSchemas(inherited ? messageSchema : PropertySchema.Empty));
        var chat = View("chat") with { Kind = ViewKind.Chat };
        var result = await handler.HandleAsync(new CreateStructuredItem(Workspace, "note", "Conversation", null,
            inherited ? PropertySchema.Empty : messageSchema, [chat], "chat"), Cancellation);
        Assert.True(result.IsSuccess);
        Assert.NotNull(tree.Inserted);
    }

    [Fact]
    public async Task Invalid_chat_creation_does_not_insert_an_item()
    {
        var tree = new RecordingTree(null);
        var handler = new CreateStructuredItemHandler(tree, new WritablePermissions(), new Session(), TimeProvider.System,
            new FixedSchemas(PropertySchema.Empty));
        var result = await handler.HandleAsync(new CreateStructuredItem(Workspace, "note", "Conversation", null,
            Schema(Property("description")), [View("chat") with { Kind = ViewKind.Chat }], "chat"), Cancellation);
        Assert.True(result.IsFailure);
        Assert.Equal(PropertyErrors.InvalidViewsCode, result.Error.Code);
        Assert.Null(tree.Inserted);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Attaching_a_chat_view_validates_the_child_schema_before_writing(bool compatible)
    {
        var schema = compatible ? ChatFields() : PropertySchema.Empty;
        var item = Container(PropertySchema.Empty, [View("list")]);
        var tree = new RecordingTree(item);
        var handler = new SetContainerViewsHandler(tree, new WritablePermissions(), new Session(), TimeProvider.System, new FixedSchemas(schema));
        var result = await handler.HandleAsync(new SetContainerViews(item.Id, [View("chat") with { Kind = ViewKind.Chat }], "chat"), Cancellation);
        Assert.Equal(compatible, result.IsSuccess);
        Assert.Equal(compatible ? 1 : 0, tree.ViewsWrites);
        if (!compatible)
        {
            Assert.Equal(PropertyErrors.InvalidViewsCode, result.Error.Code);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Chat_append_checks_existing_and_new_message_fields_before_any_write(bool compatible)
    {
        var schema = compatible ? ChatFields() : PropertySchema.Empty;
        var item = Container(PropertySchema.Empty, [View("list")]);
        var tree = new RecordingTree(item);
        var handler = new AppendViewSetupHandler(tree, new FixedSchemas(schema), new WritablePermissions(), new Session(), TimeProvider.System);
        var result = await handler.HandleAsync(new AppendViewSetup(item.Id, [], [View("chat") with { Kind = ViewKind.Chat }], false), Cancellation);
        Assert.Equal(compatible, result.IsSuccess);
        if (!compatible)
        {
            Assert.Null(tree.WrittenSchema);
            Assert.Null(tree.WrittenViews);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Chat_replacement_checks_the_resulting_schema_before_any_write(bool compatible)
    {
        var item = Container(PropertySchema.Empty, [View("list")]);
        var tree = new RecordingTree(item);
        var handler = new ReplaceViewSetupHandler(tree, new FixedSchemas(PropertySchema.Empty), new WritablePermissions(), new Session(), TimeProvider.System);
        var result = await handler.HandleAsync(new ReplaceViewSetup(item.Id, "list", compatible ? ChatFields() : PropertySchema.Empty,
            [], [View("chat") with { Kind = ViewKind.Chat }]), Cancellation);
        Assert.Equal(compatible, result.IsSuccess);
        if (!compatible)
        {
            Assert.Null(tree.WrittenSchema);
            Assert.Null(tree.WrittenViews);
        }
    }

    private static PropertySchema ChatFields() => Schema(
        new("chat_role", "Role", PropertyType.Select, ["user", "assistant", "system"], false),
        Property("chat_text"),
        new("chat_created_at", "Sent", PropertyType.Date, [], false),
        Property("chat_author"));

    private static PropertyDefinition Property(string key) =>
        new(key, key, PropertyType.Text, [], false);

    private static PropertySchema Schema(params PropertyDefinition[] properties) => new()
    {
        Properties = [.. properties],
        Inherit = true,
    };

    private static ViewDefinition View(string id) =>
        new(id, id, ViewKind.List, [], null, [], null, null, false);

    private static Item Container(PropertySchema schema, ImmutableArray<ViewDefinition> views) => new()
    {
        Id = ItemId.From(new Guid("44444444-4444-4444-8444-444444444444")),
        TenantId = Tenant,
        WorkspaceId = Workspace,
        Type = "note",
        Seq = 1000,
        Schema = PropertySchemaJson.Write(schema),
        Views = ViewDefinitionsJson.Write(views, views[0].Id),
        LifecycleState = ItemLifecycleState.Active,
        CreatedBy = Principal,
        LastModifiedBy = Principal,
        CreatedAt = DateTimeOffset.UnixEpoch,
        LastModifiedAt = DateTimeOffset.UnixEpoch,
    };

    private sealed class Session : INixSessionContextAccessor
    {
        public NixSessionContext? Current => NixSessionContext.ForTenant(Tenant, Principal);
    }

    private sealed class FixedSchemas(PropertySchema schema) : ISchemaResolver
    {
        public ValueTask<PropertySchema> ResolveForItemAsync(
            ItemId itemId,
            CancellationToken cancellationToken) => ValueTask.FromResult(schema);

        public ValueTask<PropertySchema> ResolveForChildrenAsync(
            ItemId? parentId,
            CancellationToken cancellationToken) => ValueTask.FromResult(schema);
    }

    private sealed class WritablePermissions : IPermissionResolver
    {
        public ValueTask<bool> CanReadWorkspaceAsync(
            WorkspaceId workspaceId,
            CancellationToken cancellationToken) => ValueTask.FromResult(true);

        public ValueTask<bool> CanWriteWorkspaceAsync(
            WorkspaceId workspaceId,
            CancellationToken cancellationToken) => ValueTask.FromResult(true);

        public ValueTask<bool> CanCommentWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(false);


        public ValueTask<bool> CanManageWorkspaceAsync(
            WorkspaceId workspaceId,
            CancellationToken cancellationToken) => ValueTask.FromResult(false);

        public ValueTask<IReadOnlyList<WorkspaceId>> ReadableWorkspacesAsync(
            CancellationToken cancellationToken) => ValueTask.FromResult<IReadOnlyList<WorkspaceId>>([Workspace]);

        public ValueTask<bool> IsTenantAdministratorAsync(CancellationToken cancellationToken) =>
            ValueTask.FromResult(false);
    }

    private sealed class RecordingTree(Item? item) : IItemTree
    {
        public Item? Inserted { get; private set; }

        public string? WrittenSchema { get; private set; }

        public string? WrittenViews { get; private set; }

        public int ViewsWrites { get; private set; }

        public ValueTask<Item?> FindAsync(ItemId id, CancellationToken cancellationToken) =>
            ValueTask.FromResult(item?.Id == id ? item : null);

        public ValueTask<Item?> FindStoredAsync(ItemId id, CancellationToken cancellationToken) =>
            FindAsync(id, cancellationToken);

        public ValueTask<IReadOnlySet<ItemId>> WithChildrenAsync(
            WorkspaceId workspaceId,
            IReadOnlyList<ItemId> parents,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<IReadOnlyList<Item>> ListChildrenAsync(
            WorkspaceId workspaceId,
            ItemId? parentId,
            bool includeDeleted,
            long? afterSeq,
            int limit,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<bool> WorkspaceExistsAsync(
            WorkspaceId workspaceId,
            CancellationToken cancellationToken) => ValueTask.FromResult(true);

        public ValueTask<long> NextSiblingSequenceAsync(
            WorkspaceId workspaceId,
            ItemId? parentId,
            CancellationToken cancellationToken) => ValueTask.FromResult(1000L);

        public ValueTask<long> AllocateSiblingSequenceAsync(
            WorkspaceId workspaceId,
            ItemId? parentId,
            ItemId movingId,
            ItemId? afterId,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask InsertAsync(Item inserted, CancellationToken cancellationToken)
        {
            Inserted = inserted;
            return ValueTask.CompletedTask;
        }

        public ValueTask UpdatePropertiesAsync(
            ItemId id,
            string properties,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask UpdateSchemaAsync(
            ItemId id,
            string? schema,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken)
        {
            WrittenSchema = schema;
            return ValueTask.CompletedTask;
        }

        public ValueTask UpdateViewsAsync(
            ItemId id,
            string? views,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken)
        {
            WrittenViews = views;
            ViewsWrites++;
            return ValueTask.CompletedTask;
        }

        public ValueTask TouchAsync(
            ItemId id,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<bool> WouldCreateCycleAsync(
            ItemId id,
            ItemId parentId,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask ReparentAsync(
            ItemId id,
            ItemId? newParentId,
            long seq,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask SetLifecycleAsync(
            ItemId id,
            ItemLifecycleState state,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken) => throw new NotSupportedException();
    }
}
