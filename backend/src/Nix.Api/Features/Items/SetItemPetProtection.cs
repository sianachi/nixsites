using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Messaging;

namespace Nix.Features.Items;

internal sealed record SetItemPetProtectionRequest(bool? WithholdFromPets);

internal sealed record WorkspacePetProtectionResponse(bool HasProtectedItems);

internal static class ItemPetProtectionEndpoints
{
    internal static async Task<Results<Ok<ItemResponse>, ProblemHttpResult>> Set(
        Guid itemId,
        SetItemPetProtectionRequest request,
        HttpContext http,
        [FromServices] NixDispatcher dispatcher,
        [FromServices] IItemTree tree,
        [FromServices] IVisibleItems visible,
        [FromServices] AccessTokenSessionContext credential)
    {
        if (!credential.IsInteractive)
        {
            return TypedResults.Problem(ApiProblem.Create(
                http, StatusCodes.Status403Forbidden, "items.pet_protection_interactive_only", "Not allowed",
                "Pet protection can only be changed from a signed-in browser session."));
        }

        if (request.WithholdFromPets is not { } withhold)
        {
            return TypedResults.Problem(ApiProblem.Create(
                http, StatusCodes.Status400BadRequest, "items.pet_protection_required", "Choose a pet protection setting",
                "Provide withholdFromPets as true or false."));
        }

        var id = ItemId.From(itemId);
        var cancellationToken = http.RequestAborted;
        var lookup = await visible.FindAsync(id, ItemAccess.Manage, cancellationToken).ConfigureAwait(false);
        if (lookup.IsFailure
            || !await tree.SetItemPetProtectionAsync(id, lookup.Value.WorkspaceId, withhold, cancellationToken).ConfigureAwait(false)
            || await tree.FindAsync(id, cancellationToken).ConfigureAwait(false) is not { } updated)
        {
            return TypedResults.Problem(ItemEndpoints.Problem(http, ItemErrors.NotFound($"No item {id} is visible.")));
        }

        return TypedResults.Ok(await ItemMapping.RespondAsync(updated, dispatcher, cancellationToken).ConfigureAwait(false));
    }

    internal static async Task<Results<Ok<WorkspacePetProtectionResponse>, ProblemHttpResult>> ReadWorkspace(
        Guid workspaceId,
        HttpContext http,
        [FromServices] IItemTree tree,
        [FromServices] IPermissionResolver permissions,
        [FromServices] AccessTokenSessionContext credential)
    {
        var id = WorkspaceId.From(workspaceId);
        var cancellationToken = http.RequestAborted;
        if ((!credential.IsInteractive && !credential.IsPetTurn)
            || !await permissions.CanManageWorkspaceAsync(id, cancellationToken).ConfigureAwait(false))
        {
            return TypedResults.Problem(ApiProblem.Create(
                http, StatusCodes.Status404NotFound, "workspaces.not_found", "Workspace not found",
                "No such workspace is visible."));
        }

        http.Response.Headers.CacheControl = "no-store";
        return TypedResults.Ok(new WorkspacePetProtectionResponse(
            await tree.AnyItemsWithheldFromPetsAsync(id, cancellationToken).ConfigureAwait(false)));
    }
}
