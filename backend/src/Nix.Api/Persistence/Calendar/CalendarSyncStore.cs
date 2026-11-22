using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.Calendar;
using Nix.Domain.Calendar;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Calendar;

/// <summary>
/// Backs <see cref="ICalendarSyncStore"/> with row-level-security-scoped EF reads and plain SQL
/// writes. Every call runs in a session scoped to the owner, so the owner policy alone decides
/// what is visible; tenant and principal written into new rows come from that same session.
/// </summary>
public sealed class CalendarSyncStore(NixDbContext database, INixSessionContextAccessor session) : ICalendarSyncStore
{
    /// <summary>
    /// One push page's candidates (C3), in one pass over each side: the container's active
    /// children (the item parent index) full-joined to the link's map rows (the link prefix of
    /// <c>ux_calendar_event_map_item</c>). A child is a candidate when it has a start and is unmapped,
    /// tombstoned, unconfirmed or changed since its last sync; a live map row with no active child
    /// in the container is a pending delete, and only then is its item looked up (to tell trashed
    /// from moved from purged, and to read its read-only flag). Ordered by when the item last
    /// changed, so the oldest pending change goes first.
    /// </summary>
    /// <remarks>
    /// Whatever could never be handed out is left out here rather than after the <c>LIMIT</c>, so
    /// it cannot sit at the head of every page: a child under a lock (its own or an ancestor's,
    /// decided as <c>ItemLockSql.LockedAmong</c> decides it, through the closure's self edge and
    /// ancestor edges), a read-only event, a start or end no provider could take (a shape check
    /// that admits everything the <c>datetime</c> validator admits), and a pair whose pushes failed
    /// five times in a row (<see cref="CalendarSyncRules.MaxPushFailures"/>, written into the statement as its literal) until the item is
    /// edited again after its last hand-out. A pending delete is parked at the same five. The
    /// patterns spell their digits out: EF's raw-SQL builder would read a <c>{n}</c> quantifier as a
    /// parameter placeholder.
    /// </remarks>
    public const string PushCandidatesSql = """
        SELECT map.id AS "MapId",
               COALESCE(child.id, map.item_id) AS "ItemId",
               COALESCE(child.properties, gone.properties)::text AS "Properties",
               COALESCE(child.last_modified_at, gone.last_modified_at) AS "LastModifiedAt",
               child.id IS NOT NULL AS "Live"
          FROM (
              SELECT item.id, item.properties, item.last_modified_at
                FROM item
               WHERE item.tenant_id = @tenant_id
                 AND item.workspace_id = @workspace_id
                 AND item.parent_id = @container_id
                 AND item.lifecycle_state = 'active'
                 AND item.template_id IS NULL
          ) child
          FULL JOIN (
              SELECT mapped.id, mapped.item_id, mapped.deleted_at, mapped.push_failures, mapped.external_event_id,
                     mapped.nix_version, mapped.push_nix_version, mapped.updated_at
                FROM calendar_event_map mapped
               WHERE mapped.tenant_id = @tenant_id
                 AND mapped.link_id = @link_id
          ) map ON map.item_id = child.id
          LEFT JOIN LATERAL (
              SELECT item.properties, item.last_modified_at
                FROM item
               WHERE child.id IS NULL
                 AND item.tenant_id = @tenant_id
                 AND item.id = map.item_id
          ) gone ON true
         WHERE ((child.id IS NOT NULL
                 AND jsonb_typeof(child.properties -> 'start') = 'string'
                 AND child.properties ->> 'start' ~ '^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9](T[^\[]+\[[^]]+\])?$'
                 AND (COALESCE(jsonb_typeof(child.properties -> 'end'), 'null') = 'null'
                      OR (jsonb_typeof(child.properties -> 'end') = 'string'
                          AND child.properties ->> 'end' ~ '^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9](T[^\[]+\[[^]]+\])?$'))
                 AND COALESCE(child.properties -> '$cal_readonly', 'false'::jsonb) <> 'true'::jsonb
                 AND (map.id IS NULL
                      OR ((map.deleted_at IS NOT NULL
                           OR map.external_event_id IS NULL
                           OR map.nix_version IS NULL
                           OR child.last_modified_at > map.nix_version)
                          AND (map.push_failures < 5
                               OR map.push_nix_version IS NULL
                               OR child.last_modified_at > map.push_nix_version))))
             OR (child.id IS NULL AND map.deleted_at IS NULL AND map.push_failures < 5))
           AND NOT EXISTS (
               SELECT 1
                 FROM item_closure covering
                 JOIN item_lock held
                   ON held.tenant_id = covering.tenant_id
                  AND held.item_id = covering.ancestor_id
                WHERE covering.tenant_id = @tenant_id
                  AND covering.descendant_id = COALESCE(child.id, map.item_id))
         ORDER BY COALESCE(child.last_modified_at, gone.last_modified_at, map.updated_at), COALESCE(child.id, map.item_id)
         LIMIT @limit
        """;

