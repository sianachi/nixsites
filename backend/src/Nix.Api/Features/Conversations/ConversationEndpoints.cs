using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Primitives;
using Nix.Errors;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.Conversations;

internal static class ConversationEndpoints
{
    internal static IEndpointRouteBuilder MapConversationEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost("/api/v1/workspaces/{workspaceId:guid}/conversations", Create).WithName("CreateConversation").WithTags("Conversations").RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        endpoints.MapPost("/api/v1/workspaces/{workspaceId:guid}/conversations/import", Create).WithName("ImportConversation").WithTags("Conversations").RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        var group = endpoints.MapGroup("/api/v1/conversations/{itemId:guid}").WithTags("Conversations");
        group.MapPost("/configure", Configure).WithName("ConfigureConversation").RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapGet("", Read).WithName("GetConversation");
        group.MapGet("/messages", Messages).WithName("GetConversationMessages");
        group.MapGet("/watch", Read).WithName("WatchConversation");
        group.MapPost("/turns", Send).WithName("SendConversation").RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapPost("/cancel", Cancel).WithName("CancelConversation").RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapPut("/sources", Sources).WithName("ChangeConversationSources").RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        endpoints.MapPost("/internal/conversations/{itemId:guid}/tools", ConversationTools.Handle).ExcludeFromDescription();
        return endpoints;
    }

    private static async Task<Results<Ok<ConversationResponse>, ProblemHttpResult>> Configure(Guid itemId, ConfigureConversationRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Respond(await dispatcher.SendAsync<ConfigureConversation, ConversationResponse>(new(itemId, request), context.RequestAborted).ConfigureAwait(false), context);
    private static async Task<Results<Ok<ConversationResponse>, ProblemHttpResult>> Create(Guid workspaceId, CreateConversationRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Respond(await dispatcher.SendAsync<CreateConversation, ConversationResponse>(new(workspaceId, request), context.RequestAborted).ConfigureAwait(false), context);
    private static async Task<Results<Ok<ConversationResponse>, ProblemHttpResult>> Read(Guid itemId, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Respond(await dispatcher.QueryAsync<GetConversation, Result<ConversationResponse>>(new(itemId), context.RequestAborted).ConfigureAwait(false), context);
    private static async Task<Results<Ok<ConversationMessagesResponse>, ProblemHttpResult>> Messages(Guid itemId, HttpContext context, [FromServices] NixDispatcher dispatcher, string? cursor = null, int limit = 50) =>
        Respond(await dispatcher.QueryAsync<GetConversationMessages, Result<ConversationMessagesResponse>>(new(itemId, cursor, limit), context.RequestAborted).ConfigureAwait(false), context);
    private static async Task<Results<Ok<ConversationResponse>, ProblemHttpResult>> Send(Guid itemId, SendConversationRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Respond(await dispatcher.SendAsync<SendConversation, ConversationResponse>(new(itemId, request), context.RequestAborted).ConfigureAwait(false), context);
    private static async Task<Results<Ok<ConversationResponse>, ProblemHttpResult>> Cancel(Guid itemId, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Respond(await dispatcher.SendAsync<CancelConversation, ConversationResponse>(new(itemId), context.RequestAborted).ConfigureAwait(false), context);
    private static async Task<Results<Ok<ConversationResponse>, ProblemHttpResult>> Sources(Guid itemId, ConversationSourcesRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Respond(await dispatcher.SendAsync<ChangeConversationSources, ConversationResponse>(new(itemId, request), context.RequestAborted).ConfigureAwait(false), context);
    private static Results<Ok<T>, ProblemHttpResult> Respond<T>(Result<T> result, HttpContext context)
    {
        context.Response.Headers.CacheControl = "no-store";
        return result.Match<Results<Ok<T>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => TypedResults.Problem(ApiProblem.Create(context,
            error.Code.EndsWith("not_found", StringComparison.Ordinal) ? 404 : error.Code is "conversations.busy" or "conversations.conflict" or "conversations.sources_unavailable" or "conversations.workspace_protected" ? 409 : 422,
            error.Code, "Conversation request failed", error.Message)));
    }
}
