using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Npgsql;

namespace Nix.Persistence.Workspaces;

/// <summary>An active workspace filtered by effective write permission during query evaluation.</summary>
public sealed record WorkspaceTransferDestination(WorkspaceId Id, string Name, DateTimeOffset CreatedAt);

public sealed partial class WorkspaceAdministrationStore
{
    public async ValueTask<IReadOnlyList<WorkspaceTransferDestination>> ListTransferDestinationsAsync(
        WorkspaceId source, DateTimeOffset? afterCreatedAt, WorkspaceId? afterId,
        int limit, CancellationToken cancellationToken)
    {
        var context = Session;
        var rows = new List<WorkspaceTransferDestination>(limit);
        const string statement = """
            SELECT w.workspace_id, w.name, w.created_at
            FROM workspace w
            WHERE w.tenant_id = @tenant_id AND w.lifecycle_state = 'active'
              AND w.workspace_id <> @source_workspace_id
              AND (@after_created_at IS NULL OR (w.created_at, w.workspace_id) < (@after_created_at, @after_id))
              AND (EXISTS (
                  SELECT 1 FROM workspace_member m
                  WHERE m.tenant_id = w.tenant_id AND m.workspace_id = w.workspace_id
                    AND m.role IN ('owner', 'editor')
                    AND ((m.subject_type = 'principal' AND m.subject_id = @principal_id)
                      OR (m.subject_type = 'group' AND EXISTS (
                          SELECT 1 FROM group_membership gm
                          WHERE gm.tenant_id = m.tenant_id AND gm.group_id = m.subject_id
                            AND gm.principal_id = @principal_id)))))
            ORDER BY w.created_at DESC, w.workspace_id DESC
            LIMIT @limit
            """;
        await foreach (var row in _sql.QueryAsync<WorkspaceTransferDestination, TransferDestinationMapper>(
            statement, default,
            [Uuid("tenant_id", context.TenantId.Value), Uuid("principal_id", context.PrincipalId.Value),
                Uuid("source_workspace_id", source.Value), TimestampOrNull("after_created_at", afterCreatedAt),
                UuidOrNull("after_id", afterId?.Value), Integer("limit", limit)], cancellationToken).ConfigureAwait(false))
        {
            rows.Add(row);
        }
        return rows;
    }

    private readonly struct TransferDestinationMapper : INixRowMapper<WorkspaceTransferDestination>
    {
        public WorkspaceTransferDestination Map(NpgsqlDataReader reader) =>
            new(WorkspaceId.From(reader.GetGuid(0)), reader.GetString(1), reader.GetFieldValue<DateTimeOffset>(2));
    }
}