    /// <summary>
    /// A full resync's reconciliation read, in one statement: each live, confirmed map row of the
    /// link (the link prefix of <c>ux_calendar_event_map_item</c>) with its item's start, and
    /// whether that item is still an active, non-template child of the link's container in the
    /// link's workspace - the only items the reconciliation may trash. One row past the limit is
    /// read so a truncated read is known as such.
    /// </summary>
    public const string MappedStartsSql = """
        SELECT map.tenant_id AS "TenantId", map.id AS "Id", map.link_id AS "LinkId", map.principal_id AS "PrincipalId",
               map.item_id AS "ItemId", map.external_event_id AS "ExternalEventId", map.external_version AS "ExternalVersion",
               map.external_updated_at AS "ExternalUpdatedAt", map.nix_version AS "NixVersion",
               map.last_synced_hash AS "LastSyncedHash", map.push_nix_version AS "PushNixVersion", map.push_hash AS "PushHash",
               map.push_op AS "PushOp", map.push_failures AS "PushFailures", map.seen_execution AS "SeenExecution",
               map.deleted_at AS "DeletedAt", map.created_at AS "CreatedAt", map.updated_at AS "UpdatedAt",
               item.properties ->> 'start' AS "Start",
               COALESCE(item.lifecycle_state = 'active'
                        AND item.parent_id = @container_id
                        AND item.workspace_id = @workspace_id
                        AND item.template_id IS NULL, false) AS "ItemActive"
          FROM calendar_event_map map
          LEFT JOIN item ON item.tenant_id = map.tenant_id AND item.id = map.item_id
         WHERE map.tenant_id = @tenant_id
           AND map.link_id = @link_id
           AND map.deleted_at IS NULL
           AND map.external_event_id IS NOT NULL
         ORDER BY map.id
         LIMIT @limit
        """;

    /// <summary>The newest page of a link's log (served by <c>ix_calendar_sync_log_link_at</c>).</summary>
    public const string LogPageSql = """
        SELECT * FROM calendar_sync_log
         WHERE tenant_id = @tenant_id AND link_id = @link_id
         ORDER BY at DESC, id DESC
         LIMIT @limit
        """;

    /// <summary>A later page of a link's log, strictly after the keyset cursor.</summary>
    public const string LogPageAfterSql = """
        SELECT * FROM calendar_sync_log
         WHERE tenant_id = @tenant_id AND link_id = @link_id AND (at, id) < (@before_at, @before_id)
         ORDER BY at DESC, id DESC
         LIMIT @limit
        """;

    private const string LinkInsertSavepoint = "calendar_link_insert";

    private const string ContainerForeignKey = "fk_calendar_link_container_item";

    private NixSessionContext Context =>
        session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

    public async Task<WorkspaceId?> PersonalWorkspaceAsync(CancellationToken cancellationToken)
    {
        var principal = Context.PrincipalId;
        var found = await database.Set<Workspace>().AsNoTracking()
            .Where(workspace => workspace.PersonalOwnerPrincipalId == principal)
            .Select(workspace => (WorkspaceId?)workspace.Id)
            .FirstOrDefaultAsync(cancellationToken).ConfigureAwait(false);
        return found;
    }

    public async Task<IReadOnlyList<CalendarConnection>> ListConnectionsAsync(CancellationToken cancellationToken) =>
        await database.Set<CalendarConnection>().AsNoTracking()
            .OrderByDescending(row => row.CreatedAt)
            .ThenBy(row => row.Id)
            .Take(100)
            .ToListAsync(cancellationToken).ConfigureAwait(false);

    public Task<CalendarConnection?> GetConnectionAsync(Guid connectionId, CancellationToken cancellationToken) =>
        database.Set<CalendarConnection>().AsNoTracking()
            .SingleOrDefaultAsync(row => row.Id == connectionId, cancellationToken);

    public async Task<CalendarConnection?> LockConnectionAsync(Guid connectionId, CancellationToken cancellationToken)
    {
        var rows = await database.Set<CalendarConnection>()
            .FromSqlInterpolated($"SELECT * FROM calendar_connection WHERE id = {connectionId} FOR UPDATE")
            .AsNoTracking()
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        return rows.SingleOrDefault();
    }

