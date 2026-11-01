using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.Sync;

internal static class NativeReplayEndpoints
{
    internal static IEndpointRouteBuilder MapNativeReplayEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost("/api/v1/workspaces/{workspaceId:guid}/sync/replay", Replay)
            .WithTags("NativeSync")
            .WithName("ReplayNativeOperation")
            .WithRequestBodyLimit(65536)
            .Produces<NativeReplayResponse>()
            .ProducesProblem(400)
            .ProducesProblem(409)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        return endpoints;
    }

    private static async Task<IResult> Replay(Guid workspaceId, NativeReplayRequest request, HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        context.Response.Headers.CacheControl = "no-store";
        var result = await dispatcher.SendAsync<NativeReplay, NativeReplayResponse>(
            new NativeReplay(WorkspaceId.From(workspaceId), request), context.RequestAborted).ConfigureAwait(false);
        return result.IsSuccess
            ? TypedResults.Ok(result.Value)
            : TypedResults.Problem(ApiProblem.Create(context,
                result.Error.Code == NativeReplayHandler.InvalidCode ? 400 : 409,
                result.Error.Code, "Native replay refused", result.Error.Message));
    }
}
