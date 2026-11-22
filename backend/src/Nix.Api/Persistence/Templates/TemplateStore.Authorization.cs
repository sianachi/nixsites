using System.Collections.Immutable;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.Templates;
using Nix.Domain.Audit;
using Nix.Domain.Files;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using Npgsql;

namespace Nix.Persistence.Templates;

public sealed partial class TemplateStore
{
    /// <summary>Authorizes every item mapping and identifies required body targets in one worker-owned import stage.</summary>
    public async ValueTask<Result<TemplateOperationWriteAuthorization>> AuthorizeOperationWritesAsync(
        TemplateOperationId operationId,
        CancellationToken cancellationToken)
    {
        var operation = await _database.TemplateOperations
            .AsNoTracking()
            .FirstOrDefaultAsync(candidate => candidate.Id == operationId, cancellationToken)
            .ConfigureAwait(false);
        if (operation is null
            || operation.ActorId != Context.PrincipalId
            || operation.Kind != TemplateOperationKind.Import
            || operation.State != TemplateOperationState.Provisioning
            || operation.ExpiresAt <= _clock.GetUtcNow()
            || !await _permissions.CanWriteWorkspaceAsync(operation.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateOperationWriteAuthorization>(
                TemplateErrors.NotFound("No such template import stage is visible."));
        }

        var mappings = await _database.TemplateOperationItems
            .AsNoTracking()
            .Where(candidate => candidate.OperationId == operationId)
            .OrderBy(candidate => candidate.TemplateSourceId)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (mappings.Count > 0)
        {
            var targets = mappings.Select(value => value.TargetItemId).ToArray();
            var provisioning = await _database.Items.IgnoreQueryFilters()
                .CountAsync(candidate => targets.Contains(candidate.Id)
                    && candidate.LifecycleState == ItemLifecycleState.Provisioning, cancellationToken)
                .ConfigureAwait(false);
            if (provisioning != targets.Length)
            {
                return Result.Failure<TemplateOperationWriteAuthorization>(
                    TemplateErrors.NotFound("No such template import stage is visible."));
            }
        }

        return Result.Success(new TemplateOperationWriteAuthorization(
            operationId,
            Context.TenantId,
            Context.PrincipalId,
            operation.WorkspaceId,
            mappings.Select(value => new TemplateBodyWrite(
                value.TemplateSourceId,
                value.TargetItemId,
                value.ItemType,
                value.BodyRequired)).ToArray(),
            CanWrite: true));
    }

    /// <summary>Authorizes a source or staged target body for one in-progress operation.</summary>
    public async ValueTask<Result<TemplateOperationAuthorization>> AuthorizeOperationItemAsync(
        Guid operationId,
        ItemId itemId,
        CancellationToken cancellationToken)
    {
        var operation = await _database.TemplateOperations
            .FirstOrDefaultAsync(candidate => candidate.Id == TemplateOperationId.From(operationId), cancellationToken)
            .ConfigureAwait(false);
        if (operation is not null)
        {
            if (operation.ActorId != Context.PrincipalId
                || operation.State != TemplateOperationState.Provisioning
                || operation.ExpiresAt <= _clock.GetUtcNow()
                || !await _permissions.CanWriteWorkspaceAsync(operation.WorkspaceId, cancellationToken).ConfigureAwait(false))
            {
                return Result.Failure<TemplateOperationAuthorization>(
                    TemplateErrors.NotFound("No such staging item is visible."));
            }

            var operationTypedId = TemplateOperationId.From(operationId);
            var mapping = await _database.TemplateOperationItems
                .FirstOrDefaultAsync(
                    candidate => candidate.OperationId == operationTypedId
                        && (candidate.SourceItemId == itemId || candidate.TargetItemId == itemId),
                    cancellationToken)
                .ConfigureAwait(false);
            if (mapping is null)
            {
                return Result.Failure<TemplateOperationAuthorization>(
                    TemplateErrors.NotFound("No such staging item is visible."));
            }

            var operationTargetCanWrite = mapping.TargetItemId == itemId
                && mapping.BodyRequired
                && await _database.Items.IgnoreQueryFilters().AnyAsync(
                    candidate => candidate.Id == itemId
                        && candidate.LifecycleState == ItemLifecycleState.Provisioning,
                    cancellationToken).ConfigureAwait(false);

            return Result.Success(new TemplateOperationAuthorization(
                operationId,
                itemId,
                Context.TenantId,
                Context.PrincipalId,
                operation.WorkspaceId,
                mapping.ItemType,
                mapping.SourceItemId == itemId,
                mapping.TargetItemId == itemId,
                operationTargetCanWrite));
        }

        var applicationTypedId = TemplateApplicationId.From(operationId);
        var application = await _database.TemplateApplications
            .FirstOrDefaultAsync(candidate => candidate.Id == applicationTypedId, cancellationToken)
            .ConfigureAwait(false);
        if (application is null
            || application.ActorId != Context.PrincipalId
            || application.State != TemplateOperationState.Provisioning
            || application.ExpiresAt <= _clock.GetUtcNow()
            || !await _permissions.CanWriteWorkspaceAsync(application.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateOperationAuthorization>(
                TemplateErrors.NotFound("No such staging item is visible."));
        }

        var applicationMapping = await _database.TemplateApplicationItems
            .FirstOrDefaultAsync(
                candidate => candidate.ApplicationId == applicationTypedId
                    && (candidate.SourceItemId == itemId || candidate.TargetItemId == itemId),
                cancellationToken)
            .ConfigureAwait(false);
        if (applicationMapping is null)
        {
            return Result.Failure<TemplateOperationAuthorization>(
                TemplateErrors.NotFound("No such staging item is visible."));
        }


        var applicationTargetCanWrite = applicationMapping.TargetItemId == itemId
            && applicationMapping.Created
            && applicationMapping.BodyRequired
            && await _database.Items.IgnoreQueryFilters().AnyAsync(
                candidate => candidate.Id == itemId
                    && candidate.LifecycleState == ItemLifecycleState.Provisioning,
                cancellationToken).ConfigureAwait(false);

        var sourceItem = await _database.Items.IgnoreQueryFilters()
            .SingleAsync(candidate => candidate.Id == applicationMapping.SourceItemId, cancellationToken)
            .ConfigureAwait(false);
        return Result.Success(new TemplateOperationAuthorization(
            operationId,
            itemId,
            Context.TenantId,
            Context.PrincipalId,
            application.WorkspaceId,
            sourceItem.Type,
            applicationMapping.SourceItemId == itemId,
            applicationMapping.TargetItemId == itemId,
            applicationTargetCanWrite));
    }

    /// <summary>Authorizes an active hidden template body for read or user-template editing.</summary>
    public async ValueTask<Result<TemplateItemAuthorization>> AuthorizeTemplateItemAsync(
        TemplateId templateId,
        Guid sourceId,
        CancellationToken cancellationToken)
    {
        var template = await ActiveTemplateAsync(templateId, cancellationToken).ConfigureAwait(false);
        if (template is null
            || !await _permissions.CanReadWorkspaceAsync(template.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateItemAuthorization>(TemplateErrors.NotFound("No such template item is visible."));
        }

        var activeIds = (await ActiveTreeAsync(template, cancellationToken).ConfigureAwait(false))
            .Where(item => item.TemplateSourceId == sourceId)
            .ToList();
        if (activeIds.Count != 1)
        {
            return Result.Failure<TemplateItemAuthorization>(TemplateErrors.NotFound("No such template item is visible."));
        }

        var item = activeIds[0];
        return Result.Success(new TemplateItemAuthorization(
            templateId,
            sourceId,
            item.Id,
            Context.TenantId,
            Context.PrincipalId,
            template.WorkspaceId,
            item.Type,
            true,
            false));
    }

    /// <summary>Returns a parent-first envelope snapshot for template-profile export.</summary>
    public async ValueTask<Result<TemplateExportSnapshot>> ExportAsync(
        TemplateId templateId,
        CancellationToken cancellationToken)
    {
        var template = await ActiveTemplateAsync(templateId, cancellationToken).ConfigureAwait(false);
        if (template is null
            || !await _permissions.CanReadWorkspaceAsync(template.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateExportSnapshot>(TemplateErrors.NotFound("No such template is visible."));
        }

        var items = await ActiveTreeAsync(template, cancellationToken).ConfigureAwait(false);
        if (items.Count > 200)
        {
            return Result.Failure<TemplateExportSnapshot>(TemplateErrors.Invalid(
                "A portable template may contain at most 200 items."));
        }
        var byItem = items.ToDictionary(item => item.Id, item => item.TemplateSourceId!.Value);
        var bodies = await BodyItemIdsAsync(items.Select(item => item.Id), cancellationToken).ConfigureAwait(false);
        var itemIds = items.Where(item => item.Type == "file").Select(item => item.Id).ToArray();
        var currentVersions = itemIds.Length == 0
            ? new Dictionary<ItemId, FileVersionId>()
            : await _database.FileBodies.AsNoTracking()
                .Where(body => body.TenantId == Context.TenantId
                    && body.WorkspaceId == template.WorkspaceId
                    && itemIds.Contains(body.ItemId))
                .ToDictionaryAsync(body => body.ItemId, body => body.CurrentVersionId, cancellationToken)
                .ConfigureAwait(false);
        var fileRows = itemIds.Length == 0
            ? []
            : await (from version in _database.FileVersions.AsNoTracking()
                     where version.TenantId == Context.TenantId
                         && version.WorkspaceId == template.WorkspaceId
                         && itemIds.Contains(version.ItemId)
                         && version.ObjectReady
                     orderby version.ItemId, version.Version
                     select new
                     {
                         version.ItemId,
                         version.Id,
                         version.Version,
                         version.ObjectKey,
                         version.FileName,
                         version.MediaType,
                         version.ByteLength,
                         version.Sha256,
                         version.Previewable,
                         version.PixelWidth,
                         version.PixelHeight
                     })
                .Take(20_001)
                .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (fileRows.Count > 20_000)
        {
            return Result.Failure<TemplateExportSnapshot>(TemplateErrors.Invalid(
                "A portable template may contain at most 20,000 file versions."));
        }
        if (currentVersions.Count != itemIds.Length
            || itemIds.Any(itemId => !fileRows.Any(file => file.ItemId == itemId
                && file.Id == currentVersions.GetValueOrDefault(itemId)))
            || fileRows.GroupBy(file => file.ItemId).Any(group => group.Count() > 100))
        {
            return Result.Failure<TemplateExportSnapshot>(TemplateErrors.Conflict(
                "A template attachment is missing its current ready version or exceeds 100 versions."));
        }
        var sourceByItem = items.ToDictionary(item => item.Id, item => item.TemplateSourceId!.Value);
        var files = fileRows.Select(file => new TemplateExportFile(
            file.Id.Value, sourceByItem[file.ItemId], file.Version,
            currentVersions.TryGetValue(file.ItemId, out var currentVersion) && currentVersion == file.Id,
            file.ObjectKey, file.FileName, file.MediaType, file.ByteLength,
            file.Sha256, file.Previewable, file.PixelWidth, file.PixelHeight)).ToArray();
        return Result.Success(new TemplateExportSnapshot(
            template.Id,
            template.WorkspaceId,
            template.ProfileKey,
            template.Title,
            template.Description,
            template.Origin,
            template.Revision,
            template.IncludeBody,
            template.IncludeChildren,
            items.Select(item => new TemplateExportItem(
                item.TemplateSourceId!.Value,
                item.ParentId is { } parent ? byItem[parent] : null,
                item.Id,
                item.Type,
                ItemProperties.ReadTitle(item.Properties),
                item.Seq,
                item.Properties,
                item.Schema,
                item.Views,
                bodies.Contains(item.Id),
                item.Recurrence)).ToArray(),
            template.Initialization is null ? TemplateInitialization.Empty : ReadInitializationOrThrow(template.Initialization),
            files));
    }

    public async ValueTask<TemplateExportFileDownload?> AuthorizeExportFileAsync(
        TemplateId templateId,
        int expectedRevision,
        Guid fileVersionId,
        CancellationToken cancellationToken)
    {
        var template = await ActiveTemplateAsync(templateId, cancellationToken).ConfigureAwait(false);
        if (template is null || template.Revision != expectedRevision
            || !await _permissions.CanReadWorkspaceAsync(template.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        var activeFileIds = (await ActiveTreeAsync(template, cancellationToken).ConfigureAwait(false))
            .Where(item => item.Type == "file").Select(item => item.Id).ToArray();
        if (activeFileIds.Length == 0)
        {
            return null;
        }

        var objectKey = await _database.FileVersions.AsNoTracking()
            .Where(version => version.TenantId == Context.TenantId
                && version.WorkspaceId == template.WorkspaceId
                && activeFileIds.Contains(version.ItemId)
                && version.Id == FileVersionId.From(fileVersionId)
                && version.ObjectReady)
            .Select(version => version.ObjectKey)
            .SingleOrDefaultAsync(cancellationToken).ConfigureAwait(false);
        return objectKey is null ? null : new TemplateExportFileDownload(objectKey);
    }

    public async ValueTask<Result<TemplateExportFilesPage>> ExportFilesPageAsync(
        TemplateId templateId,
        int? expectedRevision,
        Guid? afterFileVersionId,
        int limit,
        CancellationToken cancellationToken)
    {
        if (limit is < 1 or > 100)
        {
            return Result.Failure<TemplateExportFilesPage>(TemplateErrors.Invalid("The file page size is invalid."));
        }
        var template = await ActiveTemplateAsync(templateId, cancellationToken).ConfigureAwait(false);
        if (template is null || !await _permissions.CanReadWorkspaceAsync(template.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateExportFilesPage>(TemplateErrors.NotFound("No such template is visible."));
        }
        if (expectedRevision is { } revision && revision != template.Revision)
        {
            return Result.Failure<TemplateExportFilesPage>(TemplateErrors.Conflict("The template changed while its file export was being paged."));
        }
        var items = await ActiveTreeAsync(template, cancellationToken).ConfigureAwait(false);
        if (items.Count > 200)
        {
            return Result.Failure<TemplateExportFilesPage>(TemplateErrors.Invalid("A portable template may contain at most 200 items."));
        }
        var itemSources = items.Where(item => item.Type == "file")
            .ToDictionary(item => item.Id, item => item.TemplateSourceId!.Value);
        var itemIds = itemSources.Keys.ToArray();
        if (itemIds.Length == 0)
        {
            return Result.Success(new TemplateExportFilesPage(template.Revision, [], null, true));
        }
        var ready = _database.FileVersions.AsNoTracking().Where(version => version.TenantId == Context.TenantId
            && version.WorkspaceId == template.WorkspaceId && itemIds.Contains(version.ItemId) && version.ObjectReady);
        if (afterFileVersionId is null)
        {
            if (await ready.CountAsync(cancellationToken).ConfigureAwait(false) > 20_000
                || await ready.GroupBy(version => version.ItemId).AnyAsync(group => group.Count() > 100, cancellationToken).ConfigureAwait(false))
            {
                return Result.Failure<TemplateExportFilesPage>(TemplateErrors.Invalid("A portable template may contain at most 20,000 file versions and 100 per file."));
            }
            var readyCurrentCount = await (from body in _database.FileBodies.AsNoTracking()
                                           join version in _database.FileVersions.AsNoTracking()
                                               on new { body.TenantId, body.ItemId, VersionId = body.CurrentVersionId }
                                               equals new { version.TenantId, ItemId = version.ItemId, VersionId = version.Id }
                                           where body.TenantId == Context.TenantId && body.WorkspaceId == template.WorkspaceId
                                               && itemIds.Contains(body.ItemId) && version.ObjectReady
                                           select body.ItemId).Distinct().CountAsync(cancellationToken).ConfigureAwait(false);
            if (readyCurrentCount != itemIds.Length)
            {
                return Result.Failure<TemplateExportFilesPage>(TemplateErrors.Conflict("A template attachment is missing its current ready version."));
            }
        }
        var query = ready;
        if (afterFileVersionId is { } cursor)
        {
            query = query.Where(version => version.Id.Value.CompareTo(cursor) > 0);
        }
        var rows = await query.TagWith("TemplateStore.ExportFilesPageAsync.file_versions_page")
            .OrderBy(version => version.Id).Take(limit + 1)
            .Select(version => new
            {
                version.Id,
                version.ItemId,
                version.Version,
                version.ObjectKey,
                version.FileName,
                version.MediaType,
                version.ByteLength,
                version.Sha256,
                version.Previewable,
                version.PixelWidth,
                version.PixelHeight,
            }).ToListAsync(cancellationToken).ConfigureAwait(false);
        var hasMore = rows.Count > limit;
        var pageRows = rows.Take(limit).ToArray();
        var currents = await _database.FileBodies.AsNoTracking()
            .Where(body => body.TenantId == Context.TenantId && body.WorkspaceId == template.WorkspaceId
                && pageRows.Select(row => row.ItemId).Distinct().Contains(body.ItemId))
            .ToDictionaryAsync(body => body.ItemId, body => body.CurrentVersionId, cancellationToken)
            .ConfigureAwait(false);
        var files = pageRows.Select(row => new TemplateExportFile(
            row.Id.Value, itemSources[row.ItemId], row.Version,
            currents.TryGetValue(row.ItemId, out var currentId) && currentId == row.Id,
            row.ObjectKey, row.FileName, row.MediaType, row.ByteLength, row.Sha256,
            row.Previewable, row.PixelWidth, row.PixelHeight)).ToArray();
        return Result.Success(new TemplateExportFilesPage(template.Revision, files,
            hasMore ? pageRows[^1].Id.Value : null, !hasMore));
    }

}
