using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Sync;

/// <summary>Replay receipts use the same connection, transaction, and SET LOCAL context as item commands.</summary>
public sealed class NativeReplayStore(NixDbContext database, NixSqlExecutor sql, INixSessionContextAccessor session) : INativeReplayStore
{
    private NixSessionContext Context => session.Current
        ?? throw new InvalidOperationException("Native replay requires an authenticated unit of work.");

    /// <inheritdoc />
    public async ValueTask LockOperationAsync(Guid operationId, CancellationToken cancellationToken) =>
        _ = await sql.ExecuteAsync(NativeReplaySql.LockOperation,
            [new NpgsqlParameter("identity", NpgsqlDbType.Text)
            {
                Value = $"native-replay:{Context.TenantId.Value:D}:{Context.PrincipalId.Value:D}:{operationId:D}",
            }], cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<NativeReplayReceipt?> FindAsync(Guid operationId, CancellationToken cancellationToken)
    {
        await foreach (var receipt in sql.QueryAsync<NativeReplayReceipt, ReceiptMapper>(NativeReplaySql.FindReceipt,
            default, OperationParameters(operationId), cancellationToken).ConfigureAwait(false))
        {
            return receipt;
        }
        return null;
    }

    /// <inheritdoc />
    public async ValueTask<long?> LockItemRevisionAsync(WorkspaceId workspaceId, ItemId itemId, CancellationToken cancellationToken)
    {
        var found = await sql.ScalarOrDefaultAsync<Guid>(NativeReplaySql.LockItem,
            ItemParameters(workspaceId, itemId), cancellationToken).ConfigureAwait(false);
        if (found == Guid.Empty)
        {
            return null;
        }
        return await sql.ScalarOrDefaultAsync<long>(NativeReplaySql.ItemRevision,
            ItemParameters(workspaceId, itemId), cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask SaveAsync(Guid operationId, WorkspaceId workspaceId, string fingerprint, string response, CancellationToken cancellationToken) =>
        _ = await sql.ExecuteAsync(NativeReplaySql.SaveReceipt,
            [.. OperationParameters(operationId), Uuid("workspace_id", workspaceId.Value),
                new NpgsqlParameter("fingerprint", NpgsqlDbType.Text) { Value = fingerprint },
                new NpgsqlParameter("response", NpgsqlDbType.Text) { Value = response }], cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask BeginMutationAsync(CancellationToken cancellationToken) =>
        await Transaction.CreateSavepointAsync("native_replay_mutation", cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask EndMutationAsync(bool accepted, CancellationToken cancellationToken)
    {
        if (!accepted)
        {
            await Transaction.RollbackToSavepointAsync("native_replay_mutation", cancellationToken).ConfigureAwait(false);
            database.ChangeTracker.Clear();
        }
        await Transaction.ReleaseSavepointAsync("native_replay_mutation", cancellationToken).ConfigureAwait(false);
    }

    private Microsoft.EntityFrameworkCore.Storage.IDbContextTransaction Transaction => database.Database.CurrentTransaction
        ?? throw new InvalidOperationException("Native replay requires an active transaction.");

    private NpgsqlParameter[] OperationParameters(Guid operationId) =>
        [Uuid("tenant_id", Context.TenantId.Value), Uuid("principal_id", Context.PrincipalId.Value), Uuid("operation_id", operationId)];

    private NpgsqlParameter[] ItemParameters(WorkspaceId workspaceId, ItemId itemId) =>
        [Uuid("tenant_id", Context.TenantId.Value), Uuid("workspace_id", workspaceId.Value), Uuid("item_id", itemId.Value)];

    private static NpgsqlParameter Uuid(string name, Guid value) => new(name, NpgsqlDbType.Uuid) { Value = value };

    private readonly struct ReceiptMapper : INixRowMapper<NativeReplayReceipt>
    {
        public NativeReplayReceipt Map(NpgsqlDataReader reader) => new(reader.GetGuid(0), reader.GetString(1), reader.GetString(2));
    }
}