    public async Task<Guid> UpsertConnectionAsync(
        TenantId tenantId, PrincipalId principalId, CalendarConnectionGrant grant, DateTimeOffset now, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(grant);
        var id = Guid.CreateVersion7();
        var ids = await database.Database.SqlQuery<Guid>($"""
            INSERT INTO calendar_connection
                (tenant_id, id, principal_id, provider, account_subject, account_email, status,
                 refresh_token_protected, access_token_protected, access_token_expires_at, scopes,
                 last_error, created_at, updated_at)
            VALUES ({tenantId.Value}, {id}, {principalId.Value}, {grant.Provider}, {grant.AccountSubject},
                    {grant.AccountEmail}, 'active', {grant.RefreshTokenProtected}, {grant.AccessTokenProtected},
                    {grant.AccessTokenExpiresAt}, {grant.Scopes}, NULL, {now}, {now})
            ON CONFLICT (tenant_id, principal_id, provider, account_subject) DO UPDATE SET
                account_email = EXCLUDED.account_email,
                status = 'active',
                refresh_token_protected = EXCLUDED.refresh_token_protected,
                access_token_protected = EXCLUDED.access_token_protected,
                access_token_expires_at = EXCLUDED.access_token_expires_at,
                scopes = EXCLUDED.scopes,
                last_error = NULL,
                updated_at = EXCLUDED.updated_at
            RETURNING id AS "Value"
            """).ToListAsync(cancellationToken).ConfigureAwait(false);
        return ids.Single();
    }

