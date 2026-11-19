using System.Diagnostics.CodeAnalysis;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions.Linear;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Linear;

public sealed partial class LinearStore
{
    public async Task<LinearItemLink?> FindLinkAsync(WorkspaceId workspaceId, ItemId itemId, CancellationToken cancellationToken)
    {
        var row = await database.Database.SqlQuery<LinkRow>($"""
            SELECT connection_id AS "ConnectionId", connection_revision AS "ConnectionRevision",
                   revision AS "Revision", issue_id AS "IssueId", identifier AS "Identifier",
                   url AS "Url", status_id AS "StatusId", status AS "Status",
                   remote_updated_at AS "RemoteUpdatedAt", checked_at AS "CheckedAt",
                   baseline_status_id AS "BaselineStatusId", baseline_local_status AS "BaselineLocalStatus"
              FROM linear_item_link
             WHERE workspace_id = {workspaceId.Value} AND item_id = {itemId.Value}
            """).SingleOrDefaultAsync(cancellationToken).ConfigureAwait(false);
        return row is null ? null : new LinearItemLink(
            itemId, workspaceId, row.ConnectionId, row.ConnectionRevision, row.Revision, row.IssueId,
            row.Identifier, new Uri(row.Url, UriKind.Absolute), row.StatusId, row.Status, row.RemoteUpdatedAt, row.CheckedAt,
            row.BaselineStatusId, row.BaselineLocalStatus);
    }

    public async Task<bool> CreateLinkAsync(LinearItemLink link, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(link);
        return await database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO linear_item_link (
                tenant_id, workspace_id, item_id, owner_id, connection_id, connection_revision, revision,
                issue_id, identifier, url, status_id, status, remote_updated_at, checked_at,
                baseline_status_id, baseline_local_status)
            SELECT c.tenant_id, c.workspace_id, i.id, c.owner_id, c.id, c.revision, {link.Revision},
                   {link.IssueId}, {link.Identifier}, {link.Url.AbsoluteUri}, {link.StatusId}, {link.Status},
                   {link.RemoteUpdatedAt}, {link.CheckedAt}, {link.BaselineStatusId}, {link.BaselineLocalStatus}
              FROM pet_connector_grant c
              JOIN item i ON i.tenant_id = c.tenant_id AND i.workspace_id = c.workspace_id
             WHERE c.id = {link.ConnectionId} AND c.revision = {link.ConnectionRevision}
               AND c.workspace_id = {link.WorkspaceId.Value} AND c.protected_tokens IS NOT NULL
               AND c.provider = 'linear' AND c.resource_kind = 'team' AND 'linear.read_issue' = ANY(c.actions)
               AND i.id = {link.ItemId.Value} AND i.lifecycle_state = 'active'
            ON CONFLICT DO NOTHING
            """, cancellationToken).ConfigureAwait(false) == 1;
    }

    public async Task<bool> UpdateLinkAsync(LinearItemLink link, Guid expectedRevision, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(link);
        return await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE linear_item_link l
               SET revision = {link.Revision}, identifier = {link.Identifier}, url = {link.Url.AbsoluteUri},
                   status_id = {link.StatusId}, status = {link.Status}, checked_at = {link.CheckedAt},
                   remote_updated_at = {link.RemoteUpdatedAt}, baseline_status_id = {link.BaselineStatusId},
                   baseline_local_status = {link.BaselineLocalStatus}
              FROM pet_connector_grant c, item i
             WHERE l.workspace_id = {link.WorkspaceId.Value} AND l.item_id = {link.ItemId.Value}
               AND l.revision = {expectedRevision} AND l.issue_id = {link.IssueId}
               AND c.id = l.connection_id AND c.revision = l.connection_revision AND c.protected_tokens IS NOT NULL
               AND 'linear.read_issue' = ANY(c.actions)
               AND i.id = l.item_id AND i.tenant_id = l.tenant_id AND i.workspace_id = l.workspace_id
               AND i.lifecycle_state = 'active'
            """, cancellationToken).ConfigureAwait(false) == 1;
    }

    public async Task<bool> LockLinkItemAsync(
        WorkspaceId workspaceId, ItemId itemId, Guid revision, CancellationToken cancellationToken)
    {
        var rows = await database.Database.SqlQuery<int>($"""
            SELECT 1 AS "Value"
              FROM linear_item_link l
              JOIN item i ON i.id = l.item_id AND i.tenant_id = l.tenant_id AND i.workspace_id = l.workspace_id
              JOIN pet_connector_grant c ON c.id = l.connection_id AND c.revision = l.connection_revision
             WHERE l.workspace_id = {workspaceId.Value} AND l.item_id = {itemId.Value} AND l.revision = {revision}
               AND c.protected_tokens IS NOT NULL AND 'linear.read_issue' = ANY(c.actions) AND i.lifecycle_state = 'active'
             FOR UPDATE OF l, i, c
            """).ToListAsync(cancellationToken).ConfigureAwait(false);
        return rows.Count == 1;
    }

    public async Task<bool> DeleteLinkAsync(
        WorkspaceId workspaceId, ItemId itemId, Guid expectedRevision, CancellationToken cancellationToken) =>
        await database.Database.ExecuteSqlInterpolatedAsync($"""
            DELETE FROM linear_item_link
             WHERE workspace_id = {workspaceId.Value} AND item_id = {itemId.Value} AND revision = {expectedRevision}
            """, cancellationToken).ConfigureAwait(false) == 1;

    [SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes", Justification = "EF Core materialises SqlQuery rows through reflection.")]
    private sealed record LinkRow(
        Guid ConnectionId, Guid ConnectionRevision, Guid Revision, Guid IssueId, string Identifier, string Url,
        Guid StatusId, string Status, DateTimeOffset RemoteUpdatedAt, DateTimeOffset CheckedAt,
        Guid BaselineStatusId, string? BaselineLocalStatus);
}
