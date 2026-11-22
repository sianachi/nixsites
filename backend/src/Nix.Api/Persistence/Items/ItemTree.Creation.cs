using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using static Nix.Persistence.Sql.NixParameter;

namespace Nix.Persistence.Items;

public sealed partial class ItemTree
{
    /// <inheritdoc />
    public async ValueTask<ItemCreationReceipt?> GetCreationReceiptAsync(
        Guid key, string request, CancellationToken cancellationToken)
    {
        var parameters = CreationParameters(key);
        await _sql.ExecuteAsync(ItemCreationSql.Lock, parameters, cancellationToken).ConfigureAwait(false);
        await foreach (var receipt in _sql.QueryAsync<ItemCreationReceipt, CreationReceiptMapper>(
            ItemCreationSql.Find, default,
            [.. CreationParameters(key), NixParameter.Text("request", request)],
            cancellationToken).ConfigureAwait(false))
        {
            return receipt;
        }

        return null;
    }

    /// <inheritdoc />
    public async ValueTask RecordCreationReceiptAsync(
        Guid key, string request, ItemId itemId, CancellationToken cancellationToken) =>
        await _sql.ExecuteAsync(ItemCreationSql.Insert,
            [.. CreationParameters(key),
                NixParameter.Text("request", request),
                Uuid("item_id", itemId.Value)], cancellationToken).ConfigureAwait(false);

    private NpgsqlParameter[] CreationParameters(Guid key)
    {
        var context = _session.Current ?? throw new InvalidOperationException("No item creation session is established.");
        return [Uuid("tenant_id", context.TenantId.Value),
            Uuid("principal_id", context.PrincipalId.Value), Uuid("key", key)];
    }

    private readonly struct CreationReceiptMapper : INixRowMapper<ItemCreationReceipt>
    {
        public ItemCreationReceipt Map(NpgsqlDataReader reader) =>
            new(ItemId.From(reader.GetGuid(0)), reader.GetBoolean(1));
    }
}
