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
    private async ValueTask<WorkspaceTemplate?> ActiveTemplateAsync(
        TemplateId templateId,
        CancellationToken cancellationToken) =>
        await _database.WorkspaceTemplates.AsTracking().FirstOrDefaultAsync(
            template => template.Id == templateId
                && template.State == TemplateState.Active
                && template.RootItemId != null,
            cancellationToken).ConfigureAwait(false);

    private async ValueTask<Item?> RegularItemAsync(ItemId itemId, CancellationToken cancellationToken)
    {
        var item = await _database.Items.AsNoTracking()
            .FirstOrDefaultAsync(candidate => candidate.Id == itemId, cancellationToken)
            .ConfigureAwait(false);
        if (item is null
            || item.TemplateId is not null
            || item.LifecycleState != ItemLifecycleState.Active
            || !await _permissions.CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        return item;
    }

    private async ValueTask<Item?> LockRegularItemAsync(
        ItemId itemId,
        CancellationToken cancellationToken)
    {
        var tenantId = Context.TenantId.Value;
        var item = await _database.Items
            .FromSqlInterpolated(
                $"SELECT * FROM item WHERE tenant_id = {tenantId} AND id = {itemId.Value} FOR UPDATE")
            .IgnoreQueryFilters()
            .AsTracking()
            .SingleOrDefaultAsync(cancellationToken)
            .ConfigureAwait(false);
        return item is { TemplateId: null, LifecycleState: ItemLifecycleState.Active } ? item : null;
    }

    private async ValueTask<List<Item>> LockItemsAsync(
        IReadOnlyList<ItemId> itemIds,
        CancellationToken cancellationToken)
    {
        var ids = itemIds.Select(itemId => itemId.Value).Distinct().ToArray();
        if (ids.Length == 0)
        {
            return [];
        }

        return await _database.Items
            .FromSqlRaw(
                "SELECT * FROM item WHERE tenant_id = @tenant_id AND id = ANY(@item_ids) ORDER BY id FOR UPDATE",
                new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = Context.TenantId.Value },
                new NpgsqlParameter("item_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = ids })
            .IgnoreQueryFilters()
            .AsTracking()
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    private async ValueTask<Result<bool>> EnsureCatalogCapacityAsync(
        WorkspaceId workspaceId,
        bool addingCatalog,
        CancellationToken cancellationToken)
    {
        if (!addingCatalog)
        {
            return Result.Success(true);
        }

        var count = await _database.WorkspaceTemplates
            .Where(template => template.WorkspaceId == workspaceId)
            .Take(MaximumCatalogTemplates)
            .CountAsync(cancellationToken)
            .ConfigureAwait(false);
        return count < MaximumCatalogTemplates
            ? Result.Success(true)
            : Result.Failure<bool>(TemplateErrors.Conflict(
                $"A workspace may contain at most {MaximumCatalogTemplates:N0} template catalog entries; "
                + "remove one before adding another."));
    }

    private async ValueTask<List<Item>> ActiveTreeAsync(
        WorkspaceTemplate template,
        CancellationToken cancellationToken)
    {
        if (template.RootItemId is not { } rootId)
        {
            return [];
        }

        return await (
            from edge in _database.ItemClosure
            join item in _database.Items.IgnoreQueryFilters() on edge.DescendantId equals item.Id
            where edge.AncestorId == rootId
                && item.TemplateId == template.Id
                && item.LifecycleState == ItemLifecycleState.Active
            orderby edge.Depth, item.Seq
            select item)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    private async ValueTask<PropertySchema> ResolveHiddenTemplateSchemaAsync(
        ItemId itemId,
        TemplateId templateId,
        CancellationToken cancellationToken)
    {
        var declarations = await (
            from edge in _database.ItemClosure
            join item in _database.Items.IgnoreQueryFilters() on edge.AncestorId equals item.Id
            where edge.DescendantId == itemId
                && item.TemplateId == templateId
                && item.LifecycleState == ItemLifecycleState.Provisioning
            orderby edge.Depth
            select item.Schema)
            .Take(MaximumTemplateDepth + 1)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var effective = PropertySchema.Empty;
        var any = false;
        foreach (var schema in declarations)
        {
            var declared = PropertySchemaJson.Read(schema);
            effective = any ? PropertySchema.Merge(declared, effective) : declared;
            any = true;
            if (!declared.Inherit)
            {
                break;
            }
        }

        return effective;
    }

    private async ValueTask<List<Item>> SourceTreeAsync(
        WorkspaceId workspaceId,
        ItemId rootId,
        bool includeChildren,
        CancellationToken cancellationToken)
    {
        var root = await RegularItemAsync(rootId, cancellationToken).ConfigureAwait(false);
        if (root is null || root.WorkspaceId != workspaceId || root.LifecycleState != ItemLifecycleState.Active)
        {
            return [];
        }

        if (!includeChildren)
        {
            return [root];
        }

        return await (
            from edge in _database.ItemClosure
            join item in _database.Items on edge.DescendantId equals item.Id
            where edge.AncestorId == rootId && item.LifecycleState == ItemLifecycleState.Active
            orderby edge.Depth, item.Seq
            select item)
            .Take(MaximumTemplateItems + 1)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    private async ValueTask<HashSet<ItemId>> BodyItemIdsAsync(
        IEnumerable<ItemId> itemIds,
        CancellationToken cancellationToken)
    {
        var ids = itemIds.ToArray();
        return await _database.ContentDocs
            .Where(document => ids.Contains(document.ItemId))
            .Select(document => document.ItemId)
            .ToHashSetAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    private async ValueTask DeleteTemplateRevisionAsync(
        ItemId rootItemId,
        CancellationToken cancellationToken)
    {
        var itemIds = await _database.ItemClosure
            .Where(edge => edge.AncestorId == rootItemId)
            .Select(edge => edge.DescendantId)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        if (itemIds.Length == 0)
        {
            itemIds = [rootItemId];
        }

        var isRequiredByProvisioningApplication = await (
            from mapping in _database.TemplateApplicationItems
            join application in _database.TemplateApplications
                on mapping.ApplicationId equals application.Id
            where itemIds.Contains(mapping.SourceItemId)
                && application.State == TemplateOperationState.Provisioning
            select mapping.ApplicationId)
            .AnyAsync(cancellationToken)
            .ConfigureAwait(false);
        if (isRequiredByProvisioningApplication)
        {
            return;
        }

        var root = await _database.Items.IgnoreQueryFilters().AsNoTracking()
            .Where(item => item.Id == rootItemId)
            .Select(item => new { item.WorkspaceId, item.TemplateId })
            .SingleOrDefaultAsync(cancellationToken).ConfigureAwait(false);
        var objectKeys = await _database.FileVersions.AsNoTracking()
            .Where(version => itemIds.Contains(version.ItemId))
            .Select(version => version.ObjectKey).ToArrayAsync(cancellationToken).ConfigureAwait(false);
        if (root is not null && objectKeys.Length > 0)
        {
            await ObjectCleanupJobs.QueueBatchedAsync(
                _jobs, Context.TenantId, Context.PrincipalId, root.WorkspaceId,
                "template-revision", rootItemId.Value, _signer.GetCleanupNotBefore(), objectKeys,
                cancellationToken).ConfigureAwait(false);
        }

        await _database.ItemClosure
            .Where(edge => itemIds.Contains(edge.AncestorId) || itemIds.Contains(edge.DescendantId))
            .ExecuteDeleteAsync(cancellationToken)
            .ConfigureAwait(false);
        await _database.Items.IgnoreQueryFilters()
            .Where(item => itemIds.Contains(item.Id) && item.TemplateId != null)
            .ExecuteDeleteAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    private async ValueTask DeleteRetiredTemplateRevisionsAsync(
        TemplateId templateId,
        CancellationToken cancellationToken)
    {
        var catalog = await _database.WorkspaceTemplates
            .AsNoTracking()
            .FirstOrDefaultAsync(template => template.Id == templateId, cancellationToken)
            .ConfigureAwait(false);
        if (catalog is null)
        {
            return;
        }

        var retainedRoots = new[] { catalog.RootItemId, catalog.PendingRootItemId }
            .Where(static itemId => itemId is not null)
            .Select(static itemId => itemId!.Value)
            .ToHashSet();
        var retiredRoots = await _database.Items.IgnoreQueryFilters()
            .Where(item => item.TemplateId == templateId
                && item.ParentId == null
                && !retainedRoots.Contains(item.Id))
            .Select(item => item.Id)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        foreach (var retiredRoot in retiredRoots)
        {
            await DeleteTemplateRevisionAsync(retiredRoot, cancellationToken).ConfigureAwait(false);
        }
    }

    private async ValueTask TrimManagedOperationHistoryAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken)
    {
        const string sql = """
            WITH ranked AS MATERIALIZED (
                SELECT operation.operation_id,
                       row_number() OVER (
                           PARTITION BY operation.template_id
                           ORDER BY operation.finalized_at DESC NULLS LAST,
                                    operation.created_at DESC,
                                    operation.operation_id DESC) AS revision_rank
                  FROM template_operation operation
                  JOIN workspace_template template
                    ON template.tenant_id = operation.tenant_id
                   AND template.template_id = operation.template_id
                 WHERE operation.tenant_id = @tenant_id
                   AND operation.workspace_id = @workspace_id
                   AND operation.kind = 'import'
                   AND operation.state = 'active'
                   AND template.origin = 'managed'
            ), deletable AS (
                SELECT ranked.operation_id
                  FROM ranked
                 WHERE ranked.revision_rank > @retained
                   AND NOT EXISTS (
                       SELECT 1
                         FROM template_operation_item operation_item
                         JOIN template_application_item application_item
                           ON application_item.tenant_id = operation_item.tenant_id
                          AND application_item.source_item_id = operation_item.target_item_id
                         JOIN template_application application
                           ON application.tenant_id = application_item.tenant_id
                          AND application.application_id = application_item.application_id
                        WHERE operation_item.operation_id = ranked.operation_id
                          AND application.state = 'provisioning'
                   )
            )
            DELETE FROM template_operation operation
             USING deletable
             WHERE operation.operation_id = deletable.operation_id
               AND operation.tenant_id = @tenant_id
            """;

        await _database.Database.ExecuteSqlRawAsync(
            sql,
            [
                new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = Context.TenantId.Value },
                new NpgsqlParameter("workspace_id", NpgsqlDbType.Uuid) { Value = workspaceId.Value },
                new NpgsqlParameter("retained", NpgsqlDbType.Integer) { Value = RetainedManagedOperationHistory },
            ],
            cancellationToken).ConfigureAwait(false);
    }

    private static TemplateShape Shape(List<Item> items)
    {
        if (items.Count == 0)
        {
            return new TemplateShape(0, 0, 0, []);
        }

        var schema = PropertySchemaJson.Read(items[0].Schema);
        var views = ViewDefinitionsJson.Read(items[0].Views).Views;
        return new TemplateShape(
            schema.Properties.Length,
            views.Length,
            items.Count - 1,
            views.Select(view => ViewKinds.ToText(view.Kind)).Distinct(StringComparer.Ordinal).ToArray());
    }

    private static TemplateShape Shape(Item root, int childCount)
    {
        var schema = PropertySchemaJson.Read(root.Schema);
        var views = ViewDefinitionsJson.Read(root.Views).Views;
        return new TemplateShape(
            schema.Properties.Length,
            views.Length,
            childCount,
            views.Select(view => ViewKinds.ToText(view.Kind)).Distinct(StringComparer.Ordinal).ToArray());
    }

    private static TemplateItemSnapshot BuildTree(List<Item> items, HashSet<ItemId> bodies)
    {
        var children = items.ToLookup(item => item.ParentId);
        TemplateItemSnapshot Build(Item item) => new(
            item.TemplateSourceId!.Value,
            item.Type,
            ItemProperties.ReadTitle(item.Properties),
            item.Seq,
            item.Properties,
            item.Schema,
            item.Views,
            bodies.Contains(item.Id),
            children[item.Id].OrderBy(child => child.Seq).Select(Build).ToArray(),
            item.Recurrence);

        return Build(items.Single(item => item.ParentId is null));
    }

    private static TemplateItemSnapshot? FindSnapshot(TemplateItemSnapshot current, Guid sourceId)
    {
        if (current.SourceId == sourceId)
        {
            return current;
        }

        foreach (var child in current.Children)
        {
            if (FindSnapshot(child, sourceId) is { } found)
            {
                return found;
            }
        }

        return null;
    }

}
