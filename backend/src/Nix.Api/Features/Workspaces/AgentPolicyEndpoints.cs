using Nix.Errors;
using Nix.Http;

namespace Nix.Features.Workspaces;

/// <summary>
/// Changes what access tokens and external bearers may do in a workspace. A null field is left as it is.
/// </summary>
/// <param name="AgentsMayApprove">Whether they may approve or revoke file versions.</param>
/// <param name="AgentsMayCreatePublicLinks">Whether they may create public links.</param>
internal sealed record SetAgentPolicyRequest(bool? AgentsMayApprove, bool? AgentsMayCreatePublicLinks);

/// <summary>Lane 1 stub: the workspace agent policy. Replace the handler; keep the route and types.</summary>
internal static class AgentPolicyEndpoints
{
    internal static IEndpointRouteBuilder MapAgentPolicyEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        endpoints.MapPut(
                "/api/v1/workspaces/{workspaceId:guid}/agent-policy",
                (Guid workspaceId, SetAgentPolicyRequest request, HttpContext context) =>
                    TypedResults.Problem(ApiProblem.Create(
                        context,
                        StatusCodes.Status501NotImplemented,
                        "workspaces.not_implemented",
                        "Not implemented",
                        "This route is not implemented yet.")))
            .WithTags("Workspaces")
            .WithName("SetWorkspaceAgentPolicy")
            .Produces<WorkspaceResponse>()
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        return endpoints;
    }
}
