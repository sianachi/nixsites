using System.Globalization;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Domain.Authorization;
using Nix.Domain.Sync;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using static Nix.Persistence.Sql.NixParameter;

namespace Nix.Persistence.Sync;

/// <summary>Streams bounded mirror pages on the request's tenant connection and transaction.</summary>
public sealed class WorkspaceSyncStore(
    NixSqlExecutor sql,
    INixSessionContextAccessor session,
    CredentialSessionContext credential,
    AccessTokenSessionContext tokenScope,
    TimeProvider clock) : IWorkspaceSync
{
    /// <inheritdoc />
    public async ValueTask PublishPendingAsync(CancellationToken cancellationToken) =>
        _ = await sql.ExecuteAsync(WorkspaceSyncSql.FlushPending, cancellationToken: cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<WorkspaceSyncSnapshot?> SnapshotAsync(
        WorkspaceId workspaceId, long? boundary, Guid? cursor, int limit, CancellationToken cancellationToken)
    {
        var now = clock.GetUtcNow();
        var head = await ReadBoundaryAsync(workspaceId, boundary ?? 0, now, cancellationToken).ConfigureAwait(false);
        if (head is null)
        {
            return null;
        }
        if (boundary is { } saved && (saved < head.RetainedFloor || saved > head.Seq || head.Resync))
        {
            return new WorkspaceSyncSnapshot(Decimal(head.Seq), null, false, [], now, Resync: true);
        }
        var rows = await ReadRowsAsync(WorkspaceSyncSql.Snapshot, Parameters(workspaceId, now,
            Uuid("cursor", cursor), NixParameter.Integer("limit", limit + 1)), cancellationToken).ConfigureAwait(false);
        var savedBoundary = Math.Min(boundary ?? head.Seq, head.Seq);
        var finalHead = await ReadBoundaryAsync(workspaceId, savedBoundary, now, cancellationToken).ConfigureAwait(false);
        if (finalHead is null)
        {
            return null;
        }
        if (finalHead.Resync || savedBoundary < finalHead.RetainedFloor)
        {
            return new WorkspaceSyncSnapshot(Decimal(finalHead.Seq), null, false, [], now, Resync: true);
        }
        var complete = rows.Count <= limit;
        var items = rows.Take(limit).Select(static row => row.Item).ToArray();
        return new WorkspaceSyncSnapshot(
            Decimal(savedBoundary), complete ? null : items[^1].Id, complete, items, now);
    }

    /// <inheritdoc />
    public async ValueTask<WorkspaceSyncChanges?> ChangesAsync(
        WorkspaceId workspaceId, long after, int limit, CancellationToken cancellationToken)
    {
        var now = clock.GetUtcNow();
        var head = await ReadBoundaryAsync(workspaceId, after, now, cancellationToken).ConfigureAwait(false);
        if (head is null)
        {
            return null;
        }
        if (after < head.RetainedFloor || after > head.Seq || head.Resync)
        {
            return new WorkspaceSyncChanges(Decimal(head.Seq), false, true, [], now);
        }
        var rows = await ReadRowsAsync(WorkspaceSyncSql.Changes, Parameters(workspaceId, now,
            NixParameter.Int8("after", after), NixParameter.Int8("boundary", head.Seq),
            NixParameter.Integer("limit", limit + 1)), cancellationToken).ConfigureAwait(false);
        var hasMore = rows.Count > limit;
        return new WorkspaceSyncChanges(Decimal(hasMore ? rows[limit - 1].Seq : head.Seq), hasMore, false,
            rows.Take(limit).Select(static row => row.Item).ToArray(), now);
    }

    /// <inheritdoc />
    public async ValueTask<WorkspaceSyncReconciliation> ReconcileAsync(
        WorkspaceId workspaceId, IReadOnlyList<Guid> itemIds, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(itemIds);
        var now = clock.GetUtcNow();
        var rows = await ReadRowsAsync(WorkspaceSyncSql.Reconcile, Parameters(workspaceId, now,
            NixParameter.UuidArray("item_ids", itemIds.Distinct().ToArray())), cancellationToken).ConfigureAwait(false);
        var items = rows.Select(static row => row.Item).ToArray();
        var visible = items.Select(static item => item.Id).ToHashSet();
        return new WorkspaceSyncReconciliation(items,
            itemIds.Distinct().Where(id => !visible.Contains(id)).Select(static id => new NativeRemovedItem(id, "inaccessible")).ToArray(), now);
    }

    private async ValueTask<BoundaryRow?> ReadBoundaryAsync(
        WorkspaceId workspaceId, long after, DateTimeOffset now, CancellationToken cancellationToken)
    {
        await foreach (var row in sql.QueryAsync<BoundaryRow, BoundaryMapper>(WorkspaceSyncSql.Boundary, default,
            Parameters(workspaceId, now, NixParameter.Int8("after", after)), cancellationToken).ConfigureAwait(false))
        {
            return row;
        }
        return null;
    }

    private async Task<List<SnapshotRow>> ReadRowsAsync(string statement, NpgsqlParameter[] parameters, CancellationToken cancellationToken)
    {
        var rows = new List<SnapshotRow>();
        await foreach (var row in sql.QueryAsync<SnapshotRow, SnapshotMapper>(statement, default, parameters, cancellationToken).ConfigureAwait(false))
        {
            rows.Add(row);
        }
        return rows;
    }

    private NpgsqlParameter[] Parameters(WorkspaceId workspaceId, DateTimeOffset now, params NpgsqlParameter[] extras)
    {
        var context = session.Current ?? throw new InvalidOperationException("A native mirror read requires a tenant unit of work.");
        var roles = Enum.GetValues<WorkspaceRole>();
        return [
            NixParameter.Uuid("tenant_id", context.TenantId.Value),
            NixParameter.Uuid("principal_id", context.PrincipalId.Value),
            NixParameter.Uuid("workspace_id", workspaceId.Value),
            NixParameter.TextArray("read_roles", roles.Select(WorkspaceRoles.ToText).ToArray()),
            NixParameter.TextArray("write_roles", roles.Where(static role => role.GrantsWrite()).Select(WorkspaceRoles.ToText).ToArray()),
            NixParameter.Boolean("may_write", tokenScope.MayWrite),
            NixParameter.Timestamp("now", now), Uuid("credential_id", credential.CredentialId),
            .. extras,
        ];
    }

    private static string Decimal(long value) => value.ToString(CultureInfo.InvariantCulture);
    private sealed record BoundaryRow(long Seq, long RetainedFloor, bool Resync);
    private sealed record SnapshotRow(long Seq, NativeItemSnapshot Item);

    private readonly struct BoundaryMapper : INixRowMapper<BoundaryRow>
    {
        public BoundaryRow Map(NpgsqlDataReader reader) => new(reader.GetInt64(0), reader.GetInt64(1), reader.GetBoolean(2));
    }

    private readonly struct SnapshotMapper : INixRowMapper<SnapshotRow>
    {
        public SnapshotRow Map(NpgsqlDataReader reader)
        {
            var seq = reader.GetInt64(0);
            var id = reader.GetGuid(1);
            var workspaceId = reader.GetGuid(2);
            var revision = Decimal(reader.GetInt64(3));
            var parentId = Nullable<Guid>(reader, 4);
            var type = reader.GetString(5);
            var title = reader.GetString(6);
            var siblingSeq = reader.GetInt64(7);
            var lifecycle = reader.GetString(8);
            var properties = JsonObject.Parse(reader.GetString(9))!.AsObject();
            var schema = Object(reader, 10);
            var viewsText = Text(reader, 11);
            var views = viewsText is null ? null : JsonObject.Parse(viewsText)!.AsObject();
            var recurrence = Object(reader, 12);
            var noDelete = reader.GetBoolean(13);
            var noChildren = reader.GetBoolean(14);
            var managedBy = Text(reader, 15);
            var createdAt = reader.GetFieldValue<DateTimeOffset>(16);
            var updatedAt = Nullable<DateTimeOffset>(reader, 17);
            var canWrite = reader.GetBoolean(18);
            var locked = reader.GetBoolean(19);
            // What a device sends back as the version it edited from; withheld with the views while locked.
            var viewsVersion = locked ? null : Domain.Views.ViewConfigurationVersion.FromStored(viewsText);
            var metadataExpiresAt = Nullable<DateTimeOffset>(reader, 20);
            var bodyDocId = Nullable<Guid>(reader, 21);
            var bodySeq = Nullable<long>(reader, 22);
            var versionId = Nullable<Guid>(reader, 23);
            var fileName = Text(reader, 24);
            var mediaType = Text(reader, 25);
            var bytes = Nullable<long>(reader, 26);
            var hash = Text(reader, 27);
            var file = versionId is { } version ? new NativeFileSnapshot(version, fileName!, mediaType!, bytes!.Value, hash!, Text(reader, 28)!) : null;
            return new SnapshotRow(seq, new NativeItemSnapshot(id, workspaceId, revision, parentId, type, title, siblingSeq,
                lifecycle, properties, schema, views, recurrence, noDelete, noChildren, managedBy, createdAt, updatedAt,
                canWrite, locked, !locked, metadataExpiresAt, bodyDocId, bodySeq is { } head ? Decimal(head) : null, file,
                reader.IsDBNull(29) ? null : Domain.Items.ItemSettings.Read(reader.GetString(29)), viewsVersion));
        }

        private static T? Nullable<T>(NpgsqlDataReader reader, int ordinal) where T : struct =>
            reader.IsDBNull(ordinal) ? null : reader.GetFieldValue<T>(ordinal);
        private static string? Text(NpgsqlDataReader reader, int ordinal) => reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);
        private static JsonObject? Object(NpgsqlDataReader reader, int ordinal) =>
            reader.IsDBNull(ordinal) ? null : JsonObject.Parse(reader.GetString(ordinal))!.AsObject();
    }
}
