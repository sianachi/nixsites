using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.PetPeers;

namespace Nix.Persistence.PetPeers;

/// <inheritdoc />
public sealed class PetPeerStore(NixDbContext database, INixSessionContextAccessor session) : IPetPeerStore
{
    private NixSessionContext Context => session.Current ?? throw new InvalidOperationException("A tenant unit of work is required.");

    public async Task InsertAsync(PetPeerRegistration peer, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(peer);
        await database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO pet_peer (id, tenant_id, owner_id, workspace_id, item_id, pet_id, name, kind, expires_at)
            VALUES ({peer.Id}, {Context.TenantId.Value}, {Context.PrincipalId.Value}, {peer.WorkspaceId},
                    {peer.ItemId}, {peer.PetId}, {peer.Name}, {peer.Kind}, {peer.ExpiresAt})
            """, cancellationToken).ConfigureAwait(false);
    }

    public async Task<PetPeerRegistration?> GetAsync(Guid peerId, bool lockGrant, CancellationToken cancellationToken)
    {
        var peers = await ReadPeersAsync(peerId, itemId: null, lockGrant, cancellationToken).ConfigureAwait(false);
        return peers.SingleOrDefault();
    }

    public Task<IReadOnlyList<PetPeerRegistration>> ListAsync(Guid itemId, CancellationToken cancellationToken) =>
        ReadPeersAsync(peerId: null, itemId, lockGrant: false, cancellationToken);

    public async Task<bool> RevokeAsync(Guid itemId, Guid peerId, DateTimeOffset now, CancellationToken cancellationToken) =>
        await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE pet_peer SET revoked_at = {now}
             WHERE id = {peerId} AND item_id = {itemId} AND revoked_at IS NULL
            """, cancellationToken).ConfigureAwait(false) == 1;

    public async Task<bool> SaveWorkAsync(PetPeerWork work, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(work);
        return await database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO pet_peer_work (id, peer_id, tenant_id, workspace_id, owner_id, run_id,
                                       direction, status, brief, created_at)
            SELECT {work.Id}, p.id, p.tenant_id, p.workspace_id, p.owner_id,
                   {work.RunId}, {work.Direction}, {work.Status}, {work.Brief}, {work.CreatedAt}
              FROM pet_peer p JOIN pet_run r
                ON r.id = {work.RunId} AND r.tenant_id = p.tenant_id AND r.workspace_id = p.workspace_id
                AND r.actor_id = p.owner_id AND r.item_id = p.item_id
             WHERE p.id = {work.PeerId} AND p.revoked_at IS NULL AND p.expires_at > {work.CreatedAt}
            ON CONFLICT (peer_id, id) DO NOTHING
            """, cancellationToken).ConfigureAwait(false) == 1;
    }

    public async Task<PetPeerWork?> GetWorkAsync(Guid peerId, Guid workId, CancellationToken cancellationToken)
    {
        var rows = await ReadWorkAsync(peerId, workId, runId: null, itemId: null, cancellationToken).ConfigureAwait(false);
        return rows.SingleOrDefault();
    }

    public async Task<PetPeerWork?> FindSubmissionAsync(Guid peerId, Guid runId, CancellationToken cancellationToken)
    {
        var rows = await ReadWorkAsync(peerId, workId: null, runId, itemId: null, cancellationToken).ConfigureAwait(false);
        return rows.SingleOrDefault();
    }

    public Task<IReadOnlyList<PetPeerWork>> ListWorkAsync(Guid itemId, CancellationToken cancellationToken) =>
        ReadWorkAsync(peerId: null, workId: null, runId: null, itemId, cancellationToken);

    public async Task<PetPeerWork?> ClaimAsync(Guid peerId, Guid leaseId, DateTimeOffset leaseExpiresAt, CancellationToken cancellationToken)
    {
        var claimed = await database.Database.SqlQuery<Guid>($"""
            WITH next AS MATERIALIZED (
                SELECT id FROM pet_peer_work
                 WHERE peer_id = {peerId} AND status = 'queued'
                 ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
            )
            UPDATE pet_peer_work work
               SET status = 'running', lease_id = {leaseId}, lease_expires_at = {leaseExpiresAt}
              FROM next WHERE work.peer_id = {peerId} AND work.id = next.id
            RETURNING work.id AS "Value"
            """).ToListAsync(cancellationToken).ConfigureAwait(false);
        return claimed.Count == 0
            ? null
            : await GetWorkAsync(peerId, claimed.Single(), cancellationToken).ConfigureAwait(false);
    }

    public async Task<bool> FinishAsync(Guid peerId, Guid workId, Guid leaseId, string status, string? result,
        DateTimeOffset now, CancellationToken cancellationToken) =>
        await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE pet_peer_work
               SET status = {status}, result = {result}, lease_id = NULL, lease_expires_at = NULL
             WHERE peer_id = {peerId} AND id = {workId} AND lease_id = {leaseId}
               AND status = 'running' AND lease_expires_at > {now}
            """, cancellationToken).ConfigureAwait(false) == 1;

