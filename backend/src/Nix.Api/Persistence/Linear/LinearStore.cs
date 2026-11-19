using System.Diagnostics.CodeAnalysis;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.Linear;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Linear;

/// <inheritdoc />
public sealed partial class LinearStore(NixDbContext database, INixSessionContextAccessor session, TimeProvider clock) : ILinearStore
{
    private NixSessionContext Context => session.Current ?? throw new InvalidOperationException("A tenant unit of work is required.");

    public Task<LinearConnection?> FindConnectionAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
        ReadConnectionAsync($"""
            SELECT id AS "Id", workspace_id AS "WorkspaceId", owner_id AS "OwnerId",
                   revision AS "Revision", protected_oauth_state AS "ProtectedOAuthState"
              FROM linear_connection
             WHERE workspace_id = {workspaceId.Value}
            """, cancellationToken);

    public Task<LinearConnection?> LockConnectionAsync(Guid connectionId, CancellationToken cancellationToken) =>
        ReadConnectionAsync($"""
            SELECT id AS "Id", workspace_id AS "WorkspaceId", owner_id AS "OwnerId",
                   revision AS "Revision", protected_oauth_state AS "ProtectedOAuthState"
              FROM linear_connection
             WHERE id = {connectionId}
             FOR UPDATE
            """, cancellationToken);

