using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Persistence.Locks;
using Nix.Persistence.Sql;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Records;

/// <summary>The <c>record_key</c> table and the exact-value lookups, on the request's connection and transaction.</summary>
public sealed class RecordKeyStore(
    NixSqlExecutor sql,
    INixSessionContextAccessor session,
    CredentialSessionContext credential,
    TimeProvider clock) : IRecordKeyStore
{
    private TenantId Tenant => (session.Current
        ?? throw new InvalidOperationException("Record keys require an authenticated unit of work.")).TenantId;

    /// <inheritdoc />
    public async ValueTask LockScopeAsync(ItemId scope, bool exclusive, CancellationToken cancellationToken) =>
        _ = await sql.ExecuteAsync(
            exclusive
                ? "SELECT pg_advisory_xact_lock(hashtextextended(@identity, 0));"
                : "SELECT pg_advisory_xact_lock_shared(hashtextextended(@identity, 0));",
            [new NpgsqlParameter("identity", NpgsqlDbType.Text) { Value = $"record-scope:{Tenant.Value:D}:{scope.Value:D}" }],
            cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask LockAsync(ItemId scope, IEnumerable<(string Field, string Value)> keys, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(keys);
        var identities = keys
            .Select(key => $"record-key:{Tenant.Value:D}:{scope.Value:D}:{key.Field}:{key.Value}")
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal);
        foreach (var identity in identities)
        {
            _ = await sql.ExecuteAsync(
                "SELECT pg_advisory_xact_lock(hashtextextended(@identity, 0));",
                [new NpgsqlParameter("identity", NpgsqlDbType.Text) { Value = identity }],
                cancellationToken).ConfigureAwait(false);
        }
    }

    /// <inheritdoc />
    public async ValueTask<RecordKeyHolder?> FindHolderAsync(ItemId scope, string field, string value, CancellationToken cancellationToken)
    {
        await foreach (var holder in sql.QueryAsync<RecordKeyHolder, HolderMapper>(
            """
            SELECT record_key.item_id, item.lifecycle_state <> 'active'
            FROM record_key
            JOIN item ON item.tenant_id = record_key.tenant_id AND item.id = record_key.item_id
            WHERE record_key.tenant_id = @tenant_id AND record_key.scope_item_id = @scope
              AND record_key.field = @field AND record_key.value = @value
            """,
            default,
            [Tenant_(), Uuid("scope", scope.Value), Text("field", field), Text("value", value)],
            cancellationToken).ConfigureAwait(false))
        {
            return holder;
        }

        return null;
    }

    /// <inheritdoc />
    public async ValueTask<bool> SetAsync(ItemId scope, ItemId itemId, string field, string? value, CancellationToken cancellationToken)
    {
        _ = await sql.ExecuteAsync(
            "DELETE FROM record_key WHERE tenant_id = @tenant_id AND item_id = @item AND scope_item_id = @scope AND field = @field",
            [Tenant_(), Uuid("item", itemId.Value), Uuid("scope", scope.Value), Text("field", field)],
            cancellationToken).ConfigureAwait(false);
        if (value is null)
        {
            return true;
        }

        // ON CONFLICT DO NOTHING rather than a raised violation: a failed insert would abort the
        // whole transaction, and the caller wants to answer 409 (or fail one batch row) instead.
        var inserted = await sql.ExecuteAsync(
            """
            INSERT INTO record_key (tenant_id, scope_item_id, field, value, item_id)
            VALUES (@tenant_id, @scope, @field, @value, @item)
            ON CONFLICT DO NOTHING
            """,
            [Tenant_(), Uuid("scope", scope.Value), Text("field", field), Text("value", value), Uuid("item", itemId.Value)],
            cancellationToken).ConfigureAwait(false);
        return inserted == 1;
    }

    /// <inheritdoc />
    public async ValueTask ReleaseItemAsync(ItemId itemId, CancellationToken cancellationToken) =>
        _ = await sql.ExecuteAsync(
            "DELETE FROM record_key WHERE tenant_id = @tenant_id AND item_id = @item",
            [Tenant_(), Uuid("item", itemId.Value)],
            cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask ReleaseForPurgeAsync(ItemId itemId, CancellationToken cancellationToken) =>
        _ = await sql.ExecuteAsync(
            "DELETE FROM record_key WHERE tenant_id = @tenant_id AND (item_id = @item OR scope_item_id = @item)",
            [Tenant_(), Uuid("item", itemId.Value)],
            cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask DropFieldAsync(ItemId scope, string field, CancellationToken cancellationToken) =>
        _ = await sql.ExecuteAsync(
            "DELETE FROM record_key WHERE tenant_id = @tenant_id AND scope_item_id = @scope AND field = @field",
            [Tenant_(), Uuid("scope", scope.Value), Text("field", field)],
            cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<(ItemId ItemId, string Value)>> ChildValuesAsync(ItemId scope, string field, CancellationToken cancellationToken)
    {
        var rows = new List<(ItemId, string)>();
        await foreach (var row in sql.QueryAsync<(ItemId, string), ValueMapper>(
            """
            SELECT id, properties ->> @field
            FROM item
            WHERE tenant_id = @tenant_id AND parent_id = @scope AND lifecycle_state <> 'purged'
              AND jsonb_typeof(properties -> @field) = 'string'
            """,
            default,
            [Tenant_(), Uuid("scope", scope.Value), Text("field", field)],
            cancellationToken).ConfigureAwait(false))
        {
            rows.Add(row);
        }

        return rows;
    }

    /// <inheritdoc />
    public async ValueTask BackfillAsync(ItemId scope, string field, IReadOnlyList<(ItemId ItemId, string Value)> keys, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(keys);
        if (keys.Count == 0)
        {
            return;
        }

        _ = await sql.ExecuteAsync(
            """
            INSERT INTO record_key (tenant_id, scope_item_id, field, value, item_id)
            SELECT @tenant_id, @scope, @field, key.value, key.item_id
            FROM unnest(@items, @values) AS key(item_id, value)
            """,
            [
                Tenant_(),
                Uuid("scope", scope.Value),
                Text("field", field),
                new NpgsqlParameter("items", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = keys.Select(key => key.ItemId.Value).ToArray() },
                new NpgsqlParameter("values", NpgsqlDbType.Array | NpgsqlDbType.Text) { Value = keys.Select(key => key.Value).ToArray() },
            ],
            cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<RecordMatch>> FindByPropertyAsync(
        WorkspaceId workspaceId, ItemId? parentId, string key, IReadOnlyList<string> values, int limit, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(values);

        // Exact equality on the stored JSON string; the value is bound, never interpolated.
        var ids = new List<Guid>();
        await foreach (var id in sql.QueryAsync<Guid, IdMapper>(
            """
            SELECT item.id
            FROM item
            WHERE item.tenant_id = @tenant_id AND item.workspace_id = @workspace_id
              AND item.lifecycle_state <> 'purged' AND item.template_id IS NULL
              AND (@parent IS NULL OR item.parent_id = @parent)
              AND jsonb_typeof(item.properties -> @key) = 'string'
              AND (item.properties ->> @key) = ANY(@values)
            ORDER BY item.created_at, item.id
            LIMIT @limit
            """,
            default,
            [
                Tenant_(),
                Uuid("workspace_id", workspaceId.Value),
                new NpgsqlParameter("parent", NpgsqlDbType.Uuid) { Value = parentId is { } p ? p.Value : DBNull.Value },
                Text("key", key),
                new NpgsqlParameter("values", NpgsqlDbType.Array | NpgsqlDbType.Text) { Value = values.ToArray() },
                new NpgsqlParameter("limit", NpgsqlDbType.Integer) { Value = limit },
            ],
            cancellationToken).ConfigureAwait(false))
        {
            ids.Add(id);
        }

        return await ReadableAsync(ids, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<RecordMatch>> FindByKeyAsync(ItemId scope, string field, string value, CancellationToken cancellationToken)
    {
        var ids = new List<Guid>();
        await foreach (var id in sql.QueryAsync<Guid, IdMapper>(
            """
            SELECT item_id FROM record_key
            WHERE tenant_id = @tenant_id AND scope_item_id = @scope AND field = @field AND value = @value
            """,
            default,
            [Tenant_(), Uuid("scope", scope.Value), Text("field", field), Text("value", value)],
            cancellationToken).ConfigureAwait(false))
        {
            ids.Add(id);
        }

        return await ReadableAsync(ids, cancellationToken).ConfigureAwait(false);
    }

    // The query path's rule: the item itself is listed (its own properties are not withheld by its
    // own lock), but anything under a closed lock is not.
    private async ValueTask<IReadOnlyList<RecordMatch>> ReadableAsync(List<Guid> ids, CancellationToken cancellationToken)
    {
        if (ids.Count == 0)
        {
            return [];
        }

        var closed = await LockFilterParameters.ClosedLocksAsync(sql, Tenant, credential, clock, cancellationToken).ConfigureAwait(false);
        var matches = new List<RecordMatch>();
        await foreach (var match in sql.QueryAsync<RecordMatch, MatchMapper>(
            $"""
            SELECT item.id, (item.lifecycle_state <> 'active' OR NOT {Nix.Persistence.Sql.Statements.ItemVisibilitySql.NoHiddenAncestor}) AS trashed
            FROM item
            WHERE item.tenant_id = @tenant_id AND item.id = ANY(@ids) AND item.lifecycle_state <> 'purged'
              AND {Nix.Persistence.Sql.Statements.ItemLockSql.ItemIsNotUnderClosedLock}
            ORDER BY item.created_at, item.id
            """,
            default,
            [Tenant_(), closed, new NpgsqlParameter("ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = ids.ToArray() }],
            cancellationToken).ConfigureAwait(false))
        {
            matches.Add(match);
        }

        return matches;
    }

    private NpgsqlParameter Tenant_() => Uuid("tenant_id", Tenant.Value);

    private static NpgsqlParameter Uuid(string name, Guid value) => new(name, NpgsqlDbType.Uuid) { Value = value };

    private static NpgsqlParameter Text(string name, string value) => new(name, NpgsqlDbType.Text) { Value = value };

    private readonly struct HolderMapper : INixRowMapper<RecordKeyHolder>
    {
        public RecordKeyHolder Map(NpgsqlDataReader reader) => new(ItemId.From(reader.GetGuid(0)), reader.GetBoolean(1));
    }

    private readonly struct MatchMapper : INixRowMapper<RecordMatch>
    {
        public RecordMatch Map(NpgsqlDataReader reader) => new(ItemId.From(reader.GetGuid(0)), reader.GetBoolean(1));
    }

    private readonly struct ValueMapper : INixRowMapper<(ItemId, string)>
    {
        public (ItemId, string) Map(NpgsqlDataReader reader) => (ItemId.From(reader.GetGuid(0)), reader.GetString(1));
    }

    private readonly struct IdMapper : INixRowMapper<Guid>
    {
        public Guid Map(NpgsqlDataReader reader) => reader.GetGuid(0);
    }
}
