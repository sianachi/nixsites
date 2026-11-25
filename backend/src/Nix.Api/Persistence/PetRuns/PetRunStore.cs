using System.Diagnostics.CodeAnalysis;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.PetRuns;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.PetRuns;

/// <inheritdoc />
public sealed class PetRunStore(NixDbContext database, INixSessionContextAccessor session) : IPetRunStore
{
    private NixSessionContext Context => session.Current ?? throw new InvalidOperationException("A tenant unit of work is required.");

    public async Task<bool> CreateAsync(PetRunRecord run, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(run);
        var scope = Context;
        if (run.Revision != 1 || run.Status is not ("queued" or "waiting_for_input") || run.TenantId != scope.TenantId || run.ActorId != scope.PrincipalId
            || scope.WorkspaceId is { } workspace && workspace != run.WorkspaceId)
        {
            return false;
        }

        return await database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO pet_run
                (id, tenant_id, workspace_id, item_id, actor_id, brief, source_item_ids, workspace_scope,
                 abilities, status, revision, state, created_at, updated_at, request_id)
            SELECT {run.Id}, w.tenant_id, w.workspace_id, CAST({run.ItemId?.Value} AS uuid), {run.ActorId.Value}, {run.Brief},
                   {run.SourceItemIds.ToArray()}, {run.WorkspaceScope}, {run.Abilities.ToArray()}, {run.Status},
                   {run.Revision}, CAST({run.State.GetRawText()} AS jsonb), {run.CreatedAt}, {run.UpdatedAt}, CAST({run.RequestId} AS uuid)
              FROM workspace w
             WHERE w.tenant_id = {run.TenantId.Value} AND w.workspace_id = {run.WorkspaceId.Value}
               AND w.lifecycle_state = 'active'
               AND (CAST({run.ItemId?.Value} AS uuid) IS NULL OR EXISTS (
                   SELECT 1 FROM item i WHERE i.tenant_id = w.tenant_id AND i.workspace_id = w.workspace_id
                     AND i.id = {run.ItemId?.Value} AND i.lifecycle_state = 'active'))
            ON CONFLICT DO NOTHING
            """, cancellationToken).ConfigureAwait(false) == 1;
    }

    public async Task<PetRunRecord?> GetAsync(Guid id, CancellationToken cancellationToken) =>
        (await ReadAsync(id, workspaceId: null, itemId: null, cancellationToken).ConfigureAwait(false)).SingleOrDefault();

    public Task<IReadOnlyList<PetRunRecord>> ListAsync(WorkspaceId workspaceId, ItemId? itemId, CancellationToken cancellationToken) =>
        ReadAsync(id: null, workspaceId.Value, itemId?.Value, cancellationToken);

    public async Task<PetRunRecord?> GetByRequestAsync(WorkspaceId workspaceId, Guid requestId, CancellationToken cancellationToken) =>
        (await ReadAsync(null, workspaceId.Value, null, cancellationToken, requestId).ConfigureAwait(false)).SingleOrDefault();

    public async Task<bool> UpdateAsync(PetRunRecord checkpoint, long expectedRevision, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(checkpoint);
        var scope = Context;
        if (expectedRevision < 1 || expectedRevision == long.MaxValue || checkpoint.Revision != expectedRevision + 1
            || checkpoint.TenantId != scope.TenantId || checkpoint.ActorId != scope.PrincipalId
            || scope.WorkspaceId is { } workspace && workspace != checkpoint.WorkspaceId)
        {
            return false;
        }

        return await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE pet_run
               SET status = {checkpoint.Status}, revision = {checkpoint.Revision},
                   state = CAST({checkpoint.State.GetRawText()} AS jsonb),
                   updated_at = GREATEST(updated_at, {checkpoint.UpdatedAt})
             WHERE id = {checkpoint.Id} AND tenant_id = {checkpoint.TenantId.Value} AND actor_id = {checkpoint.ActorId.Value}
               AND workspace_id = {checkpoint.WorkspaceId.Value} AND item_id IS NOT DISTINCT FROM CAST({checkpoint.ItemId?.Value} AS uuid)
               AND request_id IS NOT DISTINCT FROM CAST({checkpoint.RequestId} AS uuid)
               AND revision = {expectedRevision}
               AND brief = {checkpoint.Brief} AND source_item_ids = {checkpoint.SourceItemIds.ToArray()}
               AND workspace_scope = {checkpoint.WorkspaceScope} AND abilities = {checkpoint.Abilities.ToArray()}
               AND created_at = {checkpoint.CreatedAt}
            """, cancellationToken).ConfigureAwait(false) == 1;
    }

    private async Task<IReadOnlyList<PetRunRecord>> ReadAsync(
        Guid? id, Guid? workspaceId, Guid? itemId, CancellationToken cancellationToken, Guid? requestId = null)
    {
        var scope = Context;
        var rows = await database.Database.SqlQuery<RunRow>($"""
            SELECT id AS "Id", item_id AS "ItemId", workspace_id AS "WorkspaceId", tenant_id AS "TenantId",
                   actor_id AS "ActorId", brief AS "Brief", source_item_ids AS "SourceItemIds",
                   workspace_scope AS "WorkspaceScope", abilities AS "Abilities", status AS "Status",
                   revision AS "Revision", state::text AS "State", created_at AS "CreatedAt", updated_at AS "UpdatedAt",
                   request_id AS "RequestId"
              FROM pet_run
             WHERE tenant_id = {scope.TenantId.Value} AND actor_id = {scope.PrincipalId.Value}
               AND (CAST({id} AS uuid) IS NULL OR id = {id})
               AND (CAST({workspaceId} AS uuid) IS NULL OR workspace_id = {workspaceId})
               AND (CAST({itemId} AS uuid) IS NULL OR item_id = {itemId})
               AND (CAST({requestId} AS uuid) IS NULL OR request_id = {requestId})
             ORDER BY updated_at DESC, id DESC
             LIMIT 100
            """).ToListAsync(cancellationToken).ConfigureAwait(false);
        return rows.ConvertAll(static row =>
        {
            using var state = JsonDocument.Parse(row.State);
            return new PetRunRecord(
                row.Id, row.ItemId is { } anchor ? ItemId.From(anchor) : null, WorkspaceId.From(row.WorkspaceId), TenantId.From(row.TenantId),
                PrincipalId.From(row.ActorId), row.Brief, row.SourceItemIds, row.WorkspaceScope, row.Abilities,
                row.Status, row.Revision, state.RootElement.Clone(), row.CreatedAt, row.UpdatedAt, RequestId: row.RequestId);
        });
    }

    [SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes", Justification = "EF Core materialises SqlQuery rows through reflection.")]
    private sealed record RunRow(
        Guid Id, Guid? ItemId, Guid WorkspaceId, Guid TenantId, Guid ActorId, string Brief,
        Guid[] SourceItemIds, bool WorkspaceScope, string[] Abilities, string Status, long Revision,
        string State, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, Guid? RequestId);
}
