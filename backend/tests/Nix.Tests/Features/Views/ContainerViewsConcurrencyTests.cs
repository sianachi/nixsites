using System.Collections.Immutable;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using Nix.Features.Views;

namespace Nix.Tests.Features.Views;

public sealed class ContainerViewsConcurrencyTests
{
    private static readonly TenantId Tenant = TenantId.From(new Guid("11111111-1111-4111-8111-111111111111"));
    private static readonly TenantId ForeignTenant = TenantId.From(new Guid("99999999-9999-4999-8999-999999999999"));
    private static readonly WorkspaceId Workspace = WorkspaceId.From(new Guid("22222222-2222-4222-8222-222222222222"));
    private static readonly PrincipalId Principal = PrincipalId.From(new Guid("33333333-3333-4333-8333-333333333333"));
    private static readonly ItemId ContainerId = ItemId.From(new Guid("44444444-4444-4444-8444-444444444444"));

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Theory]
    [InlineData("denied")]
    [InlineData("foreign")]
    [InlineData("hidden")]
    [InlineData("missing")]
    public async Task Conditional_write_does_not_reveal_stale_versions_or_mutate_inaccessible_items(string access)
    {
        var tree = InaccessibleTree(access);
        var handler = WriteHandler(tree, access != "denied");

        var result = await handler.HandleAsync(
            new SetContainerViews(ContainerId, [View("Renamed")], "list", ExpectedVersion: new string('a', 64)),
            Cancellation);

        Assert.True(result.IsFailure);
        AssertFailureCode(result.Error, "items.not_found");
        Assert.Equal(0, tree.UnconditionalWrites);
        Assert.Equal(0, tree.ConditionalWrites);
        Assert.Null(tree.WrittenViews);
        Assert.Equal(0, tree.StoredReads);
    }

    [Theory]
    [InlineData("denied")]
    [InlineData("foreign")]
    [InlineData("hidden")]
    [InlineData("missing")]
    public async Task Configuration_read_does_not_reveal_a_version_for_inaccessible_items(string access)
    {
        var tree = InaccessibleTree(access);
        var schemas = new Schemas();
        var handler = new GetContainerViewsHandler(tree, schemas, new Permissions(access != "denied"));

        var result = await handler.HandleAsync(new GetContainerViews(ContainerId), Cancellation);

        Assert.True(result.IsFailure);
        AssertFailureCode(result.Error, "items.not_found");
        Assert.Equal(0, schemas.Reads);
        Assert.Equal(0, tree.StoredReads);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Configuration_read_returns_the_version_of_the_exact_stored_value_including_no_views(bool empty)
    {
        var item = Container(empty ? null : ViewDefinitionsJson.Write([View("All work")], "list"));
        var handler = new GetContainerViewsHandler(new RecordingTree(item), new Schemas(), new Permissions(true));

        var result = await handler.HandleAsync(new GetContainerViews(ContainerId), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(ViewConfigurationVersion.FromStored(item.Views), result.Value.Version);
        Assert.Equal(empty ? "document" : "list", result.Value.Default);
    }

    [Fact]
    public async Task Read_permission_and_a_matching_version_do_not_grant_write_permission()
    {
        var item = Container(ViewDefinitionsJson.Write([View("All work")], "list"));
        var tree = new RecordingTree(item);
        var handler = new SetContainerViewsHandler(
            tree, new Permissions(true, false), new Session(), TimeProvider.System, new Schemas());

        var result = await handler.HandleAsync(
            new SetContainerViews(ContainerId, [View("Renamed")], "list", ExpectedVersion: ViewConfigurationVersion.FromStored(item.Views)),
            Cancellation);

        Assert.True(result.IsFailure);
        AssertFailureCode(result.Error, "items.not_found");
        Assert.Equal(0, tree.UnconditionalWrites);
        Assert.Equal(0, tree.ConditionalWrites);
        Assert.Null(tree.WrittenViews);
    }

    [Fact]
    public async Task A_stale_read_version_is_refused_before_any_persistence_write()
    {
        var oldViews = ViewDefinitionsJson.Write([View("All work")], "list");
        var currentViews = ViewDefinitionsJson.Write([View("Someone else's change")], "list");
        var tree = new RecordingTree(Container(currentViews));

        var result = await WriteHandler(tree).HandleAsync(
            new SetContainerViews(ContainerId, [View("Renamed")], "list", ExpectedVersion: ViewConfigurationVersion.FromStored(oldViews)),
            Cancellation);

        Assert.True(result.IsFailure);
        AssertFailureCode(result.Error, "views.version_conflict");
        Assert.Equal(0, tree.UnconditionalWrites);
        Assert.Equal(0, tree.ConditionalWrites);
        Assert.Null(tree.WrittenViews);
    }

    [Fact]
    public async Task A_change_between_the_read_and_atomic_write_is_refused_without_a_legacy_retry()
    {
        var item = Container(ViewDefinitionsJson.Write([View("All work")], "list"));
        var tree = new RecordingTree(item) { ConditionalWriteSucceeds = false };

        var result = await WriteHandler(tree).HandleAsync(
            new SetContainerViews(ContainerId, [View("Renamed")], "list", ExpectedVersion: ViewConfigurationVersion.FromStored(item.Views)),
            Cancellation);

        Assert.True(result.IsFailure);
        AssertFailureCode(result.Error, "views.version_conflict");
        Assert.Equal(1, tree.ConditionalWrites);
        Assert.Equal(0, tree.UnconditionalWrites);
        Assert.Equal(item.Views, tree.ExpectedViews);
        Assert.Null(tree.WrittenViews);
    }

    [Fact]
    public async Task Storage_without_atomic_view_updates_fails_closed_for_conditional_requests()
    {
        var item = Container(ViewDefinitionsJson.Write([View("All work")], "list"));
        var handler = new SetContainerViewsHandler(
            new Query.StubTree(item, Workspace), new Permissions(true), new Session(), TimeProvider.System, new Schemas());

        var result = await handler.HandleAsync(
            new SetContainerViews(ContainerId, [View("Renamed")], "list", ExpectedVersion: ViewConfigurationVersion.FromStored(item.Views)),
            Cancellation);

        Assert.True(result.IsFailure);
        AssertFailureCode(result.Error, "views.version_conflict");
    }

    [Fact]
    public async Task A_matching_version_uses_the_atomic_write_with_the_original_workspace_and_json()
    {
        var companion = View("Companion") with { Id = "companion" };
        var item = Container(ViewDefinitionsJson.Write([companion, View("All work")], "companion", true));
        var tree = new RecordingTree(item);
        var updated = ImmutableArray.Create(companion, View("Renamed"));

        var result = await WriteHandler(tree).HandleAsync(
            new SetContainerViews(ContainerId, updated, "companion", ExpectedVersion: ViewConfigurationVersion.FromStored(item.Views)),
            Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(updated, result.Value);
        Assert.Equal(1, tree.ConditionalWrites);
        Assert.Equal(0, tree.UnconditionalWrites);
        Assert.Equal(ContainerId, tree.WrittenItemId);
        Assert.Equal(Workspace, tree.WrittenWorkspace);
        Assert.Equal(item.Views, tree.ExpectedViews);
        Assert.Equal(Principal, tree.WrittenActor);
        var saved = ViewDefinitionsJson.Read(tree.WrittenViews);
        Assert.Equal(["companion", "list"], saved.Views.Select(view => view.Id));
        Assert.Equal("Renamed", saved.Views[1].Name);
        Assert.Equal("companion", saved.Default);
        Assert.True(saved.HideDocument);
    }

    [Fact]
    public async Task Conditional_creation_of_the_first_view_compares_the_null_stored_configuration()
    {
        var tree = new RecordingTree(Container(null));

        var result = await WriteHandler(tree).HandleAsync(
            new SetContainerViews(ContainerId, [View("First view")], "list", ExpectedVersion: ViewConfigurationVersion.FromStored(null)),
            Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(1, tree.ConditionalWrites);
        Assert.Null(tree.ExpectedViews);
        Assert.NotNull(tree.WrittenViews);
        Assert.Equal(0, tree.UnconditionalWrites);
    }

    [Fact]
    public async Task Legacy_writes_without_an_expected_version_keep_the_existing_path_and_hidden_document_flag()
    {
        var item = Container(ViewDefinitionsJson.Write([View("All work")], "list", true));
        var tree = new RecordingTree(item) { ConditionalWriteSucceeds = false };

        var result = await WriteHandler(tree).HandleAsync(
            new SetContainerViews(ContainerId, [View("Renamed")], "list"),
            Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(1, tree.UnconditionalWrites);
        Assert.Equal(0, tree.ConditionalWrites);
        Assert.Equal("Renamed", ViewDefinitionsJson.Read(tree.WrittenViews).Views.Single().Name);
        Assert.True(ViewDefinitionsJson.Read(tree.WrittenViews).HideDocument);
    }

    private static void AssertFailureCode(NixError error, string code)
    {
        Assert.Equal(code, error.Code);
    }

    private static RecordingTree InaccessibleTree(string access) => new(
        access == "missing"
            ? null
            : Container(ViewDefinitionsJson.Write([View("All work")], "list"), access == "foreign" ? ForeignTenant : Tenant))
    {
        Visible = access != "hidden",
    };

    private static SetContainerViewsHandler WriteHandler(RecordingTree tree, bool writable = true) => new(
        tree, new Permissions(writable), new Session(), TimeProvider.System, new Schemas());

    private static ViewDefinition View(string name) => new("list", name, ViewKind.List, [], null, [], null, null, false);

    private static Item Container(string? views, TenantId? tenant = null) => new()
    {
        Id = ContainerId,
        TenantId = tenant ?? Tenant,
        WorkspaceId = Workspace,
        Type = "note",
        Seq = 1000,
        Views = views,
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

    private sealed class Schemas : ISchemaResolver
    {
        public int Reads { get; private set; }

        public ValueTask<PropertySchema> ResolveForItemAsync(ItemId itemId, CancellationToken cancellationToken)
        {
            Reads++;
            return ValueTask.FromResult(new PropertySchema { Properties = [], Inherit = true });
        }

        public ValueTask<PropertySchema> ResolveForChildrenAsync(ItemId? parentId, CancellationToken cancellationToken) =>
            throw new NotSupportedException();
    }

    private sealed class Permissions(bool allowed, bool? writable = null) : IPermissionResolver
    {
        public ValueTask<bool> CanReadWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(allowed);

        public ValueTask<bool> CanWriteWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(writable ?? allowed);

        public ValueTask<bool> CanCommentWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(false);


        public ValueTask<bool> CanManageWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(false);

        public ValueTask<IReadOnlyList<WorkspaceId>> ReadableWorkspacesAsync(CancellationToken cancellationToken) =>
            ValueTask.FromResult<IReadOnlyList<WorkspaceId>>(allowed ? [Workspace] : []);

        public ValueTask<bool> IsTenantAdministratorAsync(CancellationToken cancellationToken) => ValueTask.FromResult(false);
    }

    private sealed class RecordingTree(Item? item) : IItemTree
    {
        public bool Visible { get; init; } = true;
        public bool ConditionalWriteSucceeds { get; init; } = true;
        public int StoredReads { get; private set; }
        public int ConditionalWrites { get; private set; }
        public int UnconditionalWrites { get; private set; }
        public string? WrittenViews { get; private set; }
        public string? ExpectedViews { get; private set; }
        public ItemId? WrittenItemId { get; private set; }
        public WorkspaceId? WrittenWorkspace { get; private set; }
        public PrincipalId? WrittenActor { get; private set; }

        public ValueTask<Item?> FindAsync(ItemId id, CancellationToken cancellationToken) =>
            ValueTask.FromResult(Visible && item?.Id == id && item.TenantId == Tenant ? item : null);

        public ValueTask<Item?> FindStoredAsync(ItemId id, CancellationToken cancellationToken)
        {
            StoredReads++;
            return ValueTask.FromResult(item?.Id == id ? item : null);
        }

        public ValueTask<bool> TryUpdateViewsAsync(
            ItemId id, WorkspaceId workspaceId, string? expectedViews, string? views,
            PrincipalId actor, DateTimeOffset at, CancellationToken cancellationToken)
        {
            ConditionalWrites++;
            ExpectedViews = expectedViews;
            WrittenItemId = id;
            WrittenWorkspace = workspaceId;
            WrittenActor = actor;
            if (ConditionalWriteSucceeds)
            {
                WrittenViews = views;
            }

            return ValueTask.FromResult(ConditionalWriteSucceeds);
        }

        public ValueTask UpdateViewsAsync(ItemId id, string? views, PrincipalId actor, DateTimeOffset at, CancellationToken cancellationToken)
        {
            UnconditionalWrites++;
            WrittenViews = views;
            return ValueTask.CompletedTask;
        }

        public ValueTask<IReadOnlySet<ItemId>> WithChildrenAsync(WorkspaceId workspaceId, IReadOnlyList<ItemId> parents, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<IReadOnlyList<Item>> ListChildrenAsync(WorkspaceId workspaceId, ItemId? parentId, bool includeDeleted, long? afterSeq, int limit, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<bool> WorkspaceExistsAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<long> NextSiblingSequenceAsync(WorkspaceId workspaceId, ItemId? parentId, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<long> AllocateSiblingSequenceAsync(WorkspaceId workspaceId, ItemId? parentId, ItemId movingId, ItemId? afterId, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask InsertAsync(Item inserted, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask UpdatePropertiesAsync(ItemId id, string properties, PrincipalId actor, DateTimeOffset at, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask UpdateSchemaAsync(ItemId id, string? schema, PrincipalId actor, DateTimeOffset at, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask TouchAsync(ItemId id, PrincipalId actor, DateTimeOffset at, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<bool> WouldCreateCycleAsync(ItemId id, ItemId parentId, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask ReparentAsync(ItemId id, ItemId? newParentId, long seq, PrincipalId actor, DateTimeOffset at, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask SetLifecycleAsync(ItemId id, ItemLifecycleState state, PrincipalId actor, DateTimeOffset at, CancellationToken cancellationToken) => throw new NotSupportedException();
    }
}