    public Task StoreTokensAsync(
        Guid connectionId, byte[]? rotatedRefreshTokenProtected, byte[] accessTokenProtected, DateTimeOffset accessTokenExpiresAt,
        DateTimeOffset now, CancellationToken cancellationToken) =>
        database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE calendar_connection
               SET refresh_token_protected = COALESCE({rotatedRefreshTokenProtected}, refresh_token_protected),
                   access_token_protected = {accessTokenProtected},
                   access_token_expires_at = {accessTokenExpiresAt},
                   updated_at = {now}
             WHERE id = {connectionId} AND status = 'active'
            """, cancellationToken);

    public async Task<bool> MarkNeedsReauthAsync(Guid connectionId, string reason, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var bounded = CalendarSyncRules.Bound(reason, CalendarSyncRules.MaxDetailLength);
        var changed = await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE calendar_connection
               SET status = 'needs_reauth',
                   access_token_protected = NULL,
                   access_token_expires_at = NULL,
                   last_error = {bounded},
                   updated_at = {now}
             WHERE id = {connectionId} AND status = 'active'
            """, cancellationToken).ConfigureAwait(false);
        return changed == 1;
    }

    public async Task<bool> RevokeConnectionAsync(Guid connectionId, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var changed = await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE calendar_connection
               SET status = 'revoked',
                   refresh_token_protected = NULL,
                   access_token_protected = NULL,
                   access_token_expires_at = NULL,
                   updated_at = {now}
             WHERE id = {connectionId}
            """, cancellationToken).ConfigureAwait(false);
        if (changed == 0)
        {
            return false;
        }

        // Links before their triggers, in id order, as every path that touches both takes them
        // (firing and "Sync now" lock the link, then insert or update triggers): two such paths can
        // then never wait on each other in opposite orders.
        await database.Database.SqlQuery<Guid>($"""
            SELECT id AS "Value" FROM calendar_link WHERE connection_id = {connectionId} ORDER BY id FOR UPDATE
            """).ToListAsync(cancellationToken).ConfigureAwait(false);
        var context = Context;
        await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE scheduled_trigger
               SET status = 'cancelled', updated_at = {now}
             WHERE tenant_id = {context.TenantId.Value}
               AND principal_id = {context.PrincipalId.Value}
               AND kind = 'calendar'
               AND status = 'pending'
               AND rule_id IN (SELECT link.id FROM calendar_link link WHERE link.connection_id = {connectionId})
            """, cancellationToken).ConfigureAwait(false);
        await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE calendar_link
               SET status = 'stopped', revision = revision + 1, updated_at = {now}
             WHERE connection_id = {connectionId} AND status <> 'stopped'
            """, cancellationToken).ConfigureAwait(false);
        return true;
    }

    public async Task<IReadOnlyList<CalendarLink>> ListLinksAsync(WorkspaceId? workspaceId, CancellationToken cancellationToken)
    {
        var query = database.Set<CalendarLink>().AsNoTracking();
        if (workspaceId is { } workspace)
        {
            query = query.Where(row => row.WorkspaceId == workspace);
        }

        return await query.OrderBy(row => row.CreatedAt).ThenBy(row => row.Id).Take(200)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
    }

    public Task<CalendarLink?> GetLinkAsync(Guid linkId, CancellationToken cancellationToken) =>
        database.Set<CalendarLink>().AsNoTracking().SingleOrDefaultAsync(row => row.Id == linkId, cancellationToken);

    public async Task<CalendarLink?> LockLinkAsync(Guid linkId, CancellationToken cancellationToken)
    {
        var rows = await database.Set<CalendarLink>()
            .FromSqlInterpolated($"SELECT * FROM calendar_link WHERE id = {linkId} FOR UPDATE")
            .AsNoTracking()
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        return rows.SingleOrDefault();
    }

    public async Task<CalendarLinkWrite> InsertLinkAsync(CalendarLink link, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(link);

        // ON CONFLICT DO NOTHING with no target covers both unique indexes (one link per container,
        // one per external calendar of a connection) without aborting the request's transaction. A
        // container purged between the handler's check and this insert fails the foreign key; the
        // savepoint keeps that from aborting the transaction too.
        var transaction = database.Database.CurrentTransaction;
        if (transaction is not null)
        {
            await transaction.CreateSavepointAsync(LinkInsertSavepoint, cancellationToken).ConfigureAwait(false);
        }

        int inserted;
        try
        {
            inserted = await InsertLinkRowAsync(link, cancellationToken).ConfigureAwait(false);
        }
        catch (PostgresException exception) when (exception.SqlState == PostgresErrorCodes.ForeignKeyViolation
            && exception.ConstraintName == ContainerForeignKey
            && transaction is not null)
        {
            await transaction.RollbackToSavepointAsync(LinkInsertSavepoint, cancellationToken).ConfigureAwait(false);
            return CalendarLinkWrite.ContainerMissing;
        }

        if (transaction is not null)
        {
            await transaction.ReleaseSavepointAsync(LinkInsertSavepoint, cancellationToken).ConfigureAwait(false);
        }

        if (inserted != 1)
        {
            return CalendarLinkWrite.Exists;
        }

        // A linked container is the system's to remove: unlinking in settings is the one way out,
        // so it is marked managed and protected from deletion for as long as the link stands.
        await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE item
               SET managed_by = {ItemManagers.CalendarContainer}, no_delete = true
             WHERE tenant_id = {link.TenantId.Value} AND id = {link.ContainerItemId.Value}
            """, cancellationToken).ConfigureAwait(false);
        return CalendarLinkWrite.Created;
    }

    private Task<int> InsertLinkRowAsync(CalendarLink link, CancellationToken cancellationToken) =>
        database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO calendar_link
                (tenant_id, id, principal_id, connection_id, workspace_id, container_item_id,
                 external_calendar_id, name, direction, window_past_days, window_future_days,
                 sync_cursor, cursor_window_start, cursor_window_end, status, last_synced_at,
                 last_error, last_job_id, revision, created_at, updated_at)
            VALUES ({link.TenantId.Value}, {link.Id}, {link.PrincipalId.Value}, {link.ConnectionId},
                    {link.WorkspaceId.Value}, {link.ContainerItemId.Value}, {link.ExternalCalendarId}, {link.Name},
                    {link.Direction}, {link.WindowPastDays}, {link.WindowFutureDays}, NULL, NULL, NULL,
                    {link.Status}, NULL, NULL, NULL, {link.Revision}, {link.CreatedAt}, {link.UpdatedAt})
            ON CONFLICT DO NOTHING
            """, cancellationToken);

    public async Task<CalendarLink?> UpdateLinkAsync(
        Guid linkId, int expectedRevision, string name, string direction, string status, short windowPastDays, short windowFutureDays,
        DateTimeOffset now, CancellationToken cancellationToken)
    {
        var changed = await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE calendar_link
               SET name = {name},
                   direction = {direction},
                   status = {status},
                   window_past_days = {windowPastDays},
                   window_future_days = {windowFutureDays},
                   last_error = CASE WHEN {status} = 'active' THEN NULL ELSE last_error END,
                   revision = revision + 1,
                   updated_at = {now}
             WHERE id = {linkId} AND revision = {expectedRevision}
            """, cancellationToken).ConfigureAwait(false);
        return changed == 1 ? await GetLinkAsync(linkId, cancellationToken).ConfigureAwait(false) : null;
    }

    public async Task<IReadOnlyList<Item>> ListLinkedContainersAsync(WorkspaceId workspaceId, CancellationToken cancellationToken)
    {
        var tenantId = Context.TenantId;
        return await database.Items.AsNoTracking()
            .Where(item => item.TenantId == tenantId
                && item.WorkspaceId == workspaceId
                && item.ManagedBy == ItemManagers.CalendarContainer
                && item.LifecycleState == ItemLifecycleState.Active)
            .OrderBy(item => item.CreatedAt)
            .Take(200)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task<bool> UnlinkContainerAsync(WorkspaceId workspaceId, ItemId containerItemId, CancellationToken cancellationToken) =>
        await database.Database.SqlQuery<bool>($"""
            SELECT nix_unlink_calendar_container({workspaceId.Value}, {containerItemId.Value}) AS "Value"
            """).SingleAsync(cancellationToken).ConfigureAwait(false);

    public async Task<bool> DeleteLinkAsync(Guid linkId, CancellationToken cancellationToken)
    {
        // The link before its triggers, the order every path that touches both takes them.
        if (await LockLinkAsync(linkId, cancellationToken).ConfigureAwait(false) is not { } link)
        {
            return false;
        }

        var context = Context;

        // Hand the container and its mirrored events back as ordinary items. Only the protection
        // the link itself put there is lifted: managed_by is what says it was the link's. Events
        // are found by the link's own map as well as by parent, so one that was paired while in
        // the trash or outside the container is not left protected with nothing to release it.
        await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE item
               SET managed_by = NULL, no_delete = false
             WHERE tenant_id = {link.TenantId.Value}
               AND managed_by IS NOT NULL
               AND ((id = {link.ContainerItemId.Value} AND managed_by = {ItemManagers.CalendarContainer})
                    OR (managed_by = {ItemManagers.CalendarEvent}
                        AND (parent_id = {link.ContainerItemId.Value}
                             OR id IN (SELECT map.item_id FROM calendar_event_map map
                                        WHERE map.tenant_id = {link.TenantId.Value} AND map.link_id = {linkId}))))
            """, cancellationToken).ConfigureAwait(false);
        await CancelTriggersAsync(context, linkId, cancellationToken).ConfigureAwait(false);
        var deleted = await database.Database.ExecuteSqlInterpolatedAsync(
            $"DELETE FROM calendar_link WHERE id = {linkId}", cancellationToken).ConfigureAwait(false);
        return deleted == 1;
    }

    public Task SetLastJobAsync(Guid linkId, Guid jobId, DateTimeOffset now, CancellationToken cancellationToken) =>
        database.Database.ExecuteSqlInterpolatedAsync(
            $"UPDATE calendar_link SET last_job_id = {jobId}, updated_at = {now} WHERE id = {linkId}", cancellationToken);

    public Task SetLinkErrorAsync(Guid linkId, string? status, string reason, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var bounded = CalendarSyncRules.Bound(reason, CalendarSyncRules.MaxDetailLength);
        return database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE calendar_link
               SET status = COALESCE({status}, status), last_error = {bounded}, updated_at = {now}
             WHERE id = {linkId}
            """, cancellationToken);
    }

    public Task StoreCursorAsync(
        Guid linkId, string? cursor, DateTimeOffset windowStart, DateTimeOffset windowEnd, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var stored = string.IsNullOrEmpty(cursor) ? null : cursor;
        return database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE calendar_link
               SET sync_cursor = {stored},
                   cursor_window_start = {windowStart},
                   cursor_window_end = {windowEnd},
                   last_synced_at = {now},
                   last_error = NULL,
                   status = CASE WHEN status = 'error' THEN 'active' ELSE status END,
                   updated_at = {now}
             WHERE id = {linkId}
            """, cancellationToken);
    }

    public Task EnqueueDirtyAsync(CalendarLink link, DateTimeOffset now, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(link);
        var minute = new DateTimeOffset(now.UtcTicks - (now.UtcTicks % TimeSpan.TicksPerMinute), TimeSpan.Zero);
        var fireAt = minute.AddMinutes(1);
        var key = CalendarSyncRules.DirtyKey(link.Id, minute);
        return database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO scheduled_trigger
                (tenant_id, id, workspace_id, principal_id, kind, source, source_item_id, rule_id,
                 fire_at, dedupe_key, status, attempts, created_at, updated_at)
            VALUES ({link.TenantId.Value}, {Guid.CreateVersion7()}, {link.WorkspaceId.Value}, {link.PrincipalId.Value},
                    'calendar', {CalendarSyncRules.DirtySource}, {link.ContainerItemId.Value}, {link.Id},
                    {fireAt}, {key}, 'pending', 0, {now}, {now})
            ON CONFLICT (tenant_id, principal_id, dedupe_key) DO NOTHING
            """, cancellationToken);
    }

    public async Task AppendLogAsync(IReadOnlyCollection<CalendarSyncLogEntry> entries, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(entries);
        if (entries.Count == 0)
        {
            return;
        }

        var rows = entries.ToArray();
        await database.Database.ExecuteSqlRawAsync(
            """
            INSERT INTO calendar_sync_log
                (tenant_id, id, link_id, principal_id, at, direction, action, item_id, external_event_id, detail)
            SELECT entry.tenant_id, entry.id, entry.link_id, entry.principal_id, entry.at, entry.direction,
                   entry.action, entry.item_id, entry.external_event_id, entry.detail
              FROM unnest(@tenant_ids, @ids, @link_ids, @principal_ids, @ats, @directions, @actions,
                          @item_ids, @external_ids, @details)
                   AS entry(tenant_id, id, link_id, principal_id, at, direction, action, item_id,
                            external_event_id, detail)
            """,
            [
                UuidArray("tenant_ids", rows.Select(row => (Guid?)row.TenantId.Value)),
                UuidArray("ids", rows.Select(row => (Guid?)row.Id)),
                UuidArray("link_ids", rows.Select(row => (Guid?)row.LinkId)),
                UuidArray("principal_ids", rows.Select(row => (Guid?)row.PrincipalId.Value)),
                NixParameter.TimestampArray("ats", rows.Select(row => row.At.ToUniversalTime()).ToArray()),
                TextArray("directions", rows.Select(row => row.Direction)),
                TextArray("actions", rows.Select(row => row.Action)),
                UuidArray("item_ids", rows.Select(row => row.ItemId)),
                TextArray("external_ids", rows.Select(row => row.ExternalEventId)),
                TextArray("details", rows.Select(row => CalendarSyncRules.Bound(row.Detail, CalendarSyncRules.MaxDetailLength))),
            ],
            cancellationToken).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<CalendarSyncLogEntry>> ReadLogAsync(
        Guid linkId, DateTimeOffset? beforeAt, Guid? beforeId, int limit, CancellationToken cancellationToken)
    {
        var bound = Math.Clamp(limit, 1, 100);
        var context = Context;
        IQueryable<CalendarSyncLogEntry> query = beforeAt is { } at && beforeId is { } id
            ? database.Set<CalendarSyncLogEntry>().FromSqlRaw(
                LogPageAfterSql,
                NixParameter.Uuid("tenant_id", context.TenantId.Value),
                NixParameter.Uuid("link_id", linkId),
                NixParameter.Timestamp("before_at", at.ToUniversalTime()),
                NixParameter.Uuid("before_id", id),
                NixParameter.Integer("limit", bound))
            : database.Set<CalendarSyncLogEntry>().FromSqlRaw(
                LogPageSql,
                NixParameter.Uuid("tenant_id", context.TenantId.Value),
                NixParameter.Uuid("link_id", linkId),
                NixParameter.Integer("limit", bound));
        var rows = await query.AsNoTracking().ToListAsync(cancellationToken).ConfigureAwait(false);
        return [.. rows.OrderByDescending(row => row.At).ThenByDescending(row => row.Id)];
    }

    public Task<CalendarEventMap?> FindMapByExternalAsync(Guid linkId, string externalEventId, CancellationToken cancellationToken) =>
        database.Set<CalendarEventMap>().AsNoTracking()
            .SingleOrDefaultAsync(row => row.LinkId == linkId && row.ExternalEventId == externalEventId, cancellationToken);

    public async Task<IReadOnlyList<CalendarEventMap>> FindMapsByExternalAsync(
        Guid linkId, IReadOnlyCollection<string> externalEventIds, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(externalEventIds);
        if (externalEventIds.Count == 0)
        {
            return [];
        }

        var ids = externalEventIds.ToArray();
        return await database.Set<CalendarEventMap>().AsNoTracking()
            .Where(row => row.LinkId == linkId && row.ExternalEventId != null && ids.Contains(row.ExternalEventId))
            .ToListAsync(cancellationToken).ConfigureAwait(false);
    }

    public Task<CalendarEventMap?> FindUnconfirmedCreateAsync(Guid linkId, Guid itemId, CancellationToken cancellationToken) =>
        database.Set<CalendarEventMap>().AsNoTracking()
            .SingleOrDefaultAsync(
                row => row.LinkId == linkId && row.ItemId == itemId && row.ExternalEventId == null && row.PushOp == "create" && row.DeletedAt == null,
                cancellationToken);

    public async Task<IReadOnlyList<CalendarEventMap>> FindMapsByItemsAsync(
        Guid linkId, IReadOnlyCollection<Guid> itemIds, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(itemIds);
        if (itemIds.Count == 0)
        {
            return [];
        }

        var ids = itemIds.ToArray();
        return await database.Set<CalendarEventMap>().AsNoTracking()
            .Where(row => row.LinkId == linkId && ids.Contains(row.ItemId))
            .ToListAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task<bool> SaveMapAsync(CalendarEventMap row, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(row);

        // Checked first rather than caught: a unique violation would abort the whole execution
        // transaction. Rounds of one link never overlap (the worker guard admits only the link's
        // last recorded job), so nothing else writes this link's map between the check and the
        // write.
        var clashes = await database.Database.SqlQuery<bool>($"""
            SELECT EXISTS (
                SELECT 1 FROM calendar_event_map other
                 WHERE other.tenant_id = {row.TenantId.Value}
                   AND other.link_id = {row.LinkId}
                   AND other.id <> {row.Id}
                   AND (other.item_id = {row.ItemId}
                        OR other.external_event_id = {row.ExternalEventId ?? string.Empty})) AS "Value"
            """).SingleAsync(cancellationToken).ConfigureAwait(false);
        if (clashes)
        {
            return false;
        }

        try
        {
            await UpsertMapAsync(row, cancellationToken).ConfigureAwait(false);
        }
        catch (PostgresException exception) when (exception.SqlState == PostgresErrorCodes.UniqueViolation)
        {
            throw new CalendarPairingConflictException("Another map row of the link already pairs this item or external event.", exception);
        }

        // A paired event is removed at its source or by unlinking, never from the workspace, so it
        // is marked managed and protected the moment it is paired - pulled or pushed alike.
        if (row.DeletedAt is null)
        {
            await database.Database.ExecuteSqlInterpolatedAsync($"""
                UPDATE item
                   SET managed_by = {ItemManagers.CalendarEvent}, no_delete = true
                 WHERE tenant_id = {row.TenantId.Value} AND id = {row.ItemId} AND managed_by IS NULL
                """, cancellationToken).ConfigureAwait(false);
        }
        else
        {
            // A pairing that has ended (the event was cancelled at its source) hands the item
            // back: restored from the trash it is an ordinary note, not one nothing can remove.
            await database.Database.ExecuteSqlInterpolatedAsync($"""
                UPDATE item
                   SET managed_by = NULL, no_delete = false
                 WHERE tenant_id = {row.TenantId.Value} AND id = {row.ItemId}
                   AND managed_by = {ItemManagers.CalendarEvent}
                """, cancellationToken).ConfigureAwait(false);
        }

        return true;
    }

    private Task<int> UpsertMapAsync(CalendarEventMap row, CancellationToken cancellationToken) =>
        database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO calendar_event_map
                (tenant_id, id, link_id, principal_id, item_id, external_event_id, external_version,
                 external_updated_at, nix_version, last_synced_hash, push_nix_version, push_hash, push_op,
                 push_failures, seen_execution, deleted_at, created_at, updated_at)
            VALUES ({row.TenantId.Value}, {row.Id}, {row.LinkId}, {row.PrincipalId.Value}, {row.ItemId},
                    {row.ExternalEventId}, {row.ExternalVersion}, {row.ExternalUpdatedAt}, {row.NixVersion},
                    {row.LastSyncedHash}, {row.PushNixVersion}, {row.PushHash}, {row.PushOp}, {row.PushFailures},
                    {row.SeenExecution}, {row.DeletedAt}, {row.CreatedAt}, {row.UpdatedAt})
            ON CONFLICT (tenant_id, id) DO UPDATE SET
                item_id = EXCLUDED.item_id,
                external_event_id = EXCLUDED.external_event_id,
                external_version = EXCLUDED.external_version,
                external_updated_at = EXCLUDED.external_updated_at,
                nix_version = EXCLUDED.nix_version,
                last_synced_hash = EXCLUDED.last_synced_hash,
                push_nix_version = EXCLUDED.push_nix_version,
                push_hash = EXCLUDED.push_hash,
                push_op = EXCLUDED.push_op,
                push_failures = EXCLUDED.push_failures,
                seen_execution = EXCLUDED.seen_execution,
                deleted_at = EXCLUDED.deleted_at,
                updated_at = EXCLUDED.updated_at
            """, cancellationToken);

    public async Task<IReadOnlyList<CalendarPushCandidate>> SelectPushCandidatesAsync(
        CalendarLink link, int limit, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(link);
        var bound = Math.Clamp(limit, 1, 500);

        var rows = await database.Database.SqlQueryRaw<PushCandidateRow>(
            PushCandidatesSql,
            NixParameter.Uuid("tenant_id", link.TenantId.Value),
            NixParameter.Uuid("workspace_id", link.WorkspaceId.Value),
            NixParameter.Uuid("link_id", link.Id),
            NixParameter.Uuid("container_id", link.ContainerItemId.Value),
            NixParameter.Integer("limit", bound))
            .ToListAsync(cancellationToken).ConfigureAwait(false);

        var mapIds = rows.Where(row => row.MapId is not null).Select(row => row.MapId!.Value).ToArray();
        var maps = mapIds.Length == 0
            ? []
            : await database.Set<CalendarEventMap>().AsNoTracking()
                .Where(row => row.LinkId == link.Id && mapIds.Contains(row.Id))
                .ToDictionaryAsync(row => row.Id, cancellationToken).ConfigureAwait(false);

        return [.. rows.Select(row => new CalendarPushCandidate(
            row.MapId is { } mapId && maps.TryGetValue(mapId, out var map) ? map : null,
            row.ItemId,
            row.Properties,
            row.LastModifiedAt,
            row.Live))];
    }

    public async Task<CalendarMappedStarts> ListMappedStartsAsync(CalendarLink link, int limit, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(link);
        var bound = Math.Clamp(limit, 1, 100_000);
        var rows = await database.Database.SqlQueryRaw<MappedStartRow>(
            MappedStartsSql,
            NixParameter.Uuid("tenant_id", link.TenantId.Value),
            NixParameter.Uuid("link_id", link.Id),
            NixParameter.Uuid("container_id", link.ContainerItemId.Value),
            NixParameter.Uuid("workspace_id", link.WorkspaceId.Value),
            NixParameter.Integer("limit", bound + 1))
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        return new CalendarMappedStarts(
            [.. rows.Take(bound).Select(row => new CalendarMappedStart(row.ToMap(), row.Start, row.ItemActive))],
            rows.Count > bound);
    }

    public Task SetSyncMarkerAsync(Guid? linkId, CancellationToken cancellationToken)
    {
        var value = linkId is { } id ? id.ToString("D", System.Globalization.CultureInfo.InvariantCulture) : string.Empty;
        return database.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT set_config('nix.calendar_sync_link', {value}, true)", cancellationToken);
    }

    private Task<int> CancelTriggersAsync(NixSessionContext context, Guid linkId, CancellationToken cancellationToken) =>
        database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE scheduled_trigger
               SET status = 'cancelled', updated_at = {DateTimeOffset.UtcNow}
             WHERE tenant_id = {context.TenantId.Value}
               AND principal_id = {context.PrincipalId.Value}
               AND kind = 'calendar'
               AND rule_id = {linkId}
               AND status = 'pending'
            """, cancellationToken);

    private static NpgsqlParameter<Guid?[]> UuidArray(string name, IEnumerable<Guid?> values) =>
        new(name, NpgsqlDbType.Array | NpgsqlDbType.Uuid) { TypedValue = values.ToArray() };

    private static NpgsqlParameter<string?[]> TextArray(string name, IEnumerable<string?> values) =>
        new(name, NpgsqlDbType.Array | NpgsqlDbType.Text) { TypedValue = values.ToArray() };

    [System.Diagnostics.CodeAnalysis.SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes", Justification = "EF Core materialises SqlQuery rows through reflection.")]
    private sealed record PushCandidateRow(Guid? MapId, Guid ItemId, string? Properties, DateTimeOffset? LastModifiedAt, bool Live);

#pragma warning disable CA1819 // Justification: the hashes are opaque bytea values copied straight into the map row.
    [System.Diagnostics.CodeAnalysis.SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes", Justification = "EF Core materialises SqlQuery rows through reflection.")]
    private sealed record MappedStartRow(
        Guid TenantId,
        Guid Id,
        Guid LinkId,
        Guid PrincipalId,
        Guid ItemId,
        string? ExternalEventId,
        string? ExternalVersion,
        DateTimeOffset? ExternalUpdatedAt,
        DateTimeOffset? NixVersion,
        byte[]? LastSyncedHash,
        DateTimeOffset? PushNixVersion,
        byte[]? PushHash,
        string? PushOp,
        short PushFailures,
        string? SeenExecution,
        DateTimeOffset? DeletedAt,
        DateTimeOffset CreatedAt,
        DateTimeOffset UpdatedAt,
        string? Start,
        bool ItemActive)
    {
        internal CalendarEventMap ToMap() => new()
        {
            TenantId = Nix.Domain.Tenancy.TenantId.From(TenantId),
            Id = Id,
            LinkId = LinkId,
            PrincipalId = Nix.Domain.Identity.PrincipalId.From(PrincipalId),
            ItemId = ItemId,
            ExternalEventId = ExternalEventId,
            ExternalVersion = ExternalVersion,
            ExternalUpdatedAt = ExternalUpdatedAt,
            NixVersion = NixVersion,
            LastSyncedHash = LastSyncedHash,
            PushNixVersion = PushNixVersion,
            PushHash = PushHash,
            PushOp = PushOp,
            PushFailures = PushFailures,
            SeenExecution = SeenExecution,
            DeletedAt = DeletedAt,
            CreatedAt = CreatedAt,
            UpdatedAt = UpdatedAt,
        };
    }
#pragma warning restore CA1819
}

/// <summary>
/// Calls <c>nix_find_active_calendar_links</c> directly against the pool, exactly like the
/// automation and reminder finders: no session is established, and the function crosses row
/// security only because the migrator role owns it.
/// </summary>
public sealed class CalendarLinkFinder(NpgsqlDataSource dataSource) : ICalendarLinkFinder
{
    private readonly PooledSql _db = new(dataSource);

    public async Task<IReadOnlyList<ActiveCalendarLink>> FindActiveAsync(int limit, Guid afterId, CancellationToken cancellationToken)
    {
        if (limit is < 1 or > 500)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }

        return await _db.RowsAsync(
            "SELECT * FROM nix_find_active_calendar_links(@limit, @after_id)",
            static reader => new ActiveCalendarLink(
                TenantId.From(reader.GetGuid(0)),
                reader.GetGuid(1),
                WorkspaceId.From(reader.GetGuid(2)),
                PrincipalId.From(reader.GetGuid(3)),
                reader.GetGuid(4)),
            cancellationToken,
            NixParameter.Integer("limit", limit),
            NixParameter.Uuid("after_id", afterId)).ConfigureAwait(false);
    }
}
