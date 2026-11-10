using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Http;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

/// <summary>
/// Changes what access tokens and external bearers may do in a workspace. A null field is left as it is.
/// </summary>
/// <param name="AgentsMayApprove">Whether they may approve or revoke file versions.</param>
/// <param name="AgentsMayCreatePublicLinks">Whether they may create public links.</param>
internal sealed record SetAgentPolicyRequest(bool? AgentsMayApprove, bool? AgentsMayCreatePublicLinks);

/// <summary>
/// [SEC] The workspace agent policy. Only an owner on an interactive session may change it, so no
/// token (whatever its scope) and no external bearer can unlock its own gate.
/// </summary>
internal static class AgentPolicyEndpoints
{
    internal static IEndpointRouteBuilder MapAgentPolicyEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        endpoints.MapPut("/api/v1/workspaces/{workspaceId:guid}/agent-policy", Handle)
            .WithTags("Workspaces")
            .WithName("SetWorkspaceAgentPolicy")
            .AddEndpointFilter(WorkspaceLocks.ClosedWorkspaceFilter.InvokeAsync)
            .Produces<WorkspaceResponse>()
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        return endpoints;
    }

    private static async Task<IResult> Handle(
        Guid workspaceId,
        SetAgentPolicyRequest request,
        HttpContext context,
        [FromServices] AccessTokenSessionContext credential,
        [FromServices] WorkspaceAdministrationStore store)
    {
        if (!credential.IsInteractive)
        {
            return TypedResults.Problem(ApiProblem.Create(
                context, 403, "workspaces.agent_policy_interactive_only", "Not allowed",
                "The agent policy can only be changed from a signed-in session."));
        }

        var id = WorkspaceId.From(workspaceId);
        if (!await store.SetAgentPolicyAsync(id, request.AgentsMayApprove, request.AgentsMayCreatePublicLinks, context.RequestAborted)
            .ConfigureAwait(false)
            || await store.FindForResponseAsync(id, context.RequestAborted).ConfigureAwait(false) is not { } updated)
        {
            return TypedResults.Problem(ApiProblem.Create(
                context, 404, "workspaces.not_found", "Workspace not found", "No such workspace is visible."));
        }

        return TypedResults.Ok(WorkspaceEndpoints.ToResponse(updated));
    }
}
