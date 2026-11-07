using System.Data;
using System.Data.Common;
using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Nix.Domain.Authorization;
using Nix.Domain.Content;
using Nix.Domain.Files;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Recurrence;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Integration.Tests.Harness;
using Nix.Persistence;
using Nix.Persistence.ObjectStorage;
using Nix.Persistence.Templates;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresCollectionDefinition.Name)]
public sealed class TemplateStoreIntegrationTests : IAsyncLifetime
{
    private static readonly Guid RootSource = new("71111111-1111-4111-8111-111111111111");
    private static readonly Guid ChildSource = new("72222222-2222-4222-8222-222222222222");
    private static readonly Guid ManagedServicePrincipal = new("73333333-3333-4333-8333-333333333333");
    private static readonly Guid ViewerPrincipal = new("74444444-4444-4444-8444-444444444444");
    private readonly NixPostgresFixture _fixture;
    private readonly ITestOutputHelper _output;

    public TemplateStoreIntegrationTests(NixPostgresFixture fixture, ITestOutputHelper output)
    {
        _fixture = fixture;
        _output = output;
    }

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Approved_capture_rejects_changed_metadata_and_replays_pinned_snapshot()
    {
        var sourceId = await AddOrdinaryItemAsync("Approved source");
        string fingerprint;
        var preview = await _fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext, IsolationLevel.RepeatableRead, Cancellation);
        await using (preview.ConfigureAwait(false))
        {
            var result = await preview.Resolve<TemplateStore>().PreviewCaptureAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace), sourceId, true, Cancellation);
            Assert.True(result.IsSuccess);
            fingerprint = result.Value.Fingerprint;
            Assert.Equal(1, result.Value.ItemCount);
        }

        var edit = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (edit.ConfigureAwait(false))
        {
            await edit.DbContext.Items.Where(item => item.Id == sourceId)
                .ExecuteUpdateAsync(update => update.SetProperty(
                    item => item.Properties, ItemProperties.WithTitle(null, "Changed source")), Cancellation);
            await edit.CommitAsync(Cancellation);
        }

        var stale = await _fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext, IsolationLevel.RepeatableRead, Cancellation);
        await using (stale.ConfigureAwait(false))
        {
            var result = await stale.Resolve<TemplateStore>().BeginCaptureAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace), sourceId, "Approved template", null,
                true, true, "approved-capture", Cancellation, fingerprint);
            Assert.True(result.IsFailure);
            Assert.Equal("templates.conflict", result.Error.Code);
        }

        var fresh = await _fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext, IsolationLevel.RepeatableRead, Cancellation);
        await using (fresh.ConfigureAwait(false))
        {
            var store = fresh.Resolve<TemplateStore>();
            var current = await store.PreviewCaptureAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace), sourceId, true, Cancellation);
            Assert.True(current.IsSuccess);
            Assert.NotEqual(fingerprint, current.Value.Fingerprint);
            var begun = await store.BeginCaptureAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace), sourceId, "Approved template", null,
                true, true, "approved-capture", Cancellation, current.Value.Fingerprint);
            Assert.True(begun.IsSuccess, begun.IsFailure ? begun.Error.ToString() : null);
            await fresh.CommitAsync(Cancellation);
            fingerprint = current.Value.Fingerprint;
        }

        var replay = await _fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext, IsolationLevel.RepeatableRead, Cancellation);
        await using (replay.ConfigureAwait(false))
        {
            var result = await replay.Resolve<TemplateStore>().BeginCaptureAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace), sourceId, "Approved template", null,
                true, true, "approved-capture", Cancellation, fingerprint);
            Assert.True(result.IsSuccess, result.IsFailure ? result.Error.ToString() : null);
        }
    }

    [Fact]
    public async Task Capture_preview_fingerprint_changes_when_body_is_added()
    {
        var sourceId = await AddOrdinaryItemAsync("Body source");
        var before = await _fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext, IsolationLevel.RepeatableRead, Cancellation);
        string fingerprint;
        await using (before.ConfigureAwait(false))
        {
            var snapshot = await before.Resolve<TemplateStore>().PreviewCaptureAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace), sourceId, true, Cancellation);
            Assert.True(snapshot.IsSuccess);
            Assert.Null(snapshot.Value.BodyHeads[sourceId]);
            fingerprint = snapshot.Value.Fingerprint;
        }
        var documentId = await AddBodyAsync(sourceId);
        var after = await _fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext, IsolationLevel.RepeatableRead, Cancellation);
        await using (after.ConfigureAwait(false))
        {
            var snapshot = await after.Resolve<TemplateStore>().PreviewCaptureAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace), sourceId, true, Cancellation);
            Assert.True(snapshot.IsSuccess);
            Assert.Equal(1, snapshot.Value.BodyHeads[sourceId]);
            Assert.Equal(documentId.Value, snapshot.Value.BodyDocIds[sourceId]);
            Assert.NotEqual(fingerprint, snapshot.Value.Fingerprint);
        }
    }

    [Fact]
    public async Task Capture_preview_fingerprint_changes_when_file_version_changes()
    {
        var sourceId = await AddOrdinaryItemAsync("File source");
        var firstVersion = FileVersionId.Create();
        var secondVersion = FileVersionId.Create();
        var setup = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (setup.ConfigureAwait(false))
        {
            setup.DbContext.FileBodies.Add(new FileBody
            {
                TenantId = TestTenants.AlphaContext.TenantId,
                WorkspaceId = WorkspaceId.From(TestTenants.AlphaWorkspace),
                ItemId = sourceId,
                CurrentVersionId = firstVersion,
            });
            foreach (var versionId in new[] { firstVersion, secondVersion })
            {
                setup.DbContext.FileVersions.Add(new FileVersion
                {
                    Id = versionId,
                    TenantId = TestTenants.AlphaContext.TenantId,
                    WorkspaceId = WorkspaceId.From(TestTenants.AlphaWorkspace),
                    ItemId = sourceId,
                    Version = versionId == firstVersion ? 1 : 2,
                    ObjectKey = ObjectStorageKeys.FileVersion(TestTenants.AlphaContext.TenantId, versionId),
                    FileName = "file.txt",
                    MediaType = "text/plain",
                    ByteLength = 0,
                    Sha256 = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData([])),
                    ObjectReady = true,
                    Previewable = false,
                    CreatedBy = TestTenants.AlphaContext.PrincipalId,
                    CreatedAt = DateTimeOffset.UtcNow,
                });
            }
            await setup.DbContext.SaveChangesAsync(Cancellation);
            await setup.CommitAsync(Cancellation);
        }
        var before = await _fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext, IsolationLevel.RepeatableRead, Cancellation);
        string fingerprint;
        await using (before.ConfigureAwait(false))
        {
            var result = await before.Resolve<TemplateStore>().PreviewCaptureAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace), sourceId, true, Cancellation);
            Assert.True(result.IsSuccess);
            fingerprint = result.Value.Fingerprint;
        }
        var edit = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (edit.ConfigureAwait(false))
        {
            await edit.DbContext.FileBodies.Where(body => body.ItemId == sourceId)
                .ExecuteUpdateAsync(update => update.SetProperty(body => body.CurrentVersionId, secondVersion), Cancellation);
            await edit.CommitAsync(Cancellation);
        }
        var after = await _fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext, IsolationLevel.RepeatableRead, Cancellation);
        await using (after.ConfigureAwait(false))
        {
            var result = await after.Resolve<TemplateStore>().PreviewCaptureAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace), sourceId, true, Cancellation);
            Assert.True(result.IsSuccess);
            Assert.NotEqual(fingerprint, result.Value.Fingerprint);
        }
    }

    [Fact]
    public async Task Capture_preview_does_not_disclose_another_tenants_source()
    {
        var sourceId = await AddOrdinaryItemAsync("Private source");
        var otherTenant = await _fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.BetaContext, IsolationLevel.RepeatableRead, Cancellation);
        await using (otherTenant.ConfigureAwait(false))
        {
            var result = await otherTenant.Resolve<TemplateStore>().PreviewCaptureAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace), sourceId, true, Cancellation);
            Assert.True(result.IsFailure);
            Assert.Equal("templates.not_found", result.Error.Code);
        }
    }

    [Fact]
    public async Task Approved_capture_rejects_new_descendant()
    {
        var sourceId = await AddOrdinaryItemAsync("Tree source");
        var preview = await _fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext, IsolationLevel.RepeatableRead, Cancellation);
        string fingerprint;
        await using (preview.ConfigureAwait(false))
        {
            var result = await preview.Resolve<TemplateStore>().PreviewCaptureAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace), sourceId, true, Cancellation);
            Assert.True(result.IsSuccess);
            fingerprint = result.Value.Fingerprint;
        }
        var edit = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (edit.ConfigureAwait(false))
        {
            var child = NewItem("New child", null, sourceId, 1, DateTimeOffset.UtcNow);
            edit.DbContext.Items.Add(child);
            await edit.DbContext.SaveChangesAsync(Cancellation);
            await edit.DbContext.Database.ExecuteSqlInterpolatedAsync(
                $"INSERT INTO item_closure (tenant_id, workspace_id, ancestor_id, descendant_id, depth) VALUES ({child.TenantId.Value}, {child.WorkspaceId.Value}, {child.Id.Value}, {child.Id.Value}, 0), ({child.TenantId.Value}, {child.WorkspaceId.Value}, {sourceId.Value}, {child.Id.Value}, 1)",
                Cancellation);
            await edit.CommitAsync(Cancellation);
        }
        var stale = await _fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext, IsolationLevel.RepeatableRead, Cancellation);
        await using (stale.ConfigureAwait(false))
        {
            var result = await stale.Resolve<TemplateStore>().BeginCaptureAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace), sourceId, "Tree template", null,
                true, true, "changed-tree", Cancellation, fingerprint);
            Assert.True(result.IsFailure);
            Assert.Equal("templates.conflict", result.Error.Code);
        }
    }

    [Fact]
    public async Task Capture_preview_projects_sample_subtrees_without_approving_sample_changes()
    {
        var rootId = await AddOrdinaryItemAsync("Job hunt");
        var setup = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        ItemId sampleId;
        ItemId sampleChildId;
        await using (setup.ConfigureAwait(false))
        {
            var now = DateTimeOffset.UtcNow;
            var sample = NewItem("Sample: application", null, rootId, 1, now);
            var sampleChild = NewItem("Note", null, sample.Id, 1, now);
            var ordinary = NewItem("Applications", null, rootId, 2, now);
            setup.DbContext.Items.AddRange(sample, sampleChild, ordinary);
            await setup.DbContext.SaveChangesAsync(Cancellation);
            await setup.DbContext.Database.ExecuteSqlInterpolatedAsync(
                $"INSERT INTO item_closure (tenant_id, workspace_id, ancestor_id, descendant_id, depth) VALUES ({sample.TenantId.Value}, {sample.WorkspaceId.Value}, {sample.Id.Value}, {sample.Id.Value}, 0), ({sample.TenantId.Value}, {sample.WorkspaceId.Value}, {rootId.Value}, {sample.Id.Value}, 1), ({sampleChild.TenantId.Value}, {sampleChild.WorkspaceId.Value}, {sampleChild.Id.Value}, {sampleChild.Id.Value}, 0), ({sampleChild.TenantId.Value}, {sampleChild.WorkspaceId.Value}, {sample.Id.Value}, {sampleChild.Id.Value}, 1), ({sampleChild.TenantId.Value}, {sampleChild.WorkspaceId.Value}, {rootId.Value}, {sampleChild.Id.Value}, 2), ({ordinary.TenantId.Value}, {ordinary.WorkspaceId.Value}, {ordinary.Id.Value}, {ordinary.Id.Value}, 0), ({ordinary.TenantId.Value}, {ordinary.WorkspaceId.Value}, {rootId.Value}, {ordinary.Id.Value}, 1)",
                Cancellation);
            await setup.CommitAsync(Cancellation);
            sampleId = sample.Id;
            sampleChildId = sampleChild.Id;
        }

        string approvedFull;
        string approvedCapture;
        var preview = await _fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext, IsolationLevel.RepeatableRead, Cancellation);
        await using (preview.ConfigureAwait(false))
        {
            var store = preview.Resolve<TemplateStore>();
            var projected = await store.PreviewCaptureAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace), rootId, true, Cancellation, true);
            var included = await store.PreviewCaptureAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace), rootId, true, Cancellation);
            Assert.True(projected.IsSuccess);
            Assert.True(included.IsSuccess);
            Assert.Equal(2, projected.Value.ItemCount);
            Assert.Equal(4, included.Value.ItemCount);
            Assert.Equal(included.Value.Fingerprint, projected.Value.Fingerprint);
            Assert.Equal(included.Value.Fingerprint, included.Value.CaptureFingerprint);
            Assert.NotEqual(projected.Value.Fingerprint, projected.Value.CaptureFingerprint);
            approvedFull = projected.Value.Fingerprint;
            approvedCapture = projected.Value.CaptureFingerprint;
        }

        var editSample = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (editSample.ConfigureAwait(false))
        {
            await editSample.DbContext.Items.Where(item => item.Id == sampleChildId)
                .ExecuteUpdateAsync(update => update.SetProperty(
                    item => item.Properties, ItemProperties.WithTitle(null, "Changed sample note")), Cancellation);
            await editSample.CommitAsync(Cancellation);
        }
        var stale = await _fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext, IsolationLevel.RepeatableRead, Cancellation);
        await using (stale.ConfigureAwait(false))
        {
            var changed = await stale.Resolve<TemplateStore>().PreviewCaptureAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace), rootId, true, Cancellation, true);
            Assert.True(changed.IsSuccess);
            Assert.NotEqual(approvedFull, changed.Value.Fingerprint);
            Assert.Equal(approvedCapture, changed.Value.CaptureFingerprint);
        }

        await SetLifecycleAsync(sampleId, ItemLifecycleState.Deleted);
        await SetLifecycleAsync(sampleChildId, ItemLifecycleState.Deleted);
        var capture = await _fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext, IsolationLevel.RepeatableRead, Cancellation);
        await using (capture.ConfigureAwait(false))
        {
            var store = capture.Resolve<TemplateStore>();
            var current = await store.PreviewCaptureAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace), rootId, true, Cancellation);
            Assert.True(current.IsSuccess);
            Assert.Equal(approvedCapture, current.Value.Fingerprint);
            Assert.NotEqual(approvedFull, current.Value.Fingerprint);
            var begun = await store.BeginCaptureAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace), rootId, "Job hunt template", null,
                true, true, "sample-exclusion", Cancellation, approvedCapture);
            Assert.True(begun.IsSuccess, begun.IsFailure ? begun.Error.ToString() : null);
        }
    }

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task User_import_preserves_root_and_selected_child_values()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<TemplateStore>();
            var begun = await store.BeginImportAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                "import-root-values",
                Descriptor(),
                Items(),
                Cancellation);

            Assert.True(begun.IsSuccess);
            var rootTarget = begun.Value.ItemMappings.Single(mapping => mapping.SourceId == RootSource).ItemId;
            var childTarget = begun.Value.ItemMappings.Single(mapping => mapping.SourceId == ChildSource).ItemId;
            var root = await work.DbContext.Items.IgnoreQueryFilters().SingleAsync(
                item => item.Id == rootTarget,
                Cancellation);
            var child = await work.DbContext.Items.IgnoreQueryFilters().SingleAsync(
                item => item.Id == childTarget,
                Cancellation);

            Assert.Equal("Template root", ItemProperties.ReadTitle(root.Properties));
            Assert.Contains("workspace-answer", root.Properties, StringComparison.Ordinal);
            Assert.Contains("selected-answer", child.Properties, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task Captured_file_is_copied_to_a_fresh_ready_object_version_before_publication()
    {
        var now = DateTimeOffset.UtcNow;
        var root = NewItem("File template", null, null, 91_000, now, "canvas");
        var sourceFile = NewItem("Attachment", null, root.Id, 1, now, "file");
        var versionId = FileVersionId.Create();
        var objectKey = ObjectStorageKeys.FileVersion(root.TenantId, versionId);
        var contentHash = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData("source bytes"u8));
        ItemId copiedFileId;
        FileVersionId copiedVersionId;
        TemplateId templateId;
        string copiedObjectKey;
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            work.DbContext.Items.AddRange(root, sourceFile);
            work.DbContext.FileVersions.Add(new FileVersion
            {
                Id = versionId,
                TenantId = root.TenantId,
                WorkspaceId = root.WorkspaceId,
                ItemId = sourceFile.Id,
                Version = 1,
                ObjectKey = objectKey,
                FileName = "brief.txt",
                MediaType = "text/plain",
                ByteLength = 12,
                Sha256 = contentHash,
                ObjectReady = true,
                Previewable = false,
                CreatedBy = TestTenants.AlphaContext.PrincipalId,
                CreatedAt = now,
            });
            work.DbContext.FileBodies.Add(new FileBody
            {
                TenantId = root.TenantId,
                WorkspaceId = root.WorkspaceId,
                ItemId = sourceFile.Id,
                CurrentVersionId = versionId,
            });
            await work.DbContext.SaveChangesAsync(Cancellation);
            await work.DbContext.Database.ExecuteSqlInterpolatedAsync(
                $"INSERT INTO item_closure (tenant_id, workspace_id, ancestor_id, descendant_id, depth) VALUES ({root.TenantId.Value}, {root.WorkspaceId.Value}, {root.Id.Value}, {root.Id.Value}, 0), ({sourceFile.TenantId.Value}, {sourceFile.WorkspaceId.Value}, {sourceFile.Id.Value}, {sourceFile.Id.Value}, 0), ({root.TenantId.Value}, {root.WorkspaceId.Value}, {root.Id.Value}, {sourceFile.Id.Value}, 1)",
                Cancellation);

            var store = work.Resolve<TemplateStore>();
            var begun = await store.BeginCaptureAsync(
                root.WorkspaceId,
                root.Id,
                "Independent file template",
                null,
                true,
                true,
                "capture-independent-file",
                Cancellation);
            Assert.True(begun.IsSuccess);
            var operationId = begun.Value.OperationId;
            var transferRows = await work.DbContext.TemplateFileTransfers.AsNoTracking()
                .Where(transfer => transfer.OperationId == operationId)
                .ToListAsync(Cancellation);
            var transfer = Assert.Single(transferRows);
            copiedFileId = transfer.TargetItemId;
            copiedVersionId = transfer.TargetVersionId;
            Assert.NotEqual(sourceFile.Id, transfer.TargetItemId);
            Assert.NotEqual(objectKey, (await work.DbContext.FileVersions.AsNoTracking()
                .SingleAsync(version => version.Id == transfer.TargetVersionId, Cancellation)).ObjectKey);
            Assert.True(await store.HasUnreadyCopiesAsync("operation", operationId.Value, Cancellation));
            var premature = await store.FinalizeOperationAsync(operationId, [], Cancellation);
            Assert.True(premature.IsFailure);

            var copyPlan = await store.AuthorizeCopyAsync("operation", operationId.Value, "lease-1", null, 100, Cancellation);
            Assert.NotNull(copyPlan);
            var authorizedCopy = Assert.Single(copyPlan.Transfers);
            Assert.Equal(contentHash, authorizedCopy.Sha256);
            Assert.Equal(12, authorizedCopy.ByteLength);
            Assert.True(await store.CompleteCopyAsync("operation", operationId.Value, "lease-1", [transfer.Id], Cancellation));
            Assert.False(await store.HasUnreadyCopiesAsync("operation", operationId.Value, Cancellation));

            var finalized = await store.FinalizeOperationAsync(operationId, [], Cancellation);
            Assert.True(finalized.IsSuccess);
            templateId = finalized.Value;
            var targetVersion = await work.DbContext.FileVersions.AsNoTracking()
                .SingleAsync(version => version.Id == transfer.TargetVersionId, Cancellation);
            copiedObjectKey = targetVersion.ObjectKey;
            var targetBody = await work.DbContext.FileBodies.AsNoTracking()
                .SingleAsync(body => body.ItemId == transfer.TargetItemId, Cancellation);
            Assert.True(targetVersion.ObjectReady);
            Assert.Equal(targetVersion.Id, targetBody.CurrentVersionId);
            await work.CommitAsync(Cancellation);
        }

        var deletion = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (deletion.ConfigureAwait(false))
        {
            var source = await deletion.DbContext.Items.SingleAsync(item => item.Id == sourceFile.Id, Cancellation);
            deletion.DbContext.Items.Remove(source);
            await deletion.DbContext.SaveChangesAsync(Cancellation);
            await deletion.CommitAsync(Cancellation);
        }

        var verification = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (verification.ConfigureAwait(false))
        {
            Assert.False(await verification.DbContext.Items.AnyAsync(item => item.Id == sourceFile.Id, Cancellation));
            var pageResult = await verification.Resolve<TemplateStore>().ExportFilesPageAsync(
                templateId, null, null, 1, Cancellation);
            Assert.True(pageResult.IsSuccess, pageResult.Error.Message);
            var exportPage = pageResult.Value;
            var exportedFile = Assert.Single(exportPage.Files);
            Assert.Equal(copiedVersionId.Value, exportedFile.FileVersionId);
            Assert.True(exportedFile.Current);
            Assert.True(exportPage.Complete);
            Assert.NotNull(await verification.Resolve<TemplateStore>().AuthorizeExportFileAsync(
                templateId, exportPage.Revision, exportedFile.FileVersionId, Cancellation));
            Assert.Null(await verification.Resolve<TemplateStore>().AuthorizeExportFileAsync(
                templateId, exportPage.Revision - 1, exportedFile.FileVersionId, Cancellation));
            var independent = await verification.DbContext.FileBodies.AsNoTracking()
                .SingleAsync(body => body.ItemId == copiedFileId, Cancellation);
            Assert.Equal(copiedVersionId, independent.CurrentVersionId);
            Assert.True(await verification.DbContext.FileVersions.AsNoTracking()
                .Where(version => version.Id == copiedVersionId)
                .Select(version => version.ObjectReady)
                .SingleAsync(Cancellation));
        }

        var deleteTemplate = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (deleteTemplate.ConfigureAwait(false))
        {
            Assert.True((await deleteTemplate.Resolve<TemplateStore>().DeleteAsync(templateId, Cancellation)).IsSuccess);
            await deleteTemplate.CommitAsync(Cancellation);
        }
        var cleanupCheck = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (cleanupCheck.ConfigureAwait(false))
        {
            var cleanup = await cleanupCheck.DbContext.WorkerJobs.AsNoTracking()
                .Where(job => job.Kind == "object.cleanup")
                .OrderByDescending(job => job.CreatedAt)
                .Select(job => job.Payload)
                .FirstAsync(Cancellation);
            Assert.Contains(copiedObjectKey, cleanup, StringComparison.Ordinal);
            Assert.DoesNotContain(objectKey, cleanup, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task Template_export_file_history_page_uses_a_bounded_runtime_query()
    {
        var explain = new TaggedExplainInterceptor("TemplateStore.ExportFilesPageAsync.file_versions_page");
        await using var application = NixPersistenceHost.Create(_fixture.ApplicationConnectionString, explain);
        var work = await application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var now = DateTimeOffset.UtcNow;
            var root = NewItem("Plan evidence", null, null, 92_000, now, "canvas");
            var file = NewItem("Evidence file", null, root.Id, 1, now, "file");
            var versionId = FileVersionId.Create();
            work.DbContext.Items.AddRange(root, file);
            work.DbContext.FileVersions.Add(new FileVersion
            {
                Id = versionId,
                TenantId = root.TenantId,
                WorkspaceId = root.WorkspaceId,
                ItemId = file.Id,
                Version = 1,
                ObjectKey = ObjectStorageKeys.FileVersion(root.TenantId, versionId),
                FileName = "evidence.bin",
                MediaType = "application/octet-stream",
                ByteLength = 1,
                Sha256 = new string('a', 64),
                ObjectReady = true,
                Previewable = false,
                CreatedBy = TestTenants.AlphaContext.PrincipalId,
                CreatedAt = now,
            });
            work.DbContext.FileBodies.Add(new FileBody
            {
                TenantId = root.TenantId,
                WorkspaceId = root.WorkspaceId,
                ItemId = file.Id,
                CurrentVersionId = versionId,
            });
            await work.DbContext.SaveChangesAsync(Cancellation);
            await work.DbContext.Database.ExecuteSqlInterpolatedAsync(
                $"INSERT INTO item_closure (tenant_id, workspace_id, ancestor_id, descendant_id, depth) VALUES ({root.TenantId.Value}, {root.WorkspaceId.Value}, {root.Id.Value}, {root.Id.Value}, 0), ({file.TenantId.Value}, {file.WorkspaceId.Value}, {file.Id.Value}, {file.Id.Value}, 0), ({root.TenantId.Value}, {root.WorkspaceId.Value}, {root.Id.Value}, {file.Id.Value}, 1)",
                Cancellation);
            var begun = await work.Resolve<TemplateStore>().BeginCaptureAsync(root.WorkspaceId, root.Id,
                "Page plan", null, false, true, "export-page-plan-evidence", Cancellation);
            Assert.True(begun.IsSuccess);
            var transfer = await work.DbContext.TemplateFileTransfers.AsNoTracking()
                .SingleAsync(value => value.OperationId == begun.Value.OperationId, Cancellation);
            var copyPlan = await work.Resolve<TemplateStore>().AuthorizeCopyAsync(
                "operation", begun.Value.OperationId.Value, "plan-evidence-lease", null, 100, Cancellation);
            Assert.NotNull(copyPlan);
            Assert.True(await work.Resolve<TemplateStore>().CompleteCopyAsync("operation",
                begun.Value.OperationId.Value, "plan-evidence-lease", [transfer.Id], Cancellation));
            var template = await work.Resolve<TemplateStore>().FinalizeOperationAsync(begun.Value.OperationId, [], Cancellation);
            Assert.True(template.IsSuccess);
            var page = await work.Resolve<TemplateStore>().ExportFilesPageAsync(template.Value, null, null, 1, Cancellation);
            Assert.True(page.IsSuccess, page.Error.Message);
            Assert.Single(page.Value.Files);
            Assert.NotNull(explain.Plan);
            _output.WriteLine("EXPLAIN (ANALYZE, BUFFERS), bounded template file history page:{0}{1}",
                Environment.NewLine, explain.Plan);
            Assert.Contains("Limit", explain.Plan, StringComparison.Ordinal);
            Assert.Contains("file_version", explain.Plan, StringComparison.Ordinal);
            Assert.Contains("rows=1", explain.Plan, StringComparison.OrdinalIgnoreCase);
            await work.CommitAsync(Cancellation);
        }
    }

    [Fact]
    public async Task Legacy_template_file_child_without_ready_version_cannot_start_a_draft()
    {
        var now = DateTimeOffset.UtcNow;
        var templateId = TemplateId.Create();
        var rootId = ItemId.Create();
        var fileId = ItemId.Create();
        var rootSourceId = Guid.NewGuid();
        var fileSourceId = Guid.NewGuid();
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            work.DbContext.WorkspaceTemplates.Add(new WorkspaceTemplate
            {
                Id = templateId,
                TenantId = TestTenants.AlphaContext.TenantId,
                WorkspaceId = WorkspaceId.From(TestTenants.AlphaWorkspace),
                RootItemId = rootId,
                StableKey = "legacy.file-template",
                ProfileKey = "legacy.file-template",
                Origin = TemplateOrigin.User,
                Title = "Legacy file template",
                IncludeBody = true,
                IncludeChildren = true,
                State = TemplateState.Active,
                Revision = 1,
                CreatedBy = TestTenants.AlphaContext.PrincipalId,
                LastModifiedBy = TestTenants.AlphaContext.PrincipalId,
                CreatedAt = now,
                LastModifiedAt = now,
            });
            work.DbContext.Items.AddRange(
                new Item
                {
                    Id = rootId,
                    TenantId = TestTenants.AlphaContext.TenantId,
                    WorkspaceId = WorkspaceId.From(TestTenants.AlphaWorkspace),
                    Type = "canvas",
                    Seq = 1,
                    Properties = ItemProperties.WithTitle(null, "Legacy canvas"),
                    TemplateId = templateId,
                    TemplateSourceId = rootSourceId,
                    LifecycleState = ItemLifecycleState.Active,
                    CreatedBy = TestTenants.AlphaContext.PrincipalId,
                    LastModifiedBy = TestTenants.AlphaContext.PrincipalId,
                    CreatedAt = now,
                    LastModifiedAt = now,
                },
                new Item
                {
                    Id = fileId,
                    TenantId = TestTenants.AlphaContext.TenantId,
                    WorkspaceId = WorkspaceId.From(TestTenants.AlphaWorkspace),
                    Type = "file",
                    ParentId = rootId,
                    Seq = 1,
                    Properties = ItemProperties.WithTitle(null, "Legacy attachment"),
                    TemplateId = templateId,
                    TemplateSourceId = fileSourceId,
                    LifecycleState = ItemLifecycleState.Active,
                    CreatedBy = TestTenants.AlphaContext.PrincipalId,
                    LastModifiedBy = TestTenants.AlphaContext.PrincipalId,
                    CreatedAt = now,
                    LastModifiedAt = now,
                });
            await work.DbContext.SaveChangesAsync(Cancellation);
            await work.DbContext.Database.ExecuteSqlInterpolatedAsync(
                $"INSERT INTO item_closure (tenant_id, workspace_id, ancestor_id, descendant_id, depth) VALUES ({TestTenants.AlphaContext.TenantId.Value}, {TestTenants.AlphaWorkspace}, {rootId.Value}, {rootId.Value}, 0), ({TestTenants.AlphaContext.TenantId.Value}, {TestTenants.AlphaWorkspace}, {fileId.Value}, {fileId.Value}, 0), ({TestTenants.AlphaContext.TenantId.Value}, {TestTenants.AlphaWorkspace}, {rootId.Value}, {fileId.Value}, 1)",
                Cancellation);

            var store = work.Resolve<TemplateStore>();
            var draft = await store.BeginDraftAsync(templateId, "legacy-file-draft", Cancellation);
            Assert.False(draft.IsSuccess);
            Assert.Equal("templates.conflict", draft.Error.Code);
        }
    }

    [Fact]
    public async Task Draft_file_child_is_copied_to_a_fresh_ready_version()
    {
        var now = DateTimeOffset.UtcNow;
        var templateId = TemplateId.Create();
        var rootId = ItemId.Create();
        var fileId = ItemId.Create();
        var sourceVersionId = FileVersionId.Create();
        var sourceKey = ObjectStorageKeys.FileVersion(TestTenants.AlphaContext.TenantId, sourceVersionId);
        var sha256 = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData("draft source"u8));
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            work.DbContext.WorkspaceTemplates.Add(new WorkspaceTemplate
            {
                Id = templateId,
                TenantId = TestTenants.AlphaContext.TenantId,
                WorkspaceId = WorkspaceId.From(TestTenants.AlphaWorkspace),
                RootItemId = rootId,
                StableKey = "ready.file-template",
                ProfileKey = "ready.file-template",
                Origin = TemplateOrigin.User,
                Title = "Ready file template",
                IncludeBody = true,
                IncludeChildren = true,
                State = TemplateState.Active,
                Revision = 1,
                CreatedBy = TestTenants.AlphaContext.PrincipalId,
                LastModifiedBy = TestTenants.AlphaContext.PrincipalId,
                CreatedAt = now,
                LastModifiedAt = now,
            });
            work.DbContext.Items.AddRange(
                new Item
                {
                    Id = rootId,
                    TenantId = TestTenants.AlphaContext.TenantId,
                    WorkspaceId = WorkspaceId.From(TestTenants.AlphaWorkspace),
                    Type = "canvas",
                    Seq = 1,
                    Properties = ItemProperties.WithTitle(null, "Ready canvas"),
                    TemplateId = templateId,
                    TemplateSourceId = Guid.NewGuid(),
                    LifecycleState = ItemLifecycleState.Active,
                    CreatedBy = TestTenants.AlphaContext.PrincipalId,
                    LastModifiedBy = TestTenants.AlphaContext.PrincipalId,
                    CreatedAt = now,
                    LastModifiedAt = now,
                },
                new Item
                {
                    Id = fileId,
                    TenantId = TestTenants.AlphaContext.TenantId,
                    WorkspaceId = WorkspaceId.From(TestTenants.AlphaWorkspace),
                    Type = "file",
                    ParentId = rootId,
                    Seq = 1,
                    Properties = ItemProperties.WithTitle(null, "Ready attachment"),
                    TemplateId = templateId,
                    TemplateSourceId = Guid.NewGuid(),
                    LifecycleState = ItemLifecycleState.Active,
                    CreatedBy = TestTenants.AlphaContext.PrincipalId,
                    LastModifiedBy = TestTenants.AlphaContext.PrincipalId,
                    CreatedAt = now,
                    LastModifiedAt = now,
                });
            work.DbContext.FileVersions.Add(new FileVersion
            {
                Id = sourceVersionId,
                TenantId = TestTenants.AlphaContext.TenantId,
                WorkspaceId = WorkspaceId.From(TestTenants.AlphaWorkspace),
                ItemId = fileId,
                Version = 1,
                ObjectKey = sourceKey,
                FileName = "draft.txt",
                MediaType = "text/plain",
                ByteLength = 12,
                Sha256 = sha256,
                ObjectReady = true,
                Previewable = false,
                CreatedBy = TestTenants.AlphaContext.PrincipalId,
                CreatedAt = now,
            });
            work.DbContext.FileBodies.Add(new FileBody
            {
                TenantId = TestTenants.AlphaContext.TenantId,
                WorkspaceId = WorkspaceId.From(TestTenants.AlphaWorkspace),
                ItemId = fileId,
                CurrentVersionId = sourceVersionId,
            });
            await work.DbContext.SaveChangesAsync(Cancellation);
            await work.DbContext.Database.ExecuteSqlInterpolatedAsync(
                $"INSERT INTO item_closure (tenant_id, workspace_id, ancestor_id, descendant_id, depth) VALUES ({TestTenants.AlphaContext.TenantId.Value}, {TestTenants.AlphaWorkspace}, {rootId.Value}, {rootId.Value}, 0), ({TestTenants.AlphaContext.TenantId.Value}, {TestTenants.AlphaWorkspace}, {fileId.Value}, {fileId.Value}, 0), ({TestTenants.AlphaContext.TenantId.Value}, {TestTenants.AlphaWorkspace}, {rootId.Value}, {fileId.Value}, 1)",
                Cancellation);

            var store = work.Resolve<TemplateStore>();
            var draft = await store.BeginDraftAsync(templateId, "ready-file-draft", Cancellation);
            Assert.True(draft.IsSuccess, draft.Error.Message);
            var transfer = await work.DbContext.TemplateFileTransfers.AsNoTracking()
                .SingleAsync(row => row.OperationId == draft.Value.OperationId, Cancellation);
            Assert.NotEqual(fileId, transfer.TargetItemId);
            Assert.NotEqual(sourceVersionId, transfer.TargetVersionId);
            Assert.True(await store.HasUnreadyCopiesAsync("operation", draft.Value.OperationId.Value, Cancellation));
            Assert.True((await store.AuthorizeCopyAsync("operation", draft.Value.OperationId.Value,
                "draft-copy-lease", null, 100, Cancellation)) is not null);
            Assert.True(await store.CompleteCopyAsync("operation", draft.Value.OperationId.Value,
                "draft-copy-lease", [transfer.Id], Cancellation));
            Assert.True((await store.SaveDraftAsync(templateId, draft.Value.OperationId, Cancellation)).IsSuccess);
            var targetVersion = await work.DbContext.FileVersions.AsNoTracking()
                .SingleAsync(version => version.Id == transfer.TargetVersionId, Cancellation);
            Assert.True(targetVersion.ObjectReady);
            Assert.Equal(1, await work.DbContext.FileVersions.AsNoTracking()
                .Where(version => version.Id == targetVersion.Id)
                .Select(version => version.Version)
                .SingleAsync(Cancellation));
            Assert.Equal(sha256, targetVersion.Sha256);
            await work.CommitAsync(Cancellation);
        }
    }

    [Fact]
    public async Task Import_and_draft_edit_accept_child_views_backed_by_an_inherited_template_field()
    {
        const string inheritedSchema = "{\"inherit\":false,\"properties\":[{\"key\":\"phase\",\"label\":\"Phase\",\"type\":\"select\",\"options\":[\"Ready\",\"Done\"],\"required\":false}]}";
        const string inheritedView = "{\"views\":[{\"id\":\"phase-board\",\"name\":\"Phase board\",\"kind\":\"board\",\"columns\":[\"title\",\"phase\"],\"groupBy\":\"phase\",\"sortDescending\":false}],\"default\":\"phase-board\"}";
        TemplateId templateId;
        var import = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (import.ConfigureAwait(false))
        {
            var items = Items();
            var begun = await import.Resolve<TemplateStore>().BeginImportAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                "inherited-child-view-import",
                Descriptor(),
                [
                    items[0] with { Schema = inheritedSchema, Views = null },
                    items[1] with { Schema = null, Views = inheritedView },
                ],
                Cancellation);
            Assert.True(begun.IsSuccess);
            var finalized = await import.Resolve<TemplateStore>().FinalizeOperationAsync(
                begun.Value.OperationId!.Value,
                [],
                Cancellation);
            Assert.True(finalized.IsSuccess);
            templateId = finalized.Value;
            await import.CommitAsync(Cancellation);
        }

        var edit = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (edit.ConfigureAwait(false))
        {
            var store = edit.Resolve<TemplateStore>();
            var draft = await store.BeginDraftAsync(templateId, "inherited-child-view-draft", Cancellation);
            Assert.True(draft.IsSuccess);
            var childSourceId = Assert.Single(draft.Value.Root.Children).SourceId;

            var updated = await store.UpdateDraftItemAsync(
                templateId,
                draft.Value.OperationId,
                childSourceId,
                null,
                null,
                null,
                inheritedView,
                Cancellation);

            Assert.True(updated.IsSuccess);
            Assert.True(JsonNode.DeepEquals(
                JsonNode.Parse(inheritedView),
                JsonNode.Parse(updated.Value.Views!)));
        }
    }

    [Fact]
    public async Task Applying_a_bodyless_tree_reports_every_created_envelope()
    {
        var templateId = await ImportAndFinalizeAsync("bodyless-tree");
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<TemplateStore>();
            var begun = await store.BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Create,
                null,
                null,
                "Created from template",
                "apply-bodyless-tree",
                Cancellation);

            Assert.True(begun.IsSuccess);
            Assert.Equal(2, begun.Value.CreatedItems.Count);
            Assert.Equal(2, begun.Value.ItemMappings.Count);
            Assert.Empty(begun.Value.BodyCopies);
        }
    }

    [Fact]
    public async Task Applying_a_template_attributes_its_due_date_and_reminder_to_the_applier()
    {
        // H1a: a set-by value inside a template (imported from a file, or captured from someone
        // else's item) must never route the applied item's reminders to the principal it names.
        var forged = TestTenants.BetaPrincipal.ToString();
        var root = Items()[0] with
        {
            Properties = $$"""{"title":"Template root","answer":"workspace-answer","due_date":"2026-12-01","$due_set_by":"{{forged}}","reminder":"2026-12-01T09:00:00+00:00[Etc/UTC]","$reminder_set_by":"{{forged}}"}""",
        };
        TemplateId templateId;
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<TemplateStore>();
            var begun = await store.BeginImportAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace), "forged-set-by-import", Descriptor(), [root, Items()[1]], Cancellation);
            Assert.True(begun.IsSuccess, begun.IsFailure ? begun.Error.ToString() : null);
            var finalized = await store.FinalizeOperationAsync(begun.Value.OperationId!.Value, [], Cancellation);
            Assert.True(finalized.IsSuccess, finalized.IsFailure ? finalized.Error.ToString() : null);
            templateId = finalized.Value;
            await work.CommitAsync(Cancellation);
        }

        var apply = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (apply.ConfigureAwait(false))
        {
            var template = await apply.DbContext.WorkspaceTemplates.AsNoTracking()
                .SingleAsync(candidate => candidate.Id == templateId, Cancellation);
            var templateRoot = await apply.DbContext.Items.IgnoreQueryFilters().AsNoTracking()
                .SingleAsync(item => item.Id == template.RootItemId, Cancellation);
            var templateBag = Assert.IsType<JsonObject>(JsonNode.Parse(templateRoot.Properties!));
            Assert.False(templateBag.ContainsKey(ItemProperties.DueSetByKey));
            Assert.False(templateBag.ContainsKey(ItemProperties.ReminderSetByKey));
            Assert.Equal("2026-12-01", (string?)templateBag["due_date"]);

            var begun = await apply.Resolve<TemplateStore>().BeginApplicationAsync(
                templateId, TemplateApplicationMode.Create, null, null, "Applied with a due date", "apply-forged-set-by", Cancellation);
            Assert.True(begun.IsSuccess, begun.IsFailure ? begun.Error.ToString() : null);
            var createdIds = begun.Value.CreatedItems.Select(mapping => mapping.ItemId).ToArray();
            var appliedRoot = await apply.DbContext.Items.IgnoreQueryFilters().AsNoTracking()
                .SingleAsync(item => createdIds.Contains(item.Id) && item.ParentId == null, Cancellation);
            var appliedBag = Assert.IsType<JsonObject>(JsonNode.Parse(appliedRoot.Properties!));
            Assert.Equal(TestTenants.AlphaPrincipal.ToString(), (string?)appliedBag[ItemProperties.DueSetByKey]);
            Assert.Equal(TestTenants.AlphaPrincipal.ToString(), (string?)appliedBag[ItemProperties.ReminderSetByKey]);
        }
    }

    [Fact]
    public async Task Import_persists_initialization_and_authored_root_properties_for_preflight()
    {
        var initialization = new TemplateInitialization(
            1,
            [
                new("project", "Project", TemplateInitializationInputType.Text, true),
                new("kickoff", "Kickoff", TemplateInitializationInputType.Date, true),
            ],
            [
                new(RootSource, "name", TemplateInitializationRuleKind.Input, InputKey: "project"),
                new(RootSource, "due_date", TemplateInitializationRuleKind.RelativeDate, InputKey: "kickoff", OffsetDays: 5),
            ],
            []);
        var descriptor = Descriptor() with { Initialization = initialization };
        var importedRoot = Items()[0] with
        {
            Title = "{{project}} plan",
            Properties = "{\"title\":\"{{project}} plan\",\"name\":\"starter\",\"due_date\":\"2025-01-01\"}",
            Schema = "{\"inherit\":false,\"properties\":[{\"key\":\"name\",\"label\":\"Name\",\"type\":\"text\",\"required\":false},{\"key\":\"due_date\",\"label\":\"Due date\",\"type\":\"due_date\",\"required\":false}]}",
            Recurrence = "{\"freq\":\"weekly\",\"interval\":2,\"weekdays\":[\"fr\"]}",
        };
        TemplateId templateId;
        var begin = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (begin.ConfigureAwait(false))
        {
            var staged = await begin.Resolve<TemplateStore>().BeginImportAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                "import-initialization-persistence",
                descriptor,
                [importedRoot],
                Cancellation);
            Assert.True(staged.IsSuccess, staged.IsFailure ? staged.Error.ToString() : null);
            templateId = staged.Value.TemplateId;
            var stagedOperation = await begin.DbContext.TemplateOperations.AsNoTracking()
                .SingleAsync(operation => operation.Id == staged.Value.OperationId, Cancellation);
            Assert.True(JsonNode.DeepEquals(
                JsonNode.Parse(TemplateInitializationJson.Write(initialization)),
                JsonNode.Parse(stagedOperation.DraftInitialization!)));
            var finalized = await begin.Resolve<TemplateStore>().FinalizeOperationAsync(
                staged.Value.OperationId!.Value, [], Cancellation);
            Assert.True(finalized.IsSuccess, finalized.IsFailure ? finalized.Error.ToString() : null);
            await begin.CommitAsync(Cancellation);
        }

        var verify = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (verify.ConfigureAwait(false))
        {
            var template = await verify.DbContext.WorkspaceTemplates.AsNoTracking()
                .SingleAsync(candidate => candidate.Id == templateId, Cancellation);
            Assert.True(JsonNode.DeepEquals(
                JsonNode.Parse(TemplateInitializationJson.Write(initialization)),
                JsonNode.Parse(template.Initialization!)));
            var root = await verify.DbContext.Items.IgnoreQueryFilters().AsNoTracking()
                .SingleAsync(item => item.Id == template.RootItemId, Cancellation);
            Assert.Equal(ItemLifecycleState.Active, root.LifecycleState);
            Assert.Equal("{{project}} plan", ItemProperties.ReadTitle(root.Properties));
            Assert.Equal("starter", JsonNode.Parse(root.Properties!)!["name"]!.GetValue<string>());
            Assert.Equal("weekly", Assert.IsType<System.Text.Json.Nodes.JsonObject>(
                JsonNode.Parse(root.Recurrence!))["freq"]!.GetValue<string>());

            var preflight = await verify.Resolve<TemplateStore>().PreflightAsync(
                templateId,
                TemplateApplicationMode.Create,
                null,
                null,
                null,
                new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["project"] = "Apollo",
                    ["kickoff"] = "2026-03-01",
                },
                null,
                Cancellation);
            Assert.True(preflight.IsSuccess, preflight.IsFailure ? preflight.Error.ToString() : null);
            var preview = Assert.Single(preflight.Value.InitializationPreview!);
            Assert.Equal("Apollo plan", preview.Title);
            var previewProperties = JsonNode.Parse(preview.Properties!)!;
            Assert.Equal("Apollo", previewProperties["name"]!.GetValue<string>());
            Assert.Equal("2026-03-06", previewProperties["due_date"]!.GetValue<string>());
            var recurrence = RecurrenceRuleJson.Read(preview.Recurrence);
            Assert.NotNull(recurrence);
            Assert.Equal("WEEKLY", recurrence.Frequency.ToString().ToUpperInvariant());
            Assert.Equal(2, recurrence.Interval);
        }
    }

    [Fact]
    public async Task Managed_revision_replacement_swaps_initialization_with_the_imported_tree()
    {
        await SeedTemplateActorsAsync();
        var serviceContext = TestTenants.ContextFor(
            TestTenants.Alpha,
            TestTenants.AlphaWorkspace,
            ManagedServicePrincipal);
        const string stableKey = "managed.initialization.revision";

        async Task<TemplateId> ImportRevisionAsync(int revision, string inputKey, char digestCharacter)
        {
            var initialization = new TemplateInitialization(
                1,
                [new(inputKey, "Project", TemplateInitializationInputType.Text, true)],
                [new(RootSource, "name", TemplateInitializationRuleKind.Input, InputKey: inputKey)],
                []);
            var authoredTitle = "{{" + inputKey + "}} v" + revision + " plan";
            var descriptor = Descriptor() with
            {
                StableKey = stableKey,
                Origin = TemplateOrigin.Managed,
                ManagedSource = "/templates/managed.initialization.revision.nix",
                Digest = new string(digestCharacter, 64),
                Initialization = initialization,
            };
            var root = Items()[0] with
            {
                Title = authoredTitle,
                Properties = "{\"title\":\"" + authoredTitle + "\",\"name\":\"starter\"}",
                Schema = "{\"inherit\":false,\"properties\":[{\"key\":\"name\",\"label\":\"Name\",\"type\":\"text\",\"required\":false}]}",
            };
            var work = await _fixture.Application.BeginUnitOfWorkAsync(serviceContext, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                var store = work.Resolve<TemplateStore>();
                var begun = await store.BeginImportAsync(
                    serviceContext.WorkspaceId!.Value,
                    $"managed-init-revision-{revision}",
                    descriptor,
                    [root],
                    Cancellation);
                Assert.True(begun.IsSuccess, begun.IsFailure ? begun.Error.ToString() : null);
                var finalized = await store.FinalizeManagedBatchAsync(
                    serviceContext.WorkspaceId.Value,
                    [new ManagedTemplateFinalization(
                        begun.Value.OperationId,
                        begun.Value.TemplateId,
                        stableKey,
                        descriptor.Digest,
                        [])],
                    [stableKey],
                    Cancellation);
                Assert.True(finalized.IsSuccess, finalized.IsFailure ? finalized.Error.ToString() : null);
                await work.CommitAsync(Cancellation);
                return begun.Value.TemplateId;
            }
        }

        var templateId = await ImportRevisionAsync(1, "project", 'a');
        var firstPreview = await _fixture.Application.BeginUnitOfWorkAsync(serviceContext, Cancellation);
        await using (firstPreview.ConfigureAwait(false))
        {
            var preflight = await firstPreview.Resolve<TemplateStore>().PreflightAsync(
                templateId,
                TemplateApplicationMode.Create,
                null,
                null,
                null,
                new Dictionary<string, string>(StringComparer.Ordinal) { ["project"] = "Apollo" },
                null,
                Cancellation);
            Assert.True(preflight.IsSuccess, preflight.IsFailure ? preflight.Error.ToString() : null);
            Assert.Equal("Apollo v1 plan", Assert.Single(preflight.Value.InitializationPreview!).Title);
        }

        Assert.Equal(templateId, await ImportRevisionAsync(2, "initiative", 'b'));
        var replacementPreview = await _fixture.Application.BeginUnitOfWorkAsync(serviceContext, Cancellation);
        await using (replacementPreview.ConfigureAwait(false))
        {
            var preflight = await replacementPreview.Resolve<TemplateStore>().PreflightAsync(
                templateId,
                TemplateApplicationMode.Create,
                null,
                null,
                null,
                new Dictionary<string, string>(StringComparer.Ordinal) { ["initiative"] = "Nix" },
                null,
                Cancellation);
            Assert.True(preflight.IsSuccess, preflight.IsFailure ? preflight.Error.ToString() : null);
            Assert.Equal("Nix v2 plan", Assert.Single(preflight.Value.InitializationPreview!).Title);
            var catalog = await replacementPreview.DbContext.WorkspaceTemplates.AsNoTracking()
                .SingleAsync(template => template.Id == templateId, Cancellation);
            Assert.Equal(2, catalog.Revision);
            Assert.Contains("initiative", catalog.Initialization!, StringComparison.Ordinal);
            Assert.DoesNotContain("project", catalog.Initialization!, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task Create_preflight_and_application_resolve_text_date_member_and_item_inputs_in_postgres()
    {
        var now = DateTimeOffset.UtcNow;
        var templateId = TemplateId.Create();
        var templateRootId = ItemId.Create();
        var ownerId = TestTenants.AlphaPrincipal;
        var initialization = new TemplateInitialization(
            1,
            [
                new("project", "Project", TemplateInitializationInputType.Text, true),
                new("kickoff", "Kickoff", TemplateInitializationInputType.Date, true),
                new("owner", "Owner", TemplateInitializationInputType.Member, true),
                new("related", "Related item", TemplateInitializationInputType.Item, true),
            ],
            [
                new(RootSource, "name", TemplateInitializationRuleKind.Input, InputKey: "project"),
                new(RootSource, "due_date", TemplateInitializationRuleKind.RelativeDate, InputKey: "kickoff", OffsetDays: 5),
                new(RootSource, "assignee", TemplateInitializationRuleKind.Input, InputKey: "owner"),
            ],
            []);
        var unavailableDefault = Guid.NewGuid();
        var changedInitialization = new TemplateInitialization(
            1,
            [new("owner", "Owner", TemplateInitializationInputType.Member, true, unavailableDefault.ToString("D"))],
            [],
            []);
        var changedInitializationJson = TemplateInitializationJson.Write(changedInitialization);
        var templateRoot = new Item
        {
            Id = templateRootId,
            TenantId = TestTenants.AlphaContext.TenantId,
            WorkspaceId = WorkspaceId.From(TestTenants.AlphaWorkspace),
            Type = "task",
            Seq = 90_200,
            Properties = "{\"title\":\"Plan: {{project}} for {{related}}\",\"name\":\"old\",\"due_date\":\"2025-01-01\",\"assignee\":\"" + ownerId.ToString("D") + "\"}",
            Schema = "{\"inherit\":false,\"properties\":["
                + "{\"key\":\"name\",\"label\":\"Name\",\"type\":\"text\",\"required\":true},"
                + "{\"key\":\"due_date\",\"label\":\"Due date\",\"type\":\"due_date\",\"required\":true},"
                + "{\"key\":\"assignee\",\"label\":\"Assignee\",\"type\":\"assignee\",\"required\":true}]}",
            Recurrence = "{\"freq\":\"weekly\",\"interval\":2,\"weekdays\":[\"fr\"],"
                + "\"until\":\"2026-05-20\",\"completedThrough\":\"2026-04-02\",\"completed\":[\"2026-04-10\"]}",
            TemplateId = templateId,
            TemplateSourceId = RootSource,
            LifecycleState = ItemLifecycleState.Active,
            CreatedBy = TestTenants.AlphaContext.PrincipalId,
            LastModifiedBy = TestTenants.AlphaContext.PrincipalId,
            CreatedAt = now,
            LastModifiedAt = now,
        };
        var template = new WorkspaceTemplate
        {
            Id = templateId,
            TenantId = TestTenants.AlphaContext.TenantId,
            WorkspaceId = WorkspaceId.From(TestTenants.AlphaWorkspace),
            RootItemId = templateRootId,
            StableKey = "init.integration",
            ProfileKey = "init.integration",
            Origin = TemplateOrigin.User,
            Title = "{{project}} for {{related}}",
            IncludeBody = true,
            IncludeChildren = true,
            Initialization = TemplateInitializationJson.Write(initialization),
            State = TemplateState.Active,
            Revision = 7,
            CreatedBy = TestTenants.AlphaContext.PrincipalId,
            LastModifiedBy = TestTenants.AlphaContext.PrincipalId,
            CreatedAt = now,
            LastModifiedAt = now,
        };
        var externalTarget = NewItem("Reference target", null, null, 90_201, now);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            work.DbContext.WorkspaceTemplates.Add(template);
            work.DbContext.Items.AddRange(templateRoot, externalTarget);
            await work.DbContext.SaveChangesAsync(Cancellation);
            await work.DbContext.Database.ExecuteSqlInterpolatedAsync(
                $"INSERT INTO item_closure (tenant_id, workspace_id, ancestor_id, descendant_id, depth) VALUES ({TestTenants.AlphaContext.TenantId.Value}, {TestTenants.AlphaWorkspace}, {templateRootId.Value}, {templateRootId.Value}, 0), ({TestTenants.AlphaContext.TenantId.Value}, {TestTenants.AlphaWorkspace}, {externalTarget.Id.Value}, {externalTarget.Id.Value}, 0)",
                Cancellation);

            var inputs = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["project"] = "Apollo",
                ["kickoff"] = "2026-04-10",
                ["owner"] = ownerId.ToString("D"),
                ["related"] = externalTarget.Id.Value.ToString("D"),
            };
            var store = work.Resolve<TemplateStore>();
            var preflight = await store.PreflightAsync(
                templateId,
                TemplateApplicationMode.Create,
                null,
                null,
                null,
                inputs,
                7,
                Cancellation);

            Assert.True(preflight.IsSuccess);
            Assert.True(preflight.Value.CanApply);
            Assert.Equal(3, preflight.Value.FieldAdditions);
            Assert.Equal(0, preflight.Value.ViewAdditions);
            Assert.Equal(7, preflight.Value.Resolution!.TemplateRevision);
            Assert.Equal("Apollo", preflight.Value.Resolution.TextBindings["project"]);
            Assert.Equal("alpha user", preflight.Value.Resolution.TextBindings["owner"]);
            Assert.Equal("Reference target", preflight.Value.Resolution.TextBindings["related"]);
            var preview = Assert.Single(preflight.Value.InitializationPreview!);
            Assert.Equal("Plan: Apollo for Reference target", preview.Title);
            var explicitTitlePreflight = await store.PreflightAsync(
                templateId, TemplateApplicationMode.Create, null, null, "Chosen title", inputs, 7, Cancellation);
            Assert.True(explicitTitlePreflight.IsSuccess);
            Assert.Equal("Chosen title", Assert.Single(explicitTitlePreflight.Value.InitializationPreview!).Title);
            var previewProperties = JsonNode.Parse(preview.Properties!)!.AsObject();
            Assert.Equal("Apollo", previewProperties["name"]!.GetValue<string>());
            Assert.Equal("2026-04-15", previewProperties["due_date"]!.GetValue<string>());
            Assert.Equal(ownerId.ToString("D"), previewProperties["assignee"]!.GetValue<string>());
            var previewRecurrence = RecurrenceRuleJson.Read(preview.Recurrence)!;
            Assert.Equal(2, previewRecurrence.Interval);
            Assert.Equal(new DateOnly(2026, 5, 20), previewRecurrence.Until);
            Assert.Null(previewRecurrence.CompletedThrough);
            Assert.Empty(previewRecurrence.Completed);

            var stalePreflight = await store.PreflightAsync(
                templateId,
                TemplateApplicationMode.Create,
                null,
                null,
                null,
                inputs,
                6,
                Cancellation);
            Assert.True(stalePreflight.IsFailure);
            Assert.Equal("templates.conflict", stalePreflight.Error.Code);
            var staleBegin = await store.BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Create,
                null,
                null,
                null,
                "init-create-postgres-stale-preview",
                inputs,
                6,
                Cancellation);
            Assert.True(staleBegin.IsFailure);
            Assert.Equal("templates.conflict", staleBegin.Error.Code);

            var begun = await store.BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Create,
                null,
                null,
                null,
                "init-create-postgres",
                inputs,
                7,
                Cancellation);
            Assert.True(begun.IsSuccess);
            Assert.Empty(begun.Value.BodyCopies);
            Assert.Equal(preflight.Value.Resolution.TextBindings, begun.Value.Resolution!.TextBindings);
            Assert.Equal(preflight.Value.InitializationPreview, begun.Value.InitializationPreview);
            var finalized = await store.FinalizeApplicationAsync(begun.Value.ApplicationId, [], Cancellation);
            Assert.True(finalized.IsSuccess, finalized.IsFailure ? finalized.Error.ToString() : null);
            Assert.Equal(begun.Value.TargetItemId, finalized.Value);

            var catalogEdit = await store.BeginDraftAsync(templateId, "init-catalog-edit", Cancellation);
            Assert.True(catalogEdit.IsSuccess);
            var updatedDraft = await store.UpdateDraftMetadataAsync(
                templateId,
                catalogEdit.Value.OperationId,
                null,
                null,
                changedInitialization,
                Cancellation);
            Assert.True(updatedDraft.IsSuccess);
            Assert.True((await store.SaveDraftAsync(
                templateId,
                catalogEdit.Value.OperationId,
                Cancellation)).IsSuccess);
            await work.CommitAsync(Cancellation);
        }

        ItemId createdTargetId;
        var replayWork = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (replayWork.ConfigureAwait(false))
        {
            var replay = await replayWork.Resolve<TemplateStore>().BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Create,
                null,
                null,
                null,
                "init-create-postgres",
                null,
                7,
                Cancellation);
            Assert.True(replay.IsSuccess);
            Assert.True(replay.Value.AlreadyApplied);
            Assert.Equal(7, replay.Value.Resolution!.TemplateRevision);
            Assert.Equal("alpha user", replay.Value.Resolution!.TextBindings["owner"]);
            Assert.Equal("Reference target", replay.Value.Resolution.TextBindings["related"]);
            var changedReplay = await replayWork.Resolve<TemplateStore>().BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Create,
                null,
                null,
                null,
                "init-create-postgres",
                new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["project"] = "Different project",
                },
                7,
                Cancellation);
            Assert.True(changedReplay.IsFailure);
            Assert.Equal("templates.conflict", changedReplay.Error.Code);
            createdTargetId = replay.Value.TargetItemId;
        }

        var noOpWork = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (noOpWork.ConfigureAwait(false))
        {
            var catalog = await noOpWork.DbContext.WorkspaceTemplates
                .AsNoTracking()
                .SingleAsync(candidate => candidate.Id == templateId, Cancellation);
            Assert.Equal(8, catalog.Revision);
            Assert.True(JsonNode.DeepEquals(
                JsonNode.Parse(changedInitializationJson),
                JsonNode.Parse(catalog.Initialization!)));
            var store = noOpWork.Resolve<TemplateStore>();
            var mergePreflight = await store.PreflightAsync(
                templateId,
                TemplateApplicationMode.Merge,
                createdTargetId,
                null,
                null,
                null,
                8,
                Cancellation);
            Assert.True(mergePreflight.IsSuccess, mergePreflight.IsFailure ? mergePreflight.Error.ToString() : null);
            Assert.True(mergePreflight.Value.CanApply);
            Assert.Empty(mergePreflight.Value.InitializationPreview!);
            Assert.Empty(mergePreflight.Value.Resolution!.Values);
            var noOpMerge = await store.BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Merge,
                createdTargetId,
                null,
                null,
                "no-op-merge-stale-member-default",
                null,
                8,
                Cancellation);
            Assert.True(noOpMerge.IsSuccess);
            Assert.True(noOpMerge.Value.AlreadyApplied);
        }
    }

    [Fact]
    public async Task Application_finalization_rechecks_initialized_item_access_without_rebinding()
    {
        var templateId = await ImportAndFinalizeAsync("init-finalize-access");
        var targetItemId = await AddOrdinaryItemAsync("Recheck target");
        var initialization = new TemplateInitialization(
            1,
            [new("target", "Target", TemplateInitializationInputType.Item, true)],
            [],
            []);
        TemplateApplicationId applicationId;
        ItemId applicationTargetId;

        var beginWork = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (beginWork.ConfigureAwait(false))
        {
            var store = beginWork.Resolve<TemplateStore>();
            var draft = await store.BeginDraftAsync(templateId, "init-finalize-access-edit", Cancellation);
            Assert.True(draft.IsSuccess);
            var updated = await store.UpdateDraftMetadataAsync(
                templateId,
                draft.Value.OperationId,
                null,
                null,
                initialization,
                Cancellation);
            Assert.True(updated.IsSuccess);
            Assert.True((await store.SaveDraftAsync(templateId, draft.Value.OperationId, Cancellation)).IsSuccess);

            var begun = await store.BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Create,
                null,
                null,
                "{{target}}",
                "init-finalize-access-application",
                new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["target"] = targetItemId.Value.ToString("D"),
                },
                null,
                Cancellation);
            Assert.True(begun.IsSuccess);
            Assert.Equal("Recheck target", begun.Value.Resolution!.TextBindings["target"]);
            applicationId = begun.Value.ApplicationId;
            applicationTargetId = begun.Value.TargetItemId;
            await beginWork.CommitAsync(Cancellation);
        }

        await SetLifecycleAsync(targetItemId, ItemLifecycleState.Deleted);
        var finalizeWork = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (finalizeWork.ConfigureAwait(false))
        {
            var finalized = await finalizeWork.Resolve<TemplateStore>().FinalizeApplicationAsync(
                applicationId,
                [],
                Cancellation);
            Assert.True(finalized.IsFailure);
            Assert.Equal("templates.conflict", finalized.Error.Code);
            Assert.Equal(ItemLifecycleState.Provisioning, (await finalizeWork.DbContext.Items.IgnoreQueryFilters()
                .SingleAsync(item => item.Id == applicationTargetId, Cancellation)).LifecycleState);
        }
    }

    [Fact]
    public async Task Application_finalization_rechecks_member_access_without_recomputing_saved_text()
    {
        var templateId = await ImportAndFinalizeAsync("init-finalize-member-access");
        var memberId = PrincipalId.Create();
        var now = DateTimeOffset.UtcNow;
        var memberName = "Sam Taylor";
        var initialization = new TemplateInitialization(
            1,
            [new("owner", "Owner", TemplateInitializationInputType.Member, true)],
            [],
            []);
        TemplateApplicationId applicationId;
        ItemId applicationTargetId;

        var beginWork = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (beginWork.ConfigureAwait(false))
        {
            beginWork.DbContext.Principals.Add(new Principal
            {
                Id = memberId,
                TenantId = TestTenants.AlphaContext.TenantId,
                ExternalSubject = $"template-member-{memberId.Value:D}",
                Kind = PrincipalKind.User,
                DisplayName = memberName,
                Status = PrincipalStatus.Active,
            });
            beginWork.DbContext.WorkspaceMembers.Add(new WorkspaceMember
            {
                WorkspaceId = WorkspaceId.From(TestTenants.AlphaWorkspace),
                SubjectType = SubjectType.Principal,
                SubjectId = memberId.Value,
                TenantId = TestTenants.AlphaContext.TenantId,
                Role = "editor",
                GrantedBy = TestTenants.AlphaContext.PrincipalId,
                GrantedAt = now,
            });
            await beginWork.DbContext.SaveChangesAsync(Cancellation);

            var store = beginWork.Resolve<TemplateStore>();
            var draft = await store.BeginDraftAsync(templateId, "init-finalize-member-access-edit", Cancellation);
            Assert.True(draft.IsSuccess);
            var updated = await store.UpdateDraftMetadataAsync(
                templateId,
                draft.Value.OperationId,
                null,
                null,
                initialization,
                Cancellation);
            Assert.True(updated.IsSuccess);
            Assert.True((await store.SaveDraftAsync(templateId, draft.Value.OperationId, Cancellation)).IsSuccess);

            var begun = await store.BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Create,
                null,
                null,
                "{{owner}}",
                "init-finalize-member-access-application",
                new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["owner"] = memberId.Value.ToString("D"),
                },
                null,
                Cancellation);
            Assert.True(begun.IsSuccess);
            Assert.Equal(memberName, begun.Value.Resolution!.TextBindings["owner"]);
            applicationId = begun.Value.ApplicationId;
            applicationTargetId = begun.Value.TargetItemId;
            await beginWork.CommitAsync(Cancellation);
        }

        var revokeWork = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (revokeWork.ConfigureAwait(false))
        {
            await revokeWork.DbContext.WorkspaceMembers
                .Where(member => member.WorkspaceId == WorkspaceId.From(TestTenants.AlphaWorkspace)
                    && member.SubjectType == SubjectType.Principal
                    && member.SubjectId == memberId.Value)
                .ExecuteDeleteAsync(Cancellation);
            await revokeWork.CommitAsync(Cancellation);
        }

        var finalizeWork = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (finalizeWork.ConfigureAwait(false))
        {
            var finalized = await finalizeWork.Resolve<TemplateStore>().FinalizeApplicationAsync(
                applicationId,
                [],
                Cancellation);
            Assert.True(finalized.IsFailure);
            Assert.Equal("templates.conflict", finalized.Error.Code);
            Assert.Equal(ItemLifecycleState.Provisioning, (await finalizeWork.DbContext.Items.IgnoreQueryFilters()
                .SingleAsync(item => item.Id == applicationTargetId, Cancellation)).LifecycleState);
        }
    }

    [Fact]
    public async Task Merge_into_an_existing_bodied_note_does_not_treat_its_body_as_staged()
    {
        var templateId = await ImportAndFinalizeAsync("merge-bodied-target");
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<TemplateStore>();
            var begun = await store.BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Merge,
                ItemId.From(M0SchemaSeed.Alpha.ItemId),
                null,
                null,
                "merge-bodied-target",
                Cancellation);
            Assert.True(begun.IsSuccess);

            var finalized = await store.FinalizeApplicationAsync(
                begun.Value.ApplicationId,
                [],
                Cancellation);

            Assert.True(finalized.IsSuccess);
            Assert.Equal(ItemId.From(M0SchemaSeed.Alpha.ItemId), finalized.Value);
        }
    }

    [Fact]
    public async Task A_merge_into_a_collection_with_a_unique_field_is_refused()
    {
        var templateId = await ImportAndFinalizeAsync("unique-merge");
        var targetId = await AddOrdinaryItemAsync("Unique merge target");
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var schema = """{"inherit":true,"properties":[{"key":"url","label":"Link","type":"url","required":false,"unique":true}]}""";
            await work.DbContext.Items.Where(item => item.Id == targetId)
                .ExecuteUpdateAsync(update => update.SetProperty(item => item.Schema, schema), Cancellation);
            var begun = await work.Resolve<TemplateStore>().BeginApplicationAsync(
                templateId, TemplateApplicationMode.Merge, targetId, null, null, "unique-merge-application", Cancellation);

            Assert.True(begun.IsFailure);
            Assert.Equal("templates.conflict", begun.Error.Code);
        }
    }

    [Fact]
    public async Task A_template_copy_of_a_unique_field_carries_no_flag_and_creates_no_record_keys()
    {
        const string uniqueSchema = """{"inherit":false,"properties":[{"key":"url","label":"Link","type":"url","required":false,"unique":true}]}""";
        var templateId = await ImportAndFinalizeAsync("unique-copy", rootSchema: uniqueSchema);
        ItemId copyId;
        var apply = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (apply.ConfigureAwait(false))
        {
            var store = apply.Resolve<TemplateStore>();
            var begun = await store.BeginApplicationAsync(
                templateId, TemplateApplicationMode.Create, null, null, null, "unique-copy-application", Cancellation);
            Assert.True(begun.IsSuccess, begun.IsFailure ? begun.Error.ToString() : null);
            copyId = begun.Value.TargetItemId;
            var finalized = await store.FinalizeApplicationAsync(begun.Value.ApplicationId, [], Cancellation);
            Assert.True(finalized.IsSuccess, finalized.IsFailure ? finalized.Error.ToString() : null);
            await apply.CommitAsync(Cancellation);
        }

        var verify = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (verify.ConfigureAwait(false))
        {
            var copy = await verify.DbContext.Items.AsNoTracking().SingleAsync(item => item.Id == copyId, Cancellation);
            Assert.Contains("\"url\"", copy.Schema, StringComparison.Ordinal);
            Assert.DoesNotContain("unique", copy.Schema, StringComparison.Ordinal);
            var keys = await verify.DbContext.Database.SqlQuery<int>(
                $"SELECT count(*)::int AS \"Value\" FROM record_key WHERE item_id = {copyId.Value}").SingleAsync(Cancellation);
            Assert.Equal(0, keys);
        }
    }

    [Theory]
    [InlineData(PropertyType.Formula, "[amount] * 3", null, null)]
    [InlineData(PropertyType.Rollup, null, RollupAggregate.Average, "amount")]
    [InlineData(PropertyType.Rollup, null, RollupAggregate.Sum, "budget")]
    public async Task Merge_refuses_different_computed_definitions_before_staging(
        PropertyType type, string? expression, RollupAggregate? aggregate, string? source)
    {
        var existingSchema = ComputedSchema(type);
        var incomingSchema = ComputedSchema(type, expression, aggregate, source);
        var templateId = await ImportAndFinalizeAsync("computed-merge", rootSchema: incomingSchema);
        var targetId = await AddOrdinaryItemAsync("Computed merge target");
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            await work.DbContext.Items.Where(item => item.Id == targetId)
                .ExecuteUpdateAsync(update => update.SetProperty(item => item.Schema, existingSchema), Cancellation);
            var store = work.Resolve<TemplateStore>();
            var preflight = await store.PreflightAsync(
                templateId, TemplateApplicationMode.Merge, targetId, null, Cancellation);

            Assert.True(preflight.IsSuccess);
            Assert.False(preflight.Value.CanApply);
            Assert.Equal("Property 'total' already exists with an incompatible definition.", Assert.Single(preflight.Value.Conflicts));
            var applicationsBefore = await work.DbContext.TemplateApplications.CountAsync(Cancellation);
            var begun = await store.BeginApplicationAsync(
                templateId, TemplateApplicationMode.Merge, targetId, null, null, "computed-merge-application", Cancellation);

            Assert.True(begun.IsFailure);
            Assert.Equal("templates.conflict", begun.Error.Code);
            Assert.Equal(applicationsBefore, await work.DbContext.TemplateApplications.CountAsync(Cancellation));
            Assert.False(await work.DbContext.Items.IgnoreQueryFilters().AnyAsync(
                item => item.LifecycleState == ItemLifecycleState.Provisioning, Cancellation));
            Assert.Equal(existingSchema, PropertySchemaJson.Write(PropertySchemaJson.Read(
                (await work.DbContext.Items.AsNoTracking().SingleAsync(item => item.Id == targetId, Cancellation)).Schema)));
        }
    }

    [Theory]
    [InlineData(PropertyType.Formula, "[amount] * 3", null, null)]
    [InlineData(PropertyType.Rollup, null, RollupAggregate.Average, "amount")]
    [InlineData(PropertyType.Rollup, null, RollupAggregate.Sum, "budget")]
    public async Task Merge_finalization_refuses_computed_definition_changes_after_staging(
        PropertyType type, string? expression, RollupAggregate? aggregate, string? source)
    {
        var originalSchema = ComputedSchema(type);
        var changedSchema = ComputedSchema(type, expression, aggregate, source);
        var templateId = await ImportAndFinalizeAsync("computed-merge-drift", rootSchema: originalSchema);
        var targetId = await AddOrdinaryItemAsync("Computed merge drift target");
        TemplateApplicationPlan staged;
        var begin = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (begin.ConfigureAwait(false))
        {
            await begin.DbContext.Items.Where(item => item.Id == targetId)
                .ExecuteUpdateAsync(update => update.SetProperty(item => item.Schema, originalSchema), Cancellation);
            var begun = await begin.Resolve<TemplateStore>().BeginApplicationAsync(
                templateId, TemplateApplicationMode.Merge, targetId, null, null, "computed-merge-drift-application", Cancellation);
            Assert.True(begun.IsSuccess, begun.IsFailure ? begun.Error.ToString() : null);
            staged = begun.Value;
            Assert.Single(staged.CreatedItems);
            await begin.CommitAsync(Cancellation);
        }

        var edit = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (edit.ConfigureAwait(false))
        {
            await edit.DbContext.Items.Where(item => item.Id == targetId)
                .ExecuteUpdateAsync(update => update.SetProperty(item => item.Schema, changedSchema), Cancellation);
            await edit.CommitAsync(Cancellation);
        }

        var finalize = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (finalize.ConfigureAwait(false))
        {
            var result = await finalize.Resolve<TemplateStore>().FinalizeApplicationAsync(
                staged.ApplicationId, [], Cancellation);

            Assert.True(result.IsFailure);
            Assert.Equal("templates.conflict", result.Error.Code);
            Assert.Equal(changedSchema, PropertySchemaJson.Write(PropertySchemaJson.Read(
                (await finalize.DbContext.Items.AsNoTracking().SingleAsync(item => item.Id == targetId, Cancellation)).Schema)));
            Assert.Equal(ItemLifecycleState.Provisioning,
                (await finalize.DbContext.Items.IgnoreQueryFilters().SingleAsync(
                    item => item.Id == staged.CreatedItems[0].ItemId, Cancellation)).LifecycleState);
        }
    }

    [Fact]
    public async Task Merge_preflight_rejects_schema_and_view_sets_that_only_overflow_when_combined()
    {
        var existingSchema = LargeSchema("existing-field", 'e');
        var incomingSchema = LargeSchema("incoming-field", 'i');
        var existingViews = LargeViews("existing-view", 'e');
        var incomingViews = LargeViews("incoming-view", 'i');
        TemplateId templateId;

        var imported = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (imported.ConfigureAwait(false))
        {
            var items = Items();
            var import = await imported.Resolve<TemplateStore>().BeginImportAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                "merge-byte-limit-import",
                Descriptor(),
                [items[0] with { Schema = incomingSchema, Views = incomingViews }, items[1]],
                Cancellation);
            Assert.True(import.IsSuccess);
            var finalized = await imported.Resolve<TemplateStore>().FinalizeOperationAsync(
                import.Value.OperationId!.Value,
                [],
                Cancellation);
            Assert.True(finalized.IsSuccess);
            templateId = finalized.Value;
            await imported.CommitAsync(Cancellation);
        }

        ItemId targetId;
        var targetWork = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (targetWork.ConfigureAwait(false))
        {
            var now = DateTimeOffset.UtcNow;
            var target = new Item
            {
                Id = ItemId.Create(),
                TenantId = TestTenants.AlphaContext.TenantId,
                WorkspaceId = WorkspaceId.From(TestTenants.AlphaWorkspace),
                Type = "note",
                Seq = 20,
                Properties = ItemProperties.WithTitle(null, "Large merge target"),
                Schema = existingSchema,
                Views = existingViews,
                LifecycleState = ItemLifecycleState.Active,
                CreatedBy = TestTenants.AlphaContext.PrincipalId,
                LastModifiedBy = TestTenants.AlphaContext.PrincipalId,
                CreatedAt = now,
                LastModifiedAt = now,
            };
            targetId = target.Id;
            targetWork.DbContext.Items.Add(target);
            await targetWork.DbContext.SaveChangesAsync(Cancellation);
            await targetWork.DbContext.Database.ExecuteSqlInterpolatedAsync(
                $"INSERT INTO item_closure (tenant_id, workspace_id, ancestor_id, descendant_id, depth) VALUES ({target.TenantId.Value}, {target.WorkspaceId.Value}, {target.Id.Value}, {target.Id.Value}, 0)",
                Cancellation);
            await targetWork.CommitAsync(Cancellation);
        }

        var checkedWork = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (checkedWork.ConfigureAwait(false))
        {
            var store = checkedWork.Resolve<TemplateStore>();
            var preflight = await store.PreflightAsync(
                templateId,
                TemplateApplicationMode.Merge,
                targetId,
                null,
                Cancellation);
            Assert.True(preflight.IsSuccess);
            Assert.False(preflight.Value.CanApply);
            Assert.Contains(preflight.Value.Conflicts, conflict => conflict.Contains(
                "merged property schema would exceed",
                StringComparison.OrdinalIgnoreCase));
            Assert.Contains(preflight.Value.Conflicts, conflict => conflict.Contains(
                "merged view set would exceed",
                StringComparison.OrdinalIgnoreCase));

            var applicationsBefore = await checkedWork.DbContext.TemplateApplications.CountAsync(Cancellation);
            var begun = await store.BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Merge,
                targetId,
                null,
                null,
                "merge-byte-limit-application",
                Cancellation);
            Assert.True(begun.IsFailure);
            Assert.Equal(applicationsBefore, await checkedWork.DbContext.TemplateApplications.CountAsync(Cancellation));
            Assert.False(await checkedWork.DbContext.Items.IgnoreQueryFilters().AnyAsync(
                item => item.LifecycleState == ItemLifecycleState.Provisioning,
                Cancellation));
        }
    }

    [Fact]
    public async Task Saving_a_draft_swaps_the_root_and_removes_the_previous_revision()
    {
        var templateId = await ImportAndFinalizeAsync("draft-swap");
        ItemId previousRoot;
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            previousRoot = (await work.DbContext.WorkspaceTemplates.SingleAsync(
                template => template.Id == templateId,
                Cancellation)).RootItemId!.Value;
            var store = work.Resolve<TemplateStore>();
            var draft = await store.BeginDraftAsync(templateId, "draft-swap", Cancellation);
            Assert.True(draft.IsSuccess);
            var metadata = await store.UpdateDraftMetadataAsync(
                templateId,
                draft.Value.OperationId,
                "Edited template",
                "Edited atomically",
                Cancellation);
            Assert.True(metadata.IsSuccess);

            var saved = await store.SaveDraftAsync(templateId, draft.Value.OperationId, Cancellation);
            Assert.True(saved.IsSuccess);

            Assert.False(await work.DbContext.Items.IgnoreQueryFilters().AnyAsync(
                item => item.Id == previousRoot,
                Cancellation));
            Assert.Equal(2, await work.DbContext.Items.IgnoreQueryFilters().CountAsync(
                item => item.TemplateId == templateId,
                Cancellation));
            Assert.Equal("Edited template", (await work.DbContext.WorkspaceTemplates.SingleAsync(
                template => template.Id == templateId,
                Cancellation)).Title);
        }
    }

    [Fact]
    public async Task Discarding_a_draft_removes_every_provisioning_envelope()
    {
        var templateId = await ImportAndFinalizeAsync("draft-discard");
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<TemplateStore>();
            var draft = await store.BeginDraftAsync(templateId, "draft-discard", Cancellation);
            Assert.True(draft.IsSuccess);

            var discarded = await store.AbortOperationAsync(draft.Value.OperationId, Cancellation);

            Assert.True(discarded.IsSuccess);
            Assert.False(await work.DbContext.Items.IgnoreQueryFilters().AnyAsync(
                item => item.TemplateId == templateId
                    && item.LifecycleState == ItemLifecycleState.Provisioning,
                Cancellation));
            Assert.Null((await work.DbContext.WorkspaceTemplates.SingleAsync(
                template => template.Id == templateId,
                Cancellation)).PendingRootItemId);
        }
    }

    [Fact]
    public async Task An_expired_edit_draft_is_swept_and_a_new_draft_can_begin()
    {
        var templateId = await ImportAndFinalizeAsync("draft-expiry");
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<TemplateStore>();
            var draft = await store.BeginDraftAsync(templateId, "draft-expiry-first", Cancellation);
            Assert.True(draft.IsSuccess);
            Assert.NotNull((await work.DbContext.WorkspaceTemplates.SingleAsync(
                template => template.Id == templateId,
                Cancellation)).PendingRootItemId);

            await work.DbContext.TemplateOperations
                .Where(operation => operation.Id == draft.Value.OperationId)
                .ExecuteUpdateAsync(
                    update => update.SetProperty(operation => operation.ExpiresAt, DateTimeOffset.UnixEpoch),
                    Cancellation);
            var swept = await store.SweepExpiredAsync(WorkspaceId.From(TestTenants.AlphaWorkspace), Cancellation);
            Assert.True(swept.IsSuccess);

            Assert.Null((await work.DbContext.WorkspaceTemplates.AsNoTracking().SingleAsync(
                template => template.Id == templateId,
                Cancellation)).PendingRootItemId);
            Assert.True((await store.BeginDraftAsync(templateId, "draft-expiry-second", Cancellation)).IsSuccess);
        }
    }

    [Fact]
    public async Task Template_history_does_not_block_purging_captured_or_applied_items()
    {
        var templateId = await ImportAndFinalizeAsync("purge-history");
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var now = DateTimeOffset.UtcNow;
            var source = new Item
            {
                Id = ItemId.Create(),
                TenantId = TestTenants.AlphaContext.TenantId,
                WorkspaceId = WorkspaceId.From(TestTenants.AlphaWorkspace),
                Type = "note",
                Seq = 10,
                Properties = ItemProperties.WithTitle(null, "Capture then purge"),
                LifecycleState = ItemLifecycleState.Active,
                CreatedBy = TestTenants.AlphaContext.PrincipalId,
                LastModifiedBy = TestTenants.AlphaContext.PrincipalId,
                CreatedAt = now,
                LastModifiedAt = now,
            };
            work.DbContext.Items.Add(source);
            await work.DbContext.SaveChangesAsync(Cancellation);
            await work.DbContext.Database.ExecuteSqlInterpolatedAsync(
                $"INSERT INTO item_closure (tenant_id, workspace_id, ancestor_id, descendant_id, depth) VALUES ({source.TenantId.Value}, {source.WorkspaceId.Value}, {source.Id.Value}, {source.Id.Value}, 0)",
                Cancellation);

            var store = work.Resolve<TemplateStore>();
            var capture = await store.BeginCaptureAsync(
                source.WorkspaceId,
                source.Id,
                "Captured",
                null,
                false,
                false,
                "capture-purge",
                Cancellation);
            Assert.True(capture.IsSuccess);
            Assert.True((await store.FinalizeOperationAsync(capture.Value.OperationId, [], Cancellation)).IsSuccess);

            await work.DbContext.ItemClosure.Where(edge => edge.DescendantId == source.Id)
                .ExecuteDeleteAsync(Cancellation);
            Assert.Equal(1, await work.DbContext.Items.Where(item => item.Id == source.Id)
                .ExecuteDeleteAsync(Cancellation));

            var applied = await store.BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Create,
                null,
                null,
                null,
                "apply-purge",
                Cancellation);
            Assert.True(applied.IsSuccess);
            Assert.True((await store.FinalizeApplicationAsync(applied.Value.ApplicationId, [], Cancellation)).IsSuccess);
            var child = applied.Value.CreatedItems[1].ItemId;
            await work.DbContext.ItemClosure.Where(edge => edge.DescendantId == child || edge.AncestorId == child)
                .ExecuteDeleteAsync(Cancellation);
            Assert.Equal(1, await work.DbContext.Items.Where(item => item.Id == child)
                .ExecuteDeleteAsync(Cancellation));
        }
    }

    [Fact]
    public async Task Each_tenant_sees_only_its_own_template_catalog()
    {
        await ImportAndFinalizeAsync("alpha-isolation", TestTenants.AlphaContext);
        await ImportAndFinalizeAsync("beta-isolation", TestTenants.BetaContext);

        var alpha = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (alpha.ConfigureAwait(false))
        {
            var library = await alpha.Resolve<TemplateStore>().ListAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                Cancellation);
            Assert.True(library.IsSuccess);
            Assert.Single(library.Value.Templates);
            Assert.Equal("Template", library.Value.Templates[0].Template.Title);
        }

        var beta = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation);
        await using (beta.ConfigureAwait(false))
        {
            var library = await beta.Resolve<TemplateStore>().ListAsync(
                WorkspaceId.From(TestTenants.BetaWorkspace),
                Cancellation);
            Assert.True(library.IsSuccess);
            Assert.Single(library.Value.Templates);
        }
    }

    [Fact]
    public async Task Only_the_designated_service_can_publish_managed_templates_and_viewers_get_read_capabilities()
    {
        await SeedTemplateActorsAsync();
        var descriptor = Descriptor() with
        {
            StableKey = "managed.team-template",
            Origin = TemplateOrigin.Managed,
            ManagedSource = "/etc/nix/templates/team-template.nix",
        };

        var human = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (human.ConfigureAwait(false))
        {
            var refused = await human.Resolve<TemplateStore>().BeginImportAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                "human-managed-import",
                descriptor,
                Items(),
                Cancellation);
            Assert.True(refused.IsFailure);
            Assert.DoesNotContain(
                await human.DbContext.WorkspaceTemplates.ToListAsync(Cancellation),
                template => template.StableKey == descriptor.StableKey);
        }

        var serviceContext = TestTenants.ContextFor(
            TestTenants.Alpha,
            TestTenants.AlphaWorkspace,
            ManagedServicePrincipal);
        TemplateImportPlan staged;
        var service = await _fixture.Application.BeginUnitOfWorkAsync(serviceContext, Cancellation);
        await using (service.ConfigureAwait(false))
        {
            var begun = await service.Resolve<TemplateStore>().BeginImportAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                "service-managed-import",
                descriptor,
                Items(),
                Cancellation);
            Assert.True(begun.IsSuccess);
            staged = begun.Value;
            var finalized = await service.Resolve<TemplateStore>().FinalizeManagedBatchAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                [new ManagedTemplateFinalization(
                    staged.OperationId,
                    staged.TemplateId,
                    descriptor.StableKey,
                    descriptor.Digest,
                    [])],
                [descriptor.StableKey],
                Cancellation);
            Assert.True(finalized.IsSuccess);
            Assert.Equal(1, finalized.Value.Activated);
            await service.CommitAsync(Cancellation);
        }

        var replay = await _fixture.Application.BeginUnitOfWorkAsync(serviceContext, Cancellation);
        await using (replay.ConfigureAwait(false))
        {
            var finalized = await replay.Resolve<TemplateStore>().FinalizeManagedBatchAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                [new ManagedTemplateFinalization(
                    staged.OperationId,
                    staged.TemplateId,
                    descriptor.StableKey,
                    descriptor.Digest,
                    [])],
                [descriptor.StableKey],
                Cancellation);

            Assert.True(finalized.IsSuccess, finalized.Error.Message);
            Assert.Equal(new ManagedTemplateBatchResult(0, 1, 0), finalized.Value);
        }

        var viewerContext = TestTenants.ContextFor(
            TestTenants.Alpha,
            TestTenants.AlphaWorkspace,
            ViewerPrincipal);
        var viewer = await _fixture.Application.BeginUnitOfWorkAsync(viewerContext, Cancellation);
        await using (viewer.ConfigureAwait(false))
        {
            var library = await viewer.Resolve<TemplateStore>().ListAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                Cancellation);
            Assert.True(library.IsSuccess);
            Assert.False(library.Value.CanManage);
            var template = Assert.Single(library.Value.Templates);
            Assert.False(template.CanManage);
            Assert.Equal(TemplateOrigin.Managed, template.Template.Origin);
        }
    }

    [Fact]
    public async Task Concurrent_cross_kind_reuse_of_an_idempotency_key_has_one_winner_and_one_conflict()
    {
        async Task<bool> ImportAsync()
        {
            var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                var result = await work.Resolve<TemplateStore>().BeginImportAsync(
                    WorkspaceId.From(TestTenants.AlphaWorkspace),
                    "concurrent-cross-kind-key",
                    Descriptor(),
                    Items(),
                    Cancellation);
                await work.CommitAsync(Cancellation);
                return result.IsSuccess;
            }
        }

        async Task<bool> CaptureAsync()
        {
            var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                var result = await work.Resolve<TemplateStore>().BeginCaptureAsync(
                    WorkspaceId.From(TestTenants.AlphaWorkspace),
                    ItemId.From(M0SchemaSeed.Alpha.ItemId),
                    "Concurrent capture",
                    null,
                    false,
                    false,
                    "concurrent-cross-kind-key",
                    Cancellation);
                await work.CommitAsync(Cancellation);
                return result.IsSuccess;
            }
        }

        var outcomes = await Task.WhenAll(ImportAsync(), CaptureAsync())
            .WaitAsync(TimeSpan.FromSeconds(10), Cancellation);
        Assert.Single(outcomes, static succeeded => succeeded);

        var verification = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (verification.ConfigureAwait(false))
        {
            Assert.Equal(1, await verification.DbContext.TemplateOperations.CountAsync(
                operation => operation.IdempotencyKey == "concurrent-cross-kind-key",
                Cancellation));
        }
    }

    [Fact]
    public async Task Concurrent_import_and_application_complete_without_lock_inversion()
    {
        var templateId = await ImportAndFinalizeAsync("mixed-lock-import-application-template");

        async Task<bool> ImportAsync()
        {
            var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                var result = await work.Resolve<TemplateStore>().BeginImportAsync(
                    WorkspaceId.From(TestTenants.AlphaWorkspace),
                    "mixed-lock-import-application",
                    Descriptor(),
                    Items(),
                    Cancellation);
                await work.CommitAsync(Cancellation);
                return result.IsSuccess;
            }
        }

        async Task<bool> ApplyAsync()
        {
            var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                var result = await work.Resolve<TemplateStore>().BeginApplicationAsync(
                    templateId,
                    TemplateApplicationMode.Create,
                    null,
                    null,
                    null,
                    "mixed-lock-import-application",
                    Cancellation);
                await work.CommitAsync(Cancellation);
                return result.IsSuccess;
            }
        }

        var outcomes = await Task.WhenAll(ImportAsync(), ApplyAsync())
            .WaitAsync(TimeSpan.FromSeconds(10), Cancellation);
        Assert.Single(outcomes, static succeeded => succeeded);
    }

    [Fact]
    public async Task Draft_item_patch_waiting_on_save_cannot_mutate_the_activated_revision()
    {
        var templateId = await ImportAndFinalizeAsync("draft-patch-save-race-template");
        TemplateDraftPlan draft;
        var setup = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (setup.ConfigureAwait(false))
        {
            var begun = await setup.Resolve<TemplateStore>().BeginDraftAsync(
                templateId,
                "draft-patch-save-race",
                Cancellation);
            Assert.True(begun.IsSuccess);
            draft = begun.Value;
            await setup.CommitAsync(Cancellation);
        }

        var save = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (save.ConfigureAwait(false))
        {
            var saved = await save.Resolve<TemplateStore>().SaveDraftAsync(
                templateId,
                draft.OperationId,
                Cancellation);
            Assert.True(saved.IsSuccess);

            async Task<Result<TemplateItemSnapshot>> PatchAsync()
            {
                var patch = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
                await using (patch.ConfigureAwait(false))
                {
                    return await patch.Resolve<TemplateStore>().UpdateDraftItemAsync(
                        templateId,
                        draft.OperationId,
                        ChildSource,
                        "Must not land",
                        null,
                        null,
                        null,
                        Cancellation);
                }
            }

            var pendingPatch = PatchAsync();
            await Task.Delay(100, Cancellation);
            Assert.False(pendingPatch.IsCompleted);
            await save.CommitAsync(Cancellation);

            var patched = await pendingPatch.WaitAsync(TimeSpan.FromSeconds(5), Cancellation);
            Assert.True(patched.IsFailure);
            Assert.Equal("templates.conflict", patched.Error.Code);
        }

        var verification = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (verification.ConfigureAwait(false))
        {
            var child = await verification.Resolve<TemplateStore>().ItemAsync(
                templateId,
                ChildSource,
                Cancellation);
            Assert.True(child.IsSuccess);
            Assert.Equal("Selected child", child.Value.Title);
        }
    }

    [Fact]
    public async Task Draft_metadata_patch_waiting_on_save_cannot_report_success_after_publication()
    {
        var templateId = await ImportAndFinalizeAsync("draft-metadata-save-race-template");
        TemplateDraftPlan draft;
        var setup = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (setup.ConfigureAwait(false))
        {
            var begun = await setup.Resolve<TemplateStore>().BeginDraftAsync(
                templateId,
                "draft-metadata-save-race",
                Cancellation);
            Assert.True(begun.IsSuccess);
            draft = begun.Value;
            await setup.CommitAsync(Cancellation);
        }

        var save = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (save.ConfigureAwait(false))
        {
            var saved = await save.Resolve<TemplateStore>().SaveDraftAsync(
                templateId,
                draft.OperationId,
                Cancellation);
            Assert.True(saved.IsSuccess);

            async Task<Result<TemplateDraftPlan>> PatchAsync()
            {
                var patch = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
                await using (patch.ConfigureAwait(false))
                {
                    return await patch.Resolve<TemplateStore>().UpdateDraftMetadataAsync(
                        templateId,
                        draft.OperationId,
                        "Must not publish",
                        "Must not report success",
                        Cancellation);
                }
            }

            var pendingPatch = PatchAsync();
            await Task.Delay(100, Cancellation);
            Assert.False(pendingPatch.IsCompleted);
            await save.CommitAsync(Cancellation);

            var patched = await pendingPatch.WaitAsync(TimeSpan.FromSeconds(5), Cancellation);
            Assert.True(patched.IsFailure);
            Assert.Equal("templates.conflict", patched.Error.Code);
        }

        var verification = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (verification.ConfigureAwait(false))
        {
            var detail = await verification.Resolve<TemplateStore>().DetailAsync(templateId, Cancellation);
            Assert.True(detail.IsSuccess);
            Assert.Equal("Template", detail.Value.Template.Title);
            Assert.Equal("A test template", detail.Value.Template.Description);
        }
    }

    [Fact]
    public async Task Expired_operations_and_applications_cannot_authorize_staging_items()
    {
        TemplateImportPlan operation;
        var imported = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (imported.ConfigureAwait(false))
        {
            var begun = await imported.Resolve<TemplateStore>().BeginImportAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                "expired-operation-authorization",
                Descriptor(),
                Items(),
                Cancellation);
            Assert.True(begun.IsSuccess);
            operation = begun.Value;
            await imported.CommitAsync(Cancellation);
        }

        var expiredOperation = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (expiredOperation.ConfigureAwait(false))
        {
            var operationId = operation.OperationId!.Value;
            await expiredOperation.DbContext.TemplateOperations
                .Where(candidate => candidate.Id == operationId)
                .ExecuteUpdateAsync(
                    update => update.SetProperty(candidate => candidate.ExpiresAt, DateTimeOffset.UnixEpoch),
                    Cancellation);
            var authorized = await expiredOperation.Resolve<TemplateStore>().AuthorizeOperationItemAsync(
                operationId.Value,
                operation.ItemMappings[0].ItemId,
                Cancellation);
            Assert.True(authorized.IsFailure);
        }

        var templateId = await ImportAndFinalizeAsync("expired-application-authorization-template");
        TemplateApplicationPlan application;
        var applied = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (applied.ConfigureAwait(false))
        {
            var begun = await applied.Resolve<TemplateStore>().BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Create,
                null,
                null,
                null,
                "expired-application-authorization",
                Cancellation);
            Assert.True(begun.IsSuccess);
            application = begun.Value;
            await applied.CommitAsync(Cancellation);
        }

        var expiredApplication = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (expiredApplication.ConfigureAwait(false))
        {
            await expiredApplication.DbContext.TemplateApplications
                .Where(candidate => candidate.Id == application.ApplicationId)
                .ExecuteUpdateAsync(
                    update => update.SetProperty(candidate => candidate.ExpiresAt, DateTimeOffset.UnixEpoch),
                    Cancellation);
            var authorized = await expiredApplication.Resolve<TemplateStore>().AuthorizeOperationItemAsync(
                application.ApplicationId.Value,
                application.CreatedItems[0].ItemId,
                Cancellation);
            Assert.True(authorized.IsFailure);
        }
    }

    [Fact]
    public async Task Worker_body_authorization_returns_every_mapping_and_marks_required_targets()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<TemplateStore>();
            var begun = await store.BeginImportAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                "worker-body-authorization",
                Descriptor() with { IncludeBody = true },
                ItemsWithRootBody(),
                Cancellation);
            Assert.True(begun.IsSuccess, begun.Error.Message);
            var operationId = begun.Value.OperationId!.Value;

            var authorized = await store.AuthorizeOperationWritesAsync(operationId, Cancellation);

            Assert.True(authorized.IsSuccess, authorized.Error.Message);
            Assert.True(authorized.Value.CanWrite);
            Assert.Equal(TestTenants.AlphaWorkspace, authorized.Value.WorkspaceId.Value);
            Assert.Equal(2, authorized.Value.BodyWrites.Count);
            var write = Assert.Single(authorized.Value.BodyWrites, value => value.BodyRequired);
            Assert.Equal(RootSource, write.SourceId);
            Assert.Equal(
                begun.Value.ItemMappings.Single(value => value.SourceId == RootSource).ItemId,
                write.TargetItemId);
            var bodyless = Assert.Single(authorized.Value.BodyWrites, value => !value.BodyRequired);
            Assert.Equal(ChildSource, bodyless.SourceId);
            Assert.Equal(
                begun.Value.ItemMappings.Single(value => value.SourceId == ChildSource).ItemId,
                bodyless.TargetItemId);

            var aborted = await store.AbortOperationAsync(operationId, Cancellation);
            Assert.True(aborted.IsSuccess, aborted.Error.Message);
            var refused = await store.AuthorizeOperationWritesAsync(operationId, Cancellation);
            Assert.True(refused.IsFailure);
            Assert.Equal("templates.not_found", refused.Error.Code);
        }
    }

    [Fact]
    public async Task Finalize_and_abort_of_one_import_are_serialized_with_exactly_one_winner()
    {
        TemplateImportPlan staged;
        var setup = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (setup.ConfigureAwait(false))
        {
            var begun = await setup.Resolve<TemplateStore>().BeginImportAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                "race-import-finalize-abort",
                Descriptor(),
                Items(),
                Cancellation);
            Assert.True(begun.IsSuccess);
            staged = begun.Value;
            await setup.CommitAsync(Cancellation);
        }

        async Task<bool> FinalizeAsync()
        {
            var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                var result = await work.Resolve<TemplateStore>().FinalizeOperationAsync(
                    staged.OperationId!.Value,
                    [],
                    Cancellation);
                await work.CommitAsync(Cancellation);
                return result.IsSuccess;
            }
        }

        async Task<bool> AbortAsync()
        {
            var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                var result = await work.Resolve<TemplateStore>().AbortOperationAsync(
                    staged.OperationId!.Value,
                    Cancellation);
                await work.CommitAsync(Cancellation);
                return result.IsSuccess;
            }
        }

        var outcomes = await Task.WhenAll(FinalizeAsync(), AbortAsync());
        Assert.Single(outcomes, static succeeded => succeeded);

        var verification = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (verification.ConfigureAwait(false))
        {
            Assert.False(await verification.DbContext.Items.IgnoreQueryFilters().AnyAsync(
                item => staged.ItemMappings.Select(mapping => mapping.ItemId).Contains(item.Id)
                    && item.LifecycleState == ItemLifecycleState.Provisioning,
                Cancellation));
        }
    }

    [Fact]
    public async Task Finalize_and_abort_of_one_application_are_serialized_with_exactly_one_winner()
    {
        var templateId = await ImportAndFinalizeAsync("race-application-template");
        TemplateApplicationPlan staged;
        var setup = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (setup.ConfigureAwait(false))
        {
            var begun = await setup.Resolve<TemplateStore>().BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Create,
                null,
                null,
                null,
                "race-application-finalize-abort",
                Cancellation);
            Assert.True(begun.IsSuccess);
            staged = begun.Value;
            await setup.CommitAsync(Cancellation);
        }

        async Task<bool> FinalizeAsync()
        {
            var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                var result = await work.Resolve<TemplateStore>().FinalizeApplicationAsync(
                    staged.ApplicationId,
                    [],
                    Cancellation);
                await work.CommitAsync(Cancellation);
                return result.IsSuccess;
            }
        }

        async Task<bool> AbortAsync()
        {
            var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                var result = await work.Resolve<TemplateStore>().AbortApplicationAsync(
                    staged.ApplicationId,
                    Cancellation);
                await work.CommitAsync(Cancellation);
                return result.IsSuccess;
            }
        }

        var outcomes = await Task.WhenAll(FinalizeAsync(), AbortAsync());
        Assert.Single(outcomes, static succeeded => succeeded);

        var verification = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (verification.ConfigureAwait(false))
        {
            Assert.False(await verification.DbContext.Items.IgnoreQueryFilters().AnyAsync(
                item => staged.CreatedItems.Select(mapping => mapping.ItemId).Contains(item.Id)
                    && item.LifecycleState == ItemLifecycleState.Provisioning,
                Cancellation));
        }
    }

    [Fact]
    public async Task Finalize_and_expiry_sweep_of_one_application_converge_without_orphans()
    {
        var templateId = await ImportAndFinalizeAsync("race-application-expiry-template");
        TemplateApplicationPlan staged;
        var setup = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (setup.ConfigureAwait(false))
        {
            var begun = await setup.Resolve<TemplateStore>().BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Create,
                null,
                null,
                null,
                "race-application-finalize-expiry",
                Cancellation);
            Assert.True(begun.IsSuccess);
            staged = begun.Value;
            await setup.DbContext.TemplateApplications
                .Where(application => application.Id == staged.ApplicationId)
                .ExecuteUpdateAsync(
                    update => update.SetProperty(application => application.ExpiresAt, DateTimeOffset.UnixEpoch),
                    Cancellation);
            await setup.CommitAsync(Cancellation);
        }

        async Task<bool> FinalizeAsync()
        {
            var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                var result = await work.Resolve<TemplateStore>().FinalizeApplicationAsync(
                    staged.ApplicationId,
                    [],
                    Cancellation);
                await work.CommitAsync(Cancellation);
                return result.IsSuccess;
            }
        }

        async Task<bool> SweepAsync()
        {
            var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                var result = await work.Resolve<TemplateStore>().SweepExpiredAsync(
                    WorkspaceId.From(TestTenants.AlphaWorkspace),
                    Cancellation);
                await work.CommitAsync(Cancellation);
                return result.IsSuccess;
            }
        }

        var outcomes = await Task.WhenAll(FinalizeAsync(), SweepAsync());
        Assert.False(outcomes[0]);
        Assert.True(outcomes[1]);

        var verification = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (verification.ConfigureAwait(false))
        {
            Assert.False(await verification.DbContext.TemplateApplications.AnyAsync(
                application => application.Id == staged.ApplicationId,
                Cancellation));
            Assert.False(await verification.DbContext.Items.IgnoreQueryFilters().AnyAsync(
                item => staged.CreatedItems.Select(mapping => mapping.ItemId).Contains(item.Id),
                Cancellation));
        }
    }

    [Fact]
    public async Task Replacing_a_revision_retains_sources_until_an_inflight_application_finalizes()
    {
        var templateId = await ImportAndFinalizeAsync("revision-retention");
        ItemId previousRoot;
        TemplateApplicationPlan application;
        var begin = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (begin.ConfigureAwait(false))
        {
            previousRoot = (await begin.DbContext.WorkspaceTemplates.SingleAsync(
                template => template.Id == templateId,
                Cancellation)).RootItemId!.Value;
            var staged = await begin.Resolve<TemplateStore>().BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Merge,
                ItemId.From(M0SchemaSeed.Alpha.ItemId),
                null,
                null,
                "revision-retention-application",
                Cancellation);
            Assert.True(staged.IsSuccess);
            application = staged.Value;
            await begin.CommitAsync(Cancellation);
        }

        var replace = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (replace.ConfigureAwait(false))
        {
            var draft = await replace.Resolve<TemplateStore>().BeginDraftAsync(
                templateId,
                "revision-retention-draft",
                Cancellation);
            Assert.True(draft.IsSuccess);
            Assert.True((await replace.Resolve<TemplateStore>().SaveDraftAsync(
                templateId,
                draft.Value.OperationId,
                Cancellation)).IsSuccess);
            Assert.True(await replace.DbContext.Items.IgnoreQueryFilters().AnyAsync(
                item => item.Id == previousRoot,
                Cancellation));
            await replace.CommitAsync(Cancellation);
        }

        var finalize = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (finalize.ConfigureAwait(false))
        {
            Assert.True((await finalize.Resolve<TemplateStore>().FinalizeApplicationAsync(
                application.ApplicationId,
                [],
                Cancellation)).IsSuccess);
            Assert.False(await finalize.DbContext.Items.IgnoreQueryFilters().AnyAsync(
                item => item.Id == previousRoot,
                Cancellation));
            await finalize.CommitAsync(Cancellation);
        }
    }

    [Fact]
    public async Task Capture_refuses_an_effective_root_schema_that_exceeds_the_storage_limit()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var now = DateTimeOffset.UtcNow;
            var parent = NewItem("Schema parent", LargeSchema("parent-field", 'p'), null, 100, now);
            var child = NewItem("Schema child", LargeSchema("child-field", 'c'), parent.Id, 101, now);
            work.DbContext.Items.AddRange(parent, child);
            await work.DbContext.SaveChangesAsync(Cancellation);
            await work.DbContext.Database.ExecuteSqlInterpolatedAsync(
                $"INSERT INTO item_closure (tenant_id, workspace_id, ancestor_id, descendant_id, depth) VALUES ({parent.TenantId.Value}, {parent.WorkspaceId.Value}, {parent.Id.Value}, {parent.Id.Value}, 0), ({parent.TenantId.Value}, {parent.WorkspaceId.Value}, {parent.Id.Value}, {child.Id.Value}, 1), ({child.TenantId.Value}, {child.WorkspaceId.Value}, {child.Id.Value}, {child.Id.Value}, 0)",
                Cancellation);

            var captured = await work.Resolve<TemplateStore>().BeginCaptureAsync(
                child.WorkspaceId,
                child.Id,
                "Oversized effective schema",
                null,
                false,
                false,
                "capture-effective-schema-overflow",
                Cancellation);

            Assert.True(captured.IsFailure);
            Assert.Contains("property schema may be at most", captured.Error.Message, StringComparison.OrdinalIgnoreCase);
            Assert.False(await work.DbContext.WorkspaceTemplates.AnyAsync(
                template => template.Title == "Oversized effective schema",
                Cancellation));
        }
    }

    [Fact]
    public async Task Import_refuses_properties_that_overflow_only_after_the_title_is_injected()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var oversizedAfterTitle = $"{{\"payload\":\"{new string('x', PropertyValidator.MaximumBytes - 20)}\"}}";
            Assert.True(System.Text.Encoding.UTF8.GetByteCount(oversizedAfterTitle) <= PropertyValidator.MaximumBytes);
            var child = Items()[1] with
            {
                Title = new string('t', 200),
                Properties = oversizedAfterTitle,
            };

            var imported = await work.Resolve<TemplateStore>().BeginImportAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                "import-title-overflow",
                Descriptor(),
                [Items()[0], child],
                Cancellation);

            Assert.True(imported.IsFailure);
            Assert.Contains("property bag may be at most", imported.Error.Message, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public async Task Import_refuses_a_bag_naming_a_member_twice_rather_than_failing_the_request()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var child = Items()[1] with
            {
                Properties = "{\"due_date\":\"2026-12-01\",\"due_date\":\"2026-12-02\"}",
            };

            var imported = await work.Resolve<TemplateStore>().BeginImportAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                "import-duplicate-member",
                Descriptor(),
                [Items()[0], child],
                Cancellation);

            Assert.True(imported.IsFailure);
            Assert.Equal(TemplateErrors.Invalid("x").Code, imported.Error.Code);
        }
    }

    [Fact]
    public async Task A_draft_item_edit_cannot_carry_a_set_by_value_into_template_content()
    {
        var templateId = await ImportAndFinalizeAsync("draft-strips-set-by");
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<TemplateStore>();
            var draft = await store.BeginDraftAsync(templateId, "draft-strips-set-by", Cancellation);
            Assert.True(draft.IsSuccess);

            var updated = await store.UpdateDraftItemAsync(
                templateId,
                draft.Value.OperationId,
                ChildSource,
                null,
                $$"""{"title":"Child","due_date":"2026-12-01","{{ItemProperties.DueSetByKey}}":"{{TestTenants.BetaPrincipal}}","{{ItemProperties.ReminderSetByKey}}":"{{TestTenants.BetaPrincipal}}"}""",
                null,
                null,
                Cancellation);

            Assert.True(updated.IsSuccess, updated.IsFailure ? updated.Error.Message : string.Empty);
            var bag = Assert.IsType<JsonObject>(JsonNode.Parse(updated.Value.Properties!));
            Assert.Equal("2026-12-01", (string?)bag["due_date"]);
            Assert.False(bag.ContainsKey(ItemProperties.DueSetByKey));
            Assert.False(bag.ContainsKey(ItemProperties.ReminderSetByKey));
        }
    }

    [Fact]
    public async Task Draft_root_properties_are_preserved_when_the_root_is_edited()
    {
        var templateId = await ImportAndFinalizeAsync("draft-root-invariant");
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<TemplateStore>();
            var draft = await store.BeginDraftAsync(templateId, "draft-root-invariant", Cancellation);
            Assert.True(draft.IsSuccess);
            var rootSource = draft.Value.Root.SourceId;

            var updated = await store.UpdateDraftItemAsync(
                templateId,
                draft.Value.OperationId,
                rootSource,
                null,
                "{\"title\":\"Renamed root\",\"answer\":\"must not persist\"}",
                null,
                null,
                Cancellation);

            Assert.True(updated.IsSuccess);
            Assert.Equal("Renamed root", updated.Value.Title);
            Assert.Contains("must not persist", updated.Value.Properties, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task Capture_draft_keep_rule_and_application_preserve_root_content_and_reset_task_state()
    {
        var now = DateTimeOffset.UtcNow;
        var root = new Item
        {
            Id = ItemId.Create(),
            TenantId = TestTenants.AlphaContext.TenantId,
            WorkspaceId = WorkspaceId.From(TestTenants.AlphaWorkspace),
            Type = "note",
            Seq = 91_100,
            Properties = "{\"title\":\"Captured {{project}} plan\",\"answer\":\"keep this authored answer\",\"due_date\":\"2025-01-03\",\"completion\":true}",
            Schema = "{\"inherit\":false,\"properties\":["
            + "{\"key\":\"answer\",\"label\":\"Answer\",\"type\":\"text\",\"required\":false},"
            + "{\"key\":\"due_date\",\"label\":\"Due date\",\"type\":\"due_date\",\"required\":false},"
            + "{\"key\":\"completion\",\"label\":\"Complete\",\"type\":\"completion\",\"required\":false}]}",
            Recurrence = "{\"freq\":\"weekly\",\"interval\":1,\"weekdays\":[\"fr\"],"
            + "\"until\":\"2026-12-31\",\"completedThrough\":\"2025-01-03\",\"completed\":[\"2025-01-10\"]}",
            LifecycleState = ItemLifecycleState.Active,
            CreatedBy = TestTenants.AlphaContext.PrincipalId,
            LastModifiedBy = TestTenants.AlphaContext.PrincipalId,
            CreatedAt = now,
            LastModifiedAt = now,
        };
        TemplateId templateId;
        var capture = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (capture.ConfigureAwait(false))
        {
            capture.DbContext.Items.Add(root);
            await capture.DbContext.SaveChangesAsync(Cancellation);
            await capture.DbContext.Database.ExecuteSqlInterpolatedAsync(
                $"INSERT INTO item_closure (tenant_id, workspace_id, ancestor_id, descendant_id, depth) VALUES ({root.TenantId.Value}, {root.WorkspaceId.Value}, {root.Id.Value}, {root.Id.Value}, 0)",
                Cancellation);
            var store = capture.Resolve<TemplateStore>();
            var staged = await store.BeginCaptureAsync(
                root.WorkspaceId, root.Id, "Captured workflow", null, true, true,
                "capture-root-values-draft-keep", Cancellation);
            Assert.True(staged.IsSuccess, staged.IsFailure ? staged.Error.ToString() : null);
            var finalized = await store.FinalizeOperationAsync(staged.Value.OperationId, [], Cancellation);
            Assert.True(finalized.IsSuccess, finalized.IsFailure ? finalized.Error.ToString() : null);
            templateId = finalized.Value;
            await capture.CommitAsync(Cancellation);
        }

        var draftWork = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (draftWork.ConfigureAwait(false))
        {
            var store = draftWork.Resolve<TemplateStore>();
            var draft = await store.BeginDraftAsync(templateId, "capture-root-values-draft", Cancellation);
            Assert.True(draft.IsSuccess, draft.IsFailure ? draft.Error.ToString() : null);
            Assert.Contains("keep this authored answer", draft.Value.Root.Properties, StringComparison.Ordinal);
            var initialization = new TemplateInitialization(
                1,
                [
                    new("project", "Project", TemplateInitializationInputType.Text, true),
                    new("kickoff", "Kickoff", TemplateInitializationInputType.Date, true),
                ],
                [
                    new(draft.Value.Root.SourceId, "answer", TemplateInitializationRuleKind.Keep),
                    new(draft.Value.Root.SourceId, "due_date", TemplateInitializationRuleKind.Input, InputKey: "kickoff"),
                ],
                []);
            var metadata = await store.UpdateDraftMetadataAsync(
                templateId, draft.Value.OperationId, null, null, initialization, Cancellation);
            Assert.True(metadata.IsSuccess, metadata.IsFailure ? metadata.Error.ToString() : null);
            var saved = await store.SaveDraftAsync(templateId, draft.Value.OperationId, Cancellation);
            Assert.True(saved.IsSuccess, saved.IsFailure ? saved.Error.ToString() : null);
            await draftWork.CommitAsync(Cancellation);
        }

        ItemId applicationRootId;
        var applyWork = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (applyWork.ConfigureAwait(false))
        {
            var applied = await applyWork.Resolve<TemplateStore>().BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Create,
                null,
                null,
                null,
                "apply-captured-root-values",
                new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["project"] = "Apollo",
                    ["kickoff"] = "2026-03-01",
                },
                null,
                Cancellation);
            Assert.True(applied.IsSuccess, applied.IsFailure ? applied.Error.ToString() : null);
            applicationRootId = applied.Value.TargetItemId;
            var preview = Assert.Single(applied.Value.InitializationPreview!);
            Assert.Equal("Captured Apollo plan", preview.Title);
            var previewProperties = JsonNode.Parse(preview.Properties!)!;
            Assert.Equal("keep this authored answer", previewProperties["answer"]!.GetValue<string>());
            Assert.Equal("2026-03-01", previewProperties["due_date"]!.GetValue<string>());
            Assert.False(previewProperties["completion"]!.GetValue<bool>());
            var recurrence = RecurrenceRuleJson.Read(preview.Recurrence);
            Assert.NotNull(recurrence);
            Assert.Null(recurrence.CompletedThrough);
            Assert.Empty(recurrence.Completed);
            Assert.Equal(new DateOnly(2026, 12, 31), recurrence.Until);
            var finalized = await applyWork.Resolve<TemplateStore>().FinalizeApplicationAsync(
                applied.Value.ApplicationId, [], Cancellation);
            Assert.True(finalized.IsSuccess, finalized.IsFailure ? finalized.Error.ToString() : null);
            await applyWork.CommitAsync(Cancellation);
        }

        var verify = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (verify.ConfigureAwait(false))
        {
            var appliedRoot = await verify.DbContext.Items.AsNoTracking()
                .SingleAsync(item => item.Id == applicationRootId, Cancellation);
            var properties = JsonNode.Parse(appliedRoot.Properties!)!;
            Assert.Equal("keep this authored answer", properties["answer"]!.GetValue<string>());
            Assert.Equal("2026-03-01", properties["due_date"]!.GetValue<string>());
            Assert.False(properties["completion"]!.GetValue<bool>());
        }
    }

    [Fact]
    public async Task User_import_replay_compares_the_portable_profile_key()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<TemplateStore>();
            var begun = await store.BeginImportAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                "user-profile-key-replay",
                Descriptor(),
                Items(),
                Cancellation);
            Assert.True(begun.IsSuccess);

            var replay = await store.BeginImportAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                "user-profile-key-replay",
                Descriptor() with { StableKey = "another.portable.key" },
                Items(),
                Cancellation);

            Assert.True(replay.IsFailure);
            Assert.Equal("templates.conflict", replay.Error.Code);
        }
    }

    [Fact]
    public async Task Deleting_a_template_removes_only_created_provisioning_application_targets()
    {
        var templateId = await ImportAndFinalizeAsync("delete-staged-application");
        TemplateApplicationPlan merged;
        var staging = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (staging.ConfigureAwait(false))
        {
            var store = staging.Resolve<TemplateStore>();
            var mergeResult = await store.BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Merge,
                ItemId.From(M0SchemaSeed.Alpha.ItemId),
                null,
                null,
                "delete-staged-merge",
                Cancellation);
            Assert.True(mergeResult.IsSuccess);
            merged = mergeResult.Value;
            await staging.CommitAsync(Cancellation);
        }

        var deletion = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (deletion.ConfigureAwait(false))
        {
            var store = deletion.Resolve<TemplateStore>();
            Assert.True((await store.DeleteAsync(templateId, Cancellation)).IsSuccess);
            Assert.False(await deletion.DbContext.Items.IgnoreQueryFilters().AnyAsync(
                item => merged.CreatedItems.Select(mapping => mapping.ItemId).Contains(item.Id),
                Cancellation));
            Assert.True(await deletion.DbContext.Items.AnyAsync(
                item => item.Id == ItemId.From(M0SchemaSeed.Alpha.ItemId),
                Cancellation));
        }
    }

    [Fact]
    public async Task Template_migration_down_removes_hidden_rows_and_up_restores_seed_templates()
    {
        var templateId = await ImportAndFinalizeAsync("migration-up-down");
        var before = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (before.ConfigureAwait(false))
        {
            Assert.Equal(2, await before.DbContext.Items.IgnoreQueryFilters().CountAsync(
                item => item.TemplateId == templateId,
                Cancellation));
        }

        var options = new DbContextOptionsBuilder<NixDbContext>()
            .UseNpgsql(_fixture.MigratorConnectionString)
            .Options;
        var migrationContext = new NixDbContext(options);
        await using (migrationContext.ConfigureAwait(false))
        {
            var migrator = migrationContext.GetService<IMigrator>();
            await migrator.MigrateAsync("20260816161932_PublicForms", Cancellation);
            try
            {
                var remainingOrdinary = await migrationContext.Database.SqlQueryRaw<int>(
                    "SELECT count(*)::integer AS \"Value\" FROM item").SingleAsync(Cancellation);
                Assert.Equal(2, remainingOrdinary);
                Assert.False(await migrationContext.Database.SqlQueryRaw<bool>(
                    "SELECT to_regclass('public.workspace_template') IS NOT NULL AS \"Value\"")
                    .SingleAsync(Cancellation));
            }
            finally
            {
                // Back to LATEST, not to a pinned name: restoring only to this phase's own
                // migration silently stranded the database one step behind the model the moment
                // any later phase added one, and every EF write after this test then failed on a
                // column the model has and the table does not - a 33-test cascade the TaskSemantics
                // migration was the first to trip. The down-target above stays pinned on purpose
                // (the point is to cross this phase's boundary); the way back up is "everything".
                await migrator.MigrateAsync(targetMigration: null, cancellationToken: Cancellation);
            }

            Assert.Equal(6, await migrationContext.Database.SqlQueryRaw<int>(
                "SELECT count(*)::integer AS \"Value\" FROM workspace_template WHERE origin = 'seed'")
                .SingleAsync(Cancellation));
            Assert.Equal(6, await migrationContext.Database.SqlQueryRaw<int>(
                "SELECT count(*)::integer AS \"Value\" FROM item WHERE template_id IS NOT NULL")
                .SingleAsync(Cancellation));
            Assert.Equal(2, await migrationContext.Database.SqlQueryRaw<int>(
                "SELECT count(*)::integer AS \"Value\" FROM item WHERE template_id IS NULL")
                .SingleAsync(Cancellation));
            var seededIdentities = await migrationContext.Database.SqlQueryRaw<Guid>(
                """
                SELECT template_id AS "Value" FROM workspace_template WHERE origin = 'seed'
                UNION ALL
                SELECT id AS "Value" FROM item WHERE template_id IS NOT NULL
                UNION ALL
                SELECT template_source_id AS "Value" FROM item WHERE template_id IS NOT NULL
                """).ToListAsync(Cancellation);
            Assert.Equal(18, seededIdentities.Count);
            RfcUuidAssert.Version4(seededIdentities);
        }
    }

    [Fact]
    public async Task Listing_many_templates_uses_one_bounded_shape_query()
    {
        const int templateCount = 24;
        for (var index = 0; index < templateCount; index++)
        {
            await ImportAndFinalizeAsync($"bounded-list-{index}");
        }

        var capture = new ReaderQueryCaptureInterceptor();
        await using var application = NixPersistenceHost.Create(_fixture.ApplicationConnectionString, capture);
        var work = await application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var library = await work.Resolve<TemplateStore>().ListAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                Cancellation);
            Assert.True(library.IsSuccess);
            Assert.Equal(templateCount, library.Value.Templates.Count);
        }

        var lines = capture.Statements
            .Select(line => line.Replace("\"", string.Empty, StringComparison.Ordinal).ToUpperInvariant())
            .ToArray();
        Assert.Equal(1, lines.Count(line => line.Contains(
            "FROM ITEM_CLOSURE AS",
            StringComparison.Ordinal)));
        Assert.Equal(1, lines.Count(line => line.Contains(
            "FROM WORKSPACE_TEMPLATE AS",
            StringComparison.Ordinal)));
    }

    [Fact]
    public async Task Catalog_listing_refuses_to_materialize_more_than_the_workspace_bound()
    {
        const int overBound = 1_001;
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var now = DateTimeOffset.UtcNow;
            work.DbContext.WorkspaceTemplates.AddRange(Enumerable.Range(0, overBound).Select(index =>
                new WorkspaceTemplate
                {
                    Id = TemplateId.Create(),
                    TenantId = TestTenants.AlphaContext.TenantId,
                    WorkspaceId = WorkspaceId.From(TestTenants.AlphaWorkspace),
                    StableKey = $"cap.{index}",
                    ProfileKey = $"cap.{index}",
                    Origin = TemplateOrigin.User,
                    Title = $"Template {index}",
                    IncludeBody = false,
                    IncludeChildren = false,
                    State = TemplateState.Active,
                    Revision = 1,
                    CreatedBy = TestTenants.AlphaContext.PrincipalId,
                    LastModifiedBy = TestTenants.AlphaContext.PrincipalId,
                    CreatedAt = now,
                    LastModifiedAt = now,
                }));
            await work.DbContext.SaveChangesAsync(Cancellation);

            var library = await work.Resolve<TemplateStore>().ListAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                Cancellation);

            Assert.True(library.IsFailure);
            Assert.Equal("templates.invalid", library.Error.Code);
        }
    }

    [Fact]
    public async Task Managed_batch_body_checks_and_activation_use_bounded_bulk_commands()
    {
        const int importCount = 200;
        await SeedTemplateActorsAsync();
        var serviceContext = TestTenants.ContextFor(
            TestTenants.Alpha,
            TestTenants.AlphaWorkspace,
            ManagedServicePrincipal);
        var staged = new List<(TemplateImportDescriptor Descriptor, TemplateImportPlan Plan)>(importCount);
        var setup = await _fixture.Application.BeginUnitOfWorkAsync(serviceContext, Cancellation);
        await using (setup.ConfigureAwait(false))
        {
            var store = setup.Resolve<TemplateStore>();
            for (var index = 0; index < importCount; index++)
            {
                var descriptor = Descriptor() with
                {
                    StableKey = $"managed.bulk.{index}",
                    Origin = TemplateOrigin.Managed,
                    ManagedSource = $"/templates/{index}.nix",
                };
                var result = await store.BeginImportAsync(
                    WorkspaceId.From(TestTenants.AlphaWorkspace),
                    $"managed-bulk-{index}",
                    descriptor,
                    [Items()[0]],
                    Cancellation);
                Assert.True(result.IsSuccess);
                staged.Add((descriptor, result.Value));
            }
            await setup.CommitAsync(Cancellation);
        }

        await Task.Delay(TimeSpan.FromSeconds(1.1), Cancellation);
        var since = DateTime.UtcNow;
        var finalize = await _fixture.Application.BeginUnitOfWorkAsync(serviceContext, Cancellation);
        await using (finalize.ConfigureAwait(false))
        {
            var result = await finalize.Resolve<TemplateStore>().FinalizeManagedBatchAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                staged.Select(entry => new ManagedTemplateFinalization(
                    entry.Plan.OperationId,
                    entry.Plan.TemplateId,
                    entry.Descriptor.StableKey,
                    entry.Descriptor.Digest,
                    [])).ToArray(),
                staged.Select(entry => entry.Descriptor.StableKey).ToArray(),
                Cancellation);
            Assert.True(result.IsSuccess);
            Assert.Equal(importCount, result.Value.Activated);
            await finalize.CommitAsync(Cancellation);
        }

        var lines = (await _fixture.ServerLogLinesSinceAsync(since))
            .Select(line => line.Replace("\"", string.Empty, StringComparison.Ordinal).ToUpperInvariant())
            .ToArray();
        Assert.Equal(4, lines.Count(line => line.Contains(
            "FROM TEMPLATE_OPERATION_ITEM AS",
            StringComparison.Ordinal)));
        Assert.Equal(1, lines.Count(line => line.Contains(
            "FROM CONTENT_DOC AS",
            StringComparison.Ordinal)));
        Assert.Equal(1, lines.Count(line => line.Contains(
            "UPDATE ITEM AS",
            StringComparison.Ordinal)));
    }

    [Fact]
    public async Task Managed_revision_history_retains_eight_completed_operations()
    {
        await SeedTemplateActorsAsync();
        var serviceContext = TestTenants.ContextFor(
            TestTenants.Alpha,
            TestTenants.AlphaWorkspace,
            ManagedServicePrincipal);
        TemplateId templateId = default;
        for (var revision = 1; revision <= 10; revision++)
        {
            var finalized = await FinalizeManagedRevisionAsync(serviceContext, "managed.history", revision);
            templateId = finalized.TemplateId;
        }

        var verify = await _fixture.Application.BeginUnitOfWorkAsync(serviceContext, Cancellation);
        await using (verify.ConfigureAwait(false))
        {
            var operationIds = await verify.DbContext.TemplateOperations
                .Where(operation => operation.TemplateId == templateId
                    && operation.State == TemplateOperationState.Active)
                .OrderBy(operation => operation.CreatedAt)
                .Select(operation => operation.Id)
                .ToArrayAsync(Cancellation);
            Assert.Equal(8, operationIds.Length);
            Assert.Equal(8, await verify.DbContext.TemplateOperationItems.CountAsync(
                mapping => operationIds.Contains(mapping.OperationId),
                Cancellation));
        }
    }

    [Fact]
    public async Task Managed_digest_rollback_stages_a_fresh_revision_instead_of_replaying_stale_mappings()
    {
        await SeedTemplateActorsAsync();
        var serviceContext = TestTenants.ContextFor(
            TestTenants.Alpha,
            TestTenants.AlphaWorkspace,
            ManagedServicePrincipal);
        const string stableKey = "managed.rollback";
        var digestA = new string('a', 64);
        var digestB = new string('b', 64);

        async Task<(TemplateId TemplateId, TemplateOperationId OperationId, ItemId RootId)> ImportAsync(
            string digest,
            string idempotencyKey)
        {
            var descriptor = Descriptor() with
            {
                StableKey = stableKey,
                Origin = TemplateOrigin.Managed,
                ManagedSource = "/templates/managed.rollback.nix",
                Digest = digest,
            };
            var work = await _fixture.Application.BeginUnitOfWorkAsync(serviceContext, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                var store = work.Resolve<TemplateStore>();
                var begun = await store.BeginImportAsync(
                    serviceContext.WorkspaceId!.Value,
                    idempotencyKey,
                    descriptor,
                    [Items()[0]],
                    Cancellation);
                Assert.True(begun.IsSuccess);
                Assert.False(begun.Value.Unchanged);
                var operationId = begun.Value.OperationId!.Value;
                var rootId = Assert.Single(begun.Value.ItemMappings).ItemId;
                var finalized = await store.FinalizeManagedBatchAsync(
                    serviceContext.WorkspaceId.Value,
                    [new ManagedTemplateFinalization(
                        operationId,
                        begun.Value.TemplateId,
                        stableKey,
                        digest,
                        [])],
                    [stableKey],
                    Cancellation);
                Assert.True(finalized.IsSuccess);
                await work.CommitAsync(Cancellation);
                return (begun.Value.TemplateId, operationId, rootId);
            }
        }

        var firstA = await ImportAsync(digestA, "managed-rollback-digest-a");
        var revisionB = await ImportAsync(digestB, "managed-rollback-digest-b");
        var secondA = await ImportAsync(digestA, "managed-rollback-digest-a");

        Assert.Equal(firstA.TemplateId, revisionB.TemplateId);
        Assert.Equal(firstA.TemplateId, secondA.TemplateId);
        Assert.NotEqual(firstA.OperationId, secondA.OperationId);
        Assert.NotEqual(firstA.RootId, secondA.RootId);
        Assert.NotEqual(revisionB.RootId, secondA.RootId);

        var verify = await _fixture.Application.BeginUnitOfWorkAsync(serviceContext, Cancellation);
        await using (verify.ConfigureAwait(false))
        {
            var catalog = await verify.DbContext.WorkspaceTemplates.SingleAsync(
                candidate => candidate.Id == firstA.TemplateId,
                Cancellation);
            Assert.Equal(digestA, catalog.SourceDigest);
            Assert.Equal(secondA.RootId, catalog.RootItemId);
            Assert.Equal(3, catalog.Revision);
            Assert.False(await verify.DbContext.TemplateOperations.AnyAsync(
                candidate => candidate.Id == firstA.OperationId,
                Cancellation));
            Assert.True(await verify.DbContext.TemplateOperations.AnyAsync(
                candidate => candidate.Id == secondA.OperationId,
                Cancellation));
        }
    }

    [Fact]
    public async Task Managed_history_keeps_an_old_revision_only_until_its_application_finishes()
    {
        await SeedTemplateActorsAsync();
        var serviceContext = TestTenants.ContextFor(
            TestTenants.Alpha,
            TestTenants.AlphaWorkspace,
            ManagedServicePrincipal);
        var first = await FinalizeManagedRevisionAsync(serviceContext, "managed.inflight", 1);
        TemplateApplicationPlan application;
        var begin = await _fixture.Application.BeginUnitOfWorkAsync(serviceContext, Cancellation);
        await using (begin.ConfigureAwait(false))
        {
            var staged = await begin.Resolve<TemplateStore>().BeginApplicationAsync(
                first.TemplateId,
                TemplateApplicationMode.Create,
                null,
                null,
                null,
                "managed-inflight-application",
                Cancellation);
            Assert.True(staged.IsSuccess);
            application = staged.Value;
            await begin.CommitAsync(Cancellation);
        }

        for (var revision = 2; revision <= 9; revision++)
        {
            await FinalizeManagedRevisionAsync(serviceContext, "managed.inflight", revision);
        }

        var retained = await _fixture.Application.BeginUnitOfWorkAsync(serviceContext, Cancellation);
        await using (retained.ConfigureAwait(false))
        {
            Assert.True(await retained.DbContext.TemplateOperations.AnyAsync(
                operation => operation.Id == first.OperationId,
                Cancellation));
            Assert.Equal(9, await retained.DbContext.TemplateOperations.CountAsync(
                operation => operation.TemplateId == first.TemplateId
                    && operation.State == TemplateOperationState.Active,
                Cancellation));
        }

        var finish = await _fixture.Application.BeginUnitOfWorkAsync(serviceContext, Cancellation);
        await using (finish.ConfigureAwait(false))
        {
            Assert.True((await finish.Resolve<TemplateStore>().FinalizeApplicationAsync(
                application.ApplicationId,
                [],
                Cancellation)).IsSuccess);
            Assert.False(await finish.DbContext.TemplateOperations.AnyAsync(
                operation => operation.Id == first.OperationId,
                Cancellation));
            Assert.Equal(8, await finish.DbContext.TemplateOperations.CountAsync(
                operation => operation.TemplateId == first.TemplateId
                    && operation.State == TemplateOperationState.Active,
                Cancellation));
            await finish.CommitAsync(Cancellation);
        }
    }

    [Fact]
    public async Task Deleting_a_template_with_large_history_uses_fixed_server_side_deletes()
    {
        const int historyCount = 3_200;
        var templateId = await ImportAndFinalizeAsync("large-delete-history");
        ItemId sourceRoot;
        var read = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (read.ConfigureAwait(false))
        {
            sourceRoot = (await read.DbContext.WorkspaceTemplates.SingleAsync(
                template => template.Id == templateId,
                Cancellation)).RootItemId!.Value;
        }

        await SeedTemplateHistoryAsync(templateId, sourceRoot, historyCount);
        await Task.Delay(TimeSpan.FromSeconds(1.1), Cancellation);
        var since = DateTime.UtcNow;
        var deletion = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (deletion.ConfigureAwait(false))
        {
            Assert.True((await deletion.Resolve<TemplateStore>().DeleteAsync(templateId, Cancellation)).IsSuccess);
            await deletion.CommitAsync(Cancellation);
        }

        var lines = (await _fixture.ServerLogLinesSinceAsync(since))
            .Select(line => line.Replace("\"", string.Empty, StringComparison.Ordinal).ToUpperInvariant())
            .ToArray();
        Assert.Equal(1, lines.Count(line => line.Contains(
            "DELETE FROM TEMPLATE_APPLICATION AS",
            StringComparison.Ordinal)));
        Assert.Equal(1, lines.Count(line => line.Contains(
            "DELETE FROM TEMPLATE_OPERATION AS",
            StringComparison.Ordinal)));

        var verify = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (verify.ConfigureAwait(false))
        {
            Assert.False(await verify.DbContext.WorkspaceTemplates.AnyAsync(
                template => template.Id == templateId,
                Cancellation));
            Assert.False(await verify.DbContext.TemplateApplications.AnyAsync(
                application => application.TemplateId == templateId,
                Cancellation));
            Assert.False(await verify.DbContext.TemplateOperations.AnyAsync(
                operation => operation.TemplateId == templateId,
                Cancellation));
        }
    }

    [Fact]
    public async Task Import_refuses_every_view_dependency_that_its_schema_cannot_satisfy()
    {
        var invalidViews = new (string Name, string Views)[]
        {
            ("column", "{\"views\":[{\"id\":\"v\",\"name\":\"Columns\",\"kind\":\"list\",\"columns\":[\"missing\"],\"sortDescending\":false}],\"default\":\"v\"}"),
            ("group", "{\"views\":[{\"id\":\"v\",\"name\":\"Board\",\"kind\":\"board\",\"groupBy\":\"answer\",\"sortDescending\":false}],\"default\":\"v\"}"),
            ("date", "{\"views\":[{\"id\":\"v\",\"name\":\"Calendar\",\"kind\":\"calendar\",\"dateProperty\":\"answer\",\"sortDescending\":false}],\"default\":\"v\"}"),
            ("end-date", "{\"views\":[{\"id\":\"v\",\"name\":\"Timeline\",\"kind\":\"timeline\",\"dateProperty\":\"due\",\"endDateProperty\":\"answer\",\"sortDescending\":false}],\"default\":\"v\"}"),
            ("cover", "{\"views\":[{\"id\":\"v\",\"name\":\"Gallery\",\"kind\":\"gallery\",\"coverProperty\":\"answer\",\"sortDescending\":false}],\"default\":\"v\"}"),
            ("sort", "{\"views\":[{\"id\":\"v\",\"name\":\"Sorted\",\"kind\":\"list\",\"sortBy\":\"missing\",\"sortDescending\":false}],\"default\":\"v\"}"),
            ("filter", "{\"views\":[{\"id\":\"v\",\"name\":\"Filtered\",\"kind\":\"query\",\"sortDescending\":false,\"filters\":[{\"property\":\"missing\",\"operator\":\"equals\",\"value\":\"x\"}]}],\"default\":\"v\"}"),
            ("date-filter", "{\"views\":[{\"id\":\"v\",\"name\":\"Date filter\",\"kind\":\"query\",\"sortDescending\":false,\"filters\":[{\"property\":\"answer\",\"operator\":\"before\",\"value\":\"today\"}]}],\"default\":\"v\"}"),
            ("form", "{\"views\":[{\"id\":\"v\",\"name\":\"Form\",\"kind\":\"interactive_form\",\"sortDescending\":false,\"interactiveForm\":{\"pages\":[{\"id\":\"p1\",\"title\":\"Page\",\"description\":null,\"visibleWhen\":[],\"blocks\":[{\"id\":\"q1\",\"kind\":\"field\",\"propertyKey\":\"missing\",\"text\":\"Question\",\"help\":null,\"required\":false,\"identityRole\":null,\"visibleWhen\":[]}]}],\"titleMode\":\"generated\",\"titleFieldBlockId\":null,\"confirmationTitle\":\"Thanks\",\"confirmationMessage\":\"Done\"}}],\"default\":\"v\"}"),
        };

        var schema = "{\"inherit\":false,\"properties\":[{\"key\":\"answer\",\"label\":\"Answer\",\"type\":\"text\",\"required\":false},{\"key\":\"due\",\"label\":\"Due\",\"type\":\"date\",\"required\":false}]}";
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<TemplateStore>();
            foreach (var invalid in invalidViews)
            {
                var result = await store.BeginImportAsync(
                    WorkspaceId.From(TestTenants.AlphaWorkspace),
                    $"invalid-dependency-{invalid.Name}",
                    Descriptor(),
                    [Items()[0] with { Schema = schema, Views = invalid.Views }],
                    Cancellation);

                Assert.True(result.IsFailure, invalid.Name);
                Assert.Equal("templates.invalid", result.Error.Code);
            }
        }
    }

    [Fact]
    public async Task Create_preflight_reports_a_corrupt_template_before_any_mutation()
    {
        var templateId = await ImportAndFinalizeAsync("corrupt-create-preflight");
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var rootId = (await work.DbContext.WorkspaceTemplates.SingleAsync(
                template => template.Id == templateId,
                Cancellation)).RootItemId!.Value;
            // A structurally-corrupt stored template: the default names a view that does not
            // exist. This is caught by ViewDefinitionRules before any mutation, and stays caught
            // even though a merely dangling column is now tolerated the way the live product
            // tolerates it (see TemplateValidationTests) - the safety net is for real corruption,
            // not for a column that renders as nothing.
            await work.DbContext.Items.IgnoreQueryFilters()
                .Where(item => item.Id == rootId)
                .ExecuteUpdateAsync(
                    update => update.SetProperty(
                        item => item.Views,
                        "{\"views\":[{\"id\":\"real\",\"name\":\"Real\",\"kind\":\"list\",\"columns\":[],\"sortDescending\":false}],\"default\":\"ghost\"}"),
                    Cancellation);

            var store = work.Resolve<TemplateStore>();
            var preflight = await store.PreflightAsync(
                templateId,
                TemplateApplicationMode.Create,
                null,
                null,
                Cancellation);
            Assert.True(preflight.IsSuccess);
            Assert.False(preflight.Value.CanApply);
            Assert.Contains(preflight.Value.Conflicts, conflict => conflict.Contains(
                "cannot be the one that opens",
                StringComparison.Ordinal));

            var begun = await store.BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Create,
                null,
                null,
                null,
                "corrupt-create-preflight-application",
                Cancellation);
            Assert.True(begun.IsFailure);
            Assert.Empty(await work.DbContext.TemplateApplications.Where(
                application => application.IdempotencyKey == "corrupt-create-preflight-application")
                .ToListAsync(Cancellation));
        }
    }

    [Fact]
    public async Task Finalization_refuses_a_merge_target_deleted_after_staging()
    {
        var templateId = await ImportAndFinalizeAsync("deleted-merge-target");
        TemplateApplicationPlan staged;
        var begin = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (begin.ConfigureAwait(false))
        {
            var result = await begin.Resolve<TemplateStore>().BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Merge,
                ItemId.From(M0SchemaSeed.Alpha.ItemId),
                null,
                null,
                "deleted-merge-target-application",
                Cancellation);
            Assert.True(result.IsSuccess);
            staged = result.Value;
            await begin.CommitAsync(Cancellation);
        }

        await SetLifecycleAsync(ItemId.From(M0SchemaSeed.Alpha.ItemId), ItemLifecycleState.Deleted);
        var finalize = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (finalize.ConfigureAwait(false))
        {
            var result = await finalize.Resolve<TemplateStore>().FinalizeApplicationAsync(
                staged.ApplicationId,
                [],
                Cancellation);
            Assert.True(result.IsFailure);
            Assert.Equal("templates.conflict", result.Error.Code);
            Assert.Equal(TemplateOperationState.Provisioning, (await finalize.DbContext.TemplateApplications
                .SingleAsync(application => application.Id == staged.ApplicationId, Cancellation)).State);
        }
    }

    [Fact]
    public async Task Preflight_and_begin_refuse_deleted_ordinary_destinations()
    {
        var templateId = await ImportAndFinalizeAsync("deleted-destinations");
        var destinationId = await AddOrdinaryItemAsync("Deleted destination");
        await SetLifecycleAsync(destinationId, ItemLifecycleState.Deleted);
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<TemplateStore>();
            Assert.True((await store.PreflightAsync(
                templateId,
                TemplateApplicationMode.Create,
                null,
                destinationId,
                Cancellation)).IsFailure);
            Assert.True((await store.PreflightAsync(
                templateId,
                TemplateApplicationMode.Merge,
                destinationId,
                null,
                Cancellation)).IsFailure);
            Assert.True((await store.BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Create,
                null,
                destinationId,
                null,
                "deleted-create-destination",
                Cancellation)).IsFailure);
            Assert.True((await store.BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Merge,
                destinationId,
                null,
                null,
                "deleted-merge-destination",
                Cancellation)).IsFailure);
        }
    }

    [Fact]
    public async Task Finalization_refuses_a_create_parent_deleted_after_staging()
    {
        var templateId = await ImportAndFinalizeAsync("deleted-create-parent");
        var parentId = await AddOrdinaryItemAsync("Template destination");
        TemplateApplicationPlan staged;
        var begin = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (begin.ConfigureAwait(false))
        {
            var result = await begin.Resolve<TemplateStore>().BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Create,
                null,
                parentId,
                null,
                "deleted-create-parent-application",
                Cancellation);
            Assert.True(result.IsSuccess);
            staged = result.Value;
            await begin.CommitAsync(Cancellation);
        }

        await SetLifecycleAsync(parentId, ItemLifecycleState.Deleted);
        var finalize = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (finalize.ConfigureAwait(false))
        {
            var result = await finalize.Resolve<TemplateStore>().FinalizeApplicationAsync(
                staged.ApplicationId,
                [],
                Cancellation);
            Assert.True(result.IsFailure);
            Assert.All(
                await finalize.DbContext.Items.IgnoreQueryFilters()
                    .Where(item => staged.CreatedItems.Select(created => created.ItemId).Contains(item.Id))
                    .ToListAsync(Cancellation),
                item => Assert.Equal(ItemLifecycleState.Provisioning, item.LifecycleState));
        }
    }

    [Fact]
    public async Task Reapplication_refuses_a_deleted_historical_mapping_without_resurrecting_it()
    {
        var templateId = await ImportAndFinalizeAsync("deleted-history-target");
        ItemId mappedChild;
        var first = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (first.ConfigureAwait(false))
        {
            var staged = await first.Resolve<TemplateStore>().BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Merge,
                ItemId.From(M0SchemaSeed.Alpha.ItemId),
                null,
                null,
                "deleted-history-first",
                Cancellation);
            Assert.True(staged.IsSuccess);
            mappedChild = Assert.Single(staged.Value.CreatedItems).ItemId;
            Assert.True((await first.Resolve<TemplateStore>().FinalizeApplicationAsync(
                staged.Value.ApplicationId,
                [],
                Cancellation)).IsSuccess);
            await first.CommitAsync(Cancellation);
        }

        await SetLifecycleAsync(mappedChild, ItemLifecycleState.Deleted);
        var retry = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (retry.ConfigureAwait(false))
        {
            var store = retry.Resolve<TemplateStore>();
            var preflight = await store.PreflightAsync(
                templateId,
                TemplateApplicationMode.Merge,
                ItemId.From(M0SchemaSeed.Alpha.ItemId),
                null,
                Cancellation);
            Assert.True(preflight.IsSuccess);
            Assert.False(preflight.Value.CanApply);
            Assert.Contains(preflight.Value.Conflicts, conflict => conflict.Contains(
                "previously mapped",
                StringComparison.OrdinalIgnoreCase));

            var begun = await store.BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Merge,
                ItemId.From(M0SchemaSeed.Alpha.ItemId),
                null,
                null,
                "deleted-history-second",
                Cancellation);
            Assert.True(begun.IsFailure);
            Assert.Equal(ItemLifecycleState.Deleted, (await retry.DbContext.Items.IgnoreQueryFilters()
                .SingleAsync(item => item.Id == mappedChild, Cancellation)).LifecycleState);
        }
    }

    [Fact]
    public async Task Expiry_sweep_removes_at_most_one_fixed_batch()
    {
        const int stagedCount = 30;
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var templateId = (await work.DbContext.WorkspaceTemplates.FirstAsync(Cancellation)).Id;
            var before = await work.DbContext.TemplateOperations.CountAsync(
                operation => operation.State == TemplateOperationState.Aborted,
                Cancellation);
            work.DbContext.TemplateOperations.AddRange(Enumerable.Range(0, stagedCount).Select(index =>
                new TemplateOperation
                {
                    Id = TemplateOperationId.Create(),
                    TenantId = TestTenants.AlphaContext.TenantId,
                    WorkspaceId = WorkspaceId.From(TestTenants.AlphaWorkspace),
                    TemplateId = templateId,
                    Kind = TemplateOperationKind.Import,
                    IdempotencyKey = $"sweep-bound-{index}",
                    ActorId = TestTenants.AlphaContext.PrincipalId,
                    State = TemplateOperationState.Aborted,
                    CreatedAt = DateTimeOffset.UnixEpoch,
                    ExpiresAt = DateTimeOffset.UnixEpoch,
                }));
            await work.DbContext.SaveChangesAsync(Cancellation);

            var swept = await work.Resolve<TemplateStore>().SweepExpiredAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                Cancellation);
            Assert.True(swept.IsSuccess);
            Assert.Equal(25, swept.Value.Removed);
            Assert.Equal(before + stagedCount - 25, await work.DbContext.TemplateOperations.CountAsync(
                operation => operation.State == TemplateOperationState.Aborted,
                Cancellation));
        }
    }

    [Fact]
    public async Task Concurrent_catalog_creation_enforces_the_workspace_bound_under_lock()
    {
        const int maximumCatalogTemplates = 1000;
        var setup = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (setup.ConfigureAwait(false))
        {
            var current = await setup.DbContext.WorkspaceTemplates.CountAsync(Cancellation);
            var now = DateTimeOffset.UtcNow;
            setup.DbContext.WorkspaceTemplates.AddRange(Enumerable.Range(0, maximumCatalogTemplates - current - 1)
                .Select(index => new WorkspaceTemplate
                {
                    Id = TemplateId.Create(),
                    TenantId = TestTenants.AlphaContext.TenantId,
                    WorkspaceId = WorkspaceId.From(TestTenants.AlphaWorkspace),
                    StableKey = $"catalog-bound.{index}",
                    ProfileKey = $"catalog-bound.{index}",
                    Origin = TemplateOrigin.User,
                    Title = $"Catalog bound {index}",
                    IncludeBody = false,
                    IncludeChildren = false,
                    State = TemplateState.Inactive,
                    Revision = 1,
                    CreatedBy = TestTenants.AlphaContext.PrincipalId,
                    LastModifiedBy = TestTenants.AlphaContext.PrincipalId,
                    CreatedAt = now,
                    LastModifiedAt = now,
                }));
            await setup.DbContext.SaveChangesAsync(Cancellation);
            await setup.CommitAsync(Cancellation);
        }

        async Task<bool> ImportAsync(string key)
        {
            var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                var result = await work.Resolve<TemplateStore>().BeginImportAsync(
                    WorkspaceId.From(TestTenants.AlphaWorkspace),
                    key,
                    Descriptor(),
                    [Items()[0]],
                    Cancellation);
                await work.CommitAsync(Cancellation);
                return result.IsSuccess;
            }
        }

        var outcomes = await Task.WhenAll(
            ImportAsync("catalog-bound-first"),
            ImportAsync("catalog-bound-second"));
        Assert.Single(outcomes, static outcome => outcome);

        var verify = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (verify.ConfigureAwait(false))
        {
            Assert.Equal(maximumCatalogTemplates, await verify.DbContext.WorkspaceTemplates.CountAsync(Cancellation));
        }
    }

    [Fact]
    public async Task Revoking_workspace_access_blocks_staged_finalization_and_idempotent_replay()
    {
        var activeTemplateId = await ImportAndFinalizeAsync("revoked-access-active-template");
        TemplateImportPlan stagedImport;
        TemplateApplicationPlan stagedApplication;
        var staging = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (staging.ConfigureAwait(false))
        {
            var store = staging.Resolve<TemplateStore>();
            var imported = await store.BeginImportAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                "revoked-access-import",
                Descriptor(),
                Items(),
                Cancellation);
            Assert.True(imported.IsSuccess);
            stagedImport = imported.Value;

            var applied = await store.BeginApplicationAsync(
                activeTemplateId,
                TemplateApplicationMode.Create,
                null,
                null,
                null,
                "revoked-access-application",
                Cancellation);
            Assert.True(applied.IsSuccess);
            stagedApplication = applied.Value;
            await staging.CommitAsync(Cancellation);
        }

        await RevokeAlphaAccessAsync();
        var revoked = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (revoked.ConfigureAwait(false))
        {
            var store = revoked.Resolve<TemplateStore>();
            Assert.True((await store.FinalizeOperationAsync(
                stagedImport.OperationId!.Value,
                [],
                Cancellation)).IsFailure);
            Assert.True((await store.FinalizeApplicationAsync(
                stagedApplication.ApplicationId,
                [],
                Cancellation)).IsFailure);
            Assert.True((await store.BeginImportAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                "revoked-access-import",
                Descriptor(),
                Items(),
                Cancellation)).IsFailure);
            Assert.True((await store.BeginApplicationAsync(
                activeTemplateId,
                TemplateApplicationMode.Create,
                null,
                null,
                null,
                "revoked-access-application",
                Cancellation)).IsFailure);
        }
    }

    [Fact]
    public async Task Rolling_back_application_finalization_leaves_target_and_staging_unchanged()
    {
        var templateId = await ImportAndFinalizeAsync("application-finalize-rollback");
        TemplateApplicationPlan application;
        var begun = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (begun.ConfigureAwait(false))
        {
            var result = await begun.Resolve<TemplateStore>().BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Merge,
                ItemId.From(M0SchemaSeed.Alpha.ItemId),
                null,
                null,
                "application-finalize-rollback",
                Cancellation);
            Assert.True(result.IsSuccess);
            application = result.Value;
            await begun.CommitAsync(Cancellation);
        }

        var finalization = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (finalization.ConfigureAwait(false))
        {
            var finalized = await finalization.Resolve<TemplateStore>().FinalizeApplicationAsync(
                application.ApplicationId,
                [],
                Cancellation);
            Assert.True(finalized.IsSuccess);
            Assert.NotNull((await finalization.DbContext.Items.SingleAsync(
                item => item.Id == ItemId.From(M0SchemaSeed.Alpha.ItemId),
                Cancellation)).Schema);
        }

        var verification = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (verification.ConfigureAwait(false))
        {
            var target = await verification.DbContext.Items.SingleAsync(
                item => item.Id == ItemId.From(M0SchemaSeed.Alpha.ItemId),
                Cancellation);
            Assert.Null(target.Schema);
            Assert.Null(target.Views);
            Assert.Equal(TemplateOperationState.Provisioning, (await verification.DbContext.TemplateApplications
                .SingleAsync(candidate => candidate.Id == application.ApplicationId, Cancellation)).State);
            Assert.All(
                await verification.DbContext.Items.IgnoreQueryFilters()
                    .Where(item => application.CreatedItems.Select(created => created.ItemId).Contains(item.Id))
                    .ToListAsync(Cancellation),
                item => Assert.Equal(ItemLifecycleState.Provisioning, item.LifecycleState));
        }
    }

    [Fact]
    public async Task Merging_into_a_3200_child_container_does_not_sequentially_scan_existing_children()
    {
        const int childCount = 3_200;
        var templateId = await ImportAndFinalizeAsync("large-target-no-scan");
        await SeedStressChildrenAsync(childCount);
        await Task.Delay(TimeSpan.FromSeconds(1.1), Cancellation);
        var since = DateTime.UtcNow;

        TemplateApplicationPlan application;
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<TemplateStore>().BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Merge,
                ItemId.From(M0SchemaSeed.Alpha.ItemId),
                null,
                null,
                "large-target-no-scan",
                Cancellation);
            Assert.True(result.IsSuccess);
            application = result.Value;
            Assert.Single(application.CreatedItems);
            await work.CommitAsync(Cancellation);
        }

        var statements = (await _fixture.ServerLogLinesSinceAsync(since))
            .Select(line => line.Replace("\"", string.Empty, StringComparison.Ordinal).ToUpperInvariant())
            .ToArray();
        Assert.Contains(statements, line => line.Contains(
            "FROM TEMPLATE_APPLICATION AS",
            StringComparison.Ordinal));
        Assert.Equal(2, statements.Count(line => line.Contains(
            "SELECT ANCESTOR.SCHEMA, EDGE.DEPTH",
            StringComparison.Ordinal)));
        Assert.DoesNotContain(statements, line =>
            line.Contains("PARENT_ID = $", StringComparison.Ordinal));

        var verification = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (verification.ConfigureAwait(false))
        {
            Assert.Equal(childCount, await verification.DbContext.Items.CountAsync(
                item => item.ParentId == ItemId.From(M0SchemaSeed.Alpha.ItemId),
                Cancellation));
        }
    }

    [Fact]
    public async Task Staging_and_revision_cleanup_cascades_bodies_without_touching_ordinary_content()
    {
        TemplateImportPlan imported;
        var begunImport = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (begunImport.ConfigureAwait(false))
        {
            var result = await begunImport.Resolve<TemplateStore>().BeginImportAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                "body-lifecycle-import",
                Descriptor(),
                ItemsWithRootBody(),
                Cancellation);
            Assert.True(result.IsSuccess);
            imported = result.Value;
            await begunImport.CommitAsync(Cancellation);
        }

        var importedRoot = imported.ItemMappings.Single(mapping => mapping.SourceId == RootSource).ItemId;
        var importedDocument = await AddBodyAsync(importedRoot);
        TemplateId templateId;
        var completedImport = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (completedImport.ConfigureAwait(false))
        {
            var finalized = await completedImport.Resolve<TemplateStore>().FinalizeOperationAsync(
                imported.OperationId!.Value,
                [importedRoot],
                Cancellation);
            Assert.True(finalized.IsSuccess);
            templateId = finalized.Value;
            await completedImport.CommitAsync(Cancellation);
        }

        int ordinaryDocuments;
        var ordinaryRead = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (ordinaryRead.ConfigureAwait(false))
        {
            ordinaryDocuments = await ordinaryRead.DbContext.ContentDocs.CountAsync(
                document => document.ItemId == ItemId.From(M0SchemaSeed.Alpha.ItemId),
                Cancellation);
        }

        TemplateApplicationPlan abandonedApplication;
        var begunApplication = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (begunApplication.ConfigureAwait(false))
        {
            var result = await begunApplication.Resolve<TemplateStore>().BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Create,
                null,
                null,
                null,
                "body-lifecycle-abort-application",
                Cancellation);
            Assert.True(result.IsSuccess);
            abandonedApplication = result.Value;
            await begunApplication.CommitAsync(Cancellation);
        }

        var abandonedApplicationRoot = abandonedApplication.BodyCopies.Single().TargetItemId;
        var abandonedApplicationDocument = await AddBodyAsync(abandonedApplicationRoot);
        var abortedApplication = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (abortedApplication.ConfigureAwait(false))
        {
            Assert.True((await abortedApplication.Resolve<TemplateStore>().AbortApplicationAsync(
                abandonedApplication.ApplicationId,
                Cancellation)).IsSuccess);
            await abortedApplication.CommitAsync(Cancellation);
        }
        await AssertBodyWasDeletedAsync(abandonedApplicationRoot, abandonedApplicationDocument);

        TemplateApplicationPlan expiredApplication;
        var begunExpiry = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (begunExpiry.ConfigureAwait(false))
        {
            var result = await begunExpiry.Resolve<TemplateStore>().BeginApplicationAsync(
                templateId,
                TemplateApplicationMode.Create,
                null,
                null,
                null,
                "body-lifecycle-expire-application",
                Cancellation);
            Assert.True(result.IsSuccess);
            expiredApplication = result.Value;
            await begunExpiry.CommitAsync(Cancellation);
        }

        var expiredApplicationRoot = expiredApplication.BodyCopies.Single().TargetItemId;
        var expiredApplicationDocument = await AddBodyAsync(expiredApplicationRoot);
        var sweptExpiry = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (sweptExpiry.ConfigureAwait(false))
        {
            await sweptExpiry.DbContext.TemplateApplications
                .Where(application => application.Id == expiredApplication.ApplicationId)
                .ExecuteUpdateAsync(
                    update => update.SetProperty(
                        application => application.ExpiresAt,
                        DateTimeOffset.UnixEpoch),
                    Cancellation);
            var swept = await sweptExpiry.Resolve<TemplateStore>().SweepExpiredAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace),
                Cancellation);
            Assert.True(swept.IsSuccess);
            Assert.Contains(expiredApplicationRoot, swept.Value.ItemIds);
            await sweptExpiry.CommitAsync(Cancellation);
        }
        await AssertBodyWasDeletedAsync(expiredApplicationRoot, expiredApplicationDocument);

        TemplateDraftPlan discardedDraft;
        var begunDiscard = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (begunDiscard.ConfigureAwait(false))
        {
            var result = await begunDiscard.Resolve<TemplateStore>().BeginDraftAsync(
                templateId,
                "body-lifecycle-discard-draft",
                Cancellation);
            Assert.True(result.IsSuccess);
            discardedDraft = result.Value;
            await begunDiscard.CommitAsync(Cancellation);
        }

        var discardedDraftRoot = discardedDraft.BodyCopies.Single().TargetItemId;
        var discardedDraftDocument = await AddBodyAsync(discardedDraftRoot);
        var discarded = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (discarded.ConfigureAwait(false))
        {
            Assert.True((await discarded.Resolve<TemplateStore>().AbortOperationAsync(
                discardedDraft.OperationId,
                Cancellation)).IsSuccess);
            await discarded.CommitAsync(Cancellation);
        }
        await AssertBodyWasDeletedAsync(discardedDraftRoot, discardedDraftDocument);

        TemplateDraftPlan replacementDraft;
        var begunReplacement = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (begunReplacement.ConfigureAwait(false))
        {
            var result = await begunReplacement.Resolve<TemplateStore>().BeginDraftAsync(
                templateId,
                "body-lifecycle-replace-draft",
                Cancellation);
            Assert.True(result.IsSuccess);
            replacementDraft = result.Value;
            await begunReplacement.CommitAsync(Cancellation);
        }

        var replacementRoot = replacementDraft.BodyCopies.Single().TargetItemId;
        var replacementDocument = await AddBodyAsync(replacementRoot);
        var savedReplacement = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (savedReplacement.ConfigureAwait(false))
        {
            Assert.True((await savedReplacement.Resolve<TemplateStore>().SaveDraftAsync(
                templateId,
                replacementDraft.OperationId,
                Cancellation)).IsSuccess);
            await savedReplacement.CommitAsync(Cancellation);
        }
        await AssertBodyWasDeletedAsync(importedRoot, importedDocument);

        var deletedTemplate = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (deletedTemplate.ConfigureAwait(false))
        {
            Assert.True(await deletedTemplate.DbContext.ContentDocs.AnyAsync(
                document => document.Id == replacementDocument,
                Cancellation));
            Assert.True((await deletedTemplate.Resolve<TemplateStore>().DeleteAsync(templateId, Cancellation)).IsSuccess);
            await deletedTemplate.CommitAsync(Cancellation);
        }
        await AssertBodyWasDeletedAsync(replacementRoot, replacementDocument);

        var ordinaryAfter = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (ordinaryAfter.ConfigureAwait(false))
        {
            Assert.Equal(ordinaryDocuments, await ordinaryAfter.DbContext.ContentDocs.CountAsync(
                document => document.ItemId == ItemId.From(M0SchemaSeed.Alpha.ItemId),
                Cancellation));
        }
    }

    private async Task<TemplateId> ImportAndFinalizeAsync(
        string idempotencyKey,
        Nix.Abstractions.NixSessionContext? context = null,
        string? rootSchema = null)
    {
        var selected = context ?? TestTenants.AlphaContext;
        var work = await _fixture.Application.BeginUnitOfWorkAsync(selected, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<TemplateStore>();
            var begun = await store.BeginImportAsync(
                selected.WorkspaceId!.Value,
                $"{idempotencyKey}-import",
                Descriptor(),
                rootSchema is null ? Items() : [Items()[0] with { Schema = rootSchema }, Items()[1]],
                Cancellation);
            Assert.True(begun.IsSuccess);
            var finalized = await store.FinalizeOperationAsync(begun.Value.OperationId!.Value, [], Cancellation);
            Assert.True(finalized.IsSuccess);
            await work.CommitAsync(Cancellation);
            return finalized.Value;
        }
    }

    private async Task<(TemplateId TemplateId, TemplateOperationId OperationId)> FinalizeManagedRevisionAsync(
        Nix.Abstractions.NixSessionContext context,
        string stableKey,
        int revision)
    {
        var descriptor = Descriptor() with
        {
            StableKey = stableKey,
            Origin = TemplateOrigin.Managed,
            ManagedSource = $"/templates/{stableKey}.nix",
            Digest = revision.ToString("x", CultureInfo.InvariantCulture).PadLeft(64, '0'),
        };
        var work = await _fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<TemplateStore>();
            var begun = await store.BeginImportAsync(
                context.WorkspaceId!.Value,
                $"{stableKey}-revision-{revision}",
                descriptor,
                [Items()[0]],
                Cancellation);
            Assert.True(begun.IsSuccess);
            var operationId = begun.Value.OperationId!.Value;
            var finalized = await store.FinalizeManagedBatchAsync(
                context.WorkspaceId.Value,
                [new ManagedTemplateFinalization(
                    operationId,
                    begun.Value.TemplateId,
                    stableKey,
                    descriptor.Digest,
                    [])],
                [stableKey],
                Cancellation);
            Assert.True(finalized.IsSuccess);
            await work.CommitAsync(Cancellation);
            return (begun.Value.TemplateId, operationId);
        }
    }

    private async Task SeedTemplateHistoryAsync(
        TemplateId templateId,
        ItemId sourceRoot,
        int historyCount)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        await using (var command = new NpgsqlCommand(
            """
            INSERT INTO template_application
                (application_id, tenant_id, workspace_id, template_id, target_item_id, mode,
                 idempotency_key, actor_id, state, created_at, expires_at, finalized_at)
            SELECT md5('large-delete-application:' || n)::uuid,
                   @tenant, @workspace, @template, @target, 'merge',
                   'large-delete-application-' || n, @actor, 'active', now(), now(), now()
              FROM generate_series(1, @history_count) AS n;

            INSERT INTO template_application_item
                (application_id, tenant_id, template_source_id, source_item_id, item_type,
                 target_item_id, is_root, created, body_required)
            SELECT md5('large-delete-application:' || n)::uuid,
                   @tenant, @source_identity, @source_root, 'note', @target, true, false, false
              FROM generate_series(1, @history_count) AS n;

            INSERT INTO template_operation
                (operation_id, tenant_id, workspace_id, template_id, kind, idempotency_key,
                 actor_id, state, created_at, expires_at, finalized_at)
            SELECT md5('large-delete-operation:' || n)::uuid,
                   @tenant, @workspace, @template, 'import',
                   'large-delete-operation-' || n, @actor, 'active', now(), now(), now()
              FROM generate_series(1, @history_count) AS n;

            """,
            connection))
        {
            command.Parameters.AddWithValue("tenant", TestTenants.Alpha);
            command.Parameters.AddWithValue("workspace", TestTenants.AlphaWorkspace);
            command.Parameters.AddWithValue("template", templateId.Value);
            command.Parameters.AddWithValue("target", M0SchemaSeed.Alpha.ItemId);
            command.Parameters.AddWithValue("actor", TestTenants.AlphaPrincipal);
            command.Parameters.AddWithValue("source_identity", RootSource);
            command.Parameters.AddWithValue("source_root", sourceRoot.Value);
            command.Parameters.AddWithValue("history_count", historyCount);
            await command.ExecuteNonQueryAsync(Cancellation);
        }
    }

    private static TemplateImportDescriptor Descriptor() => new(
        "team.template",
        "Template",
        "A test template",
        TemplateOrigin.User,
        null,
        new string('a', 64),
        false,
        true);

    [Fact]
    public async Task Template_import_keeps_habit_content_and_drops_every_other_reserved_key()
    {
        // Security review F2: template content may carry habit and finance groups, and nothing
        // else from the $ space - not a structural query field, not a calendar mirror key.
        var root = Items()[0] with
        {
            Properties = """{"title":"Template root","answer":"a","$type":"task","$cal_source":"google","$custom":1,"$habit_unit":"times"}""",
        };
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var begun = await work.Resolve<TemplateStore>().BeginImportAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace), "reserved-key-import", Descriptor(), [root], Cancellation);
            Assert.True(begun.IsSuccess, begun.IsFailure ? begun.Error.ToString() : null);

            var staged = await work.DbContext.Items.IgnoreQueryFilters().AsNoTracking()
                .SingleAsync(item => item.TemplateId == begun.Value.TemplateId && item.ParentId == null, Cancellation);
            var bag = Assert.IsType<JsonObject>(JsonNode.Parse(staged.Properties!));
            Assert.False(bag.ContainsKey("$type"));
            Assert.False(bag.ContainsKey("$cal_source"));
            Assert.False(bag.ContainsKey("$custom"));
            Assert.Equal("times", (string?)bag["$habit_unit"]);
        }
    }

    [Fact]
    public async Task Capture_drops_reserved_keys_outside_habit_and_finance_content()
    {
        var sourceId = await AddOrdinaryItemAsync("Reserved source");
        var work = await _fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext, IsolationLevel.RepeatableRead, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            // Written past the generic writer, as a legacy bag would be.
            await work.DbContext.Items.Where(item => item.Id == sourceId)
                .ExecuteUpdateAsync(update => update.SetProperty(item => item.Properties,
                    "{\"title\":\"Reserved source\",\"$type\":\"task\",\"$cal_link\":\"x\",\"$habit_unit\":\"times\"}"), Cancellation);

            var begun = await work.Resolve<TemplateStore>().BeginCaptureAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace), sourceId, "Reserved capture", null,
                false, false, "reserved-capture", Cancellation);
            Assert.True(begun.IsSuccess, begun.IsFailure ? begun.Error.ToString() : null);

            var captured = await work.DbContext.Items.IgnoreQueryFilters().AsNoTracking()
                .SingleAsync(item => item.TemplateId == begun.Value.TemplateId && item.ParentId == null, Cancellation);
            var bag = Assert.IsType<JsonObject>(JsonNode.Parse(captured.Properties!));
            Assert.False(bag.ContainsKey("$type"));
            Assert.False(bag.ContainsKey("$cal_link"));
            Assert.Equal("times", (string?)bag["$habit_unit"]);
        }
    }

    [Theory]
    [InlineData("""{"title":"Template root","answer":"a","$habit_frequency":"daily"}""")]
    [InlineData("""{"title":"Template root","answer":"a","$habit_frequency":"daily","$habit_timezone":"UTC","$habit_start_date":"2026-01-01","$habit_target":1,"$habit_unit":"times","$habit_versions":[{"effectiveFrom":"2026-01-01","settings":{"$habit_frequency":"daily"}}]}""")]
    public async Task A_template_whose_habit_settings_are_malformed_is_refused_at_application(string properties)
    {
        // The allowlisted group is checked by the habit validator when it is applied, not trusted
        // because the template carried it.
        var root = Items()[0] with
        {
            Properties = properties,
        };
        TemplateId templateId;
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<TemplateStore>();
            var begun = await store.BeginImportAsync(
                WorkspaceId.From(TestTenants.AlphaWorkspace), "malformed-habit-import", Descriptor(), [root], Cancellation);
            Assert.True(begun.IsSuccess, begun.IsFailure ? begun.Error.ToString() : null);
            var finalized = await store.FinalizeOperationAsync(begun.Value.OperationId!.Value, [], Cancellation);
            Assert.True(finalized.IsSuccess, finalized.IsFailure ? finalized.Error.ToString() : null);
            templateId = finalized.Value;
            await work.CommitAsync(Cancellation);
        }

        var apply = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (apply.ConfigureAwait(false))
        {
            var refused = await apply.Resolve<TemplateStore>().BeginApplicationAsync(
                templateId, TemplateApplicationMode.Create, null, null, "Malformed habit", "apply-malformed-habit", Cancellation);

            Assert.True(refused.IsFailure);
            Assert.Equal("templates.invalid", refused.Error.Code);
        }
    }

    private static IReadOnlyList<TemplateImportItem> Items() =>
    [
        new TemplateImportItem(
            RootSource,
            null,
            "note",
            "Template root",
            long.MinValue,
            "{\"title\":\"Template root\",\"answer\":\"workspace-answer\"}",
            "{\"inherit\":true,\"properties\":[{\"key\":\"answer\",\"label\":\"Answer\",\"type\":\"text\",\"required\":false}]}",
            "{\"views\":[{\"id\":\"all\",\"name\":\"All\",\"kind\":\"list\",\"sortDescending\":false}],\"default\":\"all\"}",
            false),
        new TemplateImportItem(
            ChildSource,
            RootSource,
            "note",
            "Selected child",
            long.MaxValue,
            "{\"title\":\"Selected child\",\"answer\":\"selected-answer\"}",
            null,
            null,
            false),
    ];

    private static IReadOnlyList<TemplateImportItem> ItemsWithRootBody() =>
    [
        Items()[0] with { HasBody = true },
        Items()[1],
    ];

    private static string ComputedSchema(
        PropertyType type,
        string? expression = null,
        RollupAggregate? aggregate = null,
        string? source = null) => PropertySchemaJson.Write(new PropertySchema
        {
            Inherit = false,
            Properties =
            [
                new PropertyDefinition("answer", "Answer", PropertyType.Text, [], false),
                new PropertyDefinition("amount", "Amount", PropertyType.Number, [], false),
                new PropertyDefinition("budget", "Budget", PropertyType.Number, [], false),
                new PropertyDefinition("total", "Total", type, [], false,
                    type == PropertyType.Formula ? expression ?? "[amount] * 2" : null,
                    type == PropertyType.Rollup ? aggregate ?? RollupAggregate.Sum : null,
                    type == PropertyType.Rollup ? source ?? "amount" : null),
            ],
        });

    private static string LargeSchema(string key, char labelCharacter) =>
        $"{{\"inherit\":true,\"properties\":[{{\"key\":\"{key}\",\"label\":\"{new string(labelCharacter, 17_000)}\",\"type\":\"text\",\"required\":false}}]}}";

    private static string LargeViews(string id, char nameCharacter) =>
        $"{{\"views\":[{{\"id\":\"{id}\",\"name\":\"{new string(nameCharacter, 17_000)}\",\"kind\":\"list\",\"sortDescending\":false}}],\"default\":\"{id}\"}}";

    private static Item NewItem(
        string title,
        string? schema,
        ItemId? parentId,
        long seq,
        DateTimeOffset now,
        string type = "note") => new()
        {
            Id = ItemId.Create(),
            TenantId = TestTenants.AlphaContext.TenantId,
            WorkspaceId = WorkspaceId.From(TestTenants.AlphaWorkspace),
            Type = type,
            ParentId = parentId,
            Seq = seq,
            Properties = ItemProperties.WithTitle(null, title),
            Schema = schema,
            LifecycleState = ItemLifecycleState.Active,
            CreatedBy = TestTenants.AlphaContext.PrincipalId,
            LastModifiedBy = TestTenants.AlphaContext.PrincipalId,
            CreatedAt = now,
            LastModifiedAt = now,
        };

    private async Task<ItemId> AddOrdinaryItemAsync(string title)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var item = NewItem(title, null, null, 90_000, DateTimeOffset.UtcNow);
            work.DbContext.Items.Add(item);
            await work.DbContext.SaveChangesAsync(Cancellation);
            await work.DbContext.Database.ExecuteSqlInterpolatedAsync(
                $"INSERT INTO item_closure (tenant_id, workspace_id, ancestor_id, descendant_id, depth) VALUES ({item.TenantId.Value}, {item.WorkspaceId.Value}, {item.Id.Value}, {item.Id.Value}, 0)",
                Cancellation);
            await work.CommitAsync(Cancellation);
            return item.Id;
        }
    }

    private async Task SetLifecycleAsync(ItemId itemId, ItemLifecycleState state)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            await work.DbContext.Items.IgnoreQueryFilters()
                .Where(item => item.Id == itemId)
                .ExecuteUpdateAsync(
                    update => update.SetProperty(item => item.LifecycleState, state),
                    Cancellation);
            await work.CommitAsync(Cancellation);
        }
    }

    private async Task<ContentDocId> AddBodyAsync(ItemId itemId)
    {
        var now = DateTimeOffset.UtcNow;
        var documentId = ContentDocId.Create();
        var builder = new NpgsqlConnectionStringBuilder(_fixture.ApplicationConnectionString)
        {
            Username = NixDatabaseRoles.Collaboration,
            Password = NixDatabaseRoles.Password,
        };
        await using var connection = new NpgsqlConnection(builder.ConnectionString);
        await connection.OpenAsync(Cancellation);
        await using var transaction = await connection.BeginTransactionAsync(Cancellation);
        await using var command = new NpgsqlCommand(
            """
            SELECT set_config('nix.tenant_id', @tenant_id, true);
            INSERT INTO content_doc
                (doc_id, tenant_id, item_id, workspace_id, schema_version, head_seq, created_at)
            VALUES (@doc_id, @tenant_id::uuid, @item_id, @workspace_id, 1, 1, @created_at);
            INSERT INTO content_update
                (doc_id, seq, tenant_id, update_bytes, actor_id, client_id, created_at)
            VALUES (@doc_id, 1, @tenant_id::uuid, decode('01', 'hex'), @actor_id, 'template-lifecycle-test', @created_at);
            INSERT INTO content_snapshot
                (doc_id, seq, tenant_id, yjs_state, prosemirror_json, plaintext, created_at)
            VALUES (@doc_id, 1, @tenant_id::uuid, decode('01', 'hex'), '{"type":"doc","content":[]}'::jsonb, '', @created_at);
            """,
            connection,
            transaction);
        command.Parameters.AddWithValue("tenant_id", TestTenants.AlphaContext.TenantId.Value.ToString());
        command.Parameters.AddWithValue("doc_id", documentId.Value);
        command.Parameters.AddWithValue("item_id", itemId.Value);
        command.Parameters.AddWithValue("workspace_id", TestTenants.AlphaWorkspace);
        command.Parameters.AddWithValue("created_at", now);
        command.Parameters.AddWithValue("actor_id", TestTenants.AlphaContext.PrincipalId.Value);
        await command.ExecuteNonQueryAsync(Cancellation);
        await transaction.CommitAsync(Cancellation);
        return documentId;
    }

    private async Task SeedTemplateActorsAsync()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        await using (var command = new NpgsqlCommand(
            """
            INSERT INTO principal
                (principal_id, tenant_id, external_subject, kind, display_name, email, status,
                 can_manage_templates, deprovisioned_at)
            VALUES
                (@service, @tenant, 'template-managed-service', 'service', 'Template managed service',
                 NULL, 'active', true, NULL),
                (@viewer, @tenant, 'template-viewer', 'user', 'Template viewer',
                 'template-viewer@example.test', 'active', false, NULL);
            INSERT INTO workspace_member
                (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES
                (@workspace, 'principal', @service, @tenant, 'editor', @grantor, now()),
                (@workspace, 'principal', @viewer, @tenant, 'viewer', @grantor, now());
            """,
            connection))
        {
            command.Parameters.AddWithValue("service", ManagedServicePrincipal);
            command.Parameters.AddWithValue("viewer", ViewerPrincipal);
            command.Parameters.AddWithValue("tenant", TestTenants.Alpha);
            command.Parameters.AddWithValue("workspace", TestTenants.AlphaWorkspace);
            command.Parameters.AddWithValue("grantor", TestTenants.AlphaPrincipal);
            await command.ExecuteNonQueryAsync(Cancellation);
        }
    }

    private async Task RevokeAlphaAccessAsync()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        await using (var command = new NpgsqlCommand(
            """
            DELETE FROM workspace_member
             WHERE tenant_id = @tenant AND subject_id = @principal;
            DELETE FROM tenant_role
             WHERE tenant_id = @tenant AND subject_id = @principal;
            """,
            connection))
        {
            command.Parameters.AddWithValue("tenant", TestTenants.Alpha);
            command.Parameters.AddWithValue("principal", TestTenants.AlphaPrincipal);
            await command.ExecuteNonQueryAsync(Cancellation);
        }
    }

    private async Task SeedStressChildrenAsync(int childCount)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        await using (var command = new NpgsqlCommand(
            """
            WITH children AS (
                SELECT md5('template-stress-child:' || ordinal::text)::uuid AS id,
                       ordinal
                  FROM generate_series(1, @child_count) AS ordinal
            )
            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                 created_by, last_modified_by, created_at, last_modified_at)
            SELECT children.id, @tenant, @workspace, 'note', @parent, children.ordinal,
                   jsonb_build_object('title', 'Stress child ' || children.ordinal::text),
                   'active', @principal, @principal, now(), now()
              FROM children;

            INSERT INTO item_closure
                (tenant_id, workspace_id, ancestor_id, descendant_id, depth)
            SELECT @tenant, @workspace, child.id, child.id, 0
              FROM item child
             WHERE child.parent_id = @parent;

            INSERT INTO item_closure
                (tenant_id, workspace_id, ancestor_id, descendant_id, depth)
            SELECT @tenant, @workspace, @parent, child.id, 1
              FROM item child
             WHERE child.parent_id = @parent;
            """,
            connection))
        {
            command.Parameters.AddWithValue("child_count", childCount);
            command.Parameters.AddWithValue("tenant", TestTenants.Alpha);
            command.Parameters.AddWithValue("workspace", TestTenants.AlphaWorkspace);
            command.Parameters.AddWithValue("parent", M0SchemaSeed.Alpha.ItemId);
            command.Parameters.AddWithValue("principal", TestTenants.AlphaPrincipal);
            await command.ExecuteNonQueryAsync(Cancellation);
        }
    }

    private async Task AssertBodyWasDeletedAsync(ItemId itemId, ContentDocId documentId)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            Assert.False(await work.DbContext.Items.IgnoreQueryFilters().AnyAsync(
                item => item.Id == itemId,
                Cancellation));
            Assert.False(await work.DbContext.ContentDocs.AnyAsync(
                document => document.Id == documentId,
                Cancellation));
            Assert.False(await work.DbContext.ContentUpdates.AnyAsync(
                update => update.DocId == documentId,
                Cancellation));
            Assert.False(await work.DbContext.ContentSnapshots.AnyAsync(
                snapshot => snapshot.DocId == documentId,
                Cancellation));
        }
    }

    private sealed class ReaderQueryCaptureInterceptor : DbCommandInterceptor
    {
        public List<string> Statements { get; } = [];

        public override ValueTask<DbDataReader> ReaderExecutedAsync(
            DbCommand command,
            CommandExecutedEventData eventData,
            DbDataReader result,
            CancellationToken cancellationToken = default)
        {
            ArgumentNullException.ThrowIfNull(command);
            Statements.Add(command.CommandText);
            return base.ReaderExecutedAsync(command, eventData, result, cancellationToken);
        }
    }

    private sealed class TaggedExplainInterceptor(string marker) : DbCommandInterceptor
    {
        public string? Plan { get; private set; }

        public override async ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
            DbCommand command,
            CommandEventData eventData,
            InterceptionResult<DbDataReader> result,
            CancellationToken cancellationToken = default)
        {
            ArgumentNullException.ThrowIfNull(command);
            if (Plan is null && command.CommandText.Contains(marker, StringComparison.Ordinal))
            {
                Plan = await ExplainAsync(command, cancellationToken);
            }

            return await base.ReaderExecutingAsync(command, eventData, result, cancellationToken);
        }

        private static async Task<string> ExplainAsync(DbCommand command, CancellationToken cancellationToken)
        {
            if (command.Connection is not NpgsqlConnection connection
                || command.Transaction is not NpgsqlTransaction transaction)
            {
                throw new InvalidOperationException("The captured query must use the Npgsql runtime-role transaction.");
            }

            // The command is selected by a fixed EF TagWith marker; its SQL and parameters come from EF.
#pragma warning disable CA2100 // Review SQL queries for security vulnerabilities
            var explain = new NpgsqlCommand("EXPLAIN (ANALYZE, BUFFERS) " + command.CommandText, connection, transaction);
#pragma warning restore CA2100 // Review SQL queries for security vulnerabilities
            await using (explain.ConfigureAwait(false))
            {
                foreach (DbParameter parameter in command.Parameters)
                {
                    if (parameter is not NpgsqlParameter source)
                    {
                        throw new InvalidOperationException("The captured query contained a non-Npgsql parameter.");
                    }

                    var copy = new NpgsqlParameter
                    {
                        ParameterName = source.ParameterName,
                        Direction = source.Direction,
                        IsNullable = source.IsNullable,
                        Size = source.Size,
                        Precision = source.Precision,
                        Scale = source.Scale,
                        Value = source.Value,
                    };
                    if (source.NpgsqlDbType != NpgsqlDbType.Unknown)
                    {
                        copy.NpgsqlDbType = source.NpgsqlDbType;
                    }
                    else
                    {
                        copy.DbType = source.DbType;
                    }

                    explain.Parameters.Add(copy);
                }

                var plan = new StringBuilder();
                await using var reader = await explain.ExecuteReaderAsync(cancellationToken);
                while (await reader.ReadAsync(cancellationToken))
                {
                    plan.AppendLine(reader.GetString(0));
                }

                return plan.ToString();
            }
        }
    }
}
