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
    /// <summary>Authorizes cheap import admission before archive bytes are parsed.</summary>
    public async ValueTask<Result<TemplateWorkspaceAuthorization>> AuthorizeImportAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken)
    {
        if (!await _permissions.CanReadWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateWorkspaceAuthorization>(
                TemplateErrors.NotFound("No such workspace is visible."));
        }

        var canWrite = await _permissions.CanWriteWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false);
        var canManageTemplates = canWrite
            && await IsManagedTemplatePrincipalAsync(cancellationToken).ConfigureAwait(false);
        return Result.Success(new TemplateWorkspaceAuthorization(
            Context.TenantId,
            Context.PrincipalId,
            workspaceId,
            canWrite,
            canManageTemplates));
    }

    /// <summary>Lists active templates in a readable workspace.</summary>
    public async ValueTask<Result<TemplateLibrarySnapshot>> ListAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken)
    {
        if (!await _permissions.CanReadWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateLibrarySnapshot>(
                TemplateErrors.NotFound("No such workspace is visible."));
        }

        var rows = await _database.WorkspaceTemplates
            .Where(template => template.WorkspaceId == workspaceId && template.State == TemplateState.Active)
            .OrderByDescending(template => template.LastModifiedAt)
            .Take(MaximumCatalogTemplates + 1)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        if (rows.Count > MaximumCatalogTemplates)
        {
            return Result.Failure<TemplateLibrarySnapshot>(
                TemplateErrors.Invalid(
                    $"A workspace may expose at most {MaximumCatalogTemplates:N0} active templates."));
        }
        var canManage = await _permissions.CanWriteWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false);

        var rootIds = rows.Where(template => template.RootItemId is not null)
            .Select(template => template.RootItemId!.Value)
            .ToArray();
        var roots = rootIds.Length == 0
            ? new Dictionary<ItemId, Item>()
            : await _database.Items.IgnoreQueryFilters()
                .Where(item => rootIds.Contains(item.Id)
                    && item.LifecycleState == ItemLifecycleState.Active)
                .ToDictionaryAsync(item => item.Id, cancellationToken)
                .ConfigureAwait(false);
        var childCounts = rootIds.Length == 0
            ? new Dictionary<ItemId, int>()
            : await _database.ItemClosure
                .Where(edge => rootIds.Contains(edge.AncestorId) && edge.Depth > 0)
                .GroupBy(edge => edge.AncestorId)
                .Select(group => new { RootId = group.Key, Count = group.Count() })
                .ToDictionaryAsync(row => row.RootId, row => row.Count, cancellationToken)
                .ConfigureAwait(false);

        var result = new List<TemplateCatalogSnapshot>(rows.Count);
        foreach (var row in rows)
        {
            var shape = row.RootItemId is { } rootId && roots.TryGetValue(rootId, out var root)
                ? Shape(root, childCounts.GetValueOrDefault(rootId))
                : new TemplateShape(0, 0, 0, []);
            result.Add(new TemplateCatalogSnapshot(
                row,
                shape,
                canManage));
        }

        return Result.Success(new TemplateLibrarySnapshot(result, canManage));
    }

    /// <summary>Reads one active template and its hidden tree.</summary>
    public async ValueTask<Result<TemplateDetailSnapshot>> DetailAsync(
        TemplateId templateId,
        CancellationToken cancellationToken)
    {
        var template = await ActiveTemplateAsync(templateId, cancellationToken).ConfigureAwait(false);
        if (template is null
            || !await _permissions.CanReadWorkspaceAsync(template.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateDetailSnapshot>(TemplateErrors.NotFound("No such template is visible."));
        }

        var items = await ActiveTreeAsync(template, cancellationToken).ConfigureAwait(false);
        if (items.Count == 0)
        {
            return Result.Failure<TemplateDetailSnapshot>(
                TemplateErrors.Invalid("This template has no active root and cannot be used."));
        }

        var bodyItems = await BodyItemIdsAsync(items.Select(item => item.Id), cancellationToken).ConfigureAwait(false);
        var root = BuildTree(items, bodyItems);
        var canManage = await _permissions.CanWriteWorkspaceAsync(template.WorkspaceId, cancellationToken)
            .ConfigureAwait(false);
        return Result.Success(new TemplateDetailSnapshot(template, Shape(items), root, canManage));
    }

    /// <summary>Reads one active template item by stable source identity.</summary>
    public async ValueTask<Result<TemplateItemSnapshot>> ItemAsync(
        TemplateId templateId,
        Guid sourceId,
        CancellationToken cancellationToken)
    {
        var detail = await DetailAsync(templateId, cancellationToken).ConfigureAwait(false);
        if (detail.IsFailure)
        {
            return Result.Failure<TemplateItemSnapshot>(detail.Error);
        }

        var found = FindSnapshot(detail.Value.Root, sourceId);
        return found is null
            ? Result.Failure<TemplateItemSnapshot>(TemplateErrors.NotFound("No such template item is visible."))
            : Result.Success(found);
    }

}
