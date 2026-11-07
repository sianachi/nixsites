using System.Globalization;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Contracts;
using Nix.Domain.Files;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Scheduling;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Features.Items;
using Nix.Messaging;
using Nix.Persistence.Items;
using Nix.Persistence.Locks;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Features.Attachments;

/// <summary>One file item in the attachments list. Carries no link URL, only whether a public link exists.</summary>
/// <param name="ShownVersionId">The version the file shows: latest approved, else latest upload.</param>
/// <param name="ShownVersionState">That version's state: draft, in_review, approved or revoked.</param>
/// <param name="ExpiresAt">The item's expiry, or null.</param>
/// <param name="SourceItemId">The note the shown version was exported from, or null.</param>
/// <param name="PinCount">How many references pin a version of this file.</param>
public sealed record AttachmentRow(
    Guid ItemId,
    string Title,
    string MediaType,
    Guid ShownVersionId,
    string ShownVersionState,
    DateTimeOffset? ExpiresAt,
    Guid? SourceItemId,
    int PinCount,
    bool HasPublicLink);

/// <summary>One page of attachments; the endpoint wraps it as a CursorPage.</summary>
public sealed record AttachmentPage(IReadOnlyList<AttachmentRow> Items, string? NextCursor);

/// <summary>Lists the workspace's file items, newest first, for the attachments page.</summary>
/// <param name="State">Only files whose shown version is in this state, or null.</param>
/// <param name="AfterItemId">The last item of the previous page, or null.</param>
public sealed record ListAttachments(
    WorkspaceId WorkspaceId,
    string? State,
    bool IncludeImages,
    bool Expiring,
    Guid? AfterItemId,
    int Limit) : IQuery<Result<AttachmentPage>>;

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
public sealed class ListAttachmentsHandler(
    NixSqlExecutor sql,
    IItemTree tree,
    IPermissionResolver permissions,
    INixSessionContextAccessor session,
    CredentialSessionContext credential,
    TimeProvider clock)
    : IQueryHandler<ListAttachments, Result<AttachmentPage>>
{
    public const string Statement = $"""
        SELECT item.id, item.properties ->> 'title', shown.media_type, shown.file_version_id, shown.state,
               item.properties::text, shown.source_item_id,
               (SELECT count(*) FROM item_reference AS pin
                 WHERE pin.tenant_id = @tenant_id AND pin.target_item_id = item.id
                   AND {ItemProtectionSql.LivePin})::int,
               EXISTS (SELECT 1 FROM public_link AS link
                 WHERE link.tenant_id = @tenant_id AND link.item_id = item.id AND link.revoked_at IS NULL)
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
    public async ValueTask<Result<AttachmentPage>> HandleAsync(ListAttachments query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        if (!await tree.WorkspaceExistsAsync(query.WorkspaceId, cancellationToken).ConfigureAwait(false)
            || !await permissions.CanReadWorkspaceAsync(query.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<AttachmentPage>(
                ItemErrors.WorkspaceNotFound($"No workspace {query.WorkspaceId} is visible."));
        }

        var limit = Math.Clamp(query.Limit, 1, CursorPaging.MaximumLimit);
        var tenant = (session.Current ?? throw new InvalidOperationException("No session context.")).TenantId;
        var closed = await LockFilterParameters.ClosedLocksAsync(sql, tenant, credential, clock, cancellationToken).ConfigureAwait(false);

        var rows = new List<AttachmentRow>(limit + 1);
        await foreach (var row in sql.QueryAsync<AttachmentRow, RowMapper>(
            Statement,
            default,
            [
                new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = tenant.Value },
                new NpgsqlParameter("workspace_id", NpgsqlDbType.Uuid) { Value = query.WorkspaceId.Value },
                new NpgsqlParameter("after", NpgsqlDbType.Uuid) { Value = query.AfterItemId is { } after ? (object)after : DBNull.Value },
                new NpgsqlParameter("state", NpgsqlDbType.Text) { Value = (object?)query.State ?? DBNull.Value },
                new NpgsqlParameter("include_images", NpgsqlDbType.Boolean) { Value = query.IncludeImages },
                new NpgsqlParameter("expiring", NpgsqlDbType.Boolean) { Value = query.Expiring },
                new NpgsqlParameter("limit", NpgsqlDbType.Integer) { Value = limit + 1 },
                closed,
            ],
            cancellationToken).WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            rows.Add(row);
        }

        var more = rows.Count > limit;
        if (more)
        {
            rows.RemoveAt(limit);
        }

        return Result.Success(new AttachmentPage(rows, more ? rows[^1].ItemId.ToString("D", CultureInfo.InvariantCulture) : null));
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

            var expiresAt = ReminderInstant.Read(properties, ItemProperties.ExpiryKey);
            return new AttachmentRow(id, title, mediaType, versionId, state, expiresAt, source, pins, link);
        }
    }
}

internal static class AttachmentEndpoints
{
    internal static IEndpointRouteBuilder MapAttachmentEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        endpoints.MapGet(
                "/api/v1/workspaces/{workspaceId:guid}/attachments",
                async (Guid workspaceId, HttpContext context, [FromServices] NixDispatcher dispatcher, string? cursor, string? state, bool includeImages = false, bool expiring = false, int limit = CursorPaging.DefaultLimit) =>
                {
                    Guid? after = null;
                    if (cursor is not null)
                    {
                        if (!Guid.TryParse(cursor, out var parsed))
                        {
                            return Invalid(context, "attachments.invalid_cursor", "The cursor is not one this list gave.");
                        }

                        after = parsed;
                    }

                    if (state is not null && !FileVersionStates.IsValid(state))
                    {
                        return Invalid(context, "attachments.invalid_state", "state must be draft, in_review, approved or revoked.");
                    }

                    var result = await dispatcher.QueryAsync<ListAttachments, Result<AttachmentPage>>(
                        new ListAttachments(WorkspaceId.From(workspaceId), state, includeImages, expiring, after, limit),
                        context.RequestAborted).ConfigureAwait(false);
                    return result.IsFailure
                        ? TypedResults.Problem(ItemEndpoints.Problem(context, result.Error))
                        : (IResult)TypedResults.Ok(new CursorPage<AttachmentRow>(result.Value.Items, result.Value.NextCursor));
                })
            .WithTags("Attachments")
            .WithName("ListAttachments")
            .WithSummary("File items in the workspace")
            .WithDescription("Newest first. Shows each file's latest approved version, else its current one. Images are left out unless includeImages is set. Files under a lock the caller has not opened are omitted.")
            .Produces<CursorPage<AttachmentRow>>()
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity);
        return endpoints;
    }

    private static Microsoft.AspNetCore.Http.HttpResults.ProblemHttpResult Invalid(HttpContext context, string code, string detail) =>
        TypedResults.Problem(ApiProblem.Create(context, StatusCodes.Status422UnprocessableEntity, code, "Request refused", detail));
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(AttachmentRow))]
[JsonSerializable(typeof(CursorPage<AttachmentRow>))]
internal sealed partial class AttachmentsJsonContext : JsonSerializerContext;
