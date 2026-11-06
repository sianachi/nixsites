using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Abstractions.Importing;
using Nix.Domain.Importing;
using Nix.Domain.Items;
using Nix.Domain.Templates;
using Nix.Domain.Workers;
using Nix.Persistence.ObjectStorage;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Importing;

public sealed partial class DocumentImportStore(
    NixDbContext database,
    IItemTree tree,
    IPermissionResolver permissions,
    INixSessionContextAccessor session,
    TemplateDefinitionValidator validator,
    TimeProvider clock) : IDocumentImportStore
{
    private const int MaximumItems = 10_000;

    private const int MaximumDepth = 64;

    private const long MaximumFileBytes = 100L * 1024 * 1024;

    private static readonly TimeSpan ImportLifetime = TimeSpan.FromHours(2);

    public async ValueTask<DocumentImportRecord?> BeginAsync(
        BeginDocumentImport request,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.Purpose is not (DocumentImportPurposes.Workspace
                or DocumentImportPurposes.TemplateUser
                or DocumentImportPurposes.TemplateManaged)
            || (DocumentImportPurposes.IsTemplate(request.Purpose) && request.ParentId is not null)
            || (request.Purpose == DocumentImportPurposes.TemplateManaged
                ? string.IsNullOrWhiteSpace(request.ManagedSource) || request.ManagedSource.Length > 500
                : request.ManagedSource is not null))
        {
            return null;
        }
        var context = Context;
        await LockIdempotencyAsync(request.IdempotencyKey, cancellationToken).ConfigureAwait(false);
        var existing = await database.DocumentImports.AsNoTracking().SingleOrDefaultAsync(
            candidate => candidate.TenantId == context.TenantId
                && candidate.ActorId == context.PrincipalId
                && candidate.IdempotencyKey == request.IdempotencyKey,
            cancellationToken).ConfigureAwait(false);
        if (existing is not null)
        {
            return existing.WorkspaceId == request.WorkspaceId
                && existing.UploadId == request.UploadId
                && existing.ParentId == request.ParentId
                && string.Equals(existing.Purpose, request.Purpose, StringComparison.Ordinal)
                && string.Equals(existing.ManagedSource, request.ManagedSource, StringComparison.Ordinal)
                && string.Equals(existing.Format, request.Format, StringComparison.Ordinal)
                && string.Equals(existing.Title, request.Title, StringComparison.Ordinal)
                    ? ToRecord(existing)
                    : null;
        }

        var upload = await database.FileUploads.AsNoTracking().SingleOrDefaultAsync(
            candidate => candidate.TenantId == context.TenantId
                && candidate.ActorId == context.PrincipalId
                && candidate.Id == request.UploadId,
            cancellationToken).ConfigureAwait(false);
        var expectedUploadPurpose = DocumentImportPurposes.IsTemplate(request.Purpose)
            ? FileUploadPurposes.TemplateImport
            : FileUploadPurposes.DocumentImport;
        if (upload is null
            || upload.Purpose != expectedUploadPurpose
            || upload.WorkspaceId != request.WorkspaceId
            || upload.ParentId != request.ParentId
            || upload.Status != "pending_upload"
            || upload.ExpiresAt <= clock.GetUtcNow())
        {
            return null;
        }
        if (!await permissions.CanWriteWorkspaceAsync(request.WorkspaceId, cancellationToken).ConfigureAwait(false)
            || (request.Purpose == DocumentImportPurposes.Workspace
                && !await ValidParentAsync(request.WorkspaceId, request.ParentId, cancellationToken).ConfigureAwait(false)))
        {
            return null;
        }

        var now = clock.GetUtcNow();
        var id = DocumentImportId.Create();
        var operation = new DocumentImport
        {
            Id = id,
            TenantId = context.TenantId,
            WorkspaceId = request.WorkspaceId,
            ActorId = context.PrincipalId,
            UploadId = request.UploadId,
            ParentId = request.ParentId,
            Purpose = request.Purpose,
            ManagedSource = request.ManagedSource,
            Format = request.Format,
            Title = request.Title,
            IdempotencyKey = request.IdempotencyKey,
            Status = DocumentImportStatuses.PendingUpload,
            PlanObjectKey = ObjectStorageKeys.ImportPlan(context.TenantId, id),
            ExpiresAt = now + ImportLifetime,
            CreatedAt = now,
            UpdatedAt = now,
        };
        database.DocumentImports.Add(operation);
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return ToRecord(operation);
    }

    public async ValueTask<DocumentImportRecord?> GetAsync(
        DocumentImportId id,
        CancellationToken cancellationToken)
    {
        var context = Context;
        var operation = await database.DocumentImports.AsNoTracking().SingleOrDefaultAsync(
            candidate => candidate.TenantId == context.TenantId
                && candidate.ActorId == context.PrincipalId
                && candidate.Id == id,
            cancellationToken).ConfigureAwait(false);
        return operation is null ? null : ToRecord(operation);
    }

    public async ValueTask<DocumentImportExecutionRecord?> GetExecutionAsync(
        DocumentImportId id,
        CancellationToken cancellationToken)
    {
        var context = Context;
        var result = await (
            from operation in database.DocumentImports.AsNoTracking()
            join upload in database.FileUploads.AsNoTracking()
                on new { operation.TenantId, operation.UploadId }
                equals new { upload.TenantId, UploadId = upload.Id }
            where operation.TenantId == context.TenantId
                && operation.ActorId == context.PrincipalId
                && operation.Id == id
            select new { Operation = operation, Upload = upload })
            .SingleOrDefaultAsync(cancellationToken).ConfigureAwait(false);
        return result is null
            ? null
            : new DocumentImportExecutionRecord(
                ToRecord(result.Operation),
                result.Upload.ObjectKey,
                result.Upload.FileName,
                result.Upload.DeclaredMediaType,
                result.Upload.DeclaredByteLength);
    }

    public ValueTask<DocumentImportRecord?> AttachPreviewJobAsync(
        DocumentImportId id,
        WorkerJobId jobId,
        CancellationToken cancellationToken) =>
        AttachJobAsync(id, jobId, preview: true, cancellationToken);

    public async ValueTask<DocumentImportRecord?> CompletePreviewAsync(
        CompleteDocumentImportPreview request,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        await LockImportAsync(request.ImportId, cancellationToken).ConfigureAwait(false);
        var operation = await OwnedTrackingAsync(request.ImportId, cancellationToken).ConfigureAwait(false);
        if (operation is null || operation.ExpiresAt <= clock.GetUtcNow())
        {
            return null;
        }
        if (operation.Status == DocumentImportStatuses.PreviewReady)
        {
            return operation.PlanSha256 == request.PlanSha256
                && operation.SourceSha256 == request.SourceSha256
                    ? ToRecord(operation)
                    : null;
        }
        if (operation.Status != DocumentImportStatuses.PreviewQueued)
        {
            return null;
        }
        operation.PlanSha256 = request.PlanSha256;
        operation.PlanByteLength = request.PlanByteLength;
        operation.SourceSha256 = request.SourceSha256;
        operation.ItemCount = request.ItemCount;
        operation.AssetCount = request.AssetCount;
        operation.Loss = request.Loss;
        operation.Omissions = request.Omissions;
        operation.TemplatePreview = request.TemplatePreview;
        operation.Status = DocumentImportStatuses.PreviewReady;
        operation.UpdatedAt = clock.GetUtcNow();
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return ToRecord(operation);
    }

    public ValueTask<DocumentImportRecord?> AttachCommitJobAsync(
        DocumentImportId id,
        WorkerJobId jobId,
        CancellationToken cancellationToken) =>
        AttachJobAsync(id, jobId, preview: false, cancellationToken);

    public ValueTask<DocumentImportCleanupRecord?> FailAsync(
        DocumentImportId id,
        string failureCode,
        CancellationToken cancellationToken) =>
        TerminateAsync(id, DocumentImportStatuses.Failed, failureCode, cancellationToken);

    public ValueTask<DocumentImportCleanupRecord?> CancelAsync(
        DocumentImportId id,
        CancellationToken cancellationToken) =>
        TerminateAsync(id, DocumentImportStatuses.Cancelled, null, cancellationToken);

    private async ValueTask<DocumentImportRecord?> AttachJobAsync(
        DocumentImportId id,
        WorkerJobId jobId,
        bool preview,
        CancellationToken cancellationToken)
    {
        await LockImportAsync(id, cancellationToken).ConfigureAwait(false);
        var operation = await OwnedTrackingAsync(id, cancellationToken).ConfigureAwait(false);
        if (operation is null || operation.ExpiresAt <= clock.GetUtcNow())
        {
            return null;
        }
        if (preview)
        {
            if (operation.PreviewJobId is { } existing)
            {
                return existing == jobId ? ToRecord(operation) : null;
            }
            if (operation.Status != DocumentImportStatuses.PendingUpload)
            {
                return null;
            }
            operation.PreviewJobId = jobId;
            operation.Status = DocumentImportStatuses.PreviewQueued;
        }
        else
        {
            if (operation.CommitJobId is { } existing)
            {
                return existing == jobId ? ToRecord(operation) : null;
            }
            if (operation.Status != DocumentImportStatuses.PreviewReady)
            {
                return null;
            }
            operation.CommitJobId = jobId;
            operation.Status = DocumentImportStatuses.CommitQueued;
        }
        operation.UpdatedAt = clock.GetUtcNow();
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return ToRecord(operation);
    }

    private async ValueTask<DocumentImportCleanupRecord?> TerminateAsync(
        DocumentImportId id,
        string status,
        string? failureCode,
        CancellationToken cancellationToken)
    {
        var context = Context;
        await LockImportAsync(id, cancellationToken).ConfigureAwait(false);
        var operation = await OwnedTrackingAsync(id, cancellationToken).ConfigureAwait(false);
        if (operation is null)
        {
            return null;
        }
        if (operation.Status == DocumentImportStatuses.Completed)
        {
            return null;
        }
        var mappings = await database.DocumentImportItems.AsNoTracking()
            .Where(value => value.TenantId == context.TenantId && value.ImportId == id)
            .ToArrayAsync(cancellationToken).ConfigureAwait(false);
        var upload = await database.FileUploads.AsTracking().SingleOrDefaultAsync(
            value => value.TenantId == context.TenantId && value.Id == operation.UploadId,
            cancellationToken).ConfigureAwait(false);
        var objectKeys = mappings
            .Where(value => value.ObjectKey is not null)
            .Select(value => value.ObjectKey!)
            .Append(operation.PlanObjectKey)
            .Concat(upload is null ? [] : [upload.ObjectKey])
            .Concat(await database.DocumentImportFileVersions.AsNoTracking()
                .Where(value => value.TenantId == context.TenantId && value.ImportId == id)
                .Select(value => value.ObjectKey).ToArrayAsync(cancellationToken).ConfigureAwait(false))
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        var cleanup = new DocumentImportCleanupRecord(
            operation.WorkspaceId.Value,
            objectKeys,
            operation.TemplateOperationId?.Value);
        if (operation.Status is DocumentImportStatuses.Cancelled or DocumentImportStatuses.Failed)
        {
            return cleanup;
        }
        var targetIds = mappings.Select(value => value.TargetItemId).ToArray();
        operation.RootItemId = null;
        operation.Status = status;
        operation.FailureCode = failureCode;
        operation.UpdatedAt = clock.GetUtcNow();
        operation.CompletedAt = operation.UpdatedAt;
        if (upload is not null && upload.Status != "completed")
        {
            upload.Status = status == DocumentImportStatuses.Cancelled ? "cancelled" : "failed";
            upload.FailureCode = failureCode;
            upload.UpdatedAt = operation.UpdatedAt;
        }
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        if (targetIds.Length > 0)
        {
            await database.Items.IgnoreQueryFilters()
                .Where(value => value.TenantId == context.TenantId && targetIds.Contains(value.Id))
                .ExecuteDeleteAsync(cancellationToken).ConfigureAwait(false);
        }
        return cleanup;
    }

    private Task<int> LockImportAsync(
        DocumentImportId id,
        CancellationToken cancellationToken)
    {
        var context = Context;
        return database.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({$"document-import:{context.TenantId.Value:N}:{id.Value:N}"}, 0))",
            cancellationToken);
    }

    private Task<int> LockIdempotencyAsync(
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        var context = Context;
        return database.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({$"document-import-key:{context.TenantId.Value:N}:{context.PrincipalId.Value:N}:{idempotencyKey}"}, 0))",
            cancellationToken);
    }

    private async ValueTask<bool> FitsQuotaAsync(
        Nix.Domain.Tenancy.WorkspaceId workspaceId,
        long bytes,
        CancellationToken cancellationToken)
    {
        if (bytes < 0)
        {
            return false;
        }
        await database.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({workspaceId.Value.ToString()}, 0))",
            cancellationToken).ConfigureAwait(false);
        var context = Context;
        var quota = await database.Workspaces.AsNoTracking()
            .Where(value => value.TenantId == context.TenantId && value.Id == workspaceId)
            .Select(value => value.StorageQuotaBytes)
            .SingleAsync(cancellationToken).ConfigureAwait(false);
        var used = await database.FileVersions.AsNoTracking()
            .Where(value => value.TenantId == context.TenantId && value.WorkspaceId == workspaceId)
            .SumAsync(value => (long?)value.ByteLength, cancellationToken).ConfigureAwait(false) ?? 0;
        return bytes <= quota - used;
    }

    private async ValueTask<bool> ValidParentAsync(
        Nix.Domain.Tenancy.WorkspaceId workspaceId,
        ItemId? parentId,
        CancellationToken cancellationToken)
    {
        if (parentId is null)
        {
            return true;
        }
        var parent = await tree.FindAsync(parentId.Value, cancellationToken).ConfigureAwait(false);
        // Imported items arrive unclaimed, so a collection with unique keys is refused as a destination.
        return parent is not null && parent.WorkspaceId == workspaceId && !parent.NoChildren
            && !Nix.Features.Records.RecordKeys.DeclaresUnique(parent.Schema);
    }

    private async ValueTask<DocumentImport?> OwnedTrackingAsync(
        DocumentImportId id,
        CancellationToken cancellationToken)
    {
        var context = Context;
        return await database.DocumentImports.AsTracking().SingleOrDefaultAsync(
            candidate => candidate.TenantId == context.TenantId
                && candidate.ActorId == context.PrincipalId
                && candidate.Id == id,
            cancellationToken).ConfigureAwait(false);
    }

    private NixSessionContext Context => session.Current
        ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

    private static DocumentImportRecord ToRecord(DocumentImport value) => new(
        value.Id.Value,
        value.WorkspaceId.Value,
        value.UploadId.Value,
        value.ParentId?.Value,
        value.Purpose,
        value.ManagedSource,
        value.Format,
        value.Title,
        value.IdempotencyKey,
        value.Status,
        value.PreviewJobId?.Value,
        value.CommitJobId?.Value,
        value.PlanObjectKey,
        value.PlanSha256,
        value.PlanByteLength,
        value.SourceSha256,
        value.ItemCount,
        value.AssetCount,
        value.Loss,
        value.Omissions,
        value.TemplatePreview,
        value.TemplateOperationId?.Value,
        value.TemplateId?.Value,
        value.TemplateStableKey,
        value.TemplateDigest,
        value.TemplateUnchanged,
        value.TemplateWrittenTargetItemIds,
        value.RootItemId?.Value,
        value.FailureCode,
        value.ExpiresAt,
        value.CompletedAt);

    private static DocumentImportItemMapping ToMapping(DocumentImportItem value) => new(
        value.SourceId,
        value.TargetItemId.Value,
        value.ItemType,
        value.BodyRequired,
        value.ObjectKey,
        value.ObjectReady);
}