    public async Task<bool> ShareResultAsync(Guid peerId, Guid runId, string result, CancellationToken cancellationToken) =>
        await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE pet_peer_work SET result = {result}
             WHERE peer_id = {peerId} AND run_id = {runId} AND direction = 'inbound' AND result IS NULL
            """, cancellationToken).ConfigureAwait(false) == 1;

    private async Task<IReadOnlyList<PetPeerRegistration>> ReadPeersAsync(
        Guid? peerId, Guid? itemId, bool lockGrant, CancellationToken cancellationToken)
    {
        if (lockGrant)
        {
            return await database.Database.SqlQuery<PetPeerRegistration>($"""
                SELECT id, pet_id AS "PetId", workspace_id AS "WorkspaceId", item_id AS "ItemId",
                       name, kind, expires_at AS "ExpiresAt", revoked_at AS "RevokedAt"
                  FROM pet_peer WHERE id = {peerId} FOR UPDATE
                """).ToListAsync(cancellationToken).ConfigureAwait(false);
        }
        return await database.Database.SqlQuery<PetPeerRegistration>($"""
            SELECT id, pet_id AS "PetId", workspace_id AS "WorkspaceId", item_id AS "ItemId",
                   name, kind, expires_at AS "ExpiresAt", revoked_at AS "RevokedAt"
              FROM pet_peer
             WHERE (CAST({peerId} AS uuid) IS NULL OR id = {peerId})
               AND (CAST({itemId} AS uuid) IS NULL OR item_id = {itemId})
             ORDER BY expires_at DESC, id LIMIT 200
            """).ToListAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task<IReadOnlyList<PetPeerWork>> ReadWorkAsync(
        Guid? peerId, Guid? workId, Guid? runId, Guid? itemId, CancellationToken cancellationToken) =>
        await database.Database.SqlQuery<PetPeerWork>($"""
            SELECT w.id, w.peer_id AS "PeerId", w.run_id AS "RunId", w.direction, w.status, w.brief, w.result,
                   w.lease_id AS "LeaseId", w.lease_expires_at AS "LeaseExpiresAt", w.created_at AS "CreatedAt"
              FROM pet_peer_work w JOIN pet_peer p ON p.id = w.peer_id
             WHERE (CAST({peerId} AS uuid) IS NULL OR w.peer_id = {peerId})
               AND (CAST({workId} AS uuid) IS NULL OR w.id = {workId})
               AND (CAST({runId} AS uuid) IS NULL OR (w.run_id = {runId} AND w.direction = 'inbound'))
               AND (CAST({itemId} AS uuid) IS NULL OR p.item_id = {itemId})
             ORDER BY w.created_at DESC, w.id LIMIT 200
            """).ToListAsync(cancellationToken).ConfigureAwait(false);
}
