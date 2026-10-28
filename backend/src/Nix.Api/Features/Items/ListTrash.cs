using System.Globalization;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Contracts;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Features.Items;

/// <summary>Reads the directly deleted items that the current reader can recover.</summary>
public sealed record ListTrash(
    WorkspaceId WorkspaceId,
    DateTimeOffset? Before,
    Guid? BeforeId,
    int Limit) : IQuery<Result<IReadOnlyList<Item>>>;

/// <summary>Reads the directly deleted items that the current reader can recover.</summary>
public sealed class ListTrashHandler(
    IItemTree tree,
    IPermissionResolver permissions)
    : IQueryHandler<ListTrash, Result<IReadOnlyList<Item>>>
{
    public async ValueTask<Result<IReadOnlyList<Item>>> HandleAsync(
        ListTrash query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        if (!await tree.WorkspaceExistsAsync(query.WorkspaceId, cancellationToken).ConfigureAwait(false)
            || !await permissions.CanReadWorkspaceAsync(query.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<IReadOnlyList<Item>>(
                ItemErrors.WorkspaceNotFound($"No workspace {query.WorkspaceId} is visible."));
        }

        return Result.Success(await tree.ListDeletedAsync(
            query.WorkspaceId,
            query.Before,
            query.BeforeId,
            Math.Clamp(query.Limit, 1, ListItemsHandler.MaximumPageSize),
            cancellationToken).ConfigureAwait(false));
    }
}

internal static class ListTrashEndpoint
{
    internal static async Task<Results<Ok<CursorPage<ItemResponse>>, ProblemHttpResult>> Handle(
        Guid workspaceId,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher,
        string? cursor = null,
        int limit = CursorPaging.DefaultLimit)
    {
        var position = TrashCursor.Decode(cursor);
        var result = await dispatcher.QueryAsync<ListTrash, Result<IReadOnlyList<Item>>>(
            new ListTrash(WorkspaceId.From(workspaceId), position?.At, position?.Id, limit),
            httpContext.RequestAborted).ConfigureAwait(false);
        if (result.IsFailure)
        {
            return TypedResults.Problem(ItemEndpoints.Problem(httpContext, result.Error));
        }

        var page = result.Value;
        var children = await dispatcher.QueryAsync<ItemsWithChildren, IReadOnlySet<ItemId>>(
            new ItemsWithChildren(WorkspaceId.From(workspaceId), [.. page.Select(item => item.Id)]),
            httpContext.RequestAborted).ConfigureAwait(false);
        return TypedResults.Ok(new CursorPage<ItemResponse>(
            [.. page.Select(item => ItemMapping.ToResponse(item, children.Contains(item.Id)))],
            TrashCursor.NextFrom(page, limit)));
    }
}

internal static class TrashCursor
{
    internal sealed record Position(DateTimeOffset At, Guid Id);

    internal static Position? Decode(string? cursor)
    {
        var parts = cursor?.Split(':', 2);
        return parts is [var ticks, var id]
            && long.TryParse(ticks, NumberStyles.Integer, CultureInfo.InvariantCulture, out var value)
            && Guid.TryParse(id, out var parsed)
            ? new Position(new DateTimeOffset(value, TimeSpan.Zero), parsed)
            : null;
    }

    internal static string? NextFrom(IReadOnlyList<Item> page, int limit) => page.Count >= limit && page.Count > 0
        ? $"{page[^1].LastModifiedAt.UtcTicks.ToString(CultureInfo.InvariantCulture)}:{page[^1].Id.Value:D}"
        : null;
}
