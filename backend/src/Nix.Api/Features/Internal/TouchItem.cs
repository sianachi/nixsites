using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Internal;

/// <summary>
/// Records that an item's body changed, without Core ever reading the body.
/// </summary>
/// <param name="ItemId">The item whose body was written.</param>
/// <remarks>
/// The collaboration service owns the content tables and Core owns the envelope, so when a flush
/// appends body updates the envelope's modification stamp goes stale. This command is how the seam
/// stays honest: fired once per flush batch, it bumps <c>last_modified</c> so listings, search
/// staleness and "edited five minutes ago" stay true - and Core never has to parse a CRDT to know
/// something happened.
/// </remarks>
public sealed record TouchItem(ItemId ItemId) : ICommand<ItemId>;

/// <summary>Stamps an item as modified by the acting principal, now.</summary>
/// <remarks>
/// Requires write permission: a touch is a claim that the caller changed the body, and a principal
/// who may not write the body may not claim to have written it. An item that is invisible or
/// read-only fails as not found, the same non-answer every other refusal gives.
/// </remarks>
public sealed class TouchItemHandler(
    IItemTree tree,
    IPermissionResolver permissions,
    INixSessionContextAccessor session,
    TimeProvider clock)
    : ICommandHandler<TouchItem, ItemId>
{
    private readonly INixSessionContextAccessor _session = session;

    /// <summary>Stamps the item.</summary>
    /// <param name="command">The item to stamp.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>The item's identifier, or why it could not be stamped.</returns>
    public async ValueTask<Result<ItemId>> HandleAsync(TouchItem command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var context = _session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

        var item = await tree.FindAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
        if (item is null)
        {
            return Result.Failure<ItemId>(
                InternalErrors.NotFound($"No item {command.ItemId} is visible."));
        }

        var mayWrite = await permissions
            .CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken)
            .ConfigureAwait(false);
        if (!mayWrite)
        {
            return Result.Failure<ItemId>(
                InternalErrors.NotFound($"No item {command.ItemId} is visible."));
        }

        await tree
            .TouchAsync(command.ItemId, context.PrincipalId, clock.GetUtcNow(), cancellationToken)
            .ConfigureAwait(false);

        return Result.Success(command.ItemId);
    }
}

/// <summary>
/// Route handler for the collaboration service's touched notification.
/// </summary>
/// <remarks>
/// Named apart from <see cref="TouchItem"/> itself: the command record already owns that
/// identifier in this namespace, and a route handler with the same name would be an ambiguous
/// simple name at the <c>MapPost</c> call site.
/// </remarks>
internal static class TouchItemEndpoint
{
    /// <summary>Handles a touched notification for one item.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the command to its handler.</param>
    /// <returns>Nothing on success, or a problem describing the refusal.</returns>
    internal static async Task<Results<NoContent, ProblemHttpResult>> Handle(
        Guid itemId,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher
            .SendAsync<TouchItem, ItemId>(new TouchItem(ItemId.From(itemId)), httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.Match<Results<NoContent, ProblemHttpResult>>(
            _ => TypedResults.NoContent(),
            error => TypedResults.Problem(InternalEndpoints.Problem(httpContext, error)));
    }
}
