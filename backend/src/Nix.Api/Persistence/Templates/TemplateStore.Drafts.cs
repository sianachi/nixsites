using System.Collections.Immutable;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.Templates;
using Nix.Abstractions.Workers;
using Nix.Domain.Audit;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Templates;

public sealed partial class TemplateStore
{
    /// <summary>Creates a complete editable copy while the active revision remains visible.</summary>
    public async ValueTask<Result<TemplateDraftPlan>> BeginDraftAsync(
        TemplateId templateId,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        if (InvalidKey(idempotencyKey))
        {
            return Result.Failure<TemplateDraftPlan>(TemplateErrors.Invalid("An idempotency key is required."));
        }

        var template = await _database.WorkspaceTemplates
            .AsTracking()
            .FirstOrDefaultAsync(
                candidate => candidate.Id == templateId && candidate.State == TemplateState.Active,
                cancellationToken)
            .ConfigureAwait(false);
        if (template is null
            || !await _permissions.CanWriteWorkspaceAsync(template.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateDraftPlan>(TemplateErrors.NotFound("No such template is visible."));
        }

        if (template.Origin != TemplateOrigin.User)
        {
            return Result.Failure<TemplateDraftPlan>(
                TemplateErrors.Managed("Managed templates are read-only. Duplicate one before editing it."));
        }

        await SweepExpiredAsync(template.WorkspaceId, cancellationToken).ConfigureAwait(false);
        await LockTemplateAsync(template.Id, cancellationToken).ConfigureAwait(false);
        await LockIdempotencyKeyAsync(idempotencyKey, cancellationToken).ConfigureAwait(false);
        if (await IdempotencyKeyBelongsElsewhereAsync(
            TemplateOperationKind.Edit,
            idempotencyKey,
            cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateDraftPlan>(
                TemplateErrors.Conflict("This idempotency key belongs to another template operation."));
        }
        var existingDraft = await _database.TemplateOperations.FirstOrDefaultAsync(
            operation => operation.ActorId == Context.PrincipalId
                && operation.IdempotencyKey == idempotencyKey
                && operation.Kind == TemplateOperationKind.Edit,
            cancellationToken).ConfigureAwait(false);
        if (existingDraft is not null && existingDraft.TemplateId != templateId)
        {
            return Result.Failure<TemplateDraftPlan>(
                TemplateErrors.Conflict("This idempotency key belongs to another template draft."));
        }
        await _database.Entry(template).ReloadAsync(cancellationToken).ConfigureAwait(false);
        if (await DraftReplayAsync(templateId, idempotencyKey, cancellationToken).ConfigureAwait(false) is { } replay)
        {
            return Result.Success(replay);
        }

        if (template.PendingRootItemId is not null)
        {
            return Result.Failure<TemplateDraftPlan>(
                TemplateErrors.Conflict("This template already has a draft or revision being prepared."));
        }

        var source = await ActiveTreeAsync(template, cancellationToken).ConfigureAwait(false);
        if (source.Count == 0)
        {
            return Result.Failure<TemplateDraftPlan>(TemplateErrors.Invalid("The template has no active root."));
        }
        var operationId = TemplateOperationId.Create();
        var now = _clock.GetUtcNow();
        var expiresAt = now + StagingLifetime;
        var targetIds = source.ToDictionary(item => item.Id, _ => ItemId.Create());
        var bodySources = await BodyItemIdsAsync(source.Select(item => item.Id), cancellationToken).ConfigureAwait(false);
        var staged = new List<Item>(source.Count);
        var mappings = new List<TemplateOperationItem>(source.Count);
        foreach (var item in source)
        {
            var targetId = targetIds[item.Id];
            staged.Add(CloneTemplateItem(
                item,
                template.Id,
                item.TemplateSourceId!.Value,
                item.ParentId is { } parent ? targetIds[parent] : null,
                targetId,
                false,
                null,
                now));
            mappings.Add(new TemplateOperationItem
            {
                OperationId = operationId,
                TenantId = Context.TenantId,
                TemplateSourceId = item.TemplateSourceId.Value,
                SourceItemId = item.Id,
                TargetItemId = targetId,
                ItemType = item.Type,
                BodyRequired = bodySources.Contains(item.Id),
            });
        }

        template.PendingRootItemId = targetIds[source[0].Id];
        _database.Items.AddRange(staged);
        _database.TemplateOperations.Add(new TemplateOperation
        {
            Id = operationId,
            TenantId = Context.TenantId,
            WorkspaceId = template.WorkspaceId,
            TemplateId = template.Id,
            Kind = TemplateOperationKind.Edit,
            IdempotencyKey = idempotencyKey,
            ActorId = Context.PrincipalId,
            DraftTitle = template.Title,
            DraftDescription = template.Description,
            DraftInitialization = template.Initialization ?? TemplateInitializationJson.Write(TemplateInitialization.Empty),
            State = TemplateOperationState.Provisioning,
            CreatedAt = now,
            ExpiresAt = expiresAt,
        });
        _database.TemplateOperationItems.AddRange(mappings);
        await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        var fileTransfers = await PrepareTemplateFilesAsync(operationId, mappings, cancellationToken)
            .ConfigureAwait(false);
        if (fileTransfers.IsFailure)
        {
            return Result.Failure<TemplateDraftPlan>(fileTransfers.Error);
        }
        if (fileTransfers.Value.Count > 0)
        {
            await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        }
        await RebuildClosureAsync(staged.Select(item => item.Id), cancellationToken).ConfigureAwait(false);

        return Result.Success(new TemplateDraftPlan(
            operationId,
            template.Id,
            template.Title,
            template.Description,
            expiresAt,
            BuildTree(staged, bodySources.Select(sourceId => targetIds[sourceId]).ToHashSet()),
            mappings.Select(mapping => new TemplateItemMapping(
                mapping.SourceItemId!.Value.Value,
                mapping.TargetItemId,
                mapping.ItemType)).ToArray(),
            mappings.Where(mapping => mapping.BodyRequired).Select(mapping => new TemplateBodyCopy(
                mapping.SourceItemId!.Value,
                mapping.TargetItemId,
                mapping.ItemType)).ToArray(),
            ReadInitializationOrThrow(template.Initialization)));
    }

    /// <summary>Reads a caller-owned provisioning draft without exposing another active revision.</summary>
    public async ValueTask<Result<TemplateDraftPlan>> DraftAsync(
        TemplateId templateId,
        TemplateOperationId operationId,
        CancellationToken cancellationToken)
    {
        var loaded = await LoadDraftAsync(templateId, operationId, cancellationToken).ConfigureAwait(false);
        return loaded.IsFailure
            ? Result.Failure<TemplateDraftPlan>(loaded.Error)
            : Result.Success(await DraftPlanAsync(loaded.Value, cancellationToken).ConfigureAwait(false));
    }

    /// <summary>Updates catalog metadata in a draft; it is applied only by Save.</summary>
    public async ValueTask<Result<TemplateDraftPlan>> UpdateDraftMetadataAsync(
        TemplateId templateId,
        TemplateOperationId operationId,
        string? title,
        string? description,
        CancellationToken cancellationToken)
        => await UpdateDraftMetadataAsync(
            templateId,
            operationId,
            title,
            description,
            null,
            cancellationToken).ConfigureAwait(false);

    /// <summary>Updates draft metadata and its complete initialization definition.</summary>
    public async ValueTask<Result<TemplateDraftPlan>> UpdateDraftMetadataAsync(
        TemplateId templateId,
        TemplateOperationId operationId,
        string? title,
        string? description,
        TemplateInitialization? initialization,
        CancellationToken cancellationToken)
    {
        await LockTemplateStagesAsync(cancellationToken).ConfigureAwait(false);
        var loaded = await LoadDraftAsync(templateId, operationId, cancellationToken).ConfigureAwait(false);
        if (loaded.IsFailure)
        {
            return Result.Failure<TemplateDraftPlan>(loaded.Error);
        }
        await LockWorkspaceTemplatesAsync(loaded.Value.WorkspaceId, cancellationToken).ConfigureAwait(false);

        var operation = loaded.Value;
        var nextTitle = operation.DraftTitle;
        if (title is not null)
        {
            if (string.IsNullOrWhiteSpace(title) || title.Length > 200)
            {
                return Result.Failure<TemplateDraftPlan>(
                    TemplateErrors.Invalid("A template title must be between 1 and 200 characters."));
            }

            nextTitle = title.Trim();
        }

        if (description is { Length: > 1000 })
        {
            return Result.Failure<TemplateDraftPlan>(
                TemplateErrors.Invalid("A template description may contain at most 1,000 characters."));
        }

        var nextDescription = description ?? operation.DraftDescription;
        var nextInitialization = operation.DraftInitialization;
        if (initialization is not null)
        {
            var sourceIds = await _database.TemplateOperationItems
                .Where(mapping => mapping.OperationId == operationId)
                .Select(mapping => mapping.TemplateSourceId)
                .ToHashSetAsync(cancellationToken)
                .ConfigureAwait(false);
            if (TemplateInitializationValidator.Validate(initialization, sourceIds) is { } initializationRefusal)
            {
                return Result.Failure<TemplateDraftPlan>(TemplateErrors.Invalid(initializationRefusal));
            }

            nextInitialization = TemplateInitializationJson.Write(initialization);
        }

        var now = _clock.GetUtcNow();
        var updated = await _database.TemplateOperations
            .Where(candidate => candidate.Id == operationId
                && candidate.TemplateId == templateId
                && candidate.ActorId == Context.PrincipalId
                && candidate.Kind == TemplateOperationKind.Edit
                && candidate.State == TemplateOperationState.Provisioning
                && candidate.ExpiresAt > now)
            .ExecuteUpdateAsync(
                update => update
                    .SetProperty(candidate => candidate.DraftTitle, nextTitle)
                    .SetProperty(candidate => candidate.DraftDescription, nextDescription)
                    .SetProperty(candidate => candidate.DraftInitialization, nextInitialization),
                cancellationToken)
            .ConfigureAwait(false);
        if (updated != 1)
        {
            return Result.Failure<TemplateDraftPlan>(
                TemplateErrors.Conflict("This template draft is no longer active."));
        }

        operation.DraftTitle = nextTitle;
        operation.DraftDescription = nextDescription;
        operation.DraftInitialization = nextInitialization;
        return Result.Success(await DraftPlanAsync(operation, cancellationToken).ConfigureAwait(false));
    }

    /// <summary>Updates only a provisioning draft envelope.</summary>
    public async ValueTask<Result<TemplateItemSnapshot>> UpdateDraftItemAsync(
        TemplateId templateId,
        TemplateOperationId operationId,
        Guid sourceId,
        string? title,
        string? properties,
        string? schema,
        string? views,
        CancellationToken cancellationToken)
    {
        await LockTemplateStagesAsync(cancellationToken).ConfigureAwait(false);
        var loaded = await LoadDraftAsync(templateId, operationId, cancellationToken).ConfigureAwait(false);
        if (loaded.IsFailure)
        {
            return Result.Failure<TemplateItemSnapshot>(loaded.Error);
        }
        await LockWorkspaceTemplatesAsync(loaded.Value.WorkspaceId, cancellationToken).ConfigureAwait(false);

        var mapping = await _database.TemplateOperationItems
            .FirstOrDefaultAsync(
                candidate => candidate.OperationId == operationId && candidate.TemplateSourceId == sourceId,
                cancellationToken)
            .ConfigureAwait(false);
        if (mapping is null)
        {
            return Result.Failure<TemplateItemSnapshot>(TemplateErrors.NotFound("No such draft item is visible."));
        }

        var item = await _database.Items.IgnoreQueryFilters()
            .AsNoTracking()
            .SingleAsync(candidate => candidate.Id == mapping.TargetItemId, cancellationToken)
            .ConfigureAwait(false);
        var nextProperties = properties ?? item.Properties;
        if (title is not null)
        {
            if (string.IsNullOrWhiteSpace(title) || title.Length > 200)
            {
                return Result.Failure<TemplateItemSnapshot>(
                    TemplateErrors.Invalid("An item title must be between 1 and 200 characters."));
            }

            nextProperties = ItemProperties.WithTitle(nextProperties, title.Trim());
        }

        // Template content carries no set-by value (the applier is attributed at application
        // time) and no reserved $ key beyond habit content, so a client-supplied one
        // is dropped here exactly as capture and import drop it.
        nextProperties = ReservedPropertyContent.Strip(nextProperties, ReservedPropertyContent.ContentPrefixes);

        var nextSchema = schema ?? item.Schema;
        var nextViews = views ?? item.Views;
        var declared = PropertySchemaJson.Read(nextSchema);
        var effective = item.ParentId is { } parentId && declared.Inherit
            ? PropertySchema.Merge(
                await ResolveHiddenTemplateSchemaAsync(
                    parentId,
                    templateId,
                    cancellationToken).ConfigureAwait(false),
                declared)
            : declared;
        // Editing a template item drawn from the workspace: tolerate a view whose column the
        // schema no longer declares, exactly as the live container does. See ValidateViewDependencies.
        if (_validator.ValidateEnvelope(nextProperties, nextSchema, nextViews, effective, tolerateViewDrift: true)
            is { } refusal)
        {
            return Result.Failure<TemplateItemSnapshot>(TemplateErrors.Invalid(refusal));
        }

        var now = _clock.GetUtcNow();
        var updated = await _database.Items.IgnoreQueryFilters()
            .Where(candidate => candidate.Id == item.Id
                && candidate.LifecycleState == ItemLifecycleState.Provisioning
                && _database.TemplateOperationItems.Any(candidateMapping =>
                    candidateMapping.OperationId == operationId
                    && candidateMapping.TemplateSourceId == sourceId
                    && candidateMapping.TargetItemId == candidate.Id)
                && _database.TemplateOperations.Any(candidateOperation =>
                    candidateOperation.Id == operationId
                    && candidateOperation.TemplateId == templateId
                    && candidateOperation.ActorId == Context.PrincipalId
                    && candidateOperation.Kind == TemplateOperationKind.Edit
                    && candidateOperation.State == TemplateOperationState.Provisioning
                    && candidateOperation.ExpiresAt > now))
            .ExecuteUpdateAsync(
                update => update
                    .SetProperty(candidate => candidate.Properties, nextProperties)
                    .SetProperty(candidate => candidate.Schema, nextSchema)
                    .SetProperty(candidate => candidate.Views, nextViews)
                    .SetProperty(candidate => candidate.LastModifiedBy, Context.PrincipalId)
                    .SetProperty(candidate => candidate.LastModifiedAt, now),
                cancellationToken)
            .ConfigureAwait(false);
        if (updated != 1)
        {
            return Result.Failure<TemplateItemSnapshot>(
                TemplateErrors.Conflict("This template draft is no longer active."));
        }
        var draft = await DraftPlanAsync(loaded.Value, cancellationToken).ConfigureAwait(false);
        return Result.Success(FindSnapshot(draft.Root, sourceId)!);
    }

    /// <summary>Publishes an edit operation after Collab has hydrated all of its draft bodies.</summary>
    public async ValueTask<Result<TemplateId>> SaveDraftAsync(
        TemplateId templateId,
        TemplateOperationId operationId,
        CancellationToken cancellationToken)
    {
        var loaded = await LoadDraftAsync(templateId, operationId, cancellationToken).ConfigureAwait(false);
        if (loaded.IsFailure)
        {
            return Result.Failure<TemplateId>(loaded.Error);
        }

        var expected = await _database.TemplateOperationItems
            .Where(mapping => mapping.OperationId == operationId && mapping.BodyRequired)
            .Select(mapping => mapping.TargetItemId)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        return await FinalizeOperationAsync(operationId, expected, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Resolves a portable draft item identity to its provisioning body target.</summary>
    public async ValueTask<Result<TemplateItemAuthorization>> AuthorizeDraftItemAsync(
        TemplateId templateId,
        TemplateOperationId operationId,
        Guid sourceId,
        CancellationToken cancellationToken)
    {
        var loaded = await LoadDraftAsync(templateId, operationId, cancellationToken).ConfigureAwait(false);
        if (loaded.IsFailure)
        {
            return Result.Failure<TemplateItemAuthorization>(loaded.Error);
        }

        var mapping = await _database.TemplateOperationItems
            .FirstOrDefaultAsync(
                candidate => candidate.OperationId == operationId && candidate.TemplateSourceId == sourceId,
                cancellationToken)
            .ConfigureAwait(false);
        if (mapping is null)
        {
            return Result.Failure<TemplateItemAuthorization>(TemplateErrors.NotFound("No such draft item is visible."));
        }

        return Result.Success(new TemplateItemAuthorization(
            templateId,
            sourceId,
            mapping.TargetItemId,
            Context.TenantId,
            Context.PrincipalId,
            loaded.Value.WorkspaceId,
            mapping.ItemType,
            true,
            true));
    }

    /// <summary>Deletes a user-authored catalog entry and its hidden item revisions.</summary>
    public async ValueTask<Result<bool>> DeleteAsync(TemplateId templateId, CancellationToken cancellationToken)
    {
        await LockTemplateStagesAsync(cancellationToken).ConfigureAwait(false);
        var template = await _database.WorkspaceTemplates
            .AsTracking()
            .FirstOrDefaultAsync(candidate => candidate.Id == templateId, cancellationToken)
            .ConfigureAwait(false);
        if (template is null
            || !await _permissions.CanWriteWorkspaceAsync(template.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<bool>(TemplateErrors.NotFound("No such template is visible."));
        }

        if (template.Origin != TemplateOrigin.User)
        {
            return Result.Failure<bool>(
                TemplateErrors.Managed("Managed templates are removed by their source, not from the workspace."));
        }

        await DeleteProvisioningApplicationTargetsAsync(templateId, cancellationToken).ConfigureAwait(false);
        var trackedApplicationIds = _database.ChangeTracker.Entries<TemplateApplication>()
            .Where(entry => entry.Entity.TemplateId == templateId)
            .Select(entry => entry.Entity.Id)
            .ToHashSet();
        var trackedOperationIds = _database.ChangeTracker.Entries<TemplateOperation>()
            .Where(entry => entry.Entity.TemplateId == templateId)
            .Select(entry => entry.Entity.Id)
            .ToHashSet();
        await _database.TemplateApplications
            .Where(application => application.TemplateId == templateId)
            .ExecuteDeleteAsync(cancellationToken)
            .ConfigureAwait(false);
        foreach (var entry in _database.ChangeTracker.Entries<TemplateApplicationItem>()
            .Where(entry => trackedApplicationIds.Contains(entry.Entity.ApplicationId)))
        {
            entry.State = EntityState.Detached;
        }
        foreach (var entry in _database.ChangeTracker.Entries<TemplateApplication>()
            .Where(entry => trackedApplicationIds.Contains(entry.Entity.Id)))
        {
            entry.State = EntityState.Detached;
        }
        foreach (var entry in _database.ChangeTracker.Entries<TemplateOperationItem>()
            .Where(entry => trackedOperationIds.Contains(entry.Entity.OperationId)))
        {
            entry.State = EntityState.Detached;
        }
        foreach (var entry in _database.ChangeTracker.Entries<TemplateOperation>()
            .Where(entry => trackedOperationIds.Contains(entry.Entity.Id)))
        {
            entry.State = EntityState.Detached;
        }
        await _database.TemplateOperations
            .Where(operation => operation.TemplateId == templateId)
            .ExecuteDeleteAsync(cancellationToken)
            .ConfigureAwait(false);

        template.RootItemId = null;
        template.PendingRootItemId = null;
        await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        await DeleteHiddenTemplateItemsAsync(templateId, cancellationToken).ConfigureAwait(false);

        _database.WorkspaceTemplates.Remove(template);
        AddAudit("template.deleted", template.Id.Value, template.WorkspaceId, _clock.GetUtcNow());
        await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return Result.Success(true);
    }

    private async ValueTask DeleteProvisioningApplicationTargetsAsync(
        TemplateId templateId,
        CancellationToken cancellationToken)
    {
        while (true)
        {
            var itemIds = await _database.Items.IgnoreQueryFilters()
                .Where(item => item.LifecycleState == ItemLifecycleState.Provisioning
                    && _database.TemplateApplicationItems.Any(mapping => mapping.TargetItemId == item.Id
                        && mapping.Created
                        && _database.TemplateApplications.Any(application =>
                            application.Id == mapping.ApplicationId
                            && application.TemplateId == templateId))
                    && !_database.Items.IgnoreQueryFilters().Any(child =>
                        child.ParentId == item.Id
                        && child.LifecycleState == ItemLifecycleState.Provisioning))
                .OrderBy(item => item.Id)
                .Select(item => item.Id)
                .Take(DeletionBatchSize)
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
            if (itemIds.Length == 0)
            {
                return;
            }

            await DeleteItemBatchAsync(itemIds, cancellationToken).ConfigureAwait(false);
        }
    }

    private async ValueTask DeleteHiddenTemplateItemsAsync(
        TemplateId templateId,
        CancellationToken cancellationToken)
    {
        var template = await _database.WorkspaceTemplates.AsNoTracking()
            .Where(value => value.Id == templateId)
            .Select(value => new { value.WorkspaceId })
            .SingleOrDefaultAsync(cancellationToken).ConfigureAwait(false);
        if (template is not null)
        {
            var objectKeys = await (from version in _database.FileVersions.AsNoTracking()
                                    join item in _database.Items.IgnoreQueryFilters().AsNoTracking() on version.ItemId equals item.Id
                                    where item.TenantId == Context.TenantId && item.TemplateId == templateId
                                    select version.ObjectKey).ToArrayAsync(cancellationToken).ConfigureAwait(false);
            if (objectKeys.Length > 0)
            {
                await ObjectCleanupJobs.QueueBatchedAsync(
                    _jobs, Context.TenantId, Context.PrincipalId, template.WorkspaceId,
                    "template-delete", templateId.Value, _signer.GetCleanupNotBefore(), objectKeys,
                    cancellationToken).ConfigureAwait(false);
            }
        }
        while (true)
        {
            var itemIds = await _database.Items.IgnoreQueryFilters()
                .Where(item => item.TemplateId == templateId
                    && !_database.Items.IgnoreQueryFilters().Any(child => child.ParentId == item.Id))
                .OrderBy(item => item.Id)
                .Select(item => item.Id)
                .Take(DeletionBatchSize)
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
            if (itemIds.Length == 0)
            {
                return;
            }

            await DeleteItemBatchAsync(itemIds, cancellationToken).ConfigureAwait(false);
        }
    }

    private async ValueTask DeleteItemBatchAsync(
        IReadOnlyList<ItemId> itemIds,
        CancellationToken cancellationToken)
    {
        await _database.ItemClosure
            .Where(edge => itemIds.Contains(edge.AncestorId) || itemIds.Contains(edge.DescendantId))
            .ExecuteDeleteAsync(cancellationToken)
            .ConfigureAwait(false);
        await _database.Items.IgnoreQueryFilters()
            .Where(item => itemIds.Contains(item.Id))
            .ExecuteDeleteAsync(cancellationToken)
            .ConfigureAwait(false);
        foreach (var entry in _database.ChangeTracker.Entries<Item>()
            .Where(entry => itemIds.Contains(entry.Entity.Id)))
        {
            entry.State = EntityState.Detached;
        }
    }

}