    public async Task<bool> BeginOAuthAsync(
        WorkspaceId workspaceId, string stateHash, string protectedOAuthState, DateTimeOffset expiresAt,
        CancellationToken cancellationToken)
    {
        var context = Context;
        return await database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO linear_connection
                (id, tenant_id, workspace_id, owner_id, oauth_attempt_hash, protected_pending_oauth, oauth_expires_at)
            VALUES ({Guid.CreateVersion7()}, {context.TenantId.Value}, {workspaceId.Value}, {context.PrincipalId.Value},
                    {stateHash}, {protectedOAuthState}, {expiresAt})
            ON CONFLICT (tenant_id, workspace_id, owner_id) DO UPDATE SET
                oauth_attempt_hash = EXCLUDED.oauth_attempt_hash,
                protected_pending_oauth = EXCLUDED.protected_pending_oauth,
                oauth_expires_at = EXCLUDED.oauth_expires_at
            """, cancellationToken).ConfigureAwait(false) == 1;
    }

    public async Task<LinearOAuthAttempt?> ConsumeOAuthAsync(string stateHash, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var rows = await database.Database.SqlQuery<OAuthAttemptRow>($"""
            WITH pending AS MATERIALIZED (
                SELECT id, workspace_id, revision, protected_pending_oauth
                  FROM linear_connection
                 WHERE oauth_attempt_hash = {stateHash} AND oauth_expires_at > {now}
                 FOR UPDATE
            )
            UPDATE linear_connection c
               SET protected_pending_oauth = NULL, oauth_expires_at = NULL
              FROM pending p
             WHERE c.id = p.id
            RETURNING p.id AS "Id", p.workspace_id AS "WorkspaceId", p.revision AS "Revision",
                      p.protected_pending_oauth AS "ProtectedOAuthState"
            """).ToListAsync(cancellationToken).ConfigureAwait(false);
        return rows.SingleOrDefault() is { } row
            ? new LinearOAuthAttempt(row.Id, WorkspaceId.From(row.WorkspaceId), row.Revision, row.ProtectedOAuthState, stateHash)
            : null;
    }

    public async Task<bool> CompleteOAuthAsync(LinearOAuthAttempt attempt, string protectedOAuthState, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(attempt);
        return await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE linear_connection
               SET protected_oauth_state = {protectedOAuthState}, revision = revision + 1, oauth_attempt_hash = NULL
             WHERE id = {attempt.ConnectionId} AND revision = {attempt.Revision}
               AND oauth_attempt_hash = {attempt.StateHash} AND protected_pending_oauth IS NULL
            """, cancellationToken).ConfigureAwait(false) == 1;
    }

    public async Task<bool> SaveOAuthAsync(Guid connectionId, long revision, string protectedOAuthState, CancellationToken cancellationToken) =>
        await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE linear_connection
               SET protected_oauth_state = {protectedOAuthState}
             WHERE id = {connectionId} AND revision = {revision} AND protected_oauth_state IS NOT NULL
            """, cancellationToken).ConfigureAwait(false) == 1;

    public async Task<bool> DisconnectAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
        await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE linear_connection
               SET protected_oauth_state = NULL, revision = revision + 1, oauth_attempt_hash = NULL,
                   protected_pending_oauth = NULL, oauth_expires_at = NULL
             WHERE workspace_id = {workspaceId.Value}
               AND (protected_oauth_state IS NOT NULL OR oauth_attempt_hash IS NOT NULL)
            """, cancellationToken).ConfigureAwait(false) == 1;

    public async Task<bool> CreateRequestAsync(LinearTaskRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var petName = request.PetName?.Trim();
        if (request.CommentId.HasValue
            || request.PetId.HasValue != (petName is not null)
            || (request.PetId.HasValue && (request.PetId == Guid.Empty || request.RequesterTokenId.HasValue
                || petName is not { Length: > 0 and <= 80 })))
        {
            return false;
        }

        return await database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO linear_task_request
                (id, tenant_id, workspace_id, item_id, connection_id, connection_revision, requester_id,
                 requester_token_id, issue_id, status, created_at, expires_at, pet_id, pet_name)
            SELECT {request.Id}, c.tenant_id, c.workspace_id, i.id, c.id, c.revision, c.owner_id,
                   {request.RequesterTokenId}, {request.IssueId}, 'pending', {request.CreatedAt}, {request.ExpiresAt},
                   {request.PetId}, {petName}
              FROM linear_connection c
              JOIN item i ON i.tenant_id = c.tenant_id AND i.workspace_id = c.workspace_id
             WHERE c.id = {request.ConnectionId} AND c.revision = {request.ConnectionRevision}
               AND c.protected_oauth_state IS NOT NULL AND c.owner_id = {request.RequesterId.Value}
               AND i.id = {request.ItemId.Value} AND i.lifecycle_state = 'active'
            ON CONFLICT (id) DO NOTHING
            """, cancellationToken).ConfigureAwait(false) == 1;
    }

    public async Task<LinearTaskRequest?> FindRequestAsync(ItemId itemId, Guid id, Guid? callerTokenId, CancellationToken cancellationToken)
    {
        var rows = await ReadRequestsAsync(itemId, id, callerTokenId, cancellationToken).ConfigureAwait(false);
        return rows.SingleOrDefault();
    }

    public Task<IReadOnlyList<LinearTaskRequest>> ListRequestsAsync(ItemId itemId, Guid? callerTokenId, CancellationToken cancellationToken) =>
        ReadRequestsAsync(itemId, id: null, callerTokenId, cancellationToken);

    public async Task<LinearTaskRequest?> DecideAsync(
        ItemId itemId, Guid id, bool approve, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var status = approve ? LinearRequestStatus.Running : LinearRequestStatus.Declined;
        var changed = await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE linear_task_request r
               SET status = {status}, approver_id = {Context.PrincipalId.Value}, decided_at = {now}
             WHERE r.id = {id} AND r.item_id = {itemId.Value} AND r.status = 'pending' AND r.expires_at > {now}
               AND EXISTS (
                   SELECT 1 FROM item i
                    WHERE i.tenant_id = r.tenant_id AND i.workspace_id = r.workspace_id
                      AND i.id = r.item_id AND i.lifecycle_state = 'active'
               )
               AND (NOT {approve} OR (
                   EXISTS (
                       SELECT 1 FROM linear_connection c
                        WHERE c.id = r.connection_id AND c.revision = r.connection_revision
                          AND c.protected_oauth_state IS NOT NULL
                   )
                   AND (r.requester_token_id IS NULL OR EXISTS (
                       SELECT 1 FROM personal_access_token p
                        WHERE p.tenant_id = r.tenant_id AND p.principal_id = r.requester_id
                          AND p.token_id = r.requester_token_id AND p.revoked_at IS NULL AND p.expires_at > {now}
                   ))
               ))
            """, cancellationToken).ConfigureAwait(false);
        return changed == 1
            ? await FindRequestAsync(itemId, id, callerTokenId: null, cancellationToken).ConfigureAwait(false)
            : null;
    }

    public async Task<bool> FinishAsync(
        Guid id, string status, string? resultJson, CancellationToken cancellationToken, Guid? commentId = null)
    {
        if (status is not (LinearRequestStatus.Succeeded or LinearRequestStatus.Failed or LinearRequestStatus.Unknown))
        {
            throw new ArgumentOutOfRangeException(nameof(status));
        }

        if (commentId == Guid.Empty || (commentId.HasValue && status != LinearRequestStatus.Succeeded))
        {
            return false;
        }

        return await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE linear_task_request r
               SET status = {status}, result_json = CAST({resultJson} AS jsonb), comment_id = {commentId}
             WHERE r.id = {id} AND r.status = 'running'
               AND (CAST({commentId} AS uuid) IS NULL OR r.pet_id IS NOT NULL)
               AND ({status} <> 'succeeded' OR EXISTS (
                   SELECT 1 FROM linear_connection c
                    WHERE c.id = r.connection_id AND c.revision = r.connection_revision
                      AND c.protected_oauth_state IS NOT NULL
               ))
            """, cancellationToken).ConfigureAwait(false) == 1;
    }

    private async Task<LinearConnection?> ReadConnectionAsync(FormattableString query, CancellationToken cancellationToken)
    {
        var rows = await database.Database.SqlQuery<ConnectionRow>(query).ToListAsync(cancellationToken).ConfigureAwait(false);
        return rows.SingleOrDefault() is { } row
            ? new LinearConnection(row.Id, WorkspaceId.From(row.WorkspaceId), PrincipalId.From(row.OwnerId), row.Revision, row.ProtectedOAuthState)
            : null;
    }

    private async Task<IReadOnlyList<LinearTaskRequest>> ReadRequestsAsync(
        ItemId itemId, Guid? id, Guid? callerTokenId, CancellationToken cancellationToken)
    {
        var now = clock.GetUtcNow();
        var interruptedBefore = now.AddMinutes(-2);
        var rows = await database.Database.SqlQuery<RequestRow>($"""
            SELECT r.id AS "Id", r.item_id AS "ItemId", r.connection_id AS "ConnectionId",
                   r.connection_revision AS "ConnectionRevision", r.requester_id AS "RequesterId",
                   r.requester_token_id AS "RequesterTokenId", r.issue_id AS "IssueId",
                   CASE
                       WHEN r.status = 'pending' AND (r.expires_at <= {now}
                           OR c.revision <> r.connection_revision OR c.protected_oauth_state IS NULL) THEN 'expired'
                       WHEN r.status = 'running' AND r.decided_at <= {interruptedBefore} THEN 'unknown'
                       ELSE r.status
                   END AS "Status",
                   r.created_at AS "CreatedAt", r.expires_at AS "ExpiresAt",
                   r.approver_id AS "ApproverId",
                   CASE WHEN c.revision = r.connection_revision AND c.protected_oauth_state IS NOT NULL
                        THEN r.result_json::text END AS "ResultJson",
                   r.pet_id AS "PetId", r.pet_name AS "PetName", r.comment_id AS "CommentId"
              FROM linear_task_request r
              JOIN linear_connection c ON c.id = r.connection_id
              JOIN item i ON i.tenant_id = r.tenant_id AND i.workspace_id = r.workspace_id AND i.id = r.item_id
             WHERE r.item_id = {itemId.Value} AND i.lifecycle_state = 'active'
               AND (CAST({id} AS uuid) IS NULL OR r.id = {id})
               AND (CAST({callerTokenId} AS uuid) IS NULL OR r.requester_token_id = {callerTokenId})
             ORDER BY r.created_at DESC, r.id DESC
             LIMIT 50
            """).ToListAsync(cancellationToken).ConfigureAwait(false);
        return rows.ConvertAll(row => new LinearTaskRequest(
            row.Id, ItemId.From(row.ItemId), row.ConnectionId, row.ConnectionRevision, PrincipalId.From(row.RequesterId),
            row.RequesterTokenId, row.IssueId, row.Status, row.CreatedAt, row.ExpiresAt,
            row.ApproverId is Guid approverId ? PrincipalId.From(approverId) : null, row.ResultJson,
            row.PetId, row.PetName, row.CommentId));
    }

    [SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes", Justification = "EF Core materialises SqlQuery rows through reflection.")]
    private sealed record ConnectionRow(Guid Id, Guid WorkspaceId, Guid OwnerId, long Revision, string? ProtectedOAuthState);

    [SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes", Justification = "EF Core materialises SqlQuery rows through reflection.")]
    private sealed record OAuthAttemptRow(Guid Id, Guid WorkspaceId, long Revision, string ProtectedOAuthState);

    [SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes", Justification = "EF Core materialises SqlQuery rows through reflection.")]
    private sealed record RequestRow(
        Guid Id, Guid ItemId, Guid ConnectionId, long ConnectionRevision, Guid RequesterId, Guid? RequesterTokenId,
        string IssueId, string Status, DateTimeOffset CreatedAt, DateTimeOffset ExpiresAt, Guid? ApproverId, string? ResultJson,
        Guid? PetId, string? PetName, Guid? CommentId);
}
