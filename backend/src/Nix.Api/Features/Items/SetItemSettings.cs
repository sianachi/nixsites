using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Errors;
using Nix.Features.Workspaces;
using Nix.Messaging;

namespace Nix.Features.Items;

/// <summary>Switches an item's optional features on or off.</summary>
/// <param name="ItemId">The item.</param>
/// <param name="Comments">The comments switch, or <see langword="null"/> to leave it.</param>
/// <param name="Suggesting">The suggesting switch, or <see langword="null"/> to leave it.</param>
/// <param name="ReviewStates">The file review-states switch, or <see langword="null"/> to leave it.</param>
/// <param name="FullWidth">The full-width switch, or <see langword="null"/> to leave it.</param>
/// <remarks>
/// Anybody who may edit the item may change its settings, like its protections: the switches shape
/// how the item is used, not who may see it. Only the switches named are written, so two people
/// changing different ones from the same stale read do not overwrite each other.
/// </remarks>
public sealed record SetItemSettings(ItemId ItemId, bool? Comments, bool? Suggesting, bool? ReviewStates, bool? FullWidth)
    : ICommand<Item>;

/// <summary>Handles <see cref="SetItemSettings"/>.</summary>
public sealed class SetItemSettingsHandler(IItemTree tree, IPermissionResolver permissions)
    : ICommandHandler<SetItemSettings, Item>
{
    /// <inheritdoc />
    public async ValueTask<Result<Item>> HandleAsync(SetItemSettings command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var item = await tree.FindAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Item>(ItemErrors.NotFound($"No item {command.ItemId} is visible."));
        }

        if (command.Comments is null && command.Suggesting is null && command.ReviewStates is null && command.FullWidth is null)
        {
            return Result.Success(item);
        }

        await tree.SetSettingsAsync(
            command.ItemId,
            ItemSettings.Patch(command.Comments, command.Suggesting, command.ReviewStates, command.FullWidth),
            cancellationToken).ConfigureAwait(false);

        var updated = await tree.FindAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
        return updated is null
            ? Result.Failure<Item>(ItemErrors.NotFound($"Item {command.ItemId} disappeared during the write."))
            : Result.Success(updated);
    }
}

/// <summary>Changes an item's settings. A null field is left as it is.</summary>
/// <param name="Comments">Whether people may comment on the item.</param>
/// <param name="Suggesting">Whether the item's editor offers suggesting.</param>
/// <param name="ReviewStates">Whether a file's versions carry review states.</param>
/// <param name="FullWidth">Whether a note's body uses the full pane width.</param>
internal sealed record SetItemSettingsRequest(bool? Comments, bool? Suggesting, bool? ReviewStates, bool? FullWidth);

/// <summary>Route handler for changing an item's settings.</summary>
internal static class SetItemSettingsEndpoint
{
    /// <summary>Handles a request to change an item's settings.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="request">The switches to set.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the command to its handler.</param>
    /// <returns>The item as it now stands, or a problem describing the refusal.</returns>
    internal static async Task<Results<Ok<ItemResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        SetItemSettingsRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher,
        [FromServices] IItemTree tree,
        [FromServices] IPublicLinkStore workspaces,
        [FromServices] AccessTokenSessionContext credential)
    {
        // [SEC] Turning review states off makes a public note serve a file's newest upload unapproved,
        // so it is held to the same gate as approving a version.
        if (request.ReviewStates is not null
            && await tree.FindAsync(ItemId.From(itemId), httpContext.RequestAborted).ConfigureAwait(false) is { } item
            && (await workspaces.FindWorkspaceAsync(item.WorkspaceId, httpContext.RequestAborted).ConfigureAwait(false)
                is not { } workspace
                || !AgentPolicyGate.MayChangeVersionState(credential, workspace)))
        {
            return TypedResults.Problem(ApiProblem.Create(
                httpContext, 403, "items.review_states_forbidden", "Not allowed",
                "This credential may not change review states in this workspace."));
        }

        var result = await dispatcher
            .SendAsync<SetItemSettings, Item>(
                new SetItemSettings(ItemId.From(itemId), request.Comments, request.Suggesting, request.ReviewStates, request.FullWidth),
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
