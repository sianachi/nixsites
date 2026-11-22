using Nix.Abstractions;
using Nix.Domain.Files;
using Nix.Domain.Items;
using Nix.Domain.Scheduling;
using Nix.Domain.Tenancy;
using Nix.Persistence.Items;
using Nix.Persistence.Locks;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;

using static Nix.Persistence.Sql.NixParameter;

namespace Nix.Persistence.Attachments;

/// <summary>Reads the attachments page: one statement, keyset by item id.</summary>
/// <remarks>
/// <b>Shown version rule</b> (the same one <c>FileStore.ShownFirst</c> expresses in LINQ; a test
/// asserts they agree): the highest-numbered approved version, else the current version unless it
/// is revoked, else the newest non-revoked version. One difference, on purpose: a file whose every
/// version is revoked stays on the page showing a revoked version (the store shows none, and
/// serves none). <b>Locks:</b> a file under a lock the credential has not
/// opened, or locked itself, is left out of the page entirely, so no title or property of it can
/// leak; hidden and trashed ancestors hide a file as they do in every other list.
/// </remarks>
public sealed class AttachmentStore(
    NixSqlExecutor sql,
    INixSessionContextAccessor session,
    CredentialSessionContext credential,
    TimeProvider clock)
    : IAttachmentStore
{
    public const string Statement = $"""
        SELECT item.id, item.properties ->> 'title', shown.media_type, shown.file_version_id, shown.state,
               item.properties::text, shown.source_item_id,
               (SELECT count(*) FROM item_reference AS pin
                 WHERE pin.tenant_id = @tenant_id AND pin.target_item_id = item.id
                   AND {ItemProtectionSql.LivePin})::int,
               EXISTS (SELECT 1 FROM public_link AS link
                 WHERE link.tenant_id = @tenant_id AND link.item_id = item.id AND link.revoked_at IS NULL),
               item.settings::text
        FROM file_body AS body
        JOIN item ON item.tenant_id = @tenant_id AND item.id = body.item_id
        JOIN LATERAL (
            SELECT version.file_version_id, version.media_type, version.state, version.source_item_id
            FROM file_version AS version
            WHERE version.tenant_id = @tenant_id AND version.item_id = item.id
            ORDER BY (version.state <> 'revoked') DESC,
                     (version.state = 'approved') DESC,
                     CASE WHEN version.state = 'approved' THEN version.version END DESC NULLS LAST,
                     (version.file_version_id = body.current_version_id) DESC,
                     version.version DESC
            LIMIT 1
        ) AS shown ON TRUE
        WHERE body.tenant_id = @tenant_id
          AND body.workspace_id = @workspace_id
          AND item.type = 'file'
          AND item.lifecycle_state = 'active'
          AND item.template_id IS NULL
          AND (@after::uuid IS NULL OR item.id < @after::uuid)
          AND (@state::text IS NULL OR EXISTS (
              SELECT 1 FROM file_version AS wanted
              WHERE wanted.tenant_id = @tenant_id AND wanted.item_id = item.id AND wanted.state = @state::text))
          AND (@state::text IS NULL OR shown.state = @state::text)
          AND (@include_images OR shown.media_type NOT LIKE 'image/%')
          AND (NOT @expiring OR (COALESCE(item.properties ->> 'expiry', '') <> '' AND item.properties ? '$expiry_set_by'))
          AND NOT (item.id = ANY(@closed_lock_ids))
          AND {ItemLockSql.ItemIsNotUnderClosedLock}
          AND {ItemVisibilitySql.NoHiddenAncestor}
        ORDER BY item.id DESC
        LIMIT @limit
        """;

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<AttachmentRow>> ListAsync(
        WorkspaceId workspaceId,
        string? state,
        bool includeImages,
        bool expiring,
        Guid? afterItemId,
        int limit,
        CancellationToken cancellationToken)
    {
        var tenant = (session.Current ?? throw new InvalidOperationException("No session context.")).TenantId;
        var closed = await LockFilterParameters.ClosedLocksAsync(sql, tenant, credential, clock, cancellationToken).ConfigureAwait(false);

        var rows = new List<AttachmentRow>(limit);
        await foreach (var row in sql.QueryAsync<AttachmentRow, RowMapper>(
            Statement,
            default,
            [
                Uuid("tenant_id", tenant.Value),
                Uuid("workspace_id", workspaceId.Value),
                Uuid("after", afterItemId),
                Text("state", state),
                Boolean("include_images", includeImages),
                Boolean("expiring", expiring),
                Integer("limit", limit),
                closed,
            ],
            cancellationToken).WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            rows.Add(row);
        }

        return rows;
    }

    private readonly struct RowMapper : INixRowMapper<AttachmentRow>
    {
        public AttachmentRow Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);

            // Sequential access: columns must be read in order.
            var id = reader.GetGuid(0);
            var title = reader.IsDBNull(1) ? string.Empty : reader.GetString(1);
            var mediaType = reader.GetString(2);
            var versionId = reader.GetGuid(3);
            var state = reader.GetString(4);
            var properties = reader.IsDBNull(5) ? null : reader.GetString(5);
            Guid? source = reader.IsDBNull(6) ? null : reader.GetGuid(6);
            var pins = reader.GetInt32(7);
            var link = reader.GetBoolean(8);
            var reviewStates = ItemSettings.Read(reader.IsDBNull(9) ? null : reader.GetString(9)).ReviewStates;

            var expiresAt = ReminderInstant.Read(properties, ItemProperties.ExpiryKey);
            return new AttachmentRow(id, title, mediaType, versionId, state, expiresAt, source, pins, link, reviewStates);
        }
    }
}
