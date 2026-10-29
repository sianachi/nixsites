using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Domain.Files;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Features.Items;

namespace Nix.Tests.Features.Items;

/// <summary>
/// <see cref="RenameItemHandler"/>: the title write every item gets, and the extra carry onto a
/// file body's stored file name that only a file item needs.
/// </summary>
/// <remarks>
/// Row-level security and the database round trip are the integration suite's job. What is worth
/// pinning here, free of any database, is which items trigger the file-store carry and which do
/// not - a note's rename must never reach into file storage at all.
/// </remarks>
public sealed class RenameItemTests
{
    private static readonly TenantId Tenant = TenantId.From(new Guid("11111111-1111-4111-8111-111111111111"));
    private static readonly WorkspaceId Workspace = WorkspaceId.From(new Guid("22222222-2222-4222-8222-222222222222"));
    private static readonly PrincipalId Principal = PrincipalId.From(new Guid("33333333-3333-4333-8333-333333333333"));
    private static readonly ItemId TheItem = ItemId.From(new Guid("44444444-4444-4444-8444-444444444444"));

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Renaming_a_file_item_also_carries_the_title_onto_the_file_store()
    {
        var item = MakeItem("file", """{"title":"old.pdf"}""");
        var tree = new RecordingTree(item);
        var files = new RecordingFileStore();
        var handler = Handler(tree, files);

        var result = await handler.HandleAsync(new RenameItem(TheItem, "new.pdf"), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(1, files.RenameCalls);
        Assert.Equal(TheItem, files.LastItemId);
        Assert.Equal("new.pdf", files.LastTitle);
    }

    [Fact]
    public async Task Renaming_a_note_never_touches_the_file_store()
    {
        var item = MakeItem("note", """{"title":"Old notes"}""");
        var tree = new RecordingTree(item);
        var files = new RecordingFileStore();
        var handler = Handler(tree, files);

        var result = await handler.HandleAsync(new RenameItem(TheItem, "New notes"), Cancellation);

        Assert.True(result.IsSuccess);
        Assert.Equal(0, files.RenameCalls);
    }

    private static RenameItemHandler Handler(RecordingTree tree, RecordingFileStore files) => new(
        tree,
        files,
        new WritablePermissions(),
        new Session(),
        TimeProvider.System);

    private static Item MakeItem(string type, string properties) => new()
    {
        Id = TheItem,
        TenantId = Tenant,
        WorkspaceId = Workspace,
        Type = type,
        Seq = 1000,
        Properties = properties,
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

        public ValueTask InsertAsync(Item inserted, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask UpdatePropertiesAsync(
            ItemId id,
            string properties,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken)
        {
            item = item is null ? null : new Item
            {
                Id = item.Id,
                TenantId = item.TenantId,
                WorkspaceId = item.WorkspaceId,
                Type = item.Type,
                ParentId = item.ParentId,
                Seq = item.Seq,
                Properties = properties,
                Schema = item.Schema,
                Views = item.Views,
                LifecycleState = item.LifecycleState,
                CreatedBy = item.CreatedBy,
                LastModifiedBy = actor,
                CreatedAt = item.CreatedAt,
                LastModifiedAt = at,
            };
            return ValueTask.CompletedTask;
        }

        public ValueTask UpdateSchemaAsync(
            ItemId id,
            string? schema,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask UpdateViewsAsync(
            ItemId id,
            string? views,
            PrincipalId actor,
            DateTimeOffset at,
            CancellationToken cancellationToken) => throw new NotSupportedException();

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

    private sealed class RecordingFileStore : IFileStore
    {
        public int RenameCalls { get; private set; }

        public ItemId? LastItemId { get; private set; }

        public string? LastTitle { get; private set; }

        public ValueTask<FileUploadRecord?> BeginAsync(BeginFileUpload request, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask<FileUploadRecord?> QueueInspectionAsync(FileUploadId id, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask<FileUploadInspectionRecord?> GetInspectionAsync(FileUploadId id, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask<FileRecord?> CompleteAsync(CompleteFileUpload request, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask<bool> RejectAsync(FileUploadId id, string failureCode, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask<FileUploadRecord?> GetUploadAsync(FileUploadId id, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask<bool> CancelAsync(FileUploadId id, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask<IReadOnlyList<FileVersionSourceRecord>?> AuthorizeVersionHistoryAsync(ItemId itemId, CancellationToken cancellationToken) =>
            ValueTask.FromResult<IReadOnlyList<FileVersionSourceRecord>?>(null);

        public ValueTask<FileRecord?> GetAsync(ItemId itemId, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask<FileDownloadRecord?> AuthorizeDownloadAsync(
            ItemId itemId,
            FileVersionId? versionId,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask<FileThumbnailDownloadRecord?> AuthorizeThumbnailAsync(ItemId itemId, FileVersionId? versionId, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask RenameCurrentVersionAsync(ItemId itemId, string title, CancellationToken cancellationToken)
        {
            RenameCalls++;
            LastItemId = itemId;
            LastTitle = title;
            return ValueTask.CompletedTask;
        }
    }
}
