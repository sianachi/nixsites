using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Nix.Abstractions.Workers;
using Nix.Persistence.Sql;
using Npgsql;

namespace Nix.Persistence.Workers;

/// <summary>Uses the tenant-scoped unit-of-work transaction to hold one live worker lease.</summary>
public sealed class WorkerExecutionFence(NixDbContext database) : IWorkerExecutionFence
{
    private const string FenceSql = "SELECT nix_fence_worker_execution(@job_id, @owner, @kind, @tenant_id, @workspace_id, @actor_id)";

    /// <inheritdoc />
    public async ValueTask<bool> HoldAsync(
        Guid jobId,
        string owner,
        WorkerExecutionAuthorization authorization,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(authorization);
        if (jobId == Guid.Empty
            || string.IsNullOrWhiteSpace(owner)
            || owner.Length > 128
            || owner.Any(char.IsControl)
            || string.IsNullOrWhiteSpace(authorization.Kind))
        {
            return false;
        }

        if (database.Database.GetDbConnection() is not NpgsqlConnection connection
            || database.Database.CurrentTransaction?.GetDbTransaction() is not NpgsqlTransaction transaction)
        {
            throw new InvalidOperationException("A worker execution fence requires the active Npgsql unit-of-work transaction.");
        }

        var command = new NpgsqlCommand(FenceSql, connection, transaction);
        await using (command.ConfigureAwait(false))
        {
            command.Parameters.Add(NixParameter.Uuid("job_id", jobId));
            command.Parameters.Add(NixParameter.Text("owner", owner));
            command.Parameters.Add(NixParameter.Text("kind", authorization.Kind));
            command.Parameters.Add(NixParameter.Uuid("tenant_id", authorization.TenantId));
            command.Parameters.Add(NixParameter.Uuid("workspace_id", authorization.WorkspaceId));
            command.Parameters.Add(NixParameter.Uuid("actor_id", authorization.ActorId));
            return await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false) is true;
        }
    }
}
