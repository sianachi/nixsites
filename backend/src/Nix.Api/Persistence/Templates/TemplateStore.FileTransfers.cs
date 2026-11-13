using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Files;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Persistence.ObjectStorage;

namespace Nix.Persistence.Templates;

public sealed partial class TemplateStore
{
    /// <summary>Stages current file versions for capture, import, or editable-draft operations.</summary>
    public ValueTask<Result<IReadOnlyList<TemplateFileTransfer>>> PrepareTemplateFilesAsync(
        TemplateOperationId operationId,
        IReadOnlyList<TemplateOperationItem> mappings,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(mappings);
        var candidates = mappings.Where(mapping => mapping.ItemType == "file").Select(mapping =>
            (SourceItemId: mapping.SourceItemId, TargetItemId: mapping.TargetItemId)).ToArray();
        return PrepareFileTransfersAsync(operationId, null, candidates, cancellationToken);
    }

    /// <summary>Stages current template file versions for newly created application targets.</summary>
    public ValueTask<Result<IReadOnlyList<TemplateFileTransfer>>> PrepareApplicationFilesAsync(
        TemplateApplicationId applicationId,
        IReadOnlyList<TemplateApplicationItem> mappings,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(mappings);
        var candidates = mappings.Where(mapping => mapping.Created && mapping.ItemType == "file").Select(mapping =>
            ((ItemId?)mapping.SourceItemId, mapping.TargetItemId)).ToArray();
        return PrepareFileTransfersAsync(null, applicationId, candidates, cancellationToken);
    }

