using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Errors;
using Nix.Features.Items;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.Messages;

internal static class MessageEndpoints
{
    internal static IEndpointRouteBuilder MapMessageEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/v1/items/{itemId:guid}").WithTags("Messages");
        group.MapPost("/messages", Post).WithName("PostMessage")
            .Produces<ItemResponse>(StatusCodes.Status201Created).ProducesProblem(403).ProducesProblem(404).ProducesProblem(409).ProducesProblem(422)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapGet("/message-directory", Directory).WithName("GetMessageDirectory")
            .Produces<MessageDirectoryResponse>().ProducesProblem(404);
        return endpoints;
    }

    private static async Task<Results<Created<ItemResponse>, ProblemHttpResult>> Post(
        Guid itemId, PostMessageRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<PostMessage, Item>(new(ItemId.From(itemId), request), context.RequestAborted).ConfigureAwait(false);
        return result.IsSuccess
            ? TypedResults.Created($"/api/v1/items/{result.Value.Id}", ItemMapping.ToResponse(result.Value, false))
            : Problem(context, result.Error);
    }

    private static async Task<Results<Ok<MessageDirectoryResponse>, ProblemHttpResult>> Directory(
        Guid itemId, HttpContext context, [FromServices] NixDispatcher dispatcher, string? query = null)
    {
        context.Response.Headers.CacheControl = "no-store";
        var result = await dispatcher.QueryAsync<GetMessageDirectory, Result<MessageDirectoryResponse>>(new(ItemId.From(itemId), query), context.RequestAborted).ConfigureAwait(false);
        return result.IsSuccess ? TypedResults.Ok(result.Value) : Problem(context, result.Error);
    }

    private static ProblemHttpResult Problem(HttpContext context, NixError error)
    {
        var status = error.Code switch
        {
            "messages.invalid" or "items.invalid_properties" => 422,
            "messages.interactive_only" or "messages.pets_interactive_only" => 403,
            "items.locked" => 423,
            "items.children_protected" or "items.reserved_type" => 409,
            _ => 404,
        };
        return TypedResults.Problem(ApiProblem.Create(context, status, error.Code, "Message request refused", error.Message));
    }
}
