using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Items;

/// <summary>Sets whether an item can be deleted, whether it accepts new children, and whether several people may edit it at once.</summary>
/// <param name="ItemId">The item.</param>
/// <param name="NoDelete">The deletion protection, or <see langword="null"/> to leave it.</param>
/// <param name="NoChildren">The new-children protection, or <see langword="null"/> to leave it.</param>
/// <param name="Collaboration">Whether several people may edit at once, or <see langword="null"/> to leave it.</param>
/// <remarks>
/// Anybody who may edit the item may protect or unprotect it: a protection guards against a slip,
/// not against a colleague. The exception is a deletion protection the system holds on an item it
/// manages, which only the managing feature releases.
/// </remarks>
public sealed record SetItemProtection(ItemId ItemId, bool? NoDelete, bool? NoChildren, bool? Collaboration = null) : ICommand<Item>;

/// <summary>Handles <see cref="SetItemProtection"/>.</summary>
public sealed class SetItemProtectionHandler(
    IItemTree tree,
    IItemProtections protections,
    IPermissionResolver permissions,
    IFinanceLock? topology = null) : ICommandHandler<SetItemProtection, Item>
{
    /// <inheritdoc />
    public async ValueTask<Result<Item>> HandleAsync(SetItemProtection command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var itemId = command.ItemId;
        var item = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Item>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        if (topology is not null)
        {
            var workspace = item.WorkspaceId;
            await topology.AcquireWorkspaceTopologyAsync(workspace, cancellationToken).ConfigureAwait(false);
            item = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
            if (item is null || item.WorkspaceId != workspace
                || !await permissions.CanWriteWorkspaceAsync(workspace, cancellationToken).ConfigureAwait(false))
            {
                return Result.Failure<Item>(ItemErrors.NotFound($"No item {itemId} is visible."));
            }
        }

        if (item.LifecycleState != ItemLifecycleState.Active)
        {
            return Result.Failure<Item>(
                ItemErrors.LifecycleConflict("A deleted item's protection cannot be changed."));
        }

        const string managedRefusal =
            "This item belongs to a linked calendar. Unlink the calendar in settings to remove it.";

        // Only what actually changes is written, so two people setting different protections do
        // not overwrite each other from the same stale read.
        bool? noDelete = command.NoDelete is { } wantedDelete && wantedDelete != item.NoDelete ? wantedDelete : null;
        bool? noChildren = command.NoChildren is { } wantedChildren && wantedChildren != item.NoChildren ? wantedChildren : null;
        bool? collaboration = command.Collaboration is { } wantedCollaboration && wantedCollaboration != item.Collaboration ? wantedCollaboration : null;
        if (noDelete is not null && item.ManagedBy is not null)
        {
            return Result.Failure<Item>(ItemErrors.ProtectionManaged(managedRefusal));
        }

        if (noDelete is null && noChildren is null && collaboration is null)
        {
            return Result.Success(item);
        }

        if (!await protections.SetAsync(itemId, noDelete, noChildren, collaboration, cancellationToken).ConfigureAwait(false))
        {
            // The statement's own guard: a sync took the item over after it was read above.
            return Result.Failure<Item>(ItemErrors.ProtectionManaged(managedRefusal));
        }

        var updated = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        return updated is null
            ? Result.Failure<Item>(ItemErrors.NotFound($"Item {itemId} disappeared during the write."))
            : Result.Success(updated);
    }
}

/// <summary>Changes an item's protections. A null field is left as it is.</summary>
/// <param name="NoDelete">Whether the item is protected from deletion.</param>
/// <param name="NoChildren">Whether the item refuses new children.</param>
/// <param name="Collaboration">Whether several people may edit the item at once.</param>
internal sealed record SetItemProtectionRequest(bool? NoDelete, bool? NoChildren, bool? Collaboration = null);

/// <summary>Route handler for changing an item's protections.</summary>
internal static class SetItemProtectionEndpoint
{
    /// <summary>Handles a request to change an item's protections.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="request">The protections to set.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the command to its handler.</param>
    /// <returns>The item as it now stands, or a problem describing the refusal.</returns>
    internal static async Task<Results<Ok<ItemResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        SetItemProtectionRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher
            .SendAsync<SetItemProtection, Item>(
                new SetItemProtection(ItemId.From(itemId), request.NoDelete, request.NoChildren, request.Collaboration),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        if (result.IsFailure)
        {
            return TypedResults.Problem(ItemEndpoints.Problem(httpContext, result.Error));
        }

        return TypedResults.Ok(
            await ItemMapping.RespondAsync(result.Value, dispatcher, httpContext.RequestAborted)
                .ConfigureAwait(false));
    }
}
