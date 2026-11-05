using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Abstractions.Importing;
using Nix.Abstractions.Workers;
using Nix.Domain.Files;
using Nix.Domain.Identity;
using Nix.Domain.Importing;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Persistence.Templates;

namespace Nix.Persistence.ObjectStorage;

/// <summary>Expires abandoned object-owning operations and queues idempotent byte cleanup.</summary>
public sealed class AbandonedObjectReaper(
    AbandonedObjectOperationStore operations,
    IServiceScopeFactory scopes,
    TimeProvider clock,
    ILogger<AbandonedObjectReaper>? logger = null) : BackgroundService
{
    private const int BatchSize = 100;
    private static readonly TimeSpan EmptyDelay = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan FailureDelay = TimeSpan.FromSeconds(5);
    private readonly ILogger<AbandonedObjectReaper> _logger = logger ?? NullLogger<AbandonedObjectReaper>.Instance;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var reaped = await ReapOnceAsync(stoppingToken).ConfigureAwait(false);
                if (reaped == 0)
                {
                    await Task.Delay(EmptyDelay, clock, stoppingToken).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
#pragma warning disable CA1031 // Justification: expiry cleanup is durable and must retry after any transient database failure.
            catch (Exception exception)
            {
                AbandonedObjectReaperLog.Failed(_logger, exception);
                await Task.Delay(FailureDelay, clock, stoppingToken).ConfigureAwait(false);
            }
#pragma warning restore CA1031
        }
    }

    /// <summary>Processes one bounded batch; exposed for operational probes and integration tests.</summary>
    public async Task<int> ReapOnceAsync(CancellationToken cancellationToken)
    {
        var candidates = await operations.FindAsync(BatchSize, cancellationToken).ConfigureAwait(false);
        var reaped = 0;
        foreach (var candidate in candidates)
        {
            if (await ReapAsync(candidate, cancellationToken).ConfigureAwait(false))
            {
                reaped++;
            }
        }
        return reaped;
    }

    private async ValueTask<bool> ReapAsync(
        AbandonedObjectOperation candidate,
        CancellationToken cancellationToken)
    {
        var scope = scopes.CreateAsyncScope();
        await using (scope.ConfigureAwait(false))
        {
            var provider = scope.ServiceProvider;
            provider.GetRequiredService<ScopedNixSessionContextAccessor>().Set(new NixSessionContext(
                TenantId.From(candidate.TenantId),
                WorkspaceId.From(candidate.WorkspaceId),
                PrincipalId.From(candidate.ActorId)));
            var database = provider.GetRequiredService<NixDbContext>();
            var transaction = await database.Database.BeginTransactionAsync(cancellationToken).ConfigureAwait(false);
            await using (transaction.ConfigureAwait(false))
            {
                var reaped = candidate.OwnerKind switch
                {
                    "document-import" => await ReapImportAsync(provider, candidate, cancellationToken).ConfigureAwait(false),
                    "file-upload" => await ReapFileAsync(provider, candidate, cancellationToken).ConfigureAwait(false),
                    _ => false,
                };
                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                return reaped;
            }
        }
    }

    private async ValueTask<bool> ReapImportAsync(
        IServiceProvider provider,
        AbandonedObjectOperation candidate,
        CancellationToken cancellationToken)
    {
        var imports = provider.GetRequiredService<IDocumentImportStore>();
        var importId = DocumentImportId.From(candidate.OwnerId);
        var operation = await imports.GetAsync(importId, cancellationToken).ConfigureAwait(false);
        if (operation is null
            || operation.ExpiresAt > clock.GetUtcNow()
            || operation.Status is DocumentImportStatuses.Completed
                or DocumentImportStatuses.Cancelled
                or DocumentImportStatuses.Failed)
        {
            return false;
        }

        var jobs = provider.GetRequiredService<IWorkerJobStore>();
        if (operation.PreviewJobId is { } previewJobId)
        {
            await jobs.CancelAsync(
                TenantId.From(candidate.TenantId),
                PrincipalId.From(candidate.ActorId),
                previewJobId,
                cancellationToken).ConfigureAwait(false);
        }
        if (operation.CommitJobId is { } commitJobId)
        {
            await jobs.CancelAsync(
                TenantId.From(candidate.TenantId),
                PrincipalId.From(candidate.ActorId),
                commitJobId,
                cancellationToken).ConfigureAwait(false);
        }

        if (operation.TemplateOperationId is { } templateOperationId
            && !await provider.GetRequiredService<TemplateStore>()
                .ReapAbandonedImportStageAsync(
                    WorkspaceId.From(operation.WorkspaceId),
                    TemplateOperationId.From(templateOperationId),
                    cancellationToken)
                .ConfigureAwait(false))
        {
            return false;
        }

        var cleanup = await imports.FailAsync(
            importId,
            "import_expired",
            cancellationToken).ConfigureAwait(false);
        if (cleanup is null)
        {
            return false;
        }
        await ObjectCleanupJobs.QueueBatchedAsync(
            jobs,
            TenantId.From(candidate.TenantId),
            PrincipalId.From(candidate.ActorId),
            WorkspaceId.From(cleanup.WorkspaceId),
            candidate.OwnerKind,
            candidate.OwnerId,
            clock.GetUtcNow(),
            cleanup.ObjectKeys,
            cancellationToken).ConfigureAwait(false);
        return true;
    }

    private async ValueTask<bool> ReapFileAsync(
        IServiceProvider provider,
        AbandonedObjectOperation candidate,
        CancellationToken cancellationToken)
    {
        var files = provider.GetRequiredService<IFileStore>();
        var uploadId = FileUploadId.From(candidate.OwnerId);
        var upload = await files.GetUploadAsync(uploadId, cancellationToken).ConfigureAwait(false);
        if (upload is null
            || upload.Purpose != FileUploadPurposes.File
            || upload.ExpiresAt > clock.GetUtcNow()
            || upload.Status is not ("pending_upload" or "inspection_queued")
            || !await files.RejectAsync(uploadId, "upload_expired", cancellationToken).ConfigureAwait(false))
        {
            return false;
        }

        await ObjectCleanupJobs.QueueAsync(
            provider.GetRequiredService<IWorkerJobStore>(),
            TenantId.From(candidate.TenantId),
            PrincipalId.From(candidate.ActorId),
            WorkspaceId.From(candidate.WorkspaceId),
            candidate.OwnerKind,
            candidate.OwnerId,
            clock.GetUtcNow(),
            [
                ObjectStorageKeys.FileUpload(TenantId.From(candidate.TenantId), uploadId),
                ObjectStorageKeys.FileVersion(TenantId.From(candidate.TenantId), uploadId),
                ObjectStorageKeys.FileThumbnail(TenantId.From(candidate.TenantId), uploadId),
            ],
            cancellationToken).ConfigureAwait(false);
        return true;
    }
}

internal static partial class AbandonedObjectReaperLog
{
    [LoggerMessage(5200, LogLevel.Error, "Abandoned object cleanup failed and will retry")]
    internal static partial void Failed(ILogger logger, Exception exception);
}
