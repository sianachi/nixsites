using Microsoft.EntityFrameworkCore;
using Nix.Domain.Files;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Properties;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Integration.Tests.Harness;
using Nix.Persistence;
using Nix.Persistence.ObjectStorage;
using Nix.Persistence.Templates;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class TemplateFileLifecycleMatrixTests : IAsyncLifetime
{
    private static readonly Guid RootSource = new("81111111-1111-4111-8111-111111111111");
    private static readonly Guid FirstFileSource = new("82222222-2222-4222-8222-222222222222");
    private static readonly Guid SecondFileSource = new("83333333-3333-4333-8333-333333333333");
    private readonly NixPostgresFixture _fixture;

    public TemplateFileLifecycleMatrixTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Additive_merge_preserves_a_mapped_file_and_stages_only_the_new_file_target()
    {
        var seed = await SeedFileTemplateAsync();
        var now = DateTimeOffset.UtcNow;
        var targetRoot = NewItem("Merge target", null, 10_000, now, "canvas");
        var mappedFile = NewItem("Existing attachment", targetRoot.Id, 10_001, now, "file");
        var existingVersion = AddReadyVersion(mappedFile, now, "existing.txt", 3, 'e');
        var priorApplicationId = TemplateApplicationId.Create();
        TemplateApplicationId applicationId;
        ItemId newFileId;
        FileVersionId newVersionId;
        Guid transferId;

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            work.DbContext.Items.AddRange(targetRoot, mappedFile);
            work.DbContext.FileVersions.Add(existingVersion);
            work.DbContext.FileBodies.Add(new FileBody
            {
                TenantId = mappedFile.TenantId,
                WorkspaceId = mappedFile.WorkspaceId,
                ItemId = mappedFile.Id,
                CurrentVersionId = existingVersion.Id,
            });
            work.DbContext.TemplateApplications.Add(new TemplateApplication
            {
                Id = priorApplicationId,
                TenantId = targetRoot.TenantId,
                WorkspaceId = targetRoot.WorkspaceId,
                TemplateId = seed.TemplateId,
                TargetItemId = targetRoot.Id,
                TemplateRevision = 1,
                Mode = TemplateApplicationMode.Merge,
                IdempotencyKey = "file-matrix-prior-merge",
                ActorId = TestTenants.AlphaContext.PrincipalId,
                State = TemplateOperationState.Active,
                CreatedAt = now,
                ExpiresAt = now,
                FinalizedAt = now,
            });
            work.DbContext.TemplateApplicationItems.AddRange(
                Mapping(priorApplicationId, seed.Root, targetRoot.Id, "canvas", true, false),
                Mapping(priorApplicationId, seed.FirstFile, mappedFile.Id, "file", false, true));
            await work.DbContext.SaveChangesAsync(Cancellation);
            await AddClosureAsync(work.DbContext, targetRoot, mappedFile);

            var begun = await work.Resolve<TemplateStore>().BeginApplicationAsync(
                seed.TemplateId,
                TemplateApplicationMode.Merge,
                targetRoot.Id,
                null,
                null,
                "file-matrix-additive-merge",
                Cancellation);

            Assert.True(begun.IsSuccess, begun.IsFailure ? begun.Error.ToString() : null);
            var existingMapping = begun.Value.ItemMappings.Single(mapping => mapping.SourceId == seed.FirstFile.Id.Value);
            var createdMapping = begun.Value.ItemMappings.Single(mapping => mapping.SourceId == seed.SecondFile.Id.Value);
            Assert.Equal(mappedFile.Id, existingMapping.ItemId);
            Assert.DoesNotContain(begun.Value.CreatedItems, item => item.ItemId == mappedFile.Id);
            Assert.Contains(begun.Value.CreatedItems, item => item.ItemId == createdMapping.ItemId);

            var transfers = await work.DbContext.TemplateFileTransfers.AsNoTracking()
                .Where(transfer => transfer.ApplicationId == begun.Value.ApplicationId)
                .ToListAsync(Cancellation);
            var transfer = Assert.Single(transfers);
            Assert.Equal(seed.SecondFile.Id, transfer.SourceItemId);
            Assert.Equal(createdMapping.ItemId, transfer.TargetItemId);
            Assert.NotEqual(mappedFile.Id, transfer.TargetItemId);
            applicationId = begun.Value.ApplicationId;
            newFileId = createdMapping.ItemId;
            newVersionId = transfer.TargetVersionId;
            transferId = transfer.Id;
            await work.CommitAsync(Cancellation);
        }

        const string executionId = "file-matrix-merge-copy-execution";
        var copy = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (copy.ConfigureAwait(false))
        {
            var store = copy.Resolve<TemplateStore>();
            var authorized = await store.AuthorizeCopyAsync(
                "application", applicationId.Value, executionId, null, 100, Cancellation);
            Assert.NotNull(authorized);
            var authorizedTransfer = Assert.Single(authorized!.Transfers);
            Assert.Equal(transferId, authorizedTransfer.TransferId);
            var stagedVersion = await copy.DbContext.FileVersions.AsNoTracking()
                .SingleAsync(version => version.Id == newVersionId, Cancellation);
            Assert.Equal(stagedVersion.ObjectKey, authorizedTransfer.TargetObjectKey);
            Assert.Equal(stagedVersion.Version, authorizedTransfer.TargetVersion);

            Assert.True(await store.CompleteCopyAsync(
                "application", applicationId.Value, executionId, [transferId], Cancellation));
            var finalized = await store.FinalizeApplicationAsync(applicationId, [], Cancellation);
            Assert.True(finalized.IsSuccess, finalized.IsFailure ? finalized.Error.ToString() : null);
            await copy.CommitAsync(Cancellation);
        }

        var fresh = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (fresh.ConfigureAwait(false))
        {
            var preservedVersion = await fresh.DbContext.FileVersions.AsNoTracking()
                .SingleAsync(version => version.ItemId == mappedFile.Id, Cancellation);
            var preservedBody = await fresh.DbContext.FileBodies.AsNoTracking()
                .SingleAsync(body => body.ItemId == mappedFile.Id, Cancellation);
            var copiedVersion = await fresh.DbContext.FileVersions.AsNoTracking()
                .SingleAsync(version => version.Id == newVersionId, Cancellation);
            var copiedBody = await fresh.DbContext.FileBodies.AsNoTracking()
                .SingleAsync(body => body.ItemId == newFileId, Cancellation);
            var transfer = await fresh.DbContext.TemplateFileTransfers.AsNoTracking()
                .SingleAsync(value => value.Id == transferId, Cancellation);
            var sourceVersion = await fresh.DbContext.FileVersions.AsNoTracking()
                .SingleAsync(version => version.ItemId == seed.SecondFile.Id, Cancellation);
            var application = await fresh.DbContext.TemplateApplications.AsNoTracking()
                .SingleAsync(value => value.Id == applicationId, Cancellation);

            Assert.Equal(existingVersion.Id, preservedVersion.Id);
            Assert.Equal(existingVersion.ObjectKey, preservedVersion.ObjectKey);
            Assert.Equal(existingVersion.ByteLength, preservedVersion.ByteLength);
            Assert.Equal(existingVersion.Sha256, preservedVersion.Sha256);
            Assert.True(preservedVersion.ObjectReady);
            Assert.Equal(existingVersion.Id, preservedBody.CurrentVersionId);
            Assert.Equal(newFileId, copiedVersion.ItemId);
            Assert.NotEqual(existingVersion.ObjectKey, copiedVersion.ObjectKey);
            Assert.Equal(sourceVersion.ObjectKey, transfer.SourceObjectKey);
            Assert.NotEqual(sourceVersion.ObjectKey, copiedVersion.ObjectKey);
            Assert.True(copiedVersion.ObjectReady);
            Assert.Equal(newVersionId, copiedBody.CurrentVersionId);
            Assert.Equal(TemplateOperationState.Active, application.State);
        }
    }

    private async Task<SeededTemplate> SeedFileTemplateAsync()
    {
        var now = DateTimeOffset.UtcNow;
        var templateId = TemplateId.Create();
        var root = NewTemplateItem(templateId, RootSource, "Template root", null, 20_000, now, "canvas");
        var firstFile = NewTemplateItem(templateId, FirstFileSource, "First file", root.Id, 20_001, now, "file");
        var secondFile = NewTemplateItem(templateId, SecondFileSource, "Second file", root.Id, 20_002, now, "file");
        var template = new WorkspaceTemplate
        {
            Id = templateId,
            TenantId = root.TenantId,
            WorkspaceId = root.WorkspaceId,
            RootItemId = root.Id,
            StableKey = "file.lifecycle.matrix",
            ProfileKey = "file.lifecycle.matrix",
            Origin = TemplateOrigin.User,
            Title = "File lifecycle matrix",
            IncludeBody = true,
            IncludeChildren = true,
            State = TemplateState.Active,
            Revision = 1,
            CreatedBy = TestTenants.AlphaContext.PrincipalId,
            LastModifiedBy = TestTenants.AlphaContext.PrincipalId,
            CreatedAt = now,
            LastModifiedAt = now,
        };
        var firstVersion = AddReadyVersion(firstFile, now, "first.txt", 5, '1');
        var secondVersion = AddReadyVersion(secondFile, now, "second.txt", 7, '2');

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            work.DbContext.WorkspaceTemplates.Add(template);
            work.DbContext.Items.AddRange(root, firstFile, secondFile);
            work.DbContext.FileVersions.AddRange(firstVersion, secondVersion);
            work.DbContext.FileBodies.AddRange(
                new FileBody
                {
                    TenantId = firstFile.TenantId,
                    WorkspaceId = firstFile.WorkspaceId,
                    ItemId = firstFile.Id,
                    CurrentVersionId = firstVersion.Id,
                },
                new FileBody
                {
                    TenantId = secondFile.TenantId,
                    WorkspaceId = secondFile.WorkspaceId,
                    ItemId = secondFile.Id,
                    CurrentVersionId = secondVersion.Id,
                });
            await work.DbContext.SaveChangesAsync(Cancellation);
            await work.DbContext.Database.ExecuteSqlInterpolatedAsync(
                $"INSERT INTO item_closure (tenant_id, workspace_id, ancestor_id, descendant_id, depth) VALUES ({root.TenantId.Value}, {root.WorkspaceId.Value}, {root.Id.Value}, {root.Id.Value}, 0), ({root.TenantId.Value}, {root.WorkspaceId.Value}, {firstFile.Id.Value}, {firstFile.Id.Value}, 0), ({root.TenantId.Value}, {root.WorkspaceId.Value}, {secondFile.Id.Value}, {secondFile.Id.Value}, 0), ({root.TenantId.Value}, {root.WorkspaceId.Value}, {root.Id.Value}, {firstFile.Id.Value}, 1), ({root.TenantId.Value}, {root.WorkspaceId.Value}, {root.Id.Value}, {secondFile.Id.Value}, 1)",
                Cancellation);
            await work.CommitAsync(Cancellation);
        }

        return new SeededTemplate(templateId, root, firstFile, secondFile);
    }

    private static async Task AddClosureAsync(NixDbContext db, Item root, Item child) =>
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"INSERT INTO item_closure (tenant_id, workspace_id, ancestor_id, descendant_id, depth) VALUES ({root.TenantId.Value}, {root.WorkspaceId.Value}, {root.Id.Value}, {root.Id.Value}, 0), ({child.TenantId.Value}, {child.WorkspaceId.Value}, {child.Id.Value}, {child.Id.Value}, 0), ({root.TenantId.Value}, {root.WorkspaceId.Value}, {root.Id.Value}, {child.Id.Value}, 1)",
            Cancellation);

    private async Task<int> WorkspaceItemCountAsync()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            return await work.DbContext.Items.IgnoreQueryFilters()
                .CountAsync(item => item.WorkspaceId == WorkspaceId.From(TestTenants.AlphaWorkspace), Cancellation);
        }
    }

    private static TemplateApplicationItem Mapping(
        TemplateApplicationId applicationId,
        Item source,
        Item target,
        bool isRoot,
        bool created) => Mapping(applicationId, source, target.Id, source.Type, isRoot, created);

    private static TemplateApplicationItem Mapping(
        TemplateApplicationId applicationId,
        Item source,
        ItemId targetId,
        string itemType,
        bool isRoot,
        bool created) => new()
        {
            ApplicationId = applicationId,
            TenantId = TestTenants.AlphaContext.TenantId,
            TemplateSourceId = source.TemplateSourceId!.Value,
            SourceItemId = source.Id,
            ItemType = itemType,
            TargetItemId = targetId,
            IsRoot = isRoot,
            Created = created,
            BodyRequired = false,
        };

    private static FileVersion AddReadyVersion(Item item, DateTimeOffset now, string name, long length, char digestByte)
    {
        var versionId = FileVersionId.Create();
        return new FileVersion
        {
            Id = versionId,
            TenantId = item.TenantId,
            WorkspaceId = item.WorkspaceId,
            ItemId = item.Id,
            Version = 1,
            ObjectKey = ObjectStorageKeys.FileVersion(item.TenantId, versionId),
            FileName = name,
            MediaType = "text/plain",
            ByteLength = length,
            Sha256 = new string(digestByte, 64),
            ObjectReady = true,
            Previewable = false,
            CreatedBy = TestTenants.AlphaContext.PrincipalId,
            CreatedAt = now,
        };
    }

    private static Item NewTemplateItem(
        TemplateId templateId,
        Guid sourceId,
        string title,
        ItemId? parentId,
        long seq,
        DateTimeOffset now,
        string type) => new()
        {
            Id = ItemId.Create(),
            TenantId = TestTenants.AlphaContext.TenantId,
            WorkspaceId = WorkspaceId.From(TestTenants.AlphaWorkspace),
            Type = type,
            ParentId = parentId,
            Seq = seq,
            Properties = ItemProperties.WithTitle(null, title),
            TemplateId = templateId,
            TemplateSourceId = sourceId,
            LifecycleState = ItemLifecycleState.Active,
            CreatedBy = TestTenants.AlphaContext.PrincipalId,
            LastModifiedBy = TestTenants.AlphaContext.PrincipalId,
            CreatedAt = now,
            LastModifiedAt = now,
        };

    private static Item NewItem(string title, ItemId? parentId, long seq, DateTimeOffset now, string type) => new()
    {
        Id = ItemId.Create(),
        TenantId = TestTenants.AlphaContext.TenantId,
        WorkspaceId = WorkspaceId.From(TestTenants.AlphaWorkspace),
        Type = type,
        ParentId = parentId,
        Seq = seq,
        Properties = ItemProperties.WithTitle(null, title),
        LifecycleState = ItemLifecycleState.Active,
        CreatedBy = TestTenants.AlphaContext.PrincipalId,
        LastModifiedBy = TestTenants.AlphaContext.PrincipalId,
        CreatedAt = now,
        LastModifiedAt = now,
    };

    private sealed record SeededTemplate(TemplateId TemplateId, Item Root, Item FirstFile, Item SecondFile);
}
