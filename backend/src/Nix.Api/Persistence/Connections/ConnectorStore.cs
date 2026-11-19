using System.Diagnostics.CodeAnalysis;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.Connections;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Connections;

/// <inheritdoc />
public sealed class ConnectorStore(NixDbContext database, INixSessionContextAccessor session) : IConnectorStore
{
    private NixSessionContext Context => session.Current ?? throw new InvalidOperationException("A tenant unit of work is required.");

    public async Task<IReadOnlyList<ConnectorGrant>> ListAsync(WorkspaceId workspace, CancellationToken cancellationToken)
    {
        var rows = await database.Database.SqlQuery<GrantRow>($"""
            SELECT id AS "Id", workspace_id AS "WorkspaceId", revision AS "Revision",
                   provider AS "Provider", resource_kind AS "ResourceKind", resource_id AS "ResourceId",
                   actions AS "Actions", NULL::text AS "ProtectedTokens"
              FROM pet_connector_grant
             WHERE workspace_id = {workspace.Value} AND protected_tokens IS NOT NULL
             ORDER BY provider, resource_kind, resource_id, id
            """).ToListAsync(cancellationToken).ConfigureAwait(false);
        return rows.ConvertAll(ToGrant);
    }

    public async Task<ConnectorGrant?> GetAsync(WorkspaceId workspace, Guid id, bool lockForUpdate, CancellationToken cancellationToken)
    {
        FormattableString query = lockForUpdate
            ? (FormattableString)$"""
                SELECT id AS "Id", workspace_id AS "WorkspaceId", revision AS "Revision",
                       provider AS "Provider", resource_kind AS "ResourceKind", resource_id AS "ResourceId",
                       actions AS "Actions", protected_tokens AS "ProtectedTokens"
                  FROM pet_connector_grant
                 WHERE workspace_id = {workspace.Value} AND id = {id}
                 FOR UPDATE
                """
            : (FormattableString)$"""
                SELECT id AS "Id", workspace_id AS "WorkspaceId", revision AS "Revision",
                       provider AS "Provider", resource_kind AS "ResourceKind", resource_id AS "ResourceId",
                       actions AS "Actions", protected_tokens AS "ProtectedTokens"
                  FROM pet_connector_grant
                 WHERE workspace_id = {workspace.Value} AND id = {id}
                """;
        var rows = await database.Database.SqlQuery<GrantRow>(query).ToListAsync(cancellationToken).ConfigureAwait(false);
        return rows.SingleOrDefault() is { } row ? ToGrant(row) : null;
    }

