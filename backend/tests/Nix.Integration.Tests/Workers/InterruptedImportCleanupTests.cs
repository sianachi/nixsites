using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Abstractions.Importing;
using Nix.Abstractions.Workers;
using Nix.Domain.Files;
using Nix.Domain.Importing;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Integration.Tests.Harness;
using Nix.Workers;

namespace Nix.Integration.Tests.Workers;

/// <summary>
/// An import commit interrupted by a restart leaves nothing behind: the startup sweep's cleanup
/// fails the import, hard-deletes its staged tree and queues the staged objects for cleanup.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class InterruptedImportCleanupTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task An_interrupted_commit_fails_the_import_and_removes_its_staged_tree()
    {
        Guid importId;
        Guid rootItemId;
        Guid commitJobId;
        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var files = work.Resolve<IFileStore>();
            var imports = work.Resolve<IDocumentImportStore>();
            var jobs = work.Resolve<IWorkerJobStore>();
            var digest = new string('a', 64);
            var upload = Assert.IsType<FileUploadRecord>(await files.BeginAsync(
                new BeginFileUpload(WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId), null, null, "notes.nix", "application/vnd.nix.archive+zip", 128, "nix-interrupted", FileUploadPurposes.DocumentImport), Cancellation));
            var operation = Assert.IsType<DocumentImportRecord>(await imports.BeginAsync(
                new BeginDocumentImport(WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId), null, FileUploadId.From(upload.Id), "nix", "Imported note", "nix-interrupted"), Cancellation));
            var previewJob = await jobs.CreateAsync(TenantId.From(M0SchemaSeed.Alpha.TenantId), Nix.Domain.Identity.PrincipalId.From(M0SchemaSeed.Alpha.PrincipalId), WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId), "import.preview.nix", "preview-interrupted", "{}", Cancellation);
            Assert.NotNull(await imports.AttachPreviewJobAsync(DocumentImportId.From(operation.Id), Nix.Domain.Workers.WorkerJobId.From(previewJob.Id), Cancellation));
            Assert.NotNull(await imports.CompletePreviewAsync(new CompleteDocumentImportPreview(DocumentImportId.From(operation.Id), new string('b', 64), 100, digest, 2, 0, "[]", "[]"), Cancellation));
            var commitJob = await jobs.CreateAsync(TenantId.From(M0SchemaSeed.Alpha.TenantId), Nix.Domain.Identity.PrincipalId.From(M0SchemaSeed.Alpha.PrincipalId), WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId), "import.commit", "commit-interrupted", JsonSerializer.Serialize(new { importId = operation.Id }), Cancellation);
            commitJobId = commitJob.Id;
            Assert.NotNull(await imports.AttachCommitJobAsync(DocumentImportId.From(operation.Id), Nix.Domain.Workers.WorkerJobId.From(commitJob.Id), Cancellation));
            var plans = new List<ImportEnvelopePlan>
            {
                new("root", null, 0, "Imported note", "note", null, null, null, "active", true, null),
                new("child", "root", 0, "Child", "note", null, null, null, "active", true, null),
            };
            var stage = Assert.IsType<DocumentImportStageRecord>(await imports.StageAsync(new StageDocumentImport(DocumentImportId.From(operation.Id), new string('b', 64), digest, plans), Cancellation));
            importId = operation.Id;
            rootItemId = stage.RootItemId;
            await work.CommitAsync(Cancellation);
        }

        await using (var scope = fixture.Application.CreateUnscopedScope())
        {
            var cleanup = new InterruptedImportCleanup(scope.ServiceProvider.GetRequiredService<IIsolatedUnitOfWork>());
            await cleanup.CleanUpAsync(new DispatchedWorkerJob(commitJobId, M0SchemaSeed.Alpha.TenantId, M0SchemaSeed.Alpha.WorkspaceId, M0SchemaSeed.Alpha.PrincipalId, "import.commit", JsonSerializer.Serialize(new { importId }), 1, false), Cancellation);
        }

        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var record = await work.Resolve<IDocumentImportStore>().GetAsync(DocumentImportId.From(importId), Cancellation);
            Assert.NotNull(record);
            Assert.Equal("failed", record.Status);
            Assert.Equal(InterruptedJobSweep.ErrorCode, record.FailureCode);
            var remaining = await work.DbContext.Items.IgnoreQueryFilters().AsNoTracking().CountAsync(item => item.Id == ItemId.From(rootItemId) || item.ParentId == ItemId.From(rootItemId), Cancellation);
            Assert.Equal(0, remaining);
        }
    }
}
