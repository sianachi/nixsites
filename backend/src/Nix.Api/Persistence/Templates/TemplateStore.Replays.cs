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
    private async ValueTask<Result<Dictionary<Guid, ItemId>>> PriorTargetMapAsync(
        TemplateId templateId,
        ItemId targetItemId,
        WorkspaceId workspaceId,
        IReadOnlyList<Guid> currentSourceIds,
        CancellationToken cancellationToken) =>
        await LoadPriorTargetMapAsync(
            templateId,
            targetItemId,
            workspaceId,
            currentSourceIds,
            cancellationToken).ConfigureAwait(false);

    private async ValueTask<Result<Dictionary<Guid, ItemId>>> LoadPriorTargetMapAsync(
        TemplateId templateId,
        ItemId targetItemId,
        WorkspaceId workspaceId,
        IReadOnlyList<Guid> currentSourceIds,
        CancellationToken cancellationToken)
    {
        var currentSources = currentSourceIds.ToArray();
        var rows = await (
            from application in _database.TemplateApplications
            join mapping in _database.TemplateApplicationItems on application.Id equals mapping.ApplicationId
            where application.TemplateId == templateId
                && application.TargetItemId == targetItemId
                && application.State == TemplateOperationState.Active
                && currentSources.Contains(mapping.TemplateSourceId)
            select new { mapping.TemplateSourceId, mapping.TargetItemId })
            .Distinct()
            .Take(MaximumTemplateItems + 1)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        if (rows.Count > MaximumTemplateItems)
        {
            return Result.Failure<Dictionary<Guid, ItemId>>(TemplateErrors.Conflict(
                "This target has more historical template mappings than one template can contain."));
        }

        var result = new Dictionary<Guid, ItemId>(rows.Count);
        foreach (var row in rows)
        {
            if (result.TryGetValue(row.TemplateSourceId, out var existing)
                && existing != row.TargetItemId)
            {
                return Result.Failure<Dictionary<Guid, ItemId>>(TemplateErrors.Conflict(
                    $"Template source '{row.TemplateSourceId}' maps to more than one target item."));
            }

            result[row.TemplateSourceId] = row.TargetItemId;
        }

        var targetIds = result.Values.Distinct().ToArray();
        var activeTargets = targetIds.Length == 0
            ? []
            : await _database.Items.IgnoreQueryFilters()
                .Where(item => targetIds.Contains(item.Id)
                    && item.WorkspaceId == workspaceId
                    && item.TemplateId == null
                    && item.LifecycleState == ItemLifecycleState.Active)
                .Select(item => item.Id)
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
        if (activeTargets.Length != targetIds.Length)
        {
            return Result.Failure<Dictionary<Guid, ItemId>>(TemplateErrors.Conflict(
                "A previously mapped template target is deleted or no longer belongs to this workspace; "
                + "the application will not recreate or write through it."));
        }

        return Result.Success(result);
    }

    private async ValueTask<Result<TemplateCapturePlan?>> CaptureReplayAsync(
        WorkspaceId workspaceId,
        ItemId sourceItemId,
        string title,
        string? description,
        bool includeBody,
        bool includeChildren,
        string idempotencyKey,
        string? expectedFingerprint,
        CancellationToken cancellationToken)
    {
        var operation = await _database.TemplateOperations.FirstOrDefaultAsync(
            candidate => candidate.ActorId == Context.PrincipalId
                && candidate.IdempotencyKey == idempotencyKey
                && candidate.Kind == TemplateOperationKind.Capture,
            cancellationToken).ConfigureAwait(false);
        if (operation is null)
        {
            return Result.Success<TemplateCapturePlan?>(null);
        }

        var catalog = await _database.WorkspaceTemplates
            .FirstOrDefaultAsync(template => template.Id == operation.TemplateId, cancellationToken)
            .ConfigureAwait(false);
        if (catalog is null
            || operation.WorkspaceId != workspaceId
            || operation.SourceItemId != sourceItemId
            || !string.Equals(operation.DraftTitle, title, StringComparison.Ordinal)
            || !string.Equals(operation.DraftDescription, description, StringComparison.Ordinal)
            || catalog.IncludeBody != includeBody
            || catalog.IncludeChildren != includeChildren
            || !string.Equals(operation.CaptureFingerprint, expectedFingerprint, StringComparison.OrdinalIgnoreCase))
        {
            return Result.Failure<TemplateCapturePlan?>(
                TemplateErrors.Conflict("This idempotency key belongs to a different template capture."));
        }

        var mappings = await _database.TemplateOperationItems
            .Where(mapping => mapping.OperationId == operation.Id)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        return Result.Success<TemplateCapturePlan?>(new TemplateCapturePlan(
            operation.Id,
            operation.TemplateId,
            mappings.Select(mapping => new TemplateItemMapping(
                mapping.SourceItemId!.Value.Value,
                mapping.TargetItemId,
                mapping.ItemType)).ToArray(),
            mappings.Where(mapping => mapping.BodyRequired).Select(mapping => new TemplateBodyCopy(
                mapping.SourceItemId!.Value,
                mapping.TargetItemId,
                mapping.ItemType,
                mapping.CheckHead,
                mapping.ExpectedHeadSeq,
                mapping.ExpectedDocId)).ToArray()));
    }

    private async ValueTask<TemplateDraftPlan?> DraftReplayAsync(
        TemplateId templateId,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        var operation = await _database.TemplateOperations
            .AsTracking()
            .FirstOrDefaultAsync(
                candidate => candidate.TemplateId == templateId
                    && candidate.ActorId == Context.PrincipalId
                    && candidate.IdempotencyKey == idempotencyKey
                    && candidate.Kind == TemplateOperationKind.Edit
                    && candidate.State == TemplateOperationState.Provisioning,
                cancellationToken)
            .ConfigureAwait(false);
        if (operation is null || operation.ExpiresAt <= _clock.GetUtcNow())
        {
            return null;
        }

        return await DraftPlanAsync(operation, cancellationToken).ConfigureAwait(false);
    }

    private async ValueTask<Result<TemplateOperation>> LoadDraftAsync(
        TemplateId templateId,
        TemplateOperationId operationId,
        CancellationToken cancellationToken)
    {
        var operation = await _database.TemplateOperations
            .AsTracking()
            .FirstOrDefaultAsync(
                candidate => candidate.Id == operationId
                    && candidate.TemplateId == templateId
                    && candidate.ActorId == Context.PrincipalId
                    && candidate.Kind == TemplateOperationKind.Edit,
                cancellationToken)
            .ConfigureAwait(false);
        if (operation is null)
        {
            return Result.Failure<TemplateOperation>(TemplateErrors.NotFound("No such template draft is visible."));
        }

        if (operation.State != TemplateOperationState.Provisioning || operation.ExpiresAt <= _clock.GetUtcNow())
        {
            return Result.Failure<TemplateOperation>(TemplateErrors.Conflict("This template draft is no longer active."));
        }

        if (!await _permissions.CanWriteWorkspaceAsync(operation.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateOperation>(TemplateErrors.NotFound("No such template draft is visible."));
        }

        return Result.Success(operation);
    }

    private async ValueTask<TemplateDraftPlan> DraftPlanAsync(
        TemplateOperation operation,
        CancellationToken cancellationToken)
    {
        var mappings = await _database.TemplateOperationItems
            .Where(mapping => mapping.OperationId == operation.Id)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var targetIds = mappings.Select(mapping => mapping.TargetItemId).ToArray();
        var items = await _database.Items.IgnoreQueryFilters()
            .Where(item => targetIds.Contains(item.Id))
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var bodyTargets = mappings.Where(mapping => mapping.BodyRequired)
            .Select(mapping => mapping.TargetItemId)
            .ToHashSet();
        return new TemplateDraftPlan(
            operation.Id,
            operation.TemplateId,
            operation.DraftTitle!,
            operation.DraftDescription,
            operation.ExpiresAt,
            BuildTree(items, bodyTargets),
            mappings.Select(mapping => new TemplateItemMapping(
                mapping.SourceItemId!.Value.Value,
                mapping.TargetItemId,
                mapping.ItemType)).ToArray(),
            mappings.Where(mapping => mapping.BodyRequired).Select(mapping => new TemplateBodyCopy(
                mapping.SourceItemId!.Value,
                mapping.TargetItemId,
                mapping.ItemType)).ToArray(),
            ReadInitializationOrThrow(operation.DraftInitialization));
    }

    private async ValueTask<Result<TemplateImportPlan?>> ImportReplayAsync(
        WorkspaceId workspaceId,
        TemplateImportDescriptor descriptor,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        var operation = await _database.TemplateOperations.FirstOrDefaultAsync(
            candidate => candidate.ActorId == Context.PrincipalId
                && candidate.IdempotencyKey == idempotencyKey
                && candidate.Kind == TemplateOperationKind.Import,
            cancellationToken).ConfigureAwait(false);
        if (operation is null)
        {
            return Result.Success<TemplateImportPlan?>(null);
        }

        var catalog = await _database.WorkspaceTemplates
            .FirstOrDefaultAsync(template => template.Id == operation.TemplateId, cancellationToken)
            .ConfigureAwait(false);
        if (catalog is null
            || operation.WorkspaceId != workspaceId
            || catalog.Origin != descriptor.Origin
            || !string.Equals(operation.DraftTitle, descriptor.Title, StringComparison.Ordinal)
            || !string.Equals(operation.DraftDescription, descriptor.Description, StringComparison.Ordinal)
            || !string.Equals(operation.ManagedSource, descriptor.ManagedSource, StringComparison.Ordinal)
            || !string.Equals(operation.SourceDigest, descriptor.Digest, StringComparison.Ordinal)
            || catalog.IncludeBody != descriptor.IncludeBody
            || catalog.IncludeChildren != descriptor.IncludeChildren
            || !string.Equals(catalog.ProfileKey, descriptor.StableKey, StringComparison.Ordinal))
        {
            return Result.Failure<TemplateImportPlan?>(
                TemplateErrors.Conflict("This idempotency key belongs to a different template import."));
        }

        var mappings = await _database.TemplateOperationItems
            .Where(mapping => mapping.OperationId == operation.Id)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        if (operation.State == TemplateOperationState.Active
            && descriptor.Origin == TemplateOrigin.Managed
            && (catalog.State != TemplateState.Active
                || catalog.RootItemId is null
                || !string.Equals(catalog.SourceDigest, operation.SourceDigest, StringComparison.Ordinal)
                || !mappings.Any(mapping => mapping.TargetItemId == catalog.RootItemId.Value)))
        {
            // Managed-file idempotency keys are stable by digest. A retained A operation must not
            // replay after the catalog moved to B: its mappings describe the retired A revision,
            // not a no-op against B. Retire only the completed operation record (application
            // mappings independently retain any old source items they still need), freeing the
            // digest key for a fresh A revision.
            await _database.TemplateOperations
                .Where(candidate => candidate.Id == operation.Id)
                .ExecuteDeleteAsync(cancellationToken)
                .ConfigureAwait(false);
            return Result.Success<TemplateImportPlan?>(null);
        }

        return Result.Success<TemplateImportPlan?>(new TemplateImportPlan(
            operation.Id,
            operation.TemplateId,
            operation.State == TemplateOperationState.Active,
            mappings.Select(mapping => new TemplateItemMapping(
                mapping.TemplateSourceId,
                mapping.TargetItemId,
                mapping.ItemType)).ToArray(),
            mappings.Where(mapping => mapping.BodyRequired).Select(mapping => new TemplateBodyWrite(
                mapping.TemplateSourceId,
                mapping.TargetItemId,
                mapping.ItemType)).ToArray()));
    }

    private async ValueTask<TemplateApplicationPlan?> ApplicationReplayAsync(
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        var application = await _database.TemplateApplications.FirstOrDefaultAsync(
            candidate => candidate.ActorId == Context.PrincipalId
                && candidate.IdempotencyKey == idempotencyKey,
            cancellationToken).ConfigureAwait(false);
        if (application is null)
        {
            return null;
        }

        var mappings = await _database.TemplateApplicationItems
            .Where(mapping => mapping.ApplicationId == application.Id)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        TemplateApplicationResolution? resolution = null;
        IReadOnlyList<TemplateInitializedItem>? preview = null;
        if (TryReadStoredResolution(application.ResolvedInputs, out var stored))
        {
            resolution = stored!.Resolution;
            preview = stored.InitializationPreview;
        }

        return new TemplateApplicationPlan(
            application.Id,
            application.TemplateId,
            application.TargetItemId,
            application.State == TemplateOperationState.Active,
            mappings.Where(mapping => mapping.Created).Select(mapping => new TemplateItemMapping(
                mapping.SourceItemId.Value,
                mapping.TargetItemId,
                mapping.ItemType)).ToArray(),
            mappings.Select(mapping => new TemplateItemMapping(
                mapping.SourceItemId.Value,
                mapping.TargetItemId,
                mapping.ItemType)).ToArray(),
            mappings.Where(mapping => mapping.BodyRequired
                && application.State != TemplateOperationState.Active).Select(mapping => new TemplateBodyCopy(
                mapping.SourceItemId,
                mapping.TargetItemId,
                mapping.ItemType)).ToArray(),
            resolution,
            preview);
    }
}