    public async Task<bool> BeginOAuthAsync(WorkspaceId workspace, string provider, string resourceKind, string resourceId,
        string stateHash, string protectedState, DateTimeOffset expiresAt, CancellationToken cancellationToken)
    {
        var context = Context;
        return await database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO pet_connector_grant
                (id, tenant_id, workspace_id, owner_id, revision, provider, resource_kind, resource_id,
                 state_hash, protected_pending, pending_expires_at)
            VALUES ({Guid.CreateVersion7()}, {context.TenantId.Value}, {workspace.Value}, {context.PrincipalId.Value},
                    {Guid.CreateVersion7()}, {provider}, {resourceKind}, {resourceId}, {stateHash}, {protectedState}, {expiresAt})
            ON CONFLICT (tenant_id, workspace_id, owner_id, provider, resource_kind, resource_id) DO UPDATE
               SET state_hash = EXCLUDED.state_hash, protected_pending = EXCLUDED.protected_pending,
                   pending_expires_at = EXCLUDED.pending_expires_at
            """, cancellationToken).ConfigureAwait(false) == 1;
    }

    public async Task<ConnectorPending?> ConsumeOAuthAsync(string stateHash, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var rows = await database.Database.SqlQuery<PendingRow>($"""
            WITH pending AS MATERIALIZED (
                SELECT id, workspace_id, revision, provider, protected_pending
                  FROM pet_connector_grant
                 WHERE state_hash = {stateHash} AND pending_expires_at > {now}
                 FOR UPDATE
            )
            UPDATE pet_connector_grant c
               SET protected_pending = NULL, pending_expires_at = NULL
              FROM pending p
             WHERE c.id = p.id
            RETURNING p.id AS "Id", p.workspace_id AS "WorkspaceId", p.revision AS "Revision",
                      p.provider AS "Provider", p.protected_pending AS "ProtectedState"
            """).ToListAsync(cancellationToken).ConfigureAwait(false);
        return rows.SingleOrDefault() is { } row
            ? new ConnectorPending(row.Id, WorkspaceId.From(row.WorkspaceId), row.Revision, row.Provider, row.ProtectedState, stateHash)
            : null;
    }

    public async Task<bool> CompleteOAuthAsync(ConnectorPending attempt, string[] actions, string protectedTokens, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(attempt);
        return await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE pet_connector_grant
               SET protected_tokens = {protectedTokens}, actions = {actions}, revision = {Guid.CreateVersion7()}, state_hash = NULL
             WHERE id = {attempt.ConnectionId} AND workspace_id = {attempt.WorkspaceId.Value}
               AND revision = {attempt.Revision} AND state_hash = {attempt.StateHash} AND protected_pending IS NULL
            """, cancellationToken).ConfigureAwait(false) == 1;
    }

    public async Task<bool> SaveTokensAsync(Guid id, Guid revision, string protectedTokens, CancellationToken cancellationToken) =>
        await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE pet_connector_grant SET protected_tokens = {protectedTokens}
             WHERE id = {id} AND revision = {revision} AND protected_tokens IS NOT NULL
            """, cancellationToken).ConfigureAwait(false) == 1;

    public async Task<bool> SaveScopedAsync(WorkspaceId workspace, string provider, string resourceKind, string resourceId,
        string[] actions, string protectedTokens, CancellationToken cancellationToken)
    {
        var context = Context;
        return await database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO pet_connector_grant
                (id, tenant_id, workspace_id, owner_id, revision, provider, resource_kind, resource_id, actions, protected_tokens)
            VALUES ({Guid.CreateVersion7()}, {context.TenantId.Value}, {workspace.Value}, {context.PrincipalId.Value},
                    {Guid.CreateVersion7()}, {provider}, {resourceKind}, {resourceId}, {actions}, {protectedTokens})
            ON CONFLICT (tenant_id, workspace_id, owner_id, provider, resource_kind, resource_id) DO UPDATE
               SET revision = EXCLUDED.revision, protected_tokens = EXCLUDED.protected_tokens, actions = EXCLUDED.actions,
                   state_hash = NULL, protected_pending = NULL, pending_expires_at = NULL
            """, cancellationToken).ConfigureAwait(false) == 1;
    }

    public async Task<bool> DisconnectAsync(WorkspaceId workspace, Guid id, CancellationToken cancellationToken) =>
        await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE pet_connector_grant
               SET protected_tokens = NULL, revision = {Guid.CreateVersion7()}, actions = ARRAY[]::text[],
                   state_hash = NULL, protected_pending = NULL, pending_expires_at = NULL
             WHERE workspace_id = {workspace.Value} AND id = {id}
               AND (protected_tokens IS NOT NULL OR state_hash IS NOT NULL)
            """, cancellationToken).ConfigureAwait(false) == 1;

    private static ConnectorGrant ToGrant(GrantRow row) => new(row.Id, WorkspaceId.From(row.WorkspaceId), row.Revision,
        row.Provider, row.ResourceKind, row.ResourceId, row.Actions, row.ProtectedTokens);

    [SuppressMessage("Performance", "CA1812", Justification = "Materialized by the EF SQL query.")]
    private sealed record GrantRow(Guid Id, Guid WorkspaceId, Guid Revision, string Provider, string ResourceKind,
        string ResourceId, string[] Actions, string? ProtectedTokens);

    [SuppressMessage("Performance", "CA1812", Justification = "Materialized by the EF SQL query.")]
    private sealed record PendingRow(Guid Id, Guid WorkspaceId, Guid Revision, string Provider, string ProtectedState);
}