    private async ValueTask<Result<IReadOnlyList<TemplateFileTransfer>>> PrepareFileTransfersAsync(
        TemplateOperationId? operationId,
        TemplateApplicationId? applicationId,
        IReadOnlyList<(ItemId? SourceItemId, ItemId TargetItemId)> candidates,
        CancellationToken cancellationToken)
    {
        if (candidates.Count == 0)
        {
            return Result.Success<IReadOnlyList<TemplateFileTransfer>>([]);
        }

        var context = Context;
        var ownerWorkspace = operationId is { } operation
            ? await _database.TemplateOperations.AsNoTracking()
                .Where(candidate => candidate.TenantId == context.TenantId && candidate.Id == operation)
                .Select(candidate => (WorkspaceId?)candidate.WorkspaceId)
                .SingleOrDefaultAsync(cancellationToken).ConfigureAwait(false)
            : await _database.TemplateApplications.AsNoTracking()
                .Where(candidate => candidate.TenantId == context.TenantId && candidate.Id == applicationId)
                .Select(candidate => (WorkspaceId?)candidate.WorkspaceId)
                .SingleOrDefaultAsync(cancellationToken).ConfigureAwait(false);
        if (ownerWorkspace is not { } workspaceId)
        {
            return Result.Failure<IReadOnlyList<TemplateFileTransfer>>(
                TemplateErrors.Conflict("The template stage disappeared before its file copies were prepared."));
        }

        var existing = await _database.TemplateFileTransfers.AsTracking()
            .Where(transfer => transfer.TenantId == context.TenantId
                && transfer.OperationId == operationId
                && transfer.ApplicationId == applicationId)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (existing.Count > 0)
        {
            return Result.Success<IReadOnlyList<TemplateFileTransfer>>(existing);
        }

        if (!await _permissions.CanReadWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<IReadOnlyList<TemplateFileTransfer>>(
                TemplateErrors.NotFound("A file attached to this template is no longer visible."));
        }

        await _database.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({workspaceId.Value.ToString()}, 0))",
            cancellationToken).ConfigureAwait(false);

        var sourceIds = candidates.Select(candidate => candidate.SourceItemId).Where(id => id is not null)
            .Select(id => id!.Value).Distinct().ToArray();
        var sources = await (
            from body in _database.FileBodies.AsNoTracking()
            join version in _database.FileVersions.AsNoTracking()
                on new { body.TenantId, body.ItemId, VersionId = body.CurrentVersionId }
                equals new { version.TenantId, ItemId = version.ItemId, VersionId = version.Id }
            where body.TenantId == context.TenantId
                && body.WorkspaceId == workspaceId
                && sourceIds.Contains(body.ItemId)
                && version.ObjectReady
            select new { Body = body, Version = version })
            .ToDictionaryAsync(value => value.Body.ItemId, cancellationToken).ConfigureAwait(false);

        var targetIds = candidates.Select(candidate => candidate.TargetItemId).Distinct().ToArray();
        var targetVersionNumbers = await _database.FileVersions
            .Where(version => version.TenantId == context.TenantId && targetIds.Contains(version.ItemId))
            .GroupBy(version => version.ItemId)
            .Select(group => new { ItemId = group.Key, Version = group.Max(version => version.Version) })
            .ToDictionaryAsync(value => value.ItemId, value => value.Version, cancellationToken)
            .ConfigureAwait(false);

        var pending = new List<TemplateFileTransfer>(candidates.Count);
        foreach (var (sourceItemId, targetItemId) in candidates)
        {
            if (sourceItemId is not { } sourceId
                || !sources.TryGetValue(sourceId, out var source)
                || source.Version.ByteLength is < 0 or > 104_857_600
                || source.Version.Sha256 is not { Length: 64 } digest
                || digest.Any(character => !char.IsAsciiHexDigit(character))
                || !ObjectStorageKeys.BelongsTo(context.TenantId, source.Version.ObjectKey))
            {
                return Result.Failure<IReadOnlyList<TemplateFileTransfer>>(
                    TemplateErrors.Conflict("A current file version required by this template is not available."));
            }

            var existingTargetVersion = targetVersionNumbers.GetValueOrDefault(targetItemId);
            var targetVersionId = FileVersionId.Create();
            var targetVersionNumber = checked(existingTargetVersion + 1);
            var now = _clock.GetUtcNow();
            var version = new FileVersion
            {
                Id = targetVersionId,
                TenantId = context.TenantId,
                WorkspaceId = workspaceId,
                ItemId = targetItemId,
                Version = targetVersionNumber,
                ObjectKey = ObjectStorageKeys.FileVersion(context.TenantId, targetVersionId),
                FileName = source.Version.FileName,
                MediaType = source.Version.MediaType,
                ByteLength = source.Version.ByteLength,
                Sha256 = digest,
                ObjectReady = false,
                Previewable = source.Version.Previewable,
                PixelWidth = source.Version.PixelWidth,
                PixelHeight = source.Version.PixelHeight,
                CreatedBy = context.PrincipalId,
                CreatedAt = now,
            };
            var transfer = new TemplateFileTransfer
            {
                Id = Guid.CreateVersion7(),
                TenantId = context.TenantId,
                WorkspaceId = workspaceId,
                OperationId = operationId,
                ApplicationId = applicationId,
                SourceItemId = sourceId,
                TargetItemId = targetItemId,
                TargetVersionId = targetVersionId,
                SourceObjectKey = source.Version.ObjectKey,
                FileName = source.Version.FileName,
                MediaType = source.Version.MediaType,
                ByteLength = source.Version.ByteLength,
                Sha256 = digest,
                Previewable = source.Version.Previewable,
                PixelWidth = source.Version.PixelWidth,
                PixelHeight = source.Version.PixelHeight,
            };
            _database.FileVersions.Add(version);
            _database.TemplateFileTransfers.Add(transfer);
            pending.Add(transfer);
            targetVersionNumbers[targetItemId] = targetVersionNumber;
        }

        return Result.Success<IReadOnlyList<TemplateFileTransfer>>(pending);
    }

    /// <summary>Issues exact immutable copy metadata for the current live worker lease.</summary>
    public async ValueTask<TemplateFileTransferPage?> AuthorizeCopyAsync(
        string ownerKind,
        Guid ownerId,
        string executionId,
        Guid? afterTransferId,
        int limit,
        CancellationToken cancellationToken)
    {
        var context = Context;
        if (string.IsNullOrWhiteSpace(executionId) || executionId.Length > 128)
        {
            return null;
        }

        if (limit is < 1 or > 100)
        {
            return null;
        }

        var query = OwnerTransfers(ownerKind, ownerId, context.TenantId);
        if (afterTransferId is { } cursor)
        {
            query = query.Where(transfer => transfer.Id.CompareTo(cursor) > 0);
        }
        var page = await query
            .OrderBy(transfer => transfer.Id)
            .Take(limit + 1)
            .AsTracking()
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        var hasMore = page.Count > limit;
        var transfers = page.Take(limit).ToList();
        if (transfers.Count == 0
            || !await OwnerCanCopyAsync(ownerKind, ownerId, context, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        var versionsById = await _database.FileVersions.AsTracking()
            .Where(version => version.TenantId == context.TenantId
                && transfers.Select(transfer => transfer.TargetVersionId).Contains(version.Id))
            .ToDictionaryAsync(version => version.Id, cancellationToken).ConfigureAwait(false);
        var authorized = new List<TemplateFileTransferAuthorization>(transfers.Count);
        foreach (var transfer in transfers)
        {
            if (!versionsById.TryGetValue(transfer.TargetVersionId, out var target)
                || target.ItemId != transfer.TargetItemId
                || target.WorkspaceId != transfer.WorkspaceId
                || target.ObjectKey != ObjectStorageKeys.FileVersion(context.TenantId, target.Id)
                || target.ByteLength != transfer.ByteLength
                || !string.Equals(target.Sha256, transfer.Sha256, StringComparison.Ordinal))
            {
                return null;
            }

            if (!target.ObjectReady)
            {
                transfer.ExecutionId = executionId;
            }
            authorized.Add(new TemplateFileTransferAuthorization(
                transfer.Id,
                transfer.SourceItemId.Value,
                transfer.TargetItemId.Value,
                target.Version,
                transfer.SourceObjectKey,
                target.ObjectKey,
                transfer.FileName,
                transfer.MediaType,
                transfer.ByteLength,
                transfer.Sha256,
                target.ObjectReady));
        }
        if (transfers.Any(transfer => !versionsById[transfer.TargetVersionId].ObjectReady))
        {
            await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        }
        return new TemplateFileTransferPage(
            authorized,
            hasMore ? transfers[^1].Id : null,
            !hasMore);
    }

    /// <summary>Publishes every staged target only when this exact lease prepared its capabilities.</summary>
    public async ValueTask<bool> CompleteCopyAsync(
        string ownerKind,
        Guid ownerId,
        string executionId,
        IReadOnlyList<Guid> transferIds,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(transferIds);
        if (transferIds.Count is < 1 or > 100 || transferIds.Distinct().Count() != transferIds.Count)
        {
            return false;
        }

        var context = Context;
        var transfers = await OwnerTransfers(ownerKind, ownerId, context.TenantId)
            .Where(transfer => transferIds.Contains(transfer.Id))
            .AsTracking()
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (transfers.Count != transferIds.Count
            || !await OwnerCanCopyAsync(ownerKind, ownerId, context, cancellationToken).ConfigureAwait(false))
        {
            return false;
        }

        var versions = await _database.FileVersions.AsTracking()
            .Where(version => version.TenantId == context.TenantId
                && transfers.Select(transfer => transfer.TargetVersionId).Contains(version.Id))
            .ToDictionaryAsync(version => version.Id, cancellationToken).ConfigureAwait(false);
        if (transfers.Any(transfer => !versions.TryGetValue(transfer.TargetVersionId, out var version)
                || version.ItemId != transfer.TargetItemId
                || version.ByteLength != transfer.ByteLength
                || !string.Equals(version.Sha256, transfer.Sha256, StringComparison.Ordinal)
                || (!version.ObjectReady && !string.Equals(transfer.ExecutionId, executionId, StringComparison.Ordinal))))
        {
            return false;
        }

        var targetIds = transfers.Select(transfer => transfer.TargetItemId).Distinct().ToArray();
        var bodies = await _database.FileBodies.AsTracking()
            .Where(body => body.TenantId == context.TenantId && targetIds.Contains(body.ItemId))
            .ToDictionaryAsync(body => body.ItemId, cancellationToken).ConfigureAwait(false);
        foreach (var transfer in transfers)
        {
            var target = versions[transfer.TargetVersionId];
            if (!target.ObjectReady)
            {
                target.ObjectReady = true;
            }
            if (bodies.TryGetValue(transfer.TargetItemId, out var body))
            {
                body.CurrentVersionId = target.Id;
            }
            else
            {
                body = new FileBody
                {
                    TenantId = transfer.TenantId,
                    WorkspaceId = transfer.WorkspaceId,
                    ItemId = transfer.TargetItemId,
                    CurrentVersionId = target.Id,
                };
                _database.FileBodies.Add(body);
                bodies.Add(body.ItemId, body);
            }
        }
        await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return true;
    }

    /// <summary>Returns true for any staged file target not yet ready for stage publication.</summary>
    public async ValueTask<bool> HasUnreadyCopiesAsync(
        string ownerKind,
        Guid ownerId,
        CancellationToken cancellationToken)
    {
        var context = Context;
        if (ownerKind == "operation")
        {
            var operation = TemplateOperationId.From(ownerId);
            var fileTargets = _database.TemplateOperationItems.AsNoTracking()
                .Where(mapping => mapping.TenantId == context.TenantId
                    && mapping.OperationId == operation
                    && mapping.ItemType == "file")
                .Select(mapping => mapping.TargetItemId);
            return await fileTargets.AnyAsync(targetId => !_database.FileBodies.Any(body =>
                    body.TenantId == context.TenantId
                    && body.ItemId == targetId
                    && _database.FileVersions.Any(version => version.TenantId == context.TenantId
                        && version.ItemId == body.ItemId
                        && version.Id == body.CurrentVersionId
                        && version.ObjectReady)), cancellationToken).ConfigureAwait(false);
        }
        if (ownerKind == "application")
        {
            var application = TemplateApplicationId.From(ownerId);
            var fileTargets = _database.TemplateApplicationItems.AsNoTracking()
                .Where(mapping => mapping.TenantId == context.TenantId
                    && mapping.ApplicationId == application
                    && mapping.Created
                    && mapping.ItemType == "file")
                .Select(mapping => mapping.TargetItemId);
            return await fileTargets.AnyAsync(targetId => !_database.FileBodies.Any(body =>
                    body.TenantId == context.TenantId
                    && body.ItemId == targetId
                    && _database.FileVersions.Any(version => version.TenantId == context.TenantId
                        && version.ItemId == body.ItemId
                        && version.Id == body.CurrentVersionId
                        && version.ObjectReady)), cancellationToken).ConfigureAwait(false);
        }
        return true;
    }

    /// <summary>Returns the workspace containing one staged file-copy owner.</summary>
    public async ValueTask<WorkspaceId?> GetCopyWorkspaceAsync(
        string ownerKind,
        Guid ownerId,
        CancellationToken cancellationToken)
    {
        var context = Context;
        var transfer = await OwnerTransfers(ownerKind, ownerId, context.TenantId)
            .AsNoTracking()
            .Select(candidate => (WorkspaceId?)candidate.WorkspaceId)
            .FirstOrDefaultAsync(cancellationToken).ConfigureAwait(false);
        return transfer;
    }

    private IQueryable<TemplateFileTransfer> OwnerTransfers(string ownerKind, Guid ownerId, TenantId tenantId) =>
        ownerKind switch
        {
            "operation" => _database.TemplateFileTransfers.Where(transfer =>
                transfer.TenantId == tenantId && transfer.OperationId == TemplateOperationId.From(ownerId)),
            "application" => _database.TemplateFileTransfers.Where(transfer =>
                transfer.TenantId == tenantId && transfer.ApplicationId == TemplateApplicationId.From(ownerId)),
            _ => _database.TemplateFileTransfers.Where(_ => false),
        };

    private async ValueTask<bool> OwnerCanCopyAsync(
        string ownerKind,
        Guid ownerId,
        NixSessionContext context,
        CancellationToken cancellationToken)
    {
        var now = _clock.GetUtcNow();
        bool active;
        if (ownerKind == "operation")
        {
            var operationId = TemplateOperationId.From(ownerId);
            active = await _database.TemplateOperations.AsNoTracking().AnyAsync(operation =>
                operation.TenantId == context.TenantId
                && operation.Id == operationId
                && operation.ActorId == context.PrincipalId
                && operation.State == TemplateOperationState.Provisioning
                && operation.ExpiresAt > now, cancellationToken).ConfigureAwait(false);
        }
        else if (ownerKind == "application")
        {
            var applicationId = TemplateApplicationId.From(ownerId);
            active = await _database.TemplateApplications.AsNoTracking().AnyAsync(application =>
                application.TenantId == context.TenantId
                && application.Id == applicationId
                && application.ActorId == context.PrincipalId
                && application.State == TemplateOperationState.Provisioning
                && application.ExpiresAt > now, cancellationToken).ConfigureAwait(false);
        }
        else
        {
            return false;
        }

        if (!active)
        {
            return false;
        }

        var workspaceId = await OwnerTransfers(ownerKind, ownerId, context.TenantId)
            .Select(transfer => (WorkspaceId?)transfer.WorkspaceId)
            .FirstOrDefaultAsync(cancellationToken).ConfigureAwait(false);
        return workspaceId is { } workspace
            && await _permissions.CanWriteWorkspaceAsync(workspace, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Finds every operation with an unpublished file body in one bounded database query.</summary>
    public async ValueTask<HashSet<TemplateOperationId>> OperationsWithUnreadyCopiesAsync(
        IReadOnlyCollection<TemplateOperationId> operationIds,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(operationIds);
        if (operationIds.Count == 0)
        {
            return [];
        }

        var tenantId = Context.TenantId;
        return await _database.TemplateOperationItems.AsNoTracking()
            .Where(mapping => mapping.TenantId == tenantId
                && operationIds.Contains(mapping.OperationId)
                && mapping.ItemType == "file"
                && !_database.FileBodies.Any(body => body.TenantId == tenantId
                    && body.ItemId == mapping.TargetItemId
                    && _database.FileVersions.Any(version => version.TenantId == tenantId
                        && version.ItemId == body.ItemId
                        && version.Id == body.CurrentVersionId
                        && version.ObjectReady)))
            .Select(mapping => mapping.OperationId)
            .Distinct()
            .ToHashSetAsync(cancellationToken)
            .ConfigureAwait(false);
    }
}
