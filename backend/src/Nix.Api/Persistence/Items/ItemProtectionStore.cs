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
