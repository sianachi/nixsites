using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Persistence.Locks;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Items;

/// <summary>
/// The item tree over Postgres: EF Core for the envelope rows, hand-written SQL for the closure.
/// </summary>
/// <remarks>
/// <para>
/// The split follows the data-access rule. An item row is envelope CRUD and LINQ expresses it
/// perfectly well; closure maintenance is three set operations whose plans have to be legible, and
/// an expression tree between the author and those plans helps nobody. Both run on the same
/// connection and the same transaction - <see cref="NixSqlExecutor"/> borrows the context's - so
/// there is one unit of work and one <c>SET LOCAL</c> tenant scope covering both.
/// </para>
/// <para>
/// <b>Everything is tenant-scoped, and every hot read states the tenant explicitly.</b> Row-level
/// security still enforces the session context the request pipeline established. The EF point
/// reads and the hand-written SQL additionally predicate or bind the tenant - not because the
/// policy might fail, but because a condition the planner can see lets it use an index instead of
/// evaluating the policy per row, and because the security model asks for the assertion as defence
/// in depth.
/// </para>
/// </remarks>
public sealed partial class ItemTree(
    NixDbContext dbContext,
    NixSqlExecutor sql,
    INixSessionContextAccessor session,
    CredentialSessionContext credential,
    TimeProvider clock)
    : IItemTree
{
    private readonly NixDbContext _dbContext = dbContext;
    private readonly NixSqlExecutor _sql = sql;
    private readonly INixSessionContextAccessor _session = session;
    private readonly CredentialSessionContext _credential = credential;
    private readonly TimeProvider _clock = clock;

    private TenantId Tenant => _session.Current?.TenantId
        ?? throw new InvalidOperationException(
            "No session context has been established for this unit of work. Every item operation "
            + "is tenant-scoped and there is no unscoped path.");

    /// <inheritdoc />
    public async ValueTask<Item?> FindAsync(ItemId id, CancellationToken cancellationToken)
    {
        var tenant = Tenant;

        // Visibility is derived from the whole path, not only the row itself. The subject
        // predicate excludes direct deletion; the proper-ancestor closure range excludes an
        // otherwise-active descendant whose ancestor is hidden. This is the closure half of the
        // store and is hand-written for the same reason as closure maintenance: the measured LINQ
        // anti-join started from every lifecycle candidate in the tenant rather than from this
        // item's descendant range.
        return await _dbContext.Items
            .FromSqlRaw(
                ItemVisibilitySql.FindVisible,
                Uuid("tenant_id", tenant.Value),
                Uuid("item_id", id.Value))
            .IgnoreQueryFilters()
            .TagWith("ItemTree.FindAsync")
            .FirstOrDefaultAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<Item?> FindStoredAsync(ItemId id, CancellationToken cancellationToken) =>
        await _dbContext.Items
            .FirstOrDefaultAsync(item => item.TenantId == Tenant && item.Id == id, cancellationToken)
            .ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<bool> IsVisibleSubtreeMemberAsync(
        WorkspaceId workspaceId,
        ItemId ancestorId,
        ItemId descendantId,
        CancellationToken cancellationToken)
    {
        var ancestor = await FindAsync(ancestorId, cancellationToken).ConfigureAwait(false);
        var descendant = await FindAsync(descendantId, cancellationToken).ConfigureAwait(false);
        if (ancestor is null || descendant is null
            || ancestor.WorkspaceId != workspaceId || descendant.WorkspaceId != workspaceId)
        {
            return false;
        }

        return await _dbContext.ItemClosure.AsNoTracking().AnyAsync(
            edge => edge.TenantId == Tenant
                && edge.WorkspaceId == workspaceId
                && edge.AncestorId == ancestorId
                && edge.DescendantId == descendantId,
            cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlySet<ItemId>> WithChildrenAsync(
        WorkspaceId workspaceId,
        IReadOnlyList<ItemId> parents,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(parents);

        if (parents.Count == 0)
        {
            return new HashSet<ItemId>();
        }

        // Hand-written, and see TreeShapeSql for the plan that decided it: the LINQ spelling reads
        // every child of every parent and deduplicates, so its cost grows with how full the
        // containers are rather than with how many were asked about.
        var ids = new Guid[parents.Count];
        for (var index = 0; index < parents.Count; index++)
        {
            ids[index] = parents[index].Value;
        }

        var found = new HashSet<ItemId>(parents.Count);

        var rows = _sql.QueryAsync<Guid, ItemIdMapper>(
            TreeShapeSql.ParentsWithChildren,
            default,
            [
                Uuid("tenant_id", Tenant.Value),
                Uuid("workspace_id", workspaceId.Value),
                UuidArray("parent_ids", ids),
            ],
            cancellationToken);

        await foreach (var id in rows.ConfigureAwait(false))
        {
            found.Add(ItemId.From(id));
        }

        return found;
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<Item>> ListChildrenAsync(
        WorkspaceId workspaceId,
        ItemId? parentId,
        bool includeDeleted,
        long? afterSeq,
        int limit,
        CancellationToken cancellationToken)
    {
        var query = _dbContext.Items
            .Where(item => item.WorkspaceId == workspaceId && item.ParentId == parentId);

        if (!includeDeleted)
        {
            query = query.Where(item => item.LifecycleState == ItemLifecycleState.Active);
        }

        if (afterSeq is { } cursor)
        {
            query = query.Where(item => item.Seq > cursor);
        }

        return await query
            .OrderBy(item => item.Seq)
            .Take(limit)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<Item>> ListFinanceBoundaryItemsAsync(
        WorkspaceId workspaceId,
        ItemId itemId,
        bool includeDescendants,
        int limit,
        CancellationToken cancellationToken)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(limit);
        var tenant = Tenant;
        // Do not materialise an ordinary subtree to discover whether it intersects finance. The
        // closure range is indexed and the JSONB key tests return only tagged finance roots and
        // records. One extra row lets callers fail closed when an unusually large finance subtree
        // exceeds their inspection ceiling.
        return await _dbContext.Items
            .FromSqlInterpolated($"""
                SELECT i.*
                FROM item_closure AS edge
                JOIN item AS i
                  ON i.tenant_id = edge.tenant_id
                 AND i.workspace_id = edge.workspace_id
                 AND i.id = CASE
                     WHEN edge.descendant_id = {itemId.Value} THEN edge.ancestor_id
                     ELSE edge.descendant_id
                 END
                WHERE edge.tenant_id = {tenant.Value}
                  AND edge.workspace_id = {workspaceId.Value}
                  AND (
                      edge.descendant_id = {itemId.Value}
                      OR ({includeDescendants} AND edge.ancestor_id = {itemId.Value})
                  )
                  AND (i.properties ? '$fin_currency' OR i.properties ? '$fin_kind')
                  AND i.template_id IS NULL
                  AND i.lifecycle_state <> 'provisioning'
                ORDER BY i.id
                LIMIT {limit + 1}
                """)
            .IgnoreQueryFilters()
            .AsNoTracking()
            .TagWith("ItemTree.ListFinanceBoundaryItemsAsync")
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<Item>> ListDeletedAsync(
        WorkspaceId workspaceId,
        DateTimeOffset? before,
        Guid? beforeId,
        int limit,
        CancellationToken cancellationToken)
    {
        // Trashing marks only the item itself, so one under a closed lock would otherwise list its
        // title and properties to every reader; every other listing withholds it the same way.
        var closedLockParameter = await LockFilterParameters
            .ClosedLocksAsync(_sql, Tenant, _credential, _clock, cancellationToken)
            .ConfigureAwait(false);
        var closedLocks = ((Guid[])closedLockParameter.Value!).Select(ItemId.From).ToList();
        var query = _dbContext.Items.Where(item =>
            item.WorkspaceId == workspaceId
            && item.LifecycleState == ItemLifecycleState.Deleted
            && (closedLocks.Count == 0 || !_dbContext.ItemClosure.Any(edge =>
                edge.DescendantId == item.Id && edge.Depth > 0 && closedLocks.Contains(edge.AncestorId))));

        if (before is { } cursor && beforeId is { } id)
        {
            query = query.Where(item => item.LastModifiedAt < cursor
                || (item.LastModifiedAt == cursor && item.Id.Value.CompareTo(id) < 0));
        }

        return await query
            .OrderByDescending(item => item.LastModifiedAt)
            .ThenByDescending(item => item.Id)
            .Take(limit)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<bool> WorkspaceExistsAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken) =>
        await _dbContext.Workspaces
            .AnyAsync(workspace => workspace.Id == workspaceId, cancellationToken)
            .ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<long> NextSiblingSequenceAsync(
        WorkspaceId workspaceId,
        ItemId? parentId,
        CancellationToken cancellationToken) =>
        await _sql.ScalarOrDefaultAsync<long>(
            ClosureSql.NextSiblingSequence,
            [
                Uuid("tenant_id", Tenant.Value),
                Uuid("workspace_id", workspaceId.Value),
                NullableUuid("parent_id", parentId?.Value),
            ],
            cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<long> AllocateSiblingSequenceAsync(
        WorkspaceId workspaceId,
        ItemId? parentId,
        ItemId movingId,
        ItemId? afterId,
        CancellationToken cancellationToken)
    {
        var slot = await SlotAsync(workspaceId, parentId, movingId, afterId, cancellationToken)
            .ConfigureAwait(false);
        if (slot > 0)
        {
            return slot;
        }

        // No room between the neighbours. Spread this parent's children back out and ask once
        // more; the renumber preserves their order, so nobody reading the list sees anything move.
        await _sql.ExecuteAsync(
            ClosureSql.RenumberSiblings,
            [
                Uuid("tenant_id", Tenant.Value),
                Uuid("workspace_id", workspaceId.Value),
                NullableUuid("parent_id", parentId?.Value),
            ],
            cancellationToken).ConfigureAwait(false);

        slot = await SlotAsync(workspaceId, parentId, movingId, afterId, cancellationToken)
            .ConfigureAwait(false);
        if (slot > 0)
        {
            return slot;
        }

        // Only reachable when the anchor is not among these siblings at all, which the use case
        // checks for and refuses. Appending is the safe answer for a caller that got here anyway:
        // the item lands in the destination, at the end, rather than at position zero alongside
        // whatever else failed to find a slot.
        return await NextSiblingSequenceAsync(workspaceId, parentId, cancellationToken)
            .ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask InsertAsync(Item item, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(item);

        _dbContext.Items.Add(item);
        _dbContext.Entry(item).Property(row => row.Properties).CurrentValue = ConversationImportProperties.Sanitize(item.Properties);
        await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

        // The row has to exist before its edges do: item_closure references it both ways, and the
        // composite foreign keys are checked immediately.
        await _sql.ExecuteAsync(
            ClosureSql.InsertForNewItem,
            [
                Uuid("item_id", item.Id.Value),
                Uuid("tenant_id", item.TenantId.Value),
                Uuid("workspace_id", item.WorkspaceId.Value),
                NullableUuid("parent_id", item.ParentId?.Value),
            ],
            cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask UpdatePropertiesAsync(
        ItemId id,
        string properties,
        PrincipalId actor,
        DateTimeOffset at,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(properties);

        await _dbContext.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE item SET properties = ({properties}::jsonb - '$chat_config') ||
                CASE WHEN properties ? '$chat_config' THEN jsonb_build_object('$chat_config', properties -> '$chat_config') ELSE jsonb_build_object() END,
                last_modified_by = {actor.Value}, last_modified_at = {at}
            WHERE id = {id.Value} AND tenant_id = {Tenant.Value}
            """, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask UpdateConversationConfigurationAsync(ItemId id, string configuration,
        PrincipalId actor, DateTimeOffset at, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        await _dbContext.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE item SET properties = jsonb_set(COALESCE(properties, jsonb_build_object()), ARRAY['$chat_config'], to_jsonb({configuration}::text)),
                last_modified_by = {actor.Value}, last_modified_at = {at}
            WHERE id = {id.Value} AND tenant_id = {Tenant.Value}
            """, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask TouchAsync(
        ItemId id,
        PrincipalId actor,
        DateTimeOffset at,
        CancellationToken cancellationToken) =>
        await _dbContext.Items
            .Where(item => item.Id == id)
            .ExecuteUpdateAsync(
                update => update
                    .SetProperty(item => item.LastModifiedBy, actor)
                    .SetProperty(item => item.LastModifiedAt, at),
                cancellationToken)
            .ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask UpdateSchemaAsync(
        ItemId id,
        string? schema,
        PrincipalId actor,
        DateTimeOffset at,
        CancellationToken cancellationToken) =>
        await _dbContext.Items
            .Where(item => item.Id == id)
            .ExecuteUpdateAsync(
                update => update
                    .SetProperty(item => item.Schema, schema)
                    .SetProperty(item => item.LastModifiedBy, actor)
                    .SetProperty(item => item.LastModifiedAt, at),
                cancellationToken)
            .ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask UpdateViewsAsync(
        ItemId id,
        string? views,
        PrincipalId actor,
        DateTimeOffset at,
        CancellationToken cancellationToken) =>
        await _dbContext.Items
            .Where(item => item.Id == id)
            .ExecuteUpdateAsync(
                update => update
                    .SetProperty(item => item.Views, views)
                    .SetProperty(item => item.LastModifiedBy, actor)
                    .SetProperty(item => item.LastModifiedAt, at),
                cancellationToken)
            .ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<bool> TryUpdateViewsAsync(
        ItemId id,
        WorkspaceId workspaceId,
        string? expectedViews,
        string? views,
        PrincipalId actor,
        DateTimeOffset at,
        CancellationToken cancellationToken)
    {
        var tenant = Tenant;
        var changed = await _dbContext.Items
            .Where(item => item.TenantId == tenant && item.Id == id
                && item.WorkspaceId == workspaceId && item.LifecycleState == ItemLifecycleState.Active
                && item.Views == expectedViews)
            .TagWith("ItemTree.TryUpdateViewsAsync")
            .ExecuteUpdateAsync(
                update => update
                    .SetProperty(item => item.Views, views)
                    .SetProperty(item => item.LastModifiedBy, actor)
                    .SetProperty(item => item.LastModifiedAt, at),
                cancellationToken)
            .ConfigureAwait(false);
        return changed == 1;
    }

    /// <inheritdoc />
    public async ValueTask<bool> WouldCreateCycleAsync(
        ItemId id,
        ItemId parentId,
        CancellationToken cancellationToken) =>
        await _sql.ScalarOrDefaultAsync<bool>(
            ClosureSql.WouldCreateCycle,
            [
                Uuid("tenant_id", Tenant.Value),
                Uuid("item_id", id.Value),
                Uuid("parent_id", parentId.Value),
            ],
            cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask ReparentAsync(
        ItemId id,
        ItemId? newParentId,
        long seq,
        PrincipalId actor,
        DateTimeOffset at,
        CancellationToken cancellationToken)
    {
        var item = await _dbContext.Items
            .FirstOrDefaultAsync(candidate => candidate.Id == id, cancellationToken)
            .ConfigureAwait(false)
            ?? throw new InvalidOperationException(
                $"Item {id} vanished between the caller's check and this write. The use case is "
                + "expected to have found it inside this transaction.");

        // Detach first, then attach. Between the two the subtree is a root, which is a state no
        // reader may observe - both statements run inside the caller's transaction, so none can.
        await _sql.ExecuteAsync(
            ClosureSql.DetachSubtree,
            [Uuid("tenant_id", Tenant.Value), Uuid("item_id", id.Value)],
            cancellationToken).ConfigureAwait(false);

        await _dbContext.Items
            .Where(candidate => candidate.Id == id)
            .ExecuteUpdateAsync(
                update => update
                    .SetProperty(candidate => candidate.ParentId, newParentId)
                    .SetProperty(candidate => candidate.Seq, seq)
                    .SetProperty(candidate => candidate.LastModifiedBy, actor)
                    .SetProperty(candidate => candidate.LastModifiedAt, at),
                cancellationToken)
            .ConfigureAwait(false);

        // Moving to the workspace root leaves the subtree's internal edges and its self-edges,
        // which is the whole of its closure when it has no ancestors.
        if (newParentId is { } parentId)
        {
            await _sql.ExecuteAsync(
                ClosureSql.AttachSubtree,
                [
                    Uuid("tenant_id", Tenant.Value),
                    Uuid("workspace_id", item.WorkspaceId.Value),
                    Uuid("item_id", id.Value),
                    Uuid("parent_id", parentId.Value),
                ],
                cancellationToken).ConfigureAwait(false);
        }
    }

    /// <inheritdoc />
    public async ValueTask SetLifecycleAsync(
        ItemId id,
        ItemLifecycleState state,
        PrincipalId actor,
        DateTimeOffset at,
        CancellationToken cancellationToken)
    {
        if (state != ItemLifecycleState.Active)
        {
            await new Nix.Persistence.Finance.FinanceLock(_dbContext).AcquireAsync(id, cancellationToken).ConfigureAwait(false);
            var current = await FindStoredAsync(id, cancellationToken).ConfigureAwait(false);
            var interrupted = ConversationImportProperties.InterruptConfiguration(current?.Properties);
            if (interrupted is not null)
            {
                await UpdateConversationConfigurationAsync(id, interrupted, actor, at, cancellationToken).ConfigureAwait(false);
            }
        }
        await _dbContext.Items
            .Where(item => item.Id == id)
            .ExecuteUpdateAsync(update => update
                .SetProperty(item => item.LifecycleState, state)
                .SetProperty(item => item.LastModifiedBy, actor)
                .SetProperty(item => item.LastModifiedAt, at), cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Asks the database for a free position, returning zero when there is none.
    /// </summary>
    /// <remarks>
    /// Zero doubles as "no room" because the numbering scheme never produces it: positions start at
    /// a gap and halving a positive minimum stops at one. The alternative - a nullable scalar -
    /// boxes on every call to say something the value range already says.
    /// </remarks>
    private ValueTask<long> SlotAsync(
        WorkspaceId workspaceId,
        ItemId? parentId,
        ItemId movingId,
        ItemId? afterId,
        CancellationToken cancellationToken) =>
        afterId is { } anchor
            ? _sql.ScalarOrDefaultAsync<long>(
                ClosureSql.SequenceSlotAfter,
                [
                    Uuid("tenant_id", Tenant.Value),
                    Uuid("workspace_id", workspaceId.Value),
                    NullableUuid("parent_id", parentId?.Value),
                    Uuid("item_id", movingId.Value),
                    Uuid("after_id", anchor.Value),
                ],
                cancellationToken)
            : _sql.ScalarOrDefaultAsync<long>(
                ClosureSql.SequenceSlotFirst,
                [
                    Uuid("tenant_id", Tenant.Value),
                    Uuid("workspace_id", workspaceId.Value),
                    NullableUuid("parent_id", parentId?.Value),
                    Uuid("item_id", movingId.Value),
                ],
                cancellationToken);

    private static NpgsqlParameter UuidArray(string name, Guid[] values) =>
        new(name, NpgsqlDbType.Uuid | NpgsqlDbType.Array) { Value = values };

    private static NpgsqlParameter Uuid(string name, Guid value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value };

    private static NpgsqlParameter NullableUuid(string name, Guid? value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value is { } present ? present : DBNull.Value };

    /// <summary>Reads a single uuid column.</summary>
    private readonly struct ItemIdMapper : INixRowMapper<Guid>
    {
        /// <inheritdoc />
        public Guid Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);
            return reader.GetGuid(0);
        }
    }
}
