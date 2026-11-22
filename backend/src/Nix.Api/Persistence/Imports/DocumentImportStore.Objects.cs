using Microsoft.EntityFrameworkCore;
using Nix.Abstractions.Importing;
using Nix.Domain.Files;
using Nix.Domain.Importing;
using Nix.Domain.Items;
using Npgsql;

namespace Nix.Persistence.Importing;

public sealed partial class DocumentImportStore
{
    public async ValueTask<DocumentImportFileVersionsPage?> AuthorizeFileVersionsAsync(
        DocumentImportId id, string executionId, Guid? afterTransferId, int limit,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(executionId) || executionId.Length > 128 || limit is < 1 or > 100)
        {
            return null;
        }

        var context = Context;
        var query = database.DocumentImportFileVersions.AsTracking().Where(value =>
            value.TenantId == context.TenantId && value.ImportId == id);
        if (afterTransferId is { } cursor)
        {
            query = query.Where(value => value.TransferId.CompareTo(cursor) > 0);
        }

        var fetched = await query.OrderBy(value => value.TransferId).Take(limit + 1)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        var hasMore = fetched.Count > limit;
        var rows = fetched.Take(limit).ToArray();
        var operation = await database.DocumentImports.AsNoTracking().SingleOrDefaultAsync(value =>
            value.TenantId == context.TenantId && value.ActorId == context.PrincipalId && value.Id == id
            && value.Status == DocumentImportStatuses.Staging && value.ExpiresAt > clock.GetUtcNow(), cancellationToken).ConfigureAwait(false);
        if (operation is null || rows.Length == 0)
        {
            return null;
        }
        if (!await permissions.CanWriteWorkspaceAsync(operation.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        foreach (var row in rows.Where(value => !value.ObjectReady))
        {
            row.ExecutionId = executionId;
        }

        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        var versionNumbers = await database.FileVersions.AsNoTracking()
            .Where(version => version.TenantId == context.TenantId
                && rows.Select(row => row.FileVersionId).Contains(version.Id))
            .ToDictionaryAsync(version => version.Id, version => version.Version, cancellationToken).ConfigureAwait(false);
        var files = rows.Select(value => new DocumentImportFileVersionAuthorization(
            value.TransferId, value.SourceItemId, value.TargetItemId.Value,
            versionNumbers[value.FileVersionId],
            value.ObjectKey, value.FileName, value.MediaType, value.ByteLength, value.Sha256, value.ObjectReady)).ToArray();
        return new DocumentImportFileVersionsPage(files, hasMore ? rows[^1].TransferId : null, !hasMore);
    }

    public async ValueTask<bool> CompleteFileVersionsAsync(
        DocumentImportId id, string executionId, IReadOnlyList<Guid> transferIds,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(transferIds);
        if (transferIds.Count is < 1 or > 100 || transferIds.Distinct().Count() != transferIds.Count)
        {
            return false;
        }

        var context = Context;
        await LockImportAsync(id, cancellationToken).ConfigureAwait(false);
        var operation = await OwnedTrackingAsync(id, cancellationToken).ConfigureAwait(false);
        if (operation is null || operation.Status != DocumentImportStatuses.Staging || operation.ExpiresAt <= clock.GetUtcNow())
        {
            return false;
        }
        if (!await permissions.CanWriteWorkspaceAsync(operation.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return false;
        }

        var rows = await database.DocumentImportFileVersions.AsTracking().Where(value =>
            value.TenantId == context.TenantId && value.ImportId == id && transferIds.Contains(value.TransferId))
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (rows.Count != transferIds.Count || rows.Any(value => !value.ObjectReady && value.ExecutionId != executionId))
        {
            return false;
        }

        var versions = await database.FileVersions.AsTracking().Where(value =>
            value.TenantId == context.TenantId && rows.Select(row => row.FileVersionId).Contains(value.Id))
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        foreach (var row in rows)
        {
            var version = versions.SingleOrDefault(value => value.Id == row.FileVersionId);
            if (version is null || version.ObjectKey != row.ObjectKey || version.ByteLength != row.ByteLength
                || !string.Equals(version.Sha256, row.Sha256, StringComparison.Ordinal))
            {
                return false;
            }

            version.ObjectReady = true;
            row.ObjectReady = true;
        }
        var currentIds = rows.Select(value => value.FileVersionId).ToArray();
        var currentBodies = await database.FileBodies.AsNoTracking().Where(value =>
            value.TenantId == context.TenantId && currentIds.Contains(value.CurrentVersionId))
            .Select(value => value.ItemId).ToArrayAsync(cancellationToken).ConfigureAwait(false);
        if (currentBodies.Length > 0)
        {
            await database.DocumentImportItems.AsTracking().Where(value =>
                value.TenantId == context.TenantId && value.ImportId == id
                && currentBodies.Contains(value.TargetItemId)
                && value.FileVersionId != null && currentIds.Contains(value.FileVersionId.Value))
                .ExecuteUpdateAsync(update => update.SetProperty(value => value.ObjectReady, true), cancellationToken)
                .ConfigureAwait(false);
        }
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return true;
    }

    public async ValueTask<bool> MarkObjectReadyAsync(
        DocumentImportId id,
        string sourceId,
        long byteLength,
        string sha256,
        CancellationToken cancellationToken)
    {
        var context = Context;
        await LockImportAsync(id, cancellationToken).ConfigureAwait(false);
        var operation = await OwnedTrackingAsync(id, cancellationToken).ConfigureAwait(false);
        if (operation is null || operation.Status != DocumentImportStatuses.Staging)
        {
            return false;
        }
        var mapping = await database.DocumentImportItems.AsTracking().SingleOrDefaultAsync(
            value => value.TenantId == context.TenantId
                && value.ImportId == id
                && value.SourceId == sourceId,
            cancellationToken).ConfigureAwait(false);
        if (mapping?.FileVersionId is not { } fileVersionId)
        {
            return false;
        }
        var version = await database.FileVersions.AsTracking().SingleOrDefaultAsync(
            value => value.TenantId == context.TenantId && value.Id == fileVersionId,
            cancellationToken).ConfigureAwait(false);
        if (version is null
            || version.ByteLength != byteLength
            || !string.Equals(version.Sha256, sha256, StringComparison.Ordinal))
        {
            return false;
        }
        version.ObjectReady = true;
        mapping.ObjectReady = true;
        operation.UpdatedAt = clock.GetUtcNow();
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return true;
    }

    public async ValueTask<DocumentImportObjectRecord?> AuthorizeObjectUploadAsync(
        DocumentImportId id,
        string sourceId,
        CancellationToken cancellationToken)
    {
        var context = Context;
        return await (
            from operation in database.DocumentImports.AsNoTracking()
            join item in database.DocumentImportItems.AsNoTracking()
                on new { operation.TenantId, ImportId = operation.Id }
                equals new { item.TenantId, item.ImportId }
            join version in database.FileVersions.AsNoTracking()
                on new { item.TenantId, Id = item.FileVersionId!.Value }
                equals new { version.TenantId, version.Id }
            where operation.TenantId == context.TenantId
                && operation.ActorId == context.PrincipalId
                && operation.Id == id
                && operation.Status == DocumentImportStatuses.Staging
                && operation.ExpiresAt > clock.GetUtcNow()
                && item.SourceId == sourceId
                && item.FileVersionId != null
                && item.ObjectKey != null
            select new DocumentImportObjectRecord(
                item.SourceId,
                item.ObjectKey!,
                version.MediaType,
                version.ByteLength,
                version.Sha256,
                item.ObjectReady))
            .SingleOrDefaultAsync(cancellationToken).ConfigureAwait(false);
    }
}
