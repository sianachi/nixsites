using System.Collections.Immutable;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.Templates;
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
    /// <summary>Stages an idempotent create or merge application.</summary>
    public ValueTask<Result<TemplateApplicationPlan>> BeginApplicationAsync(
        TemplateId templateId,
        TemplateApplicationMode mode,
        ItemId? targetItemId,
        ItemId? parentItemId,
        string? title,
        string idempotencyKey,
        CancellationToken cancellationToken) =>
        BeginApplicationAsync(
            templateId,
            mode,
            targetItemId,
            parentItemId,
            title,
            idempotencyKey,
            null,
            null,
            cancellationToken);

    /// <summary>Stages the same server-resolved initialization plan returned by preflight.</summary>
    public async ValueTask<Result<TemplateApplicationPlan>> BeginApplicationAsync(
        TemplateId templateId,
        TemplateApplicationMode mode,
        ItemId? targetItemId,
        ItemId? parentItemId,
        string? title,
        string idempotencyKey,
        IReadOnlyDictionary<string, string>? inputs,
        int? expectedRevision,
        CancellationToken cancellationToken)
    {
        var requestedTitle = title?.Trim();
        if (InvalidKey(idempotencyKey)
            || (mode == TemplateApplicationMode.Create
                && title is not null
                && (requestedTitle!.Length == 0 || requestedTitle.Length > 200)))
        {
            return Result.Failure<TemplateApplicationPlan>(TemplateErrors.Invalid(
                "An idempotency key and an optional create title of 1 to 200 characters are required."));
        }

        var template = await ActiveTemplateAsync(templateId, cancellationToken).ConfigureAwait(false);
        if (template is null
            || !await _permissions.CanWriteWorkspaceAsync(template.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateApplicationPlan>(TemplateErrors.NotFound("No such template is visible."));
        }

        await SweepExpiredAsync(template.WorkspaceId, cancellationToken).ConfigureAwait(false);
        await LockTemplateAsync(templateId, cancellationToken).ConfigureAwait(false);
        await LockIdempotencyKeyAsync(idempotencyKey, cancellationToken).ConfigureAwait(false);
        if (await _database.TemplateOperations.AnyAsync(
            operation => operation.ActorId == Context.PrincipalId
                && operation.IdempotencyKey == idempotencyKey,
            cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateApplicationPlan>(
                TemplateErrors.Conflict("This idempotency key belongs to another template operation."));
        }

        await _database.Entry(template).ReloadAsync(cancellationToken).ConfigureAwait(false);
        if (template.State != TemplateState.Active || template.RootItemId is null)
        {
            return Result.Failure<TemplateApplicationPlan>(TemplateErrors.NotFound("No such template is visible."));
        }

        var existingApplication = await _database.TemplateApplications
            .FirstOrDefaultAsync(
                application => application.ActorId == Context.PrincipalId
                    && application.IdempotencyKey == idempotencyKey,
                cancellationToken)
            .ConfigureAwait(false);
        if (existingApplication is not null)
        {
            if (existingApplication.TemplateId != templateId
                || existingApplication.Mode != mode
                || (mode == TemplateApplicationMode.Merge
                    && existingApplication.TargetItemId != targetItemId)
                || (mode == TemplateApplicationMode.Create
                    && existingApplication.ParentItemId != parentItemId)
                || (requestedTitle is not null
                    && !string.Equals(existingApplication.RequestedTitle, requestedTitle, StringComparison.Ordinal))
                || (expectedRevision is { } replayRevision
                    && replayRevision != existingApplication.TemplateRevision))
            {
                return Result.Failure<TemplateApplicationPlan>(TemplateErrors.Conflict(
                    "This idempotency key belongs to a different template application."));
            }

            if (TryReadStoredResolution(existingApplication.ResolvedInputs, out var storedResolution)
                && !ReplayInputsMatch(storedResolution!.Resolution, inputs))
            {
                return Result.Failure<TemplateApplicationPlan>(TemplateErrors.Conflict(
                    "This idempotency key was already used with different initialization inputs."));
            }

            if (existingApplication.State == TemplateOperationState.Provisioning)
            {
                var destinationId = existingApplication.Mode == TemplateApplicationMode.Merge
                    ? existingApplication.TargetItemId
                    : existingApplication.ParentItemId;
                if (destinationId is { } requiredDestination)
                {
                    var destination = await LockRegularItemAsync(requiredDestination, cancellationToken)
                        .ConfigureAwait(false);
                    if (destination is null || destination.WorkspaceId != existingApplication.WorkspaceId)
                    {
                        return Result.Failure<TemplateApplicationPlan>(TemplateErrors.Conflict(
                            "The destination for this template application was deleted or is no longer active."));
                    }
                }
            }

            return Result.Success((await ApplicationReplayAsync(idempotencyKey, cancellationToken)
                .ConfigureAwait(false))!);
        }

        var source = await ActiveTreeAsync(template, cancellationToken).ConfigureAwait(false);
        if (source.Count == 0)
        {
            return Result.Failure<TemplateApplicationPlan>(TemplateErrors.Invalid("The template has no active root."));
        }

        if (_validator.ValidateTemplateTree(source, tolerateViewDrift: true) is { } templateConflict)
        {
            return Result.Failure<TemplateApplicationPlan>(TemplateErrors.Invalid(templateConflict));
        }

        if (mode == TemplateApplicationMode.Create && targetItemId is not null)
        {
            return Result.Failure<TemplateApplicationPlan>(TemplateErrors.Invalid(
                "A create application cannot include a merge target."));
        }

        if (mode == TemplateApplicationMode.Merge && parentItemId is not null)
        {
            return Result.Failure<TemplateApplicationPlan>(TemplateErrors.Invalid(
                "A merge application cannot include a create parent."));
        }

        var rootSource = source[0];
        var now = _clock.GetUtcNow();
        Item? targetRoot = null;
        if (mode == TemplateApplicationMode.Merge)
        {
            if (targetItemId is not { } existingId)
            {
                return Result.Failure<TemplateApplicationPlan>(TemplateErrors.NotFound("No such target is visible."));
            }

            await LockTemplateApplicationAsync(templateId, existingId, cancellationToken).ConfigureAwait(false);
            targetRoot = await LockRegularItemAsync(existingId, cancellationToken).ConfigureAwait(false);
            if (targetRoot is null || targetRoot.WorkspaceId != template.WorkspaceId)
            {
                return Result.Failure<TemplateApplicationPlan>(TemplateErrors.NotFound("No such target is visible."));
            }

            if (targetRoot.NoChildren)
            {
                return Result.Failure<TemplateApplicationPlan>(TemplateErrors.Conflict("The target does not accept new children."));
            }

            // The merged children would arrive without a claim on the target's unique keys.
            if (Nix.Features.Records.RecordKeys.DeclaresUnique(targetRoot.Schema))
            {
                return Result.Failure<TemplateApplicationPlan>(TemplateErrors.Conflict("The target requires unique keys; apply the template elsewhere and move the result."));
            }
        }
        else if (parentItemId is { } parent)
        {
            var parentItem = await LockRegularItemAsync(parent, cancellationToken).ConfigureAwait(false);
            if (parentItem is null || parentItem.WorkspaceId != template.WorkspaceId)
            {
                return Result.Failure<TemplateApplicationPlan>(
                    TemplateErrors.NotFound("No such destination is visible."));
            }

            if (parentItem.NoChildren)
            {
                return Result.Failure<TemplateApplicationPlan>(TemplateErrors.Conflict("The destination does not accept new children."));
            }

            // The applied root would arrive without a claim on the destination's unique keys.
            if (Nix.Features.Records.RecordKeys.DeclaresUnique(parentItem.Schema))
            {
                return Result.Failure<TemplateApplicationPlan>(TemplateErrors.Conflict("The destination requires unique keys; apply the template elsewhere and move the result."));
            }
        }

        TemplateMergePlan? mergePlan = null;
        if (targetRoot is not null)
        {
            var effectiveTargetSchema = await _schemas.ResolveForItemAsync(targetRoot.Id, cancellationToken)
                .ConfigureAwait(false);
            mergePlan = _mergePlanner.Plan(
                targetRoot.Schema,
                rootSource.Schema,
                targetRoot.Views,
                rootSource.Views,
                effectiveTargetSchema);
            if (mergePlan.Conflicts.Count > 0)
            {
                return Result.Failure<TemplateApplicationPlan>(
                    TemplateErrors.Conflict(string.Join(" ", mergePlan.Conflicts)));
            }
        }

        var priorResult = mode == TemplateApplicationMode.Merge
            ? await PriorTargetMapAsync(
                templateId,
                targetRoot!.Id,
                template.WorkspaceId,
                source.Select(item => item.TemplateSourceId!.Value).ToArray(),
                cancellationToken).ConfigureAwait(false)
            : Result.Success(new Dictionary<Guid, ItemId>());
        if (priorResult.IsFailure)
        {
            return Result.Failure<TemplateApplicationPlan>(priorResult.Error);
        }

        var prior = priorResult.Value;
        var existingBySource = new Dictionary<Guid, ItemId>();
        if (targetRoot is not null)
        {
            existingBySource[rootSource.TemplateSourceId!.Value] = targetRoot.Id;
            foreach (var pair in prior)
            {
                existingBySource[pair.Key] = pair.Value;
            }
        }

        var prepared = await PrepareApplicationAsync(
            template,
            source,
            mode,
            targetRoot?.Id,
            parentItemId,
            title,
            inputs,
            existingBySource,
            expectedRevision,
            cancellationToken).ConfigureAwait(false);
        if (prepared.IsFailure)
        {
            return Result.Failure<TemplateApplicationPlan>(prepared.Error);
        }

        var sourceBodies = prepared.Value.SourceBodyIds;
        var targetItems = new Dictionary<Guid, ItemId>
        {
            [rootSource.TemplateSourceId!.Value] = targetRoot?.Id ?? ItemId.Create(),
        };
        foreach (var pair in prior)
        {
            targetItems[pair.Key] = pair.Value;
        }

        var initializedBySource = prepared.Value.Preview.ToDictionary(item => item.SourceId);
        var staged = new List<Item>();
        if (mode == TemplateApplicationMode.Create)
        {
            var rootInitialization = initializedBySource[rootSource.TemplateSourceId!.Value];
            targetRoot = CloneRegularItem(
                rootSource,
                parentItemId,
                targetItems[rootSource.TemplateSourceId!.Value],
                prepared.Value.ResolvedCreateTitle!,
                now,
                rootInitialization);
            staged.Add(targetRoot);
        }

        var applicationId = TemplateApplicationId.Create();
        var mappings = new List<TemplateApplicationItem>(source.Count);
        foreach (var item in source)
        {
            var sourceId = item.TemplateSourceId!.Value;
            var isRoot = item.Id == rootSource.Id;
            var created = isRoot && mode == TemplateApplicationMode.Create;
            if (!targetItems.TryGetValue(sourceId, out var targetId))
            {
                var parentSource = source.Single(candidate => candidate.Id == item.ParentId);
                var parentTarget = targetItems[parentSource.TemplateSourceId!.Value];
                targetId = ItemId.Create();
                targetItems[sourceId] = targetId;
                var initialized = initializedBySource[sourceId];
                staged.Add(CloneRegularItem(item, parentTarget, targetId, initialized.Title, now, initialized));
                created = true;
            }

            var bodyRequired = sourceBodies.Contains(item.Id)
                && created
                && (!isRoot || mode == TemplateApplicationMode.Create);
            mappings.Add(new TemplateApplicationItem
            {
                ApplicationId = applicationId,
                TenantId = Context.TenantId,
                TemplateSourceId = sourceId,
                SourceItemId = item.Id,
                ItemType = item.Type,
                TargetItemId = targetId,
                IsRoot = isRoot,
                Created = created,
                BodyRequired = bodyRequired,
            });
        }

        // Habit and finance content is checked by its own validators before it is applied; a
        // template only ever carries it because capture, import or a draft edit allowed it.
        foreach (var candidate in staged)
        {
            if (ReservedPropertyContent.Refuse(candidate.Properties, ItemProperties.ReadTitle(candidate.Properties)) is { } refusal)
            {
                return Result.Failure<TemplateApplicationPlan>(TemplateErrors.Invalid($"This template cannot be applied: {refusal}."));
            }
        }

        _database.Items.AddRange(staged);
        var application = new TemplateApplication
        {
            Id = applicationId,
            TenantId = Context.TenantId,
            WorkspaceId = template.WorkspaceId,
            TemplateId = templateId,
            TargetItemId = targetRoot!.Id,
            ParentItemId = mode == TemplateApplicationMode.Create ? parentItemId : null,
            RequestedTitle = mode == TemplateApplicationMode.Create
                ? requestedTitle ?? template.Title
                : null,
            TemplateRevision = prepared.Value.Resolution.TemplateRevision,
            ResolvedInputs = WriteStoredResolution(prepared.Value.Resolution, prepared.Value.Preview),
            RequestFingerprint = prepared.Value.RequestFingerprint,
            Mode = mode,
            IdempotencyKey = idempotencyKey,
            ActorId = Context.PrincipalId,
            State = TemplateOperationState.Provisioning,
            CreatedAt = now,
            ExpiresAt = now + StagingLifetime,
        };
        _database.TemplateApplications.Add(application);
        _database.TemplateApplicationItems.AddRange(mappings);
        await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        var fileTransfers = await PrepareApplicationFilesAsync(applicationId, mappings, cancellationToken)
            .ConfigureAwait(false);
        if (fileTransfers.IsFailure)
        {
            return Result.Failure<TemplateApplicationPlan>(fileTransfers.Error);
        }

        if (fileTransfers.Value.Count > 0)
        {
            await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        }

        if (staged.Count > 0)
        {
            await RebuildClosureAsync(staged.Select(item => item.Id), cancellationToken).ConfigureAwait(false);
        }

        var bodyCopies = mappings.Where(mapping => mapping.BodyRequired).Select(mapping =>
        {
            var sourceItem = source.Single(item => item.Id == mapping.SourceItemId);
            return new TemplateBodyCopy(mapping.SourceItemId, mapping.TargetItemId, sourceItem.Type);
        }).ToArray();
        return Result.Success(new TemplateApplicationPlan(
            applicationId,
            templateId,
            targetRoot.Id,
            bodyCopies.Length == 0
                && staged.Count == 0
                && mode == TemplateApplicationMode.Merge
                && mergePlan is { FieldAdditions: 0, ViewAdditions: 0 },
            mappings.Where(mapping => mapping.Created).Select(mapping => new TemplateItemMapping(
                mapping.SourceItemId.Value,
                mapping.TargetItemId,
                source.Single(item => item.Id == mapping.SourceItemId).Type)).ToArray(),
            mappings.Select(mapping => new TemplateItemMapping(
                mapping.SourceItemId.Value,
                mapping.TargetItemId,
                source.Single(item => item.Id == mapping.SourceItemId).Type)).ToArray(),
            bodyCopies,
            prepared.Value.Resolution,
            prepared.Value.Preview));
    }

    /// <summary>Atomically exposes a staged application and merges the root envelope.</summary>
    public async ValueTask<Result<ItemId>> FinalizeApplicationAsync(
        TemplateApplicationId applicationId,
        IReadOnlyList<ItemId> writtenBodyItemIds,
        CancellationToken cancellationToken)
    {
        await LockTemplateStagesAsync(cancellationToken).ConfigureAwait(false);
        var application = await _database.TemplateApplications
            .AsTracking()
            .FirstOrDefaultAsync(candidate => candidate.Id == applicationId, cancellationToken)
            .ConfigureAwait(false);
        if (application is null || application.ActorId != Context.PrincipalId)
        {
            return Result.Failure<ItemId>(TemplateErrors.NotFound("No such template application is visible."));
        }

        if (!await _permissions.CanWriteWorkspaceAsync(application.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ItemId>(TemplateErrors.NotFound("No such template application is visible."));
        }

        if (application.State == TemplateOperationState.Active)
        {
            return Result.Success(application.TargetItemId);
        }

        if (application.State != TemplateOperationState.Provisioning || application.ExpiresAt <= _clock.GetUtcNow())
        {
            return Result.Failure<ItemId>(TemplateErrors.Conflict("This template application is no longer active."));
        }

        var access = await RecheckApplicationResolutionAccessAsync(
            application.WorkspaceId,
            application.ResolvedInputs,
            cancellationToken).ConfigureAwait(false);
        if (access.IsFailure)
        {
            return Result.Failure<ItemId>(access.Error);
        }

        if (await HasUnreadyCopiesAsync("application", application.Id.Value, cancellationToken)
            .ConfigureAwait(false))
        {
            return Result.Failure<ItemId>(TemplateErrors.Conflict(
                "Template file copies must be complete before the application can be finalized."));
        }

        await LockTemplateApplicationAsync(
            application.TemplateId,
            application.TargetItemId,
            cancellationToken).ConfigureAwait(false);

        var mappings = await _database.TemplateApplicationItems
            .Where(mapping => mapping.ApplicationId == applicationId)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        if (mappings.Count == 0 || mappings.Count > MaximumTemplateItems
            || mappings.Count(mapping => mapping.IsRoot) != 1)
        {
            return Result.Failure<ItemId>(TemplateErrors.Conflict(
                "This template application's item map is incomplete or exceeds the template item limit."));
        }

        if (application.Mode == TemplateApplicationMode.Create && application.ParentItemId is { } parentItemId)
        {
            var parent = await LockRegularItemAsync(parentItemId, cancellationToken).ConfigureAwait(false);
            if (parent is null || parent.WorkspaceId != application.WorkspaceId)
            {
                return Result.Failure<ItemId>(TemplateErrors.Conflict(
                    "The destination for this template application was deleted or is no longer active."));
            }
        }

        var targetItems = await LockItemsAsync(
            mappings.Select(mapping => mapping.TargetItemId).ToArray(),
            cancellationToken).ConfigureAwait(false);
        var targetsById = targetItems.ToDictionary(item => item.Id);
        foreach (var mapping in mappings)
        {
            if (!targetsById.TryGetValue(mapping.TargetItemId, out var target)
                || target.WorkspaceId != application.WorkspaceId
                || target.TemplateId is not null
                || (mapping.Created
                    ? target.LifecycleState != ItemLifecycleState.Provisioning
                    : target.LifecycleState != ItemLifecycleState.Active))
            {
                return Result.Failure<ItemId>(TemplateErrors.Conflict(
                    "A mapped application target was deleted, replaced, or is no longer in its expected state."));
            }

            if (mapping.Created && _validator.ValidateEnvelope(target.Properties, null, null) is { } envelopeRefusal)
            {
                return Result.Failure<ItemId>(TemplateErrors.Invalid(envelopeRefusal));
            }
        }

        var sourceItemIds = mappings.Select(mapping => mapping.SourceItemId).Distinct().ToArray();
        var activeSourceCount = await _database.Items.IgnoreQueryFilters()
            .CountAsync(
                item => sourceItemIds.Contains(item.Id)
                    && item.TemplateId == application.TemplateId
                    && item.LifecycleState == ItemLifecycleState.Active,
                cancellationToken)
            .ConfigureAwait(false);
        if (activeSourceCount != sourceItemIds.Length)
        {
            return Result.Failure<ItemId>(TemplateErrors.Conflict(
                "A mapped template source is no longer active; restart the application from the current revision."));
        }

        var expected = mappings.Where(mapping => mapping.BodyRequired).Select(mapping => mapping.TargetItemId).ToArray();
        if (!SameSet(expected, writtenBodyItemIds))
        {
            return Result.Failure<ItemId>(
                TemplateErrors.BodiesIncomplete("Every requested body must be written before application."));
        }
        var actualBodies = await BodyItemIdsAsync(
            mappings.Where(mapping => mapping.Created).Select(mapping => mapping.TargetItemId),
            cancellationToken).ConfigureAwait(false);
        if (!SameSet(expected, actualBodies))
        {
            return Result.Failure<ItemId>(
                TemplateErrors.BodiesIncomplete("The staged application bodies do not match the application plan."));
        }

        if (application.Mode == TemplateApplicationMode.Merge)
        {
            var rootMapping = mappings.Single(mapping => mapping.IsRoot);
            var sourceRoot = await _database.Items.IgnoreQueryFilters()
                .SingleAsync(item => item.Id == rootMapping.SourceItemId, cancellationToken)
                .ConfigureAwait(false);
            var targetRoot = targetsById[rootMapping.TargetItemId];
            var effectiveTargetSchema = await _schemas.ResolveForItemAsync(targetRoot.Id, cancellationToken)
                .ConfigureAwait(false);
            var merge = _mergePlanner.Plan(
                targetRoot.Schema,
                sourceRoot.Schema,
                targetRoot.Views,
                sourceRoot.Views,
                effectiveTargetSchema);
            if (merge.Conflicts.Count > 0)
            {
                return Result.Failure<ItemId>(TemplateErrors.Conflict(string.Join(" ", merge.Conflicts)));
            }

            await _database.Items.IgnoreQueryFilters()
                .Where(item => item.Id == targetRoot.Id)
                .ExecuteUpdateAsync(
                    update => update
                        .SetProperty(item => item.Schema, merge.Schema)
                        .SetProperty(item => item.Views, merge.Views)
                        .SetProperty(item => item.LastModifiedBy, Context.PrincipalId)
                        .SetProperty(item => item.LastModifiedAt, _clock.GetUtcNow()),
                    cancellationToken)
                .ConfigureAwait(false);
        }

        await _database.Items.IgnoreQueryFilters()
            .Where(item => mappings.Select(mapping => mapping.TargetItemId).Contains(item.Id)
                && item.LifecycleState == ItemLifecycleState.Provisioning)
            .ExecuteUpdateAsync(
                update => update.SetProperty(item => item.LifecycleState, ItemLifecycleState.Active),
                cancellationToken)
            .ConfigureAwait(false);
        var now = _clock.GetUtcNow();
        application.State = TemplateOperationState.Active;
        application.FinalizedAt = now;
        AddAudit("template.applied", application.TemplateId.Value, application.WorkspaceId, now);
        await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        await TrimManagedOperationHistoryAsync(application.WorkspaceId, cancellationToken).ConfigureAwait(false);
        await DeleteRetiredTemplateRevisionsAsync(application.TemplateId, cancellationToken).ConfigureAwait(false);
        return Result.Success(application.TargetItemId);
    }

    /// <summary>Marks an unfinished application as abandoned; its staged items remain hidden.</summary>
    public async ValueTask<Result<bool>> AbortApplicationAsync(
        TemplateApplicationId applicationId,
        CancellationToken cancellationToken)
    {
        await LockTemplateStagesAsync(cancellationToken).ConfigureAwait(false);
        var application = await _database.TemplateApplications
            .AsTracking()
            .FirstOrDefaultAsync(candidate => candidate.Id == applicationId, cancellationToken)
            .ConfigureAwait(false);
        if (application is null || application.ActorId != Context.PrincipalId)
        {
            return Result.Failure<bool>(TemplateErrors.NotFound("No such template application is visible."));
        }

        if (application.State == TemplateOperationState.Active)
        {
            return Result.Failure<bool>(TemplateErrors.Conflict("A finalized template application cannot be aborted."));
        }

        if (application.State != TemplateOperationState.Aborted)
        {
            application.State = TemplateOperationState.Aborted;
            application.FinalizedAt = _clock.GetUtcNow();
            AddAudit(
                "template.application_aborted",
                application.TemplateId.Value,
                application.WorkspaceId,
                application.FinalizedAt.Value);
            await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        }

        await SweepExpiredBatchAsync(
            application.WorkspaceId,
            null,
            application.Id,
            cancellationToken).ConfigureAwait(false);
        return Result.Success(true);
    }

}
