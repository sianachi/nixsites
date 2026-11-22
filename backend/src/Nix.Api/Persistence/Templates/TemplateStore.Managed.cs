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

namespace Nix.Persistence.Templates;

public sealed partial class TemplateStore
{
    /// <summary>Publishes one complete managed-directory snapshot as an all-or-nothing catalog swap.</summary>
    public async ValueTask<Result<ManagedTemplateBatchResult>> FinalizeManagedBatchAsync(
        WorkspaceId workspaceId,
        IReadOnlyList<ManagedTemplateFinalization> managedEntries,
        IReadOnlyList<string> activeStableKeys,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(managedEntries);
        ArgumentNullException.ThrowIfNull(activeStableKeys);
        if (!await _permissions.CanWriteWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ManagedTemplateBatchResult>(
                TemplateErrors.NotFound("No such workspace is visible."));
        }
        if (!await IsManagedTemplatePrincipalAsync(cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ManagedTemplateBatchResult>(
                TemplateErrors.Forbidden("Only the provisioned managed-template service may publish managed templates."));
        }

        if (managedEntries.Count > MaximumCatalogTemplates
            || activeStableKeys.Count > MaximumCatalogTemplates
            || activeStableKeys.Any(static key => string.IsNullOrWhiteSpace(key) || key.Length > 160)
            || activeStableKeys.Distinct(StringComparer.Ordinal).Count() != activeStableKeys.Count
            || managedEntries.Select(imported => imported.StableKey).Distinct(StringComparer.Ordinal).Count() != managedEntries.Count)
        {
            return Result.Failure<ManagedTemplateBatchResult>(
                TemplateErrors.Invalid(
                    $"A managed snapshot may name at most {MaximumCatalogTemplates:N0} distinct stable keys."));
        }

        var requestedKeys = activeStableKeys.ToHashSet(StringComparer.Ordinal);
        if (!requestedKeys.SetEquals(managedEntries.Select(imported => imported.StableKey)))
        {
            return Result.Failure<ManagedTemplateBatchResult>(
                TemplateErrors.Invalid("Every active stable key must have exactly one import result."));
        }

        await LockTemplateStagesAsync(cancellationToken).ConfigureAwait(false);
        await LockWorkspaceTemplatesAsync(workspaceId, cancellationToken).ConfigureAwait(false);
        var catalogs = await _database.WorkspaceTemplates
            .AsTracking()
            .Where(template => template.WorkspaceId == workspaceId && template.Origin == TemplateOrigin.Managed)
            .OrderBy(template => template.Id)
            .Take(MaximumCatalogTemplates + 1)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        if (catalogs.Count > MaximumCatalogTemplates)
        {
            return Result.Failure<ManagedTemplateBatchResult>(TemplateErrors.Conflict(
                $"The managed catalog exceeds its {MaximumCatalogTemplates:N0}-template storage bound."));
        }
        var byKey = catalogs.ToDictionary(template => template.StableKey, StringComparer.Ordinal);
        if (managedEntries.Any(imported => !byKey.TryGetValue(imported.StableKey, out var catalog)
            || catalog.Id != imported.TemplateId))
        {
            return Result.Failure<ManagedTemplateBatchResult>(
                TemplateErrors.Conflict("The managed catalog changed while the snapshot was being staged."));
        }

        var suppliedOperationIds = managedEntries
            .Where(imported => imported.OperationId is not null)
            .Select(imported => imported.OperationId!.Value)
            .ToHashSet();
        var outstanding = await (
            from operation in _database.TemplateOperations.AsTracking()
            join template in _database.WorkspaceTemplates on operation.TemplateId equals template.Id
            where operation.WorkspaceId == workspaceId
                && operation.Kind == TemplateOperationKind.Import
                && operation.State == TemplateOperationState.Provisioning
                && template.Origin == TemplateOrigin.Managed
            select operation)
            .OrderBy(operation => operation.Id)
            .Take(MaximumCatalogTemplates + 1)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        if (outstanding.Count > MaximumCatalogTemplates)
        {
            return Result.Failure<ManagedTemplateBatchResult>(TemplateErrors.Conflict(
                "The managed staging set exceeds the catalog bound; expire abandoned imports before retrying."));
        }
        var activeCatalogKeys = catalogs
            .Where(template => template.State == TemplateState.Active)
            .Select(template => template.StableKey)
            .ToHashSet(StringComparer.Ordinal);
        var exactCompletedReplay = outstanding.Count == 0
            && activeCatalogKeys.SetEquals(requestedKeys)
            && managedEntries.All(imported => byKey.TryGetValue(imported.StableKey, out var catalog)
                && catalog.Id == imported.TemplateId
                && catalog.State == TemplateState.Active
                && string.Equals(catalog.SourceDigest, imported.Digest, StringComparison.Ordinal));
        if (exactCompletedReplay)
        {
            return Result.Success(new ManagedTemplateBatchResult(
                Activated: 0,
                Unchanged: managedEntries.Count,
                Retired: 0));
        }
        if (!suppliedOperationIds.SetEquals(outstanding.Select(operation => operation.Id)))
        {
            return Result.Failure<ManagedTemplateBatchResult>(
                TemplateErrors.Conflict("The managed snapshot does not match every staged import."));
        }

        var operations = outstanding.ToDictionary(operation => operation.Id);
        var mappingQuery = _database.TemplateOperationItems
            .AsNoTracking()
            .Where(mapping => suppliedOperationIds.Contains(mapping.OperationId));

        var importsByOperation = managedEntries
            .Where(imported => imported.OperationId is not null)
            .ToDictionary(imported => imported.OperationId!.Value);
        var writtenByOperation = importsByOperation.ToDictionary(
            pair => pair.Key,
            pair => pair.Value.WrittenTargetItemIds.ToHashSet());
        if (writtenByOperation.Any(pair => pair.Value.Count != importsByOperation[pair.Key].WrittenTargetItemIds.Count))
        {
            return Result.Failure<ManagedTemplateBatchResult>(TemplateErrors.Invalid(
                "A managed import lists the same written body target more than once."));
        }

        var mappingCounts = new Dictionary<TemplateOperationId, int>();
        var expectedBodyCounts = new Dictionary<TemplateOperationId, int>();
        var mappingCount = 0;
        await foreach (var mapping in mappingQuery.AsAsyncEnumerable().WithCancellation(cancellationToken)
                           .ConfigureAwait(false))
        {
            mappingCount++;
            if (mappingCount > MaximumManagedBatchMappings)
            {
                return Result.Failure<ManagedTemplateBatchResult>(TemplateErrors.Conflict(
                    $"A managed snapshot may stage at most {MaximumManagedBatchMappings:N0} item mappings."));
            }

            if (!writtenByOperation.TryGetValue(mapping.OperationId, out var writtenTargets))
            {
                return Result.Failure<ManagedTemplateBatchResult>(TemplateErrors.Conflict(
                    "A staged managed item belongs to an operation outside this snapshot."));
            }

            mappingCounts[mapping.OperationId] = mappingCounts.GetValueOrDefault(mapping.OperationId) + 1;
            if (!mapping.BodyRequired)
            {
                continue;
            }

            expectedBodyCounts[mapping.OperationId] = expectedBodyCounts.GetValueOrDefault(mapping.OperationId) + 1;
            if (!writtenTargets.Contains(mapping.TargetItemId))
            {
                return Result.Failure<ManagedTemplateBatchResult>(TemplateErrors.BodiesIncomplete(
                    $"Every body for managed template '{importsByOperation[mapping.OperationId].StableKey}' must be written."));
            }
        }

        var actualBodyCounts = suppliedOperationIds.Count == 0
            ? new Dictionary<TemplateOperationId, int>()
            : await _database.TemplateOperationItems
                .Where(mapping => suppliedOperationIds.Contains(mapping.OperationId)
                    && _database.ContentDocs.Any(document => document.ItemId == mapping.TargetItemId))
                .GroupBy(mapping => mapping.OperationId)
                .Select(group => new { OperationId = group.Key, Count = group.Count() })
                .ToDictionaryAsync(row => row.OperationId, row => row.Count, cancellationToken)
                .ConfigureAwait(false);
        var operationsWithUnreadyFiles = await OperationsWithUnreadyCopiesAsync(
            suppliedOperationIds, cancellationToken).ConfigureAwait(false);
        var now = _clock.GetUtcNow();
        foreach (var imported in managedEntries)
        {
            var catalog = byKey[imported.StableKey];
            if (imported.OperationId is null)
            {
                if (catalog.State != TemplateState.Active
                    || !string.Equals(catalog.SourceDigest, imported.Digest, StringComparison.Ordinal))
                {
                    return Result.Failure<ManagedTemplateBatchResult>(
                        TemplateErrors.Conflict($"Managed template '{imported.StableKey}' is not unchanged."));
                }

                continue;
            }

            var operation = operations[imported.OperationId.Value];
            if (operation.ActorId != Context.PrincipalId
                || operation.TemplateId != catalog.Id
                || operation.ExpiresAt <= now
                || catalog.PendingRootItemId is null
                || !string.Equals(operation.SourceDigest, imported.Digest, StringComparison.Ordinal))
            {
                return Result.Failure<ManagedTemplateBatchResult>(
                    TemplateErrors.Conflict($"Managed template '{imported.StableKey}' has stale staging state."));
            }

            if (mappingCounts.GetValueOrDefault(operation.Id) is not (> 0 and <= MaximumTemplateItems))
            {
                return Result.Failure<ManagedTemplateBatchResult>(
                    TemplateErrors.Conflict(
                        $"Managed template '{imported.StableKey}' has no staged items or exceeds the item limit."));
            }

            var expectedBodies = expectedBodyCounts.GetValueOrDefault(operation.Id);
            if (expectedBodies != writtenByOperation[operation.Id].Count)
            {
                return Result.Failure<ManagedTemplateBatchResult>(
                    TemplateErrors.BodiesIncomplete(
                        $"Every body for managed template '{imported.StableKey}' must be written."));
            }
            if (actualBodyCounts.GetValueOrDefault(operation.Id) != expectedBodies)
            {
                return Result.Failure<ManagedTemplateBatchResult>(
                    TemplateErrors.BodiesIncomplete(
                        $"The staged bodies for managed template '{imported.StableKey}' do not match its plan."));
            }
            if (operationsWithUnreadyFiles.Contains(operation.Id))
            {
                return Result.Failure<ManagedTemplateBatchResult>(TemplateErrors.Conflict(
                    $"Template file copies for managed template '{imported.StableKey}' are not complete."));
            }
        }

        if (suppliedOperationIds.Count > 0)
        {
            var activatedItems = await _database.Items.IgnoreQueryFilters()
                .Where(item => item.LifecycleState == ItemLifecycleState.Provisioning
                    && _database.TemplateOperationItems.Any(mapping =>
                        suppliedOperationIds.Contains(mapping.OperationId)
                        && mapping.TargetItemId == item.Id))
                .ExecuteUpdateAsync(
                    update => update.SetProperty(item => item.LifecycleState, ItemLifecycleState.Active),
                cancellationToken)
                .ConfigureAwait(false);
            if (activatedItems != mappingCount)
            {
                return Result.Failure<ManagedTemplateBatchResult>(TemplateErrors.Conflict(
                    "A staged managed item is missing or no longer in provisioning state."));
            }
        }

        var activated = 0;
        var unchanged = 0;
        var previousRoots = new List<ItemId>();
        foreach (var imported in managedEntries)
        {
            if (imported.OperationId is null)
            {
                unchanged++;
                continue;
            }

            var operation = operations[imported.OperationId.Value];
            var catalog = byKey[imported.StableKey];
            var previousRoot = catalog.RootItemId;
            catalog.RootItemId = catalog.PendingRootItemId;
            catalog.PendingRootItemId = null;
            catalog.State = TemplateState.Active;
            catalog.Title = operation.DraftTitle!;
            catalog.Description = operation.DraftDescription;
            catalog.ManagedSource = operation.ManagedSource;
            catalog.SourceDigest = operation.SourceDigest;
            catalog.Initialization = operation.DraftInitialization;
            catalog.LastModifiedBy = Context.PrincipalId;
            catalog.LastModifiedAt = now;
            if (previousRoot is not null)
            {
                catalog.Revision++;
                previousRoots.Add(previousRoot.Value);
            }

            operation.State = TemplateOperationState.Active;
            operation.FinalizedAt = now;
            AddAudit(
                previousRoot is null ? "template.managed_created" : "template.managed_replaced",
                catalog.Id.Value,
                workspaceId,
                now);
            activated++;
        }

        var retired = 0;
        foreach (var catalog in catalogs.Where(catalog => catalog.State == TemplateState.Active
                     && !requestedKeys.Contains(catalog.StableKey)))
        {
            catalog.State = TemplateState.Inactive;
            catalog.SourceDigest = null;
            catalog.LastModifiedBy = Context.PrincipalId;
            catalog.LastModifiedAt = now;
            AddAudit("template.managed_retired", catalog.Id.Value, workspaceId, now);
            retired++;
        }

        await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        await TrimManagedOperationHistoryAsync(workspaceId, cancellationToken).ConfigureAwait(false);
        foreach (var previousRoot in previousRoots)
        {
            await DeleteTemplateRevisionAsync(previousRoot, cancellationToken).ConfigureAwait(false);
        }

        return Result.Success(new ManagedTemplateBatchResult(activated, unchanged, retired));
    }

    /// <summary>Deletes expired staging envelopes and their bodies without touching active revisions.</summary>
    public ValueTask<Result<TemplateStageSweepResult>> SweepExpiredAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken) =>
        SweepExpiredBatchAsync(workspaceId, null, null, cancellationToken);

}
