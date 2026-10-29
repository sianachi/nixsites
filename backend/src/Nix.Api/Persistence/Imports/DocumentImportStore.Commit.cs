using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Abstractions.Importing;
using Nix.Domain.Comments;
using Nix.Domain.Files;
using Nix.Domain.Importing;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Persistence.ObjectStorage;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Importing;

public sealed partial class DocumentImportStore
{
    private const int MaxImportThreadsPerNote = 500;
    private const int MaxImportCommentsPerThread = 100;
    private const int MaxImportComments = 10_000;

    public async ValueTask<DocumentImportStageRecord?> StageAsync(
        StageDocumentImport request,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (!ValidDigest(request.PlanSha256)
            || !ValidDigest(request.SourceSha256)
            || !TryValidatePlan(request.Items, out var ordered)
            || !TryValidateFileVersions(request.FileVersions, ordered))
        {
            return null;
        }

        var context = Context;
        await LockImportAsync(request.ImportId, cancellationToken).ConfigureAwait(false);
        var operation = await OwnedTrackingAsync(request.ImportId, cancellationToken).ConfigureAwait(false);
        if (operation is null
            || operation.Purpose != DocumentImportPurposes.Workspace
            || operation.ExpiresAt <= clock.GetUtcNow()
            || operation.PlanSha256 != request.PlanSha256
            || operation.SourceSha256 != request.SourceSha256
            || operation.ItemCount != request.Items.Count)
        {
            return null;
        }
        if (operation.Status is DocumentImportStatuses.Staging or DocumentImportStatuses.Completed)
        {
            return await ReadStageAsync(operation, cancellationToken).ConfigureAwait(false);
        }
        if (operation.Status != DocumentImportStatuses.CommitQueued
            || !await permissions.CanWriteWorkspaceAsync(operation.WorkspaceId, cancellationToken).ConfigureAwait(false)
            || !await ValidParentAsync(operation.WorkspaceId, operation.ParentId, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        if (await database.DocumentImportItems.AnyAsync(
            value => value.TenantId == context.TenantId && value.ImportId == operation.Id,
            cancellationToken).ConfigureAwait(false))
        {
            return await ReadStageAsync(operation, cancellationToken).ConfigureAwait(false);
        }

        var upload = await database.FileUploads.AsTracking().SingleOrDefaultAsync(
            candidate => candidate.TenantId == context.TenantId
                && candidate.ActorId == context.PrincipalId
                && candidate.Id == operation.UploadId,
            cancellationToken).ConfigureAwait(false);
        if (upload is null
            || upload.Purpose != FileUploadPurposes.DocumentImport
            || upload.Status != "pending_upload"
            || upload.DeclaredByteLength > MaximumFileBytes)
        {
            return null;
        }

        var plannedFiles = ordered.Where(item => item.File is not null).Select(item => item.File!).ToArray();
        var fileVersions = request.FileVersions ?? [];
        if (fileVersions.Count > 0 && plannedFiles.Length > 0)
        {
            return null;
        }
        var describedFileItems = fileVersions.Select(value => value.SourceItemId).ToHashSet(StringComparer.Ordinal);
        if (ordered.Any(item => item.ItemType == "file" && item.File is null
            && !describedFileItems.Contains(item.SourceId)))
        {
            return null;
        }
        var sourceFiles = plannedFiles.Where(file => file.SourceKind == "source").ToArray();
        var expectedSourceFiles = operation.Format is "pdf" or "docx" or "txt" ? 1 : 0;
        if (sourceFiles.Length != expectedSourceFiles
            || plannedFiles.Count(file => file.SourceKind == "asset") != operation.AssetCount
            || sourceFiles.Any(file => file.ByteLength != upload.DeclaredByteLength
                || !string.Equals(file.Sha256, operation.SourceSha256, StringComparison.Ordinal)
                || !string.Equals(file.FileName, upload.FileName, StringComparison.Ordinal)))
        {
            return null;
        }

        long fileBytes = 0;
        try
        {
            foreach (var file in plannedFiles)
            {
                fileBytes = checked(fileBytes + file.ByteLength);
            }
            foreach (var file in fileVersions)
            {
                fileBytes = checked(fileBytes + file.ByteLength);
            }
        }
        catch (OverflowException)
        {
            return null;
        }
        if (!await FitsQuotaAsync(operation.WorkspaceId, fileBytes, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        var now = clock.GetUtcNow();
        var targetIds = ordered.ToDictionary(item => item.SourceId, _ => ItemId.Create(), StringComparer.Ordinal);
        var root = ordered.Single(item => item.ParentSourceId is null);
        var rootSequence = await tree.NextSiblingSequenceAsync(
            operation.WorkspaceId,
            operation.ParentId,
            cancellationToken).ConfigureAwait(false);
        var siblingIndexes = new Dictionary<string, long>(StringComparer.Ordinal);
        var items = new List<Item>(ordered.Count);
        var mappings = new List<DocumentImportItem>(ordered.Count);
        var versions = new List<FileVersion>();
        var bodies = new List<FileBody>();
        var archivedVersions = new List<DocumentImportFileVersion>();
        var comments = new List<NoteComment>();
        foreach (var planned in ordered)
        {
            var targetId = targetIds[planned.SourceId];
            var parentId = planned.ParentSourceId is null
                ? operation.ParentId
                : targetIds[planned.ParentSourceId];
            var siblingKey = planned.ParentSourceId ?? "$root";
            var siblingIndex = siblingIndexes.GetValueOrDefault(siblingKey);
            siblingIndexes[siblingKey] = siblingIndex + 1;
            var sequence = planned.ParentSourceId is null ? rootSequence : checked((siblingIndex + 1) * 1024);
            var item = new Item
            {
                Id = targetId,
                TenantId = context.TenantId,
                WorkspaceId = operation.WorkspaceId,
                Type = planned.ItemType,
                ParentId = parentId,
                Seq = sequence,
                // A planned set-by value comes from the imported file, not from anyone who acted
                // here: the importing principal is attributed for every scheduled value. Of the
                // reserved space carries habit, finance and sanitized native chat settings.
                Properties = ItemProperties.RestampCopiedSetBy(
                    ConversationNativeImportProperties.Restore(operation.Format == "nix" ? planned.Properties : null,
                        ReservedPropertyContent.Strip(
                            ItemProperties.WithTitle(planned.Properties, planned.Title),
                            ReservedPropertyContent.ContentPrefixes)),
                    context.PrincipalId.ToString()),
                Schema = planned.Schema,
                Views = planned.Views,
                LifecycleState = ItemLifecycleState.Provisioning,
                CreatedBy = context.PrincipalId,
                LastModifiedBy = context.PrincipalId,
                CreatedAt = now,
                LastModifiedAt = now,
            };
            // Habit and finance content is checked by its own validators before it is applied.
            if (ReservedPropertyContent.Refuse(item.Properties, ItemProperties.ReadTitle(item.Properties)) is not null)
            {
                return null;
            }

            items.Add(item);
            if (planned.ItemType == "note" && planned.Comments is { Count: > 0 })
            {
                // Past a cap the whole stage is refused, as for any other over-limit plan.
                if (planned.Comments.Count > MaxImportThreadsPerNote
                    || planned.Comments.Any(thread => thread.Comments?.Count > MaxImportCommentsPerThread))
                {
                    return null;
                }

                var imported = ImportedComments(planned.Comments, context, targetId, now).ToList();
                if (imported.Count > NoteComment.MaxPerNote || comments.Count + imported.Count > MaxImportComments)
                {
                    return null;
                }

                comments.AddRange(imported);
            }

            FileVersionId? fileVersionId = null;
            string? objectKey = null;
            var objectReady = planned.File is null;
            if (planned.File is { } file)
            {
                fileVersionId = FileVersionId.Create();
                objectKey = ObjectStorageKeys.FileVersion(context.TenantId, fileVersionId.Value);
                objectReady = false;
                versions.Add(new FileVersion
                {
                    Id = fileVersionId.Value,
                    TenantId = context.TenantId,
                    WorkspaceId = operation.WorkspaceId,
                    ItemId = targetId,
                    Version = 1,
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
                });
                bodies.Add(new FileBody
                {
                    TenantId = context.TenantId,
                    WorkspaceId = operation.WorkspaceId,
                    ItemId = targetId,
                    CurrentVersionId = fileVersionId.Value,
                });
            }
            mappings.Add(new DocumentImportItem
            {
                ImportId = operation.Id,
                TenantId = context.TenantId,
                SourceId = planned.SourceId,
                ParentSourceId = planned.ParentSourceId,
                TargetItemId = targetId,
                ItemType = planned.ItemType,
                FinalLifecycleState = planned.FinalLifecycleState,
                BodyRequired = planned.BodyRequired,
                FileVersionId = fileVersionId,
                ObjectKey = objectKey,
                ObjectReady = objectReady,
            });
        }

        var filesBySource = new Dictionary<string, List<(FileVersion Version, DocumentImportFileVersion Transfer)>>(StringComparer.Ordinal);
        var archivedVersionNumbers = new Dictionary<Guid, int>();
        foreach (var file in fileVersions)
        {
            var targetItemId = targetIds[file.SourceItemId];
            var versionId = FileVersionId.Create();
            var objectKey = ObjectStorageKeys.FileVersion(context.TenantId, versionId);
            var versionCreatedAt = clock.GetUtcNow();
            var version = new FileVersion
            {
                Id = versionId,
                TenantId = context.TenantId,
                WorkspaceId = operation.WorkspaceId,
                ItemId = targetItemId,
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
                CreatedAt = versionCreatedAt,
            };
            var transfer = new DocumentImportFileVersion
            {
                TransferId = Guid.CreateVersion7(),
                TenantId = context.TenantId,
                ImportId = operation.Id,
                SourceItemId = file.SourceItemId,
                TargetItemId = targetItemId,
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
            _ = filesBySource.TryGetValue(file.SourceItemId, out var history);
            history ??= [];
            history.Add((version, transfer));
            filesBySource[file.SourceItemId] = history;
            versions.Add(version);
            archivedVersions.Add(transfer);
            archivedVersionNumbers.Add(transfer.TransferId, version.Version);
        }
        foreach (var (sourceId, history) in filesBySource)
        {
            var current = history.MaxBy(entry => entry.Version.Version).Version;
            bodies.Add(new FileBody
            {
                TenantId = context.TenantId,
                WorkspaceId = operation.WorkspaceId,
                ItemId = targetIds[sourceId],
                CurrentVersionId = current.Id,
            });
            var mapping = mappings.Single(value => value.SourceId == sourceId);
            mapping.FileVersionId = current.Id;
            mapping.ObjectKey = current.ObjectKey;
            mapping.ObjectReady = false;
        }

        database.Items.AddRange(items);
        database.DocumentImportItems.AddRange(mappings);
        database.NoteComments.AddRange(comments);
        database.FileVersions.AddRange(versions);
        database.DocumentImportFileVersions.AddRange(archivedVersions);
        database.FileBodies.AddRange(bodies);
        operation.RootItemId = targetIds[root.SourceId];
        operation.Status = DocumentImportStatuses.Staging;
        operation.UpdatedAt = now;
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        await RebuildClosureAsync(items.Select(item => item.Id), cancellationToken).ConfigureAwait(false);
        return new DocumentImportStageRecord(
            operation.Id.Value,
            operation.RootItemId.Value.Value,
            mappings.Select(ToMapping).ToArray(),
            archivedVersions.Select(value => new DocumentImportFileVersionMapping(
                value.TransferId, value.SourceItemId, value.TargetItemId.Value,
                archivedVersionNumbers[value.TransferId])).ToArray());
    }

    // Imported comments belong to the importer; the original author is kept as a name only, so no
    // notice is queued. Anchors stay empty and the client re-anchors by the quote.
    private static IEnumerable<NoteComment> ImportedComments(
        IReadOnlyList<ImportCommentThread> threads,
        NixSessionContext context,
        ItemId itemId,
        DateTimeOffset now)
    {
        static string? Cut(string? value, int max) => value is { Length: > 0 } ? TextCut.Cut(value, max) : null;
        foreach (var thread in threads)
        {
            Guid? threadId = null;
            foreach (var comment in thread.Comments ?? [])
            {
                var body = Cut(comment.Body, 10_000);
                if (body is null)
                {
                    continue;
                }
                var id = Guid.CreateVersion7();
                var root = threadId is null;
                threadId ??= id;
                yield return new NoteComment
                {
                    TenantId = context.TenantId,
                    Id = id,
                    ItemId = itemId,
                    ThreadId = threadId.Value,
                    AuthorPrincipalId = context.PrincipalId,
                    ImportedAuthor = Cut(comment.Author, 200) ?? "Unknown",
                    Body = body,
                    MentionIds = [],
                    Quote = root ? Cut(thread.Quote, 1000) : null,
                    ResolvedAt = root && thread.Resolved ? now : null,
                    ResolvedBy = root && thread.Resolved ? context.PrincipalId : null,
                    CreatedAt = comment.CreatedAt ?? now,
                };
            }
        }
    }

    public async ValueTask<DocumentImportStageRecord?> AuthorizeBodyWritesAsync(
        DocumentImportId id,
        CancellationToken cancellationToken)
    {
        var context = Context;
        var operation = await database.DocumentImports.AsNoTracking().SingleOrDefaultAsync(
            value => value.TenantId == context.TenantId
                && value.ActorId == context.PrincipalId
                && value.Id == id
                && value.Status == DocumentImportStatuses.Staging
                && value.ExpiresAt > clock.GetUtcNow(),
            cancellationToken).ConfigureAwait(false);
        return operation is null ? null : await ReadStageAsync(operation, cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask<DocumentImportRecord?> FinalizeAsync(
        DocumentImportId id,
        CancellationToken cancellationToken)
    {
        var context = Context;
        await LockImportAsync(id, cancellationToken).ConfigureAwait(false);
        var operation = await OwnedTrackingAsync(id, cancellationToken).ConfigureAwait(false);
        if (operation is null || operation.Purpose != DocumentImportPurposes.Workspace)
        {
            return null;
        }
        if (operation.Status == DocumentImportStatuses.Completed)
        {
            return ToRecord(operation);
        }
        if (operation.Status != DocumentImportStatuses.Staging
            || operation.ExpiresAt <= clock.GetUtcNow()
            || !await permissions.CanWriteWorkspaceAsync(operation.WorkspaceId, cancellationToken).ConfigureAwait(false)
            || !await ValidParentAsync(operation.WorkspaceId, operation.ParentId, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        var mappings = await database.DocumentImportItems.AsNoTracking()
            .Where(value => value.TenantId == context.TenantId && value.ImportId == id)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (mappings.Count == 0
            || mappings.Count > MaximumItems
            || mappings.Count != operation.ItemCount
            || mappings.Any(value => value.FileVersionId is not null && !value.ObjectReady)
            || await database.DocumentImportFileVersions.AnyAsync(value =>
                value.TenantId == context.TenantId && value.ImportId == id && !value.ObjectReady,
                cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        var expectedBodies = mappings.Where(value => value.BodyRequired).Select(value => value.TargetItemId).ToHashSet();
        var actualBodies = await database.ContentDocs.AsNoTracking()
            .Where(value => value.TenantId == context.TenantId
                && mappings.Select(mapping => mapping.TargetItemId).Contains(value.ItemId))
            .Select(value => value.ItemId)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (!expectedBodies.SetEquals(actualBodies))
        {
            return null;
        }

        var mappedIds = mappings.Select(value => value.TargetItemId).ToArray();
        var stagedProperties = await database.Items.IgnoreQueryFilters().AsNoTracking()
            .Where(value => value.TenantId == context.TenantId && mappedIds.Contains(value.Id))
            .Select(value => value.Properties)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (stagedProperties.Count != mappings.Count
            || stagedProperties.Any(properties => validator.ValidateEnvelope(properties, null, null) is not null))
        {
            return null;
        }

        var activeIds = mappings.Where(value => value.FinalLifecycleState == "active")
            .Select(value => value.TargetItemId).ToArray();
        var deletedIds = mappings.Where(value => value.FinalLifecycleState == "deleted")
            .Select(value => value.TargetItemId).ToArray();
        if (activeIds.Length > 0)
        {
            await database.Items.IgnoreQueryFilters()
                .Where(value => value.TenantId == context.TenantId && activeIds.Contains(value.Id))
                .ExecuteUpdateAsync(update => update.SetProperty(
                    value => value.LifecycleState,
                    ItemLifecycleState.Active), cancellationToken).ConfigureAwait(false);
        }
        if (deletedIds.Length > 0)
        {
            await database.Items.IgnoreQueryFilters()
                .Where(value => value.TenantId == context.TenantId && deletedIds.Contains(value.Id))
                .ExecuteUpdateAsync(update => update.SetProperty(
                    value => value.LifecycleState,
                    ItemLifecycleState.Deleted), cancellationToken).ConfigureAwait(false);
        }

        var now = clock.GetUtcNow();
        operation.Status = DocumentImportStatuses.Completed;
        operation.UpdatedAt = now;
        operation.CompletedAt = now;
        var upload = await database.FileUploads.AsTracking().SingleAsync(
            value => value.TenantId == context.TenantId && value.Id == operation.UploadId,
            cancellationToken).ConfigureAwait(false);
        upload.Status = "completed";
        upload.PublishedItemId = mappings.SingleOrDefault(value => value.ObjectKey == upload.ObjectKey)?.TargetItemId
            ?? operation.RootItemId;
        upload.UpdatedAt = now;
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return ToRecord(operation);
    }

    private async ValueTask<DocumentImportStageRecord?> ReadStageAsync(
        DocumentImport operation,
        CancellationToken cancellationToken)
    {
        if (operation.RootItemId is not { } rootId)
        {
            return null;
        }
        var context = Context;
        var mappings = await database.DocumentImportItems.AsNoTracking()
            .Where(value => value.TenantId == context.TenantId && value.ImportId == operation.Id)
            .OrderBy(value => value.SourceId)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        var fileMappings = await database.DocumentImportFileVersions.AsNoTracking()
            .Where(value => value.TenantId == context.TenantId && value.ImportId == operation.Id)
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
        return mappings.Count == 0
            ? null
            : new DocumentImportStageRecord(
                operation.Id.Value,
                rootId.Value,
                mappings.Select(ToMapping).ToArray(),
                fileMappings.Select(value => new DocumentImportFileVersionMapping(
                    value.TransferId, value.SourceItemId, value.TargetItemId!.Value, value.Version)).ToArray());
    }

    private async ValueTask RebuildClosureAsync(
        IEnumerable<ItemId> itemIds,
        CancellationToken cancellationToken)
    {
        var ids = itemIds.Select(id => id.Value).Distinct().ToArray();
        if (ids.Length == 0)
        {
            return;
        }
        const string sql = """
            WITH RECURSIVE ancestry AS (
                SELECT item.tenant_id, item.workspace_id, item.id AS descendant_id,
                       item.id AS ancestor_id, 0 AS depth
                  FROM item
                 WHERE item.tenant_id = @tenant_id AND item.id = ANY(@item_ids)
                UNION ALL
                SELECT ancestry.tenant_id, ancestry.workspace_id, ancestry.descendant_id,
                       parent.id, ancestry.depth + 1
                  FROM ancestry
                  JOIN item current_item
                    ON current_item.tenant_id = ancestry.tenant_id
                   AND current_item.id = ancestry.ancestor_id
                  JOIN item parent
                    ON parent.tenant_id = current_item.tenant_id
                   AND parent.id = current_item.parent_id
            )
            INSERT INTO item_closure (tenant_id, workspace_id, ancestor_id, descendant_id, depth)
            SELECT tenant_id, workspace_id, ancestor_id, descendant_id, depth FROM ancestry
            ON CONFLICT (ancestor_id, descendant_id) DO NOTHING
            """;
        await database.Database.ExecuteSqlRawAsync(
            sql,
            [
                new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = Context.TenantId.Value },
                new NpgsqlParameter("item_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = ids },
            ],
            cancellationToken).ConfigureAwait(false);
    }
}
