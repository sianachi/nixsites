using Microsoft.EntityFrameworkCore;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Provisioning;
using Nix.Domain.Tenancy;
using Nix.Persistence.Authorization;
using Nix.Persistence.Sql.Statements;
using Npgsql;

namespace Nix.Persistence.Items;

public sealed partial class ItemTree
{
    /// <inheritdoc />
    public async ValueTask<string?> TransferWorkspaceAsync(
        ItemId id, WorkspaceId sourceWorkspaceId, WorkspaceId destinationWorkspaceId,
        ItemId? newParentId, ItemId? afterId, PrincipalId actor,
        DateTimeOffset at, CancellationToken cancellationToken)
    {
        // Share the file publisher's quota lock. Lock both buckets in a stable order so a
        // transfer and an upload cannot spend the same free bytes.
        foreach (var workspace in new[] { sourceWorkspaceId, destinationWorkspaceId }.OrderBy(value => value.Value))
        {
            await _dbContext.Database.ExecuteSqlInterpolatedAsync(
                $"SELECT pg_advisory_xact_lock(hashtextextended({workspace.Value.ToString()}, 0))",
                cancellationToken).ConfigureAwait(false);
        }
        var tenant = Tenant;
        // Archive/delete takes a row lock, independent of the topology advisory lock. Keep
        // containment buckets stable until commit so the active-destination decision cannot race it.
        foreach (var workspace in new[] { sourceWorkspaceId, destinationWorkspaceId }.OrderBy(value => value.Value))
        {
            await _sql.ExecuteAsync("""
                SELECT workspace_id FROM workspace
                WHERE tenant_id = @tenant_id AND workspace_id = @workspace_id FOR SHARE
                """, [Uuid("tenant_id", tenant.Value), Uuid("workspace_id", workspace.Value)],
                cancellationToken).ConfigureAwait(false);
        }
        // The request resolver may have cached roles before a structural/membership wait.
        // Ask Core's same resolver against fresh rows after membership writers are excluded.
        var freshPermissions = new WorkspaceMembershipResolver(_sql, _session, _credential, _clock);
        if (!await freshPermissions.CanWriteWorkspaceAsync(sourceWorkspaceId, cancellationToken).ConfigureAwait(false)
            || !await freshPermissions.CanWriteWorkspaceAsync(destinationWorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return "Write access to the source or destination workspace changed. Reload before moving this item.";
        }
        var subtree = _dbContext.ItemClosure.AsNoTracking()
            .Where(edge => edge.TenantId == tenant && edge.WorkspaceId == sourceWorkspaceId && edge.AncestorId == id)
            .Select(edge => edge.DescendantId);
        await _sql.ExecuteAsync("""
            SELECT candidate.id FROM item candidate
            JOIN item_closure edge ON edge.tenant_id = candidate.tenant_id AND edge.descendant_id = candidate.id
            WHERE candidate.tenant_id = @tenant_id AND edge.ancestor_id = @item_id
              AND candidate.workspace_id = @workspace_id
            ORDER BY candidate.id FOR UPDATE OF candidate
            """, [Uuid("tenant_id", tenant.Value), Uuid("item_id", id.Value),
                Uuid("workspace_id", sourceWorkspaceId.Value)], cancellationToken).ConfigureAwait(false);
        var root = await FindAsync(id, cancellationToken).ConfigureAwait(false);
        if (root is null || root.WorkspaceId != sourceWorkspaceId)
        {
            return "The source item changed. Reload it before moving it.";
        }
        var count = await subtree.CountAsync(cancellationToken).ConfigureAwait(false);
        if (count == 0 || count > 10_000)
        {
            return "A workspace transfer can move at most 10,000 items at a time.";
        }
        if (await _dbContext.Items.Where(item => item.TenantId == tenant && subtree.Contains(item.Id))
            .AnyAsync(item => item.LifecycleState == ItemLifecycleState.Purged, cancellationToken).ConfigureAwait(false))
        {
            return "A purged item cannot be moved to another workspace.";
        }
        if (await _dbContext.Items.Where(item => item.TenantId == tenant && subtree.Contains(item.Id))
            .AnyAsync(item => item.ManagedBy != null, cancellationToken).ConfigureAwait(false))
        {
            return "Unlink the calendar before moving its container or events to another workspace.";
        }
        // Any root generation: a purged root is replaced, and the successor's tree is guarded the same.
        var dailyRoots = DeterministicProvisioningId.DailyNotesRootGenerations(sourceWorkspaceId)
            .Select(ItemId.From).ToArray();
        if (await _dbContext.ItemClosure.AnyAsync(edge => edge.TenantId == tenant
            && dailyRoots.Contains(edge.AncestorId) && subtree.Contains(edge.DescendantId), cancellationToken).ConfigureAwait(false))
        {
            return "Daily notes and their folders belong to their workspace. Move their content into an ordinary note first.";
        }
        var quota = await _dbContext.Workspaces.Where(workspace => workspace.TenantId == tenant
            && workspace.Id == destinationWorkspaceId && workspace.LifecycleState == WorkspaceLifecycleState.Active)
            .Select(workspace => (long?)workspace.StorageQuotaBytes)
            .SingleOrDefaultAsync(cancellationToken).ConfigureAwait(false);
        if (quota is null)
        {
            return "The destination workspace is no longer active.";
        }
        var incoming = await _dbContext.FileVersions.Where(version => version.TenantId == tenant && subtree.Contains(version.ItemId))
            .SumAsync(version => (long?)version.ByteLength, cancellationToken).ConfigureAwait(false) ?? 0;
        var used = await _dbContext.FileVersions.Where(version => version.TenantId == tenant && version.WorkspaceId == destinationWorkspaceId)
            .SumAsync(version => (long?)version.ByteLength, cancellationToken).ConfigureAwait(false) ?? 0;
        if (incoming > quota.Value - used)
        {
            return "The destination workspace does not have enough storage for these files and their versions.";
        }

        var sequence = await AllocateSiblingSequenceAsync(destinationWorkspaceId, newParentId, id, afterId, cancellationToken).ConfigureAwait(false);
        try
        {
            // Keep the internal closure range in place through the envelope update. The metadata
            // trigger moves document containment and refuses active workspace-bound operations.
            await _sql.ExecuteAsync(ClosureSql.DetachSubtree,
                [Uuid("tenant_id", tenant.Value), Uuid("item_id", id.Value)], cancellationToken).ConfigureAwait(false);
            await _dbContext.Items.Where(item => item.TenantId == tenant && subtree.Contains(item.Id))
                .ExecuteUpdateAsync(update => update
                    .SetProperty(item => item.WorkspaceId, destinationWorkspaceId)
                    .SetProperty(item => item.LastModifiedBy, actor)
                    .SetProperty(item => item.LastModifiedAt, at), cancellationToken).ConfigureAwait(false);
            // The subtree query used above is source-scoped; closure moves only after every item.
            await _dbContext.ItemClosure.Where(edge => edge.TenantId == tenant && subtree.Contains(edge.DescendantId))
                .ExecuteUpdateAsync(update => update.SetProperty(edge => edge.WorkspaceId, destinationWorkspaceId), cancellationToken).ConfigureAwait(false);
            await _dbContext.Items.Where(item => item.TenantId == tenant && item.Id == id)
                .ExecuteUpdateAsync(update => update.SetProperty(item => item.ParentId, newParentId)
                    .SetProperty(item => item.Seq, sequence), cancellationToken).ConfigureAwait(false);
            if (newParentId is { } parent)
            {
                await _sql.ExecuteAsync(ClosureSql.AttachSubtree,
                    [Uuid("tenant_id", tenant.Value), Uuid("workspace_id", destinationWorkspaceId.Value),
                        Uuid("item_id", id.Value), Uuid("parent_id", parent.Value)], cancellationToken).ConfigureAwait(false);
            }
            await _dbContext.Database.ExecuteSqlRawAsync("SET CONSTRAINTS item_workspace_parent IMMEDIATE", cancellationToken).ConfigureAwait(false);
        }
        catch (PostgresException exception) when (exception.ConstraintName is "item_workspace_transfer_allowed" or "item_workspace_parent")
        {
            // The failed statement marks this request transaction for rollback. No partial file,
            // closure or document metadata changes can be committed by a refused command.
            return "Finish active uploads, background jobs and template operations, and disable scoped automations before moving this item.";
        }
        return null;
    }
}
