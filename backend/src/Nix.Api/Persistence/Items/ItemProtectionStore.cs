using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Items;

namespace Nix.Persistence.Items;

/// <summary>Reads and writes item protections inside the current unit of work.</summary>
/// <remarks>
/// The tenant comes from the request's own context, never a parameter, and row security bounds
/// both statements to it as well.
/// </remarks>
public sealed class ItemProtectionStore(NixDbContext database, INixSessionContextAccessor session) : IItemProtections
{
    private Guid TenantId => (session.Current
        ?? throw new InvalidOperationException("No session context has been established for this unit of work."))
        .TenantId.Value;

    /// <inheritdoc />
    public async ValueTask<bool> AnyDeleteProtectedBelowAsync(ItemId itemId, bool userOnly, CancellationToken cancellationToken)
    {
        var tenantId = TenantId;

        // Planned from the closure (the subtree's edges by ancestor), probing the partial index
        // ix_item_no_delete once per descendant: about 0.03 ms for a five-item folder and 16-25 ms
        // for twenty thousand descendants on a 348k-item corpus, small beside the delete itself.
        // Driving from the protected rows instead was measured far slower once a linked calendar
        // makes thousands of them. Only active items count; one already in the trash is hidden
        // whatever happens above it.
        return await database.Database.SqlQuery<bool>($"""
            SELECT EXISTS (
                SELECT 1
                  FROM item protected
                  JOIN item_closure edge
                    ON edge.tenant_id = protected.tenant_id
                   AND edge.descendant_id = protected.id
                   AND edge.ancestor_id = {itemId.Value}
                 WHERE protected.tenant_id = {tenantId}
                   AND protected.no_delete
                   AND (NOT {userOnly} OR protected.managed_by IS NULL)
                   AND protected.lifecycle_state = 'active'
                   AND edge.depth > 0) AS "Value"
            """).SingleAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<bool> AnyPinnedAtOrBelowAsync(ItemId itemId, CancellationToken cancellationToken)
    {
        var tenantId = TenantId;

        // A pin protects while its holder is in use: neither the holder nor any ancestor of it is
        // trashed (closure depth 0 is the holder itself). Only an active target counts, so nothing
        // already hidden blocks anything. shortcut: a pin whose file was trashed while its holder
        // was in the trash stops protecting; the bytes survive purge, so the pin still resolves.
        return await database.Database.SqlQuery<bool>($"""
            SELECT EXISTS (
                SELECT 1
                  FROM item_closure edge
                  JOIN item_reference pin
                    ON pin.tenant_id = edge.tenant_id
                   AND pin.target_item_id = edge.descendant_id
                   AND pin.target_file_version_id IS NOT NULL
                  JOIN item target
                    ON target.tenant_id = pin.tenant_id
                   AND target.id = pin.target_item_id
                   AND target.lifecycle_state = 'active'
                 WHERE edge.tenant_id = {tenantId}
                   AND edge.ancestor_id = {itemId.Value}
                   AND NOT EXISTS (
                        SELECT 1
                          FROM item_closure up
                          JOIN item holder ON holder.tenant_id = up.tenant_id AND holder.id = up.ancestor_id
                         WHERE up.tenant_id = pin.tenant_id
                           AND up.descendant_id = pin.holder_item_id
                           AND holder.lifecycle_state <> 'active')) AS "Value"
            """).SingleAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<bool> AnyReferencedAtOrBelowAsync(ItemId itemId, CancellationToken cancellationToken)
    {
        var tenantId = TenantId;
        return await database.Database.SqlQuery<bool>($"""
            SELECT EXISTS (
                SELECT 1 FROM item_closure edge
                  JOIN item_reference ref
                    ON ref.tenant_id = edge.tenant_id AND ref.holder_item_id = edge.descendant_id
                 WHERE edge.tenant_id = {tenantId} AND edge.ancestor_id = {itemId.Value})
                OR EXISTS (
                SELECT 1 FROM item_closure edge
                  JOIN item_reference ref
                    ON ref.tenant_id = edge.tenant_id AND ref.target_item_id = edge.descendant_id
                 WHERE edge.tenant_id = {tenantId} AND edge.ancestor_id = {itemId.Value}) AS "Value"
            """).SingleAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask ReleaseHeldReferencesAsync(ItemId itemId, CancellationToken cancellationToken)
    {
        var tenantId = TenantId;
        await database.Database.ExecuteSqlInterpolatedAsync(
            $"DELETE FROM item_reference WHERE tenant_id = {tenantId} AND holder_item_id = {itemId.Value}",
            cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<bool> SetAsync(ItemId itemId, bool? noDelete, bool? noChildren, bool? collaboration, CancellationToken cancellationToken)
    {
        var tenantId = TenantId;

        // Only the columns named are written, and the managed guard is in the statement: a write
        // built from an earlier read would put back a value a sync has since taken over.
        // last_modified_at is left alone on purpose: a protection is not content, and a mirrored
        // calendar event's modification time is what decides whether it is pushed upstream.
        var written = await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE item
               SET no_delete = COALESCE({noDelete}::boolean, no_delete),
                   no_children = COALESCE({noChildren}::boolean, no_children),
                   collaboration = COALESCE({collaboration}::boolean, collaboration)
             WHERE tenant_id = {tenantId} AND id = {itemId.Value}
               AND ({noDelete}::boolean IS NULL OR managed_by IS NULL)
            """, cancellationToken).ConfigureAwait(false);
        return written == 1;
    }
}
