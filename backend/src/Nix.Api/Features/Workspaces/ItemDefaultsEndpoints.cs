using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Http;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

/// <summary>Changes the settings new items in a workspace start with. A null field is left as it is.</summary>
/// <param name="Comments">Whether new items start with comments on.</param>
/// <param name="Suggesting">Whether new items start with suggesting on.</param>
/// <param name="ReviewStates">Whether new files start with review states on.</param>
/// <param name="FullWidth">Whether new items start at full width.</param>
internal sealed record SetItemDefaultsRequest(bool? Comments, bool? Suggesting, bool? ReviewStates, bool? FullWidth);

/// <summary>
/// The workspace's item defaults. Any member reads them; only an owner changes them. They apply to
/// items created afterwards and never to existing items or by inheritance from a parent.
/// </summary>
internal static class ItemDefaultsEndpoints
{
    internal static IEndpointRouteBuilder MapItemDefaultsEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        endpoints.MapGet("/api/v1/workspaces/{workspaceId:guid}/item-defaults", Read)
            .WithTags("Workspaces")
            .WithName("GetWorkspaceItemDefaults")
            .WithSummary("The settings new items in a workspace start with")
            .AddEndpointFilter(WorkspaceLocks.ClosedWorkspaceFilter.InvokeAsync)
            .Produces<ItemSettings>()
            .ProducesProblem(StatusCodes.Status404NotFound);
        endpoints.MapPut("/api/v1/workspaces/{workspaceId:guid}/item-defaults", Write)
            .WithTags("Workspaces")
            .WithName("SetWorkspaceItemDefaults")
            .WithSummary("Change the settings new items in a workspace start with")
            .WithDescription("Workspace owners only. A field left null is unchanged. Existing items keep their own settings.")
            .AddEndpointFilter(WorkspaceLocks.ClosedWorkspaceFilter.InvokeAsync)
            .Produces<ItemSettings>()
            .ProducesProblem(StatusCodes.Status404NotFound)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        return endpoints;
    }

    private static async Task<IResult> Read(
        Guid workspaceId, HttpContext context, [FromServices] WorkspaceAdministrationStore store) =>
        Answer(context, await store.ReadItemDefaultsAsync(WorkspaceId.From(workspaceId), context.RequestAborted).ConfigureAwait(false));

    private static async Task<IResult> Write(
        Guid workspaceId, SetItemDefaultsRequest request, HttpContext context, [FromServices] WorkspaceAdministrationStore store) =>
        Answer(context, await store.SetItemDefaultsAsync(
            WorkspaceId.From(workspaceId),
            ItemSettings.Patch(request.Comments, request.Suggesting, request.ReviewStates, request.FullWidth),
            context.RequestAborted).ConfigureAwait(false));

    // Not visible and not allowed are one answer, as for every other workspace write.
    private static IResult Answer(HttpContext context, string? stored) =>
        stored is null
            ? TypedResults.Problem(ApiProblem.Create(
                context, 404, "workspaces.not_found", "Workspace not found", "No such workspace is visible."))
            : TypedResults.Ok(ItemSettings.Read(stored));
}
