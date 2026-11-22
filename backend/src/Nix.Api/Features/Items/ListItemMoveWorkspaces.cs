using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Workspaces;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Items;

/// <summary>A destination that Core has confirmed is writable.</summary>
public sealed record ItemMoveWorkspace(Guid Id, string Name);

/// <summary>A page of writable destinations; the cursor advances past eligible rows.</summary>
public sealed record ItemMoveWorkspacePage(IReadOnlyList<ItemMoveWorkspace> Items, string? NextCursor);

public sealed record ListItemMoveWorkspaces(ItemId ItemId, DateTimeOffset? AfterCreatedAt,
    WorkspaceId? AfterId, int Limit) : IQuery<Result<ItemMoveWorkspacePage>>;

public sealed class ListItemMoveWorkspacesHandler(
    IVisibleItems visible, WorkspaceAdministrationStore store)
    : IQueryHandler<ListItemMoveWorkspaces, Result<ItemMoveWorkspacePage>>
{
    public async ValueTask<Result<ItemMoveWorkspacePage>> HandleAsync(
        ListItemMoveWorkspaces command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var lookup = await visible.FindAsync(
            command.ItemId, ItemAccess.Write, cancellationToken, notFoundDetail: "No movable item is visible.").ConfigureAwait(false);
        if (lookup.IsFailure)
        {
            return Result.Failure<ItemMoveWorkspacePage>(lookup.Error);
        }

        var item = lookup.Value;
        var rows = await store.ListTransferDestinationsAsync(item.WorkspaceId, command.AfterCreatedAt,
            command.AfterId, command.Limit + 1, cancellationToken).ConfigureAwait(false);
        var candidates = rows.Take(command.Limit).ToArray();
        var destinations = candidates.Select(workspace => new ItemMoveWorkspace(workspace.Id.Value, workspace.Name)).ToArray();
        var cursor = rows.Count > command.Limit
            ? WorkspaceCursor.Encode(candidates[^1].CreatedAt, candidates[^1].Id) : null;
        return Result.Success(new ItemMoveWorkspacePage(destinations, cursor));
    }
}

internal static class ListItemMoveWorkspacesEndpoint
{
    internal static async Task<Results<Ok<ItemMoveWorkspacePage>, ProblemHttpResult>> Handle(
        Guid itemId, string? cursor, int? limit, HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        if (!WorkspaceCursor.TryDecode(cursor, out var decoded))
        {
            return TypedResults.Problem(WorkspaceEndpoints.Problem(context,
                new NixError("paging.invalid_cursor", "The workspace cursor is invalid.")));
        }
        var result = await dispatcher.QueryAsync<ListItemMoveWorkspaces, Result<ItemMoveWorkspacePage>>(
            new ListItemMoveWorkspaces(ItemId.From(itemId), decoded?.CreatedAt, decoded?.Id,
                Math.Clamp(limit ?? 100, 1, 200)), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<ItemMoveWorkspacePage>, ProblemHttpResult>>(
            page => TypedResults.Ok(page), error => TypedResults.Problem(ItemEndpoints.Problem(context, error)));
    }
}
