using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Domain.Files;
using Nix.Domain.Items;
using Nix.Domain.Properties;
using Nix.Domain.Workers;
using Nix.Persistence.ObjectStorage;

namespace Nix.Persistence.Files;

public sealed class FileStore(
    NixDbContext database,
    IItemTree tree,
    IPermissionResolver permissions,
    INixSessionContextAccessor session,
    IItemLocks locks,
    TimeProvider clock,
    IFinanceLock? topology = null) : IFileStore
{
    private const long MaxFileBytes = 100L * 1024 * 1024;

    public async ValueTask<FileUploadRecord?> BeginAsync(BeginFileUpload request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var context = Context;
        await LockIdempotencyAsync(request.IdempotencyKey, cancellationToken).ConfigureAwait(false);
        var existing = await database.FileUploads.AsNoTracking().SingleOrDefaultAsync(
            upload => upload.TenantId == context.TenantId && upload.ActorId == context.PrincipalId && upload.IdempotencyKey == request.IdempotencyKey,
            cancellationToken).ConfigureAwait(false);
        if (existing is not null)
        {
            return existing.WorkspaceId == request.WorkspaceId
                && existing.ParentId == request.ParentId
                && existing.TargetItemId == request.TargetItemId
                && string.Equals(existing.Purpose, request.Purpose, StringComparison.Ordinal)
                && string.Equals(existing.FileName, request.FileName, StringComparison.Ordinal)
                && string.Equals(existing.DeclaredMediaType, request.DeclaredMediaType, StringComparison.OrdinalIgnoreCase)
                && existing.DeclaredByteLength == request.DeclaredByteLength
                    ? ToUpload(existing)
                    : null;
        }
        if (request.Purpose is not (FileUploadPurposes.File
            or FileUploadPurposes.DocumentImport
            or FileUploadPurposes.TemplateImport))
        {
            throw new InvalidOperationException("The file upload purpose is invalid.");
        }
        if (request.DeclaredByteLength < 0 || request.DeclaredByteLength > MaxFileBytes)
        {
            throw new InvalidOperationException("The file exceeds the 100 MiB upload limit.");
        }

        // Replacing a locked file's bytes is writing its body, which a session that has not
        // unlocked it may not do - the same rule the collaboration service applies to a document.
        if (request.TargetItemId is { } target
            && !await locks.MayReadBodyAsync(target, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        var now = clock.GetUtcNow();
        var id = FileUploadId.Create();
        var upload = new FileUpload
        {
            Id = id,
            TenantId = context.TenantId,
            WorkspaceId = request.WorkspaceId,
            ParentId = request.ParentId,
            TargetItemId = request.TargetItemId,
            ActorId = context.PrincipalId,
            IdempotencyKey = request.IdempotencyKey,
            Purpose = request.Purpose,
            FileName = request.FileName,
            DeclaredMediaType = request.DeclaredMediaType,
            DeclaredByteLength = request.DeclaredByteLength,
            ObjectKey = ObjectStorageKeys.FileUpload(context.TenantId, id),
            SourceItemId = request.SourceItemId is { } source ? ItemId.From(source) : null,
            SourceSeq = request.SourceSeq,
            Status = "pending_upload",
            ExpiresAt = now.AddMinutes(15),
            CreatedAt = now,
            UpdatedAt = now,
        };
        database.FileUploads.Add(upload);
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return ToUpload(upload);
    }

    public async ValueTask<FileUploadRecord?> QueueInspectionAsync(
        FileUploadId id,
        CancellationToken cancellationToken)
    {
        var context = Context;
        await LockUploadAsync(id, cancellationToken).ConfigureAwait(false);
        var upload = await database.FileUploads.AsTracking().SingleOrDefaultAsync(
            candidate => candidate.TenantId == context.TenantId
                && candidate.ActorId == context.PrincipalId
                && candidate.Id == id,
            cancellationToken).ConfigureAwait(false);
        if (upload is null
            || upload.Purpose != FileUploadPurposes.File
            || upload.ExpiresAt <= clock.GetUtcNow()
            || upload.Status is "cancelled" or "failed")
        {
            return null;
        }
        // The temporary opaque publish path keeps the upload in pending_upload. That status is
        // already part of the deployed schema and remains eligible for abandoned-object cleanup.
        return ToUpload(upload);
    }

    public async ValueTask<FileUploadInspectionRecord?> GetInspectionAsync(
        FileUploadId id,
        CancellationToken cancellationToken)
    {
        var context = Context;
        var upload = await database.FileUploads.AsNoTracking().SingleOrDefaultAsync(
            candidate => candidate.TenantId == context.TenantId
                && candidate.ActorId == context.PrincipalId
                && candidate.Id == id,
            cancellationToken).ConfigureAwait(false);
        return upload is null ? null : new FileUploadInspectionRecord(
            upload.Id.Value,
            upload.WorkspaceId.Value,
            upload.Purpose,
            upload.Status,
            upload.ObjectKey,
            upload.FileName,
            upload.DeclaredMediaType,
            upload.DeclaredByteLength,
            upload.ExpiresAt,
            upload.PublishedItemId?.Value);
    }

    public async ValueTask<FileRecord?> CompleteAsync(CompleteFileUpload request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var context = Context;
        await LockUploadAsync(request.UploadId, cancellationToken).ConfigureAwait(false);
        var upload = await database.FileUploads.AsTracking().SingleOrDefaultAsync(
            candidate => candidate.TenantId == context.TenantId && candidate.ActorId == context.PrincipalId && candidate.Id == request.UploadId,
            cancellationToken).ConfigureAwait(false);
        if (upload is null || upload.Purpose != FileUploadPurposes.File)
        {
            return null;
        }
        if (upload.Status == "completed" && upload.PublishedItemId is { } published)
        {
            return await GetAsync(published, cancellationToken).ConfigureAwait(false);
        }
        if (upload.Status != "pending_upload" || upload.ExpiresAt <= clock.GetUtcNow())
        {
            return null;
        }
        if (request.ByteLength < 0 || request.ByteLength > MaxFileBytes || request.ByteLength != upload.DeclaredByteLength)
        {
            return null;
        }
        if (!await permissions.CanWriteWorkspaceAsync(upload.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        // Structural transfers take topology before quota; publishers use the same order.
        if (topology is not null)
        {
            await topology.AcquireWorkspaceTopologyAsync(upload.WorkspaceId, cancellationToken).ConfigureAwait(false);
        }
        // Completion already runs inside NixUnitOfWorkMiddleware's transaction. A transaction-
        // scoped advisory lock serializes quota decisions per workspace, so two uploads cannot
        // both observe the same remaining bytes and over-commit the quota.
        await database.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({upload.WorkspaceId.Value.ToString()}, 0))",
            cancellationToken).ConfigureAwait(false);
        // A transfer shares this quota lock. Re-read containment after waiting for it so a
        // replacement upload cannot publish into a file that has left its source workspace.
        if (upload.ParentId is { } parent)
        {
            var parentItem = await tree.FindAsync(parent, cancellationToken).ConfigureAwait(false);
            if (parentItem is null || parentItem.WorkspaceId != upload.WorkspaceId)
            {
                return null;
            }

            // Replacing an existing file's bytes adds no child; only a new file item does.
            if (parentItem.NoChildren && upload.TargetItemId is null)
            {
                return null;
            }
        }
        if (upload.TargetItemId is { } targetItemId)
        {
            var targetItem = await tree.FindAsync(targetItemId, cancellationToken).ConfigureAwait(false);
            if (targetItem is not { Type: "file" } || targetItem.WorkspaceId != upload.WorkspaceId)
            {
                return null;
            }
        }

        var quota = await database.Workspaces
            .Where(workspace => workspace.TenantId == context.TenantId && workspace.Id == upload.WorkspaceId)
            .Select(workspace => workspace.StorageQuotaBytes)
            .SingleAsync(cancellationToken)
            .ConfigureAwait(false);
        var used = await database.FileVersions
            .Where(version => version.TenantId == context.TenantId && version.WorkspaceId == upload.WorkspaceId)
            .SumAsync(version => (long?)version.ByteLength, cancellationToken)
            .ConfigureAwait(false) ?? 0;
        if (request.ByteLength > quota - used)
        {
            return null;
        }

        ItemId itemId;
        var nextVersion = 1;
        if (upload.TargetItemId is { } target)
        {
            var body = await database.FileBodies.AsTracking().SingleOrDefaultAsync(candidate => candidate.TenantId == context.TenantId && candidate.ItemId == target, cancellationToken).ConfigureAwait(false);
            if (body is null)
            {
                return null;
            }
            itemId = target;
            nextVersion = 1 + await database.FileVersions.Where(version => version.TenantId == context.TenantId && version.ItemId == target).MaxAsync(version => version.Version, cancellationToken).ConfigureAwait(false);
        }
        else
        {
            itemId = ItemId.Create();
            var now = clock.GetUtcNow();
            var item = new Item
            {
                Id = itemId,
                TenantId = context.TenantId,
                WorkspaceId = upload.WorkspaceId,
                Type = "file",
                ParentId = upload.ParentId,
                Seq = await tree.NextSiblingSequenceAsync(upload.WorkspaceId, upload.ParentId, cancellationToken).ConfigureAwait(false),
                Properties = ItemProperties.WithTitle(null, upload.FileName),
                LifecycleState = ItemLifecycleState.Active,
                CreatedBy = context.PrincipalId,
                LastModifiedBy = context.PrincipalId,
                CreatedAt = now,
                LastModifiedAt = now,
            };
            await tree.InsertAsync(item, cancellationToken).ConfigureAwait(false);
        }

        var version = new FileVersion
        {
            Id = FileVersionId.Create(),
            TenantId = context.TenantId,
            WorkspaceId = upload.WorkspaceId,
            ItemId = itemId,
            Version = nextVersion,
            ObjectKey = ObjectStorageKeys.FileVersion(context.TenantId, upload.Id),
            FileName = upload.FileName,
            MediaType = request.DetectedMediaType,
            ByteLength = request.ByteLength,
            Sha256 = request.Sha256,
            ObjectReady = true,
            Previewable = request.Previewable,
            PixelWidth = request.PixelWidth,
            PixelHeight = request.PixelHeight,
            ThumbnailWidth = request.ThumbnailWidth,
            ThumbnailHeight = request.ThumbnailHeight,
            ThumbnailBytes = request.ThumbnailBytes,
            SourceItemId = upload.SourceItemId,
            SourceSeq = upload.SourceSeq,
            CreatedBy = context.PrincipalId,
            CreatedAt = clock.GetUtcNow(),
        };
        database.FileVersions.Add(version);
        var fileBody = await database.FileBodies.AsTracking().SingleOrDefaultAsync(candidate => candidate.TenantId == context.TenantId && candidate.ItemId == itemId, cancellationToken).ConfigureAwait(false);
        if (fileBody is null)
        {
            database.FileBodies.Add(new FileBody { TenantId = context.TenantId, WorkspaceId = upload.WorkspaceId, ItemId = itemId, CurrentVersionId = version.Id });
        }
        else
        {
            fileBody.CurrentVersionId = version.Id;
        }
        upload.PublishedItemId = itemId;
        upload.PublishedVersionId = version.Id;
        upload.Status = "completed";
        upload.UpdatedAt = clock.GetUtcNow();
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return await GetAsync(itemId, cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask<bool> RejectAsync(
        FileUploadId id,
        string failureCode,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(failureCode);
        if (failureCode.Length > 80)
        {
            throw new ArgumentOutOfRangeException(nameof(failureCode));
        }
        var context = Context;
        await LockUploadAsync(id, cancellationToken).ConfigureAwait(false);
        var upload = await database.FileUploads.AsTracking().SingleOrDefaultAsync(
            candidate => candidate.TenantId == context.TenantId
                && candidate.ActorId == context.PrincipalId
                && candidate.Id == id,
            cancellationToken).ConfigureAwait(false);
        if (upload is null || upload.Status == "completed")
        {
            return false;
        }
        upload.Status = "failed";
        upload.FailureCode = failureCode;
        upload.UpdatedAt = clock.GetUtcNow();
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return true;
    }

    public async ValueTask<FileUploadRecord?> GetUploadAsync(FileUploadId id, CancellationToken cancellationToken)
    {
        var context = Context;
        var upload = await database.FileUploads.AsNoTracking().SingleOrDefaultAsync(candidate => candidate.TenantId == context.TenantId && candidate.ActorId == context.PrincipalId && candidate.Id == id, cancellationToken).ConfigureAwait(false);
        return upload is null ? null : ToUpload(upload);
    }

    public async ValueTask<bool> CancelAsync(FileUploadId id, CancellationToken cancellationToken)
    {
        var context = Context;
        await LockUploadAsync(id, cancellationToken).ConfigureAwait(false);
        var upload = await database.FileUploads.AsTracking().SingleOrDefaultAsync(candidate => candidate.TenantId == context.TenantId && candidate.ActorId == context.PrincipalId && candidate.Id == id, cancellationToken).ConfigureAwait(false);
        if (upload is null || upload.Status == "completed")
        {
            return false;
        }
        upload.Status = "cancelled";
        upload.UpdatedAt = clock.GetUtcNow();
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return true;
    }

    public async ValueTask<FileRecord?> GetAsync(ItemId itemId, CancellationToken cancellationToken)
    {
        var context = Context;
        await LockDownloadContainmentAsync(itemId, cancellationToken).ConfigureAwait(false);
        var body = await database.FileBodies.AsNoTracking().SingleOrDefaultAsync(candidate => candidate.TenantId == context.TenantId && candidate.ItemId == itemId, cancellationToken).ConfigureAwait(false);
        var item = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        // A file item's bytes are its body, so a lock withholds them like any other body: the
        // metadata, the download capability and the version history are all refused until this
        // credential has unlocked the item.
        if (body is null
            || !await permissions.CanReadWorkspaceAsync(body.WorkspaceId, cancellationToken).ConfigureAwait(false)
            || item is null || item.WorkspaceId != body.WorkspaceId
            || !await locks.MayReadBodyAsync(itemId, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        var versions = await database.FileVersions.AsNoTracking().Where(candidate => candidate.TenantId == context.TenantId && candidate.ItemId == itemId && candidate.WorkspaceId == body.WorkspaceId && candidate.ObjectReady).OrderByDescending(candidate => candidate.Version).ToListAsync(cancellationToken).ConfigureAwait(false);
        var mapped = versions.Select(version => ToVersion(version, version.Id == body.CurrentVersionId)).ToArray();
        var current = mapped.SingleOrDefault(version => version.Current);
        return current is null ? null : new FileRecord(itemId.Value, body.WorkspaceId.Value, current, mapped);
    }

    public async ValueTask<IReadOnlyList<FileVersionSourceRecord>?> AuthorizeVersionHistoryAsync(
        ItemId itemId,
        CancellationToken cancellationToken)
    {
        var context = Context;
        await LockDownloadContainmentAsync(itemId, cancellationToken).ConfigureAwait(false);
        var body = await database.FileBodies.AsNoTracking().SingleOrDefaultAsync(
            candidate => candidate.TenantId == context.TenantId && candidate.ItemId == itemId,
            cancellationToken).ConfigureAwait(false);
        var item = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (body is null || item is not { Type: "file" } || item.WorkspaceId != body.WorkspaceId
            || !await permissions.CanReadWorkspaceAsync(body.WorkspaceId, cancellationToken).ConfigureAwait(false)
            || !await locks.MayReadBodyAsync(itemId, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        var versions = await database.FileVersions.AsNoTracking()
            .Where(candidate => candidate.TenantId == context.TenantId && candidate.ItemId == itemId && candidate.WorkspaceId == body.WorkspaceId)
            .OrderBy(candidate => candidate.Version)
            .Take(101)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (versions.Count is < 1 or > 100
            || versions.Any(version => !version.ObjectReady)
            || versions[0].Version != 1
            || versions.Where((version, index) => version.Version != index + 1).Any()
            || versions.Count(version => version.Id == body.CurrentVersionId) != 1)
        {
            return null;
        }

        return versions.Select(version => new FileVersionSourceRecord(
            version.Id.Value,
            version.Version,
            version.ObjectKey,
            version.FileName,
            PreviewMediaType(version.FileName, version.MediaType, version.ByteLength) ?? version.MediaType,
            version.ByteLength,
            version.Sha256,
            Previewable(version.FileName, version.MediaType, version.ByteLength, version.Previewable),
            version.PixelWidth,
            version.PixelHeight,
            version.Id == body.CurrentVersionId)).ToArray();
    }

    public async ValueTask<FileDownloadRecord?> AuthorizeDownloadAsync(ItemId itemId, FileVersionId? versionId, CancellationToken cancellationToken)
    {
        var version = await FindReadableVersionAsync(itemId, versionId, cancellationToken).ConfigureAwait(false);
        return version is null
            ? null
            : new(
                version.ObjectKey,
                version.FileName,
                PreviewMediaType(version.FileName, version.MediaType, version.ByteLength) ?? version.MediaType,
                version.ByteLength,
                version.Sha256,
                Previewable(version.FileName, version.MediaType, version.ByteLength, version.Previewable));
    }

    public async ValueTask<FileThumbnailDownloadRecord?> AuthorizeThumbnailAsync(ItemId itemId, FileVersionId? versionId, CancellationToken cancellationToken)
    {
        // The same lookup as the download: a thumbnail is derived from the body, so whatever
        // withholds the body (no read access, a hidden item, a closed lock) withholds it too.
        var version = await FindReadableVersionAsync(itemId, versionId, cancellationToken).ConfigureAwait(false);
        return version is { ThumbnailWidth: { } width, ThumbnailHeight: { } height, ThumbnailBytes: { } bytes }
            ? new FileThumbnailDownloadRecord(version.ObjectKey, width, height, bytes)
            : null;
    }

    /// <summary>
    /// The version of a file the caller may read the bytes of, or null. The single authorization
    /// path for everything served from a file version's object: the permission check, the tree
    /// filter and the lock check all happen here.
    /// </summary>
    private async ValueTask<FileVersion?> FindReadableVersionAsync(ItemId itemId, FileVersionId? versionId, CancellationToken cancellationToken)
    {
        var context = Context;
        await LockDownloadContainmentAsync(itemId, cancellationToken).ConfigureAwait(false);
        var body = await database.FileBodies.AsNoTracking().SingleOrDefaultAsync(candidate => candidate.TenantId == context.TenantId && candidate.ItemId == itemId, cancellationToken).ConfigureAwait(false);
        var item = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (body is null
            || !await permissions.CanReadWorkspaceAsync(body.WorkspaceId, cancellationToken).ConfigureAwait(false)
            || item is null || item.WorkspaceId != body.WorkspaceId
            || !await locks.MayReadBodyAsync(itemId, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        var wanted = versionId ?? body.CurrentVersionId;
        return await database.FileVersions.AsNoTracking().SingleOrDefaultAsync(candidate => candidate.TenantId == context.TenantId && candidate.ItemId == itemId && candidate.WorkspaceId == body.WorkspaceId && candidate.Id == wanted && candidate.ObjectReady, cancellationToken).ConfigureAwait(false);
    }

    private Task<int> LockDownloadContainmentAsync(ItemId itemId, CancellationToken cancellationToken) =>
        database.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT id FROM item WHERE tenant_id = {Context.TenantId.Value} AND id = {itemId.Value} FOR SHARE",
            cancellationToken);

    public async ValueTask RenameCurrentVersionAsync(ItemId itemId, string title, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(title);
        var context = Context;

        // A non-file item, or a file item whose body is somehow missing, leaves nothing to rename
        // here - the title write the caller made to the item row already stands on its own.
        var body = await database.FileBodies.AsNoTracking().SingleOrDefaultAsync(
            candidate => candidate.TenantId == context.TenantId && candidate.ItemId == itemId,
            cancellationToken).ConfigureAwait(false);
        if (body is null)
        {
            return;
        }

        var currentFileName = await database.FileVersions.AsNoTracking()
            .Where(version => version.TenantId == context.TenantId && version.Id == body.CurrentVersionId)
            .Select(version => version.FileName)
            .SingleOrDefaultAsync(cancellationToken).ConfigureAwait(false);
        if (currentFileName is null)
        {
            return;
        }

        var renamed = FileNaming.RenamedFileName(title, currentFileName);
        if (renamed is null || string.Equals(renamed, currentFileName, StringComparison.Ordinal))
        {
            return;
        }

        // Same shape as ItemTree.UpdatePropertiesAsync: an ExecuteUpdate rather than a tracked
        // load-and-save, so this runs as one statement inside the request's ambient transaction
        // and lands in the same unit of work as the title write that triggered it.
        await database.FileVersions
            .Where(version => version.TenantId == context.TenantId && version.Id == body.CurrentVersionId)
            .ExecuteUpdateAsync(
                update => update.SetProperty(version => version.FileName, renamed),
                cancellationToken)
            .ConfigureAwait(false);
    }

    private NixSessionContext Context => session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

    private Task<int> LockUploadAsync(FileUploadId id, CancellationToken cancellationToken)
    {
        var context = Context;
        return database.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({$"file-upload:{context.TenantId.Value:N}:{id.Value:N}"}, 0))",
            cancellationToken);
    }

    private Task<int> LockIdempotencyAsync(string idempotencyKey, CancellationToken cancellationToken)
    {
        var context = Context;
        return database.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({$"file-upload-key:{context.TenantId.Value:N}:{context.PrincipalId.Value:N}:{idempotencyKey}"}, 0))",
            cancellationToken);
    }

    private static FileUploadRecord ToUpload(FileUpload value) => new(value.Id.Value, value.WorkspaceId.Value, value.Purpose, value.Status, value.ObjectKey, value.ExpiresAt, value.PublishedItemId?.Value, value.FailureCode, value.PublishedVersionId?.Value);
    private static FileVersionRecord ToVersion(FileVersion value, bool current) => new(
        value.Id.Value,
        value.Version,
        value.FileName,
        PreviewMediaType(value.FileName, value.MediaType, value.ByteLength) ?? value.MediaType,
        value.ByteLength,
        value.Sha256,
        Previewable(value.FileName, value.MediaType, value.ByteLength, value.Previewable),
        value.PixelWidth,
        value.PixelHeight,
        value.CreatedAt,
        current,
        value is { ThumbnailWidth: { } width, ThumbnailHeight: { } height } ? new FileThumbnailRecord(width, height) : null);

    private static bool Previewable(string fileName, string mediaType, long byteLength, bool storedPreviewable) =>
        storedPreviewable
        || (string.Equals(mediaType, "application/octet-stream", StringComparison.OrdinalIgnoreCase)
            && byteLength <= 10L * 1024 * 1024
            && PreviewMediaType(fileName, mediaType, byteLength) is { } resolved
            && !ServedAudio.IsServed(resolved));

    private static string? PreviewMediaType(string fileName, string mediaType, long byteLength)
    {
        if (!string.Equals(mediaType, "application/octet-stream", StringComparison.OrdinalIgnoreCase))
        {
            return mediaType;
        }
        // Audio first and with no size ceiling: it is streamed with range requests, not decoded
        // whole, and a recording is routinely larger than the image bound below.
        if (ServedAudio.ForExtension(fileName) is { } audio)
        {
            return audio;
        }
        if (byteLength > 10L * 1024 * 1024)
        {
            return mediaType;
        }
        return Path.GetExtension(fileName).ToUpperInvariant() switch
        {
            ".PDF" => "application/pdf",
            ".PNG" => "image/png",
            ".JPG" or ".JPEG" => "image/jpeg",
            ".WEBP" => "image/webp",
            ".AVIF" => "image/avif",
            _ => null,
        };
    }
}
