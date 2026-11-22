using System.Globalization;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Contracts;
using Nix.Domain.Files;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Features.Items;
using Nix.Messaging;

namespace Nix.Features.Attachments;

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

/// <summary>Reads the attachments page: authorizes the workspace, then pages the store's rows.</summary>
public sealed class ListAttachmentsHandler(
    IAttachmentStore attachments,
    IItemTree tree,
    IPermissionResolver permissions)
    : IQueryHandler<ListAttachments, Result<AttachmentPage>>
{
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
        var rows = new List<AttachmentRow>(
            await attachments
                .ListAsync(query.WorkspaceId, query.State, query.IncludeImages, query.Expiring, query.AfterItemId, limit + 1, cancellationToken)
                .ConfigureAwait(false));
        var more = rows.Count > limit;
        if (more)
        {
            rows.RemoveAt(limit);
        }

        return Result.Success(new AttachmentPage(rows, more ? rows[^1].ItemId.ToString("D", CultureInfo.InvariantCulture) : null));
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
