using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Features.Properties;
using Nix.Messaging;

namespace Nix.Features.Items;

/// <summary>Reads one item.</summary>
/// <param name="ItemId">The item.</param>
/// <remarks>
/// An item the caller may not read is reported as not found, never as forbidden: "you may not see
/// this" confirms the thing exists, which is how an outsider enumerates a workspace one identifier
/// at a time. Row-level security makes the two indistinguishable here by construction - an
/// invisible row simply is not returned. Row-level security answers the tenant question; the
/// permission resolver answers the workspace one, and both must agree before a row is returned.
/// </remarks>
public sealed record GetItem(ItemId ItemId) : IQuery<Result<Item>>;

/// <summary>Reads one item.</summary>
/// <remarks>
/// An item the caller may not read is reported as not found, never as forbidden: "you may not see
/// this" confirms the thing exists, which is how an outsider enumerates a workspace one identifier
/// at a time. Row-level security makes the two indistinguishable here by construction - an
/// invisible row simply is not returned. Row-level security answers the tenant question; the
/// permission resolver answers the workspace one, and both must agree before a row is returned.
/// </remarks>
public sealed class GetItemHandler(
    IItemTree tree,
    IPermissionResolver permissions)
    : IQueryHandler<GetItem, Result<Item>>
{
    /// <summary>Reads the item.</summary>
    /// <param name="query">The item to read.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The item, or why it could not be read.</returns>
    public async ValueTask<Result<Item>> HandleAsync(GetItem query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        var itemId = query.ItemId;

        var item = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null)
        {
            return Result.Failure<Item>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        var mayRead = await permissions
            .CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken)
            .ConfigureAwait(false);

        return mayRead
            ? Result.Success(item)
            : Result.Failure<Item>(ItemErrors.NotFound($"No item {itemId} is visible."));
    }
}

/// <summary>
/// Route handler for reading one item.
/// </summary>
/// <remarks>
/// Named apart from <see cref="GetItem"/> itself: the query record already owns that identifier in
/// this namespace, and a route handler with the same name would be an ambiguous simple name at the
/// <c>MapGet</c> call site.
/// </remarks>
internal static class GetItemEndpoint
{
    /// <summary>Handles a request for one item.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the query to its handler.</param>
    /// <returns>The item, or a problem describing why it could not be read.</returns>
    internal static async Task<Results<Ok<ItemResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher
            .QueryAsync<GetItem, Result<Item>>(new GetItem(ItemId.From(itemId)), httpContext.RequestAborted)
            .ConfigureAwait(false);

        if (result.IsFailure)
        {
            return TypedResults.Problem(ItemEndpoints.Problem(httpContext, result.Error));
        }

        var item = result.Value;

        var withChildren = await dispatcher
            .QueryAsync<ItemsWithChildren, IReadOnlySet<ItemId>>(
                new ItemsWithChildren(item.WorkspaceId, [item.Id]),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        // Folded from the item's own schema, because a rollup declared at an item is about that
        // item's children - which is the same question a listing asks of its container.
        var rollups = await dispatcher
            .QueryAsync<ItemRollups, IReadOnlyDictionary<ItemId, JsonObject>>(
                new ItemRollups(item.WorkspaceId, [item.Id], item.Id),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return TypedResults.Ok(
            ItemMapping.ToResponse(
                item,
                withChildren.Contains(item.Id),
                rollups.TryGetValue(item.Id, out var computed) ? computed : new JsonObject()));
    }
}
