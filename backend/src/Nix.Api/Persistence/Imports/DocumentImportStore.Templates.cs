using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions.Importing;
using Nix.Domain.Files;
using Nix.Domain.Importing;
using Nix.Domain.Items;
using Nix.Domain.Templates;
using Nix.Persistence.ObjectStorage;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Importing;

public sealed partial class DocumentImportStore
{
    public async ValueTask<DocumentImportRecord?> AttachTemplateStageAsync(
        AttachTemplateImportStage request,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        await LockImportAsync(request.ImportId, cancellationToken).ConfigureAwait(false);
        var operation = await OwnedTrackingAsync(request.ImportId, cancellationToken).ConfigureAwait(false);
        if (operation is null
            || !DocumentImportPurposes.IsTemplate(operation.Purpose)
            || operation.ExpiresAt <= clock.GetUtcNow()
            || operation.SourceSha256 != request.Digest
            || string.IsNullOrWhiteSpace(request.StableKey)
            || request.StableKey.Length > 160
            || request.Unchanged != (request.OperationId is null))
        {
            return null;
        }
        if (operation.Status == DocumentImportStatuses.Staging)
        {
            return operation.TemplateOperationId == request.OperationId
                && operation.TemplateId == request.TemplateId
                && operation.TemplateStableKey == request.StableKey
                && operation.TemplateDigest == request.Digest
                && operation.TemplateUnchanged == request.Unchanged
                    ? ToRecord(operation)
                    : null;
        }
        if (operation.Status != DocumentImportStatuses.CommitQueued
            || !await permissions.CanWriteWorkspaceAsync(operation.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        operation.TemplateOperationId = request.OperationId;
        operation.TemplateId = request.TemplateId;
        operation.TemplateStableKey = request.StableKey;
        operation.TemplateDigest = request.Digest;
        operation.TemplateUnchanged = request.Unchanged;
        operation.Status = DocumentImportStatuses.Staging;
        operation.UpdatedAt = clock.GetUtcNow();
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return ToRecord(operation);
    }

    public async ValueTask<DocumentImportRecord?> CompleteTemplateAsync(
        CompleteTemplateImport request,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        await LockImportAsync(request.ImportId, cancellationToken).ConfigureAwait(false);
        var operation = await OwnedTrackingAsync(request.ImportId, cancellationToken).ConfigureAwait(false);
        if (operation is null
            || !DocumentImportPurposes.IsTemplate(operation.Purpose)
            || (operation.Purpose == DocumentImportPurposes.TemplateManaged) != request.Managed
            || operation.ExpiresAt <= clock.GetUtcNow()
            || operation.TemplateId is null
            || operation.TemplateStableKey is null
            || operation.TemplateDigest is null)
        {
            return null;
        }
        if (await database.DocumentImportFileVersions.AnyAsync(value =>
            value.TenantId == Context.TenantId && value.ImportId == request.ImportId && !value.ObjectReady,
            cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        var expectedStatus = request.Managed ? DocumentImportStatuses.Staged : DocumentImportStatuses.Completed;
        var written = request.WrittenTargetItemIds.Select(value => value.Value)
            .Distinct()
            .Order()
            .ToArray();
        var serialized = JsonSerializer.Serialize(written);
        if (operation.Status is DocumentImportStatuses.Completed or DocumentImportStatuses.Staged)
        {
            return operation.Status == expectedStatus
                && string.Equals(operation.TemplateWrittenTargetItemIds, serialized, StringComparison.Ordinal)
                    ? ToRecord(operation)
                    : null;
        }
        if (operation.Status != DocumentImportStatuses.Staging)
        {
            return null;
        }
        operation.TemplateWrittenTargetItemIds = serialized;
        operation.Status = expectedStatus;
        operation.UpdatedAt = clock.GetUtcNow();
        operation.CompletedAt = request.Managed ? null : operation.UpdatedAt;
        var upload = await database.FileUploads.AsTracking().SingleOrDefaultAsync(
            value => value.TenantId == Context.TenantId && value.Id == operation.UploadId,
            cancellationToken).ConfigureAwait(false);
        if (upload is not null)
        {
            upload.Status = "completed";
            upload.UpdatedAt = operation.UpdatedAt;
        }
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return ToRecord(operation);
    }

    public async ValueTask<bool> CompleteManagedBatchAsync(
        IReadOnlyList<DocumentImportId> importIds,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(importIds);
        var distinct = importIds.Distinct().ToArray();
        if (distinct.Length != importIds.Count || distinct.Length > 200)
        {
            return false;
        }
        foreach (var id in distinct.OrderBy(value => value.Value))
        {
            await LockImportAsync(id, cancellationToken).ConfigureAwait(false);
        }
        var operations = await database.DocumentImports.AsTracking()
            .Where(value => distinct.Contains(value.Id))
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (operations.Count != distinct.Length
            || operations.Any(value => value.ActorId != Context.PrincipalId
                || value.Purpose != DocumentImportPurposes.TemplateManaged
                || value.Status is not (DocumentImportStatuses.Staged or DocumentImportStatuses.Completed)))
        {
            return false;
        }
        if (await database.DocumentImportFileVersions.AnyAsync(value =>
            distinct.Contains(value.ImportId) && !value.ObjectReady, cancellationToken).ConfigureAwait(false))
        {
            return false;
        }
        var now = clock.GetUtcNow();
        foreach (var operation in operations.Where(value => value.Status == DocumentImportStatuses.Staged))
        {
            operation.Status = DocumentImportStatuses.Completed;
            operation.UpdatedAt = now;
            operation.CompletedAt = now;
        }
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return true;
    }

    public async ValueTask<IReadOnlyList<DocumentImportFileVersionMapping>?> StageTemplateFileVersionsAsync(
        DocumentImportId id,
        IReadOnlyList<ImportFileVersionPlan> fileVersions,
        IReadOnlyList<(string SourceItemId, ItemId TargetItemId)> targets,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(fileVersions);
        ArgumentNullException.ThrowIfNull(targets);
        if (fileVersions.Count > 20_000 || fileVersions.Any(file => file.Version is < 1 or > 100
            || !ValidFile(new ImportFilePlan("asset", "archive", file.FileName, file.MediaType,
                file.ByteLength, file.Sha256, file.Previewable, file.PixelWidth, file.PixelHeight))))
        {
            return null;
        }
        var context = Context;
        await LockImportAsync(id, cancellationToken).ConfigureAwait(false);
        var operation = await OwnedTrackingAsync(id, cancellationToken).ConfigureAwait(false);
        if (operation is null || !DocumentImportPurposes.IsTemplate(operation.Purpose)
            || operation.Status != DocumentImportStatuses.Staging || operation.ExpiresAt <= clock.GetUtcNow()
            || !await permissions.CanWriteWorkspaceAsync(operation.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        var knownTargets = targets.Where(value => value.SourceItemId.Length <= 160)
            .ToDictionary(value => value.SourceItemId, value => value.TargetItemId, StringComparer.Ordinal);
        var grouped = fileVersions.GroupBy(value => value.SourceItemId, StringComparer.Ordinal).ToArray();
        if (grouped.Any(group => !knownTargets.ContainsKey(group.Key)
            || group.Count() > 100 || group.Select(value => value.Version).Distinct().Count() != group.Count()
            || !group.Select(value => value.Version).Order().SequenceEqual(Enumerable.Range(1, group.Count()))))
        {
            return null;
        }
        var existing = await database.DocumentImportFileVersions.AsNoTracking()
            .Where(value => value.TenantId == context.TenantId && value.ImportId == id)
            .Join(database.FileVersions.AsNoTracking(), transfer => new { transfer.TenantId, transfer.FileVersionId },
                version => new { version.TenantId, FileVersionId = version.Id },
                (transfer, version) => new
                {
                    transfer.TransferId,
                    transfer.SourceItemId,
                    TargetItemId = transfer.TargetItemId,
                    version.Version,
                })
            .OrderBy(value => value.TransferId).ToArrayAsync(cancellationToken).ConfigureAwait(false);
        if (existing.Length > 0)
        {
            return existing.Length == fileVersions.Count
                ? existing.Select(value => new DocumentImportFileVersionMapping(
                    value.TransferId, value.SourceItemId, value.TargetItemId!.Value, value.Version)).ToArray()
                : null;
        }
        if (fileVersions.Count == 0)
        {
            return [];
        }
        await database.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({operation.WorkspaceId.Value.ToString()}, 0))",
            cancellationToken).ConfigureAwait(false);

        var now = clock.GetUtcNow();
        var versions = new List<FileVersion>(fileVersions.Count);
        var transfers = new List<DocumentImportFileVersion>(fileVersions.Count);
        var bySource = new Dictionary<string, List<(FileVersion Version, DocumentImportFileVersion Transfer)>>(StringComparer.Ordinal);
        var result = new List<DocumentImportFileVersionMapping>(fileVersions.Count);
        foreach (var file in fileVersions)
        {
            var targetId = knownTargets[file.SourceItemId];
            var versionId = FileVersionId.Create();
            var objectKey = ObjectStorageKeys.FileVersion(context.TenantId, versionId);
            var version = new FileVersion
            {
                Id = versionId,
                TenantId = context.TenantId,
                WorkspaceId = operation.WorkspaceId,
                ItemId = targetId,
                Version = file.Version,
                ObjectKey = objectKey,
                FileName = file.FileName,
                MediaType = file.MediaType,
                ByteLength = file.ByteLength,
                Sha256 = file.Sha256,
                ObjectReady = false,
                Previewable = file.Previewable,
                PixelWidth = file.PixelWidth,
                PixelHeight = file.PixelHeight,
                CreatedBy = context.PrincipalId,
                CreatedAt = now,
            };
            var transfer = new DocumentImportFileVersion
            {
                TransferId = Guid.CreateVersion7(),
                TenantId = context.TenantId,
                ImportId = id,
                SourceItemId = file.SourceItemId,
                TargetItemId = targetId,
                FileVersionId = versionId,
                ObjectKey = objectKey,
                FileName = file.FileName,
                MediaType = file.MediaType,
                ByteLength = file.ByteLength,
                Sha256 = file.Sha256,
                Previewable = file.Previewable,
                PixelWidth = file.PixelWidth,
                PixelHeight = file.PixelHeight,
                ObjectReady = false,
            };
            versions.Add(version);
            transfers.Add(transfer);
            if (!bySource.TryGetValue(file.SourceItemId, out var history))
            {
                history = [];
                bySource[file.SourceItemId] = history;
            }
            history.Add((version, transfer));
            result.Add(new DocumentImportFileVersionMapping(transfer.TransferId, file.SourceItemId,
                targetId.Value, file.Version));
        }
        database.FileVersions.AddRange(versions);
        database.DocumentImportFileVersions.AddRange(transfers);
        foreach (var (sourceId, history) in bySource)
        {
            var current = history.MaxBy(value => value.Version.Version).Version;
            database.FileBodies.Add(new FileBody
            {
                TenantId = context.TenantId,
                WorkspaceId = operation.WorkspaceId,
                ItemId = knownTargets[sourceId],
                CurrentVersionId = current.Id,
            });
        }
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return result;
    }
}
