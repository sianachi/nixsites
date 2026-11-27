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
            .WithSummary("Post a message under an item, or a reply under a message")
            .WithDescription("'to' lists people and pets by id; the text is never parsed. A token that addresses a pet needs the pets:send scope "
                + "and the workspace's 'agents may address pets' switch: off posts the message and starts no turn, ask holds each pet's turn "
                + "until its owner approves it in the app (7 days), on starts it at once (50 pet turns per token per day, 429 'messages.pet_turn_limit'). "
                + "The response says where each addressed pet's turn stands (pending, working, answered, failed, declined or expired) and the poster's monthly pet budget; "
                + "a used-up budget is 403 'pets.budget_exhausted'.")
            .Produces<PostedMessageResponse>(StatusCodes.Status201Created).ProducesProblem(403).ProducesProblem(404).ProducesProblem(409).ProducesProblem(422).ProducesProblem(429)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapGet("/pet-turns", PetTurns).WithName("GetMessagePetTurns")
            .WithSummary("Where each pet a message addressed stands")
            .Produces<MessagePetStatesResponse>().ProducesProblem(404);
        group.MapPost("/pet-turns/{petId:guid}/approve", Approve).WithName("ApproveMessagePetTurn")
            .WithSummary("Start a pet's waiting turn, or save the fact it wants remembered (the app only)")
            .Produces<MessagePetState>().ProducesProblem(403).ProducesProblem(404).ProducesProblem(409)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapPost("/pet-turns/{petId:guid}/dismiss", Dismiss).WithName("DismissMessagePetTurn")
            .WithSummary("Decline a pet's waiting turn, or drop the fact it wants remembered (the app only)")
            .Produces<MessagePetState>().ProducesProblem(403).ProducesProblem(404)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapGet("/message-directory", Directory).WithName("GetMessageDirectory")
            .WithDescription("The people who can read the item and, for the app or a token with the pets:send scope, the caller's own pets. A token without pets:send sees people only.")
            .Produces<MessageDirectoryResponse>().ProducesProblem(404);
        return endpoints;
    }

    private static async Task<Results<Created<PostedMessageResponse>, ProblemHttpResult>> Post(
        Guid itemId, PostMessageRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<PostMessage, PostedMessage>(new(ItemId.From(itemId), request), context.RequestAborted).ConfigureAwait(false);
        return result.IsSuccess
            ? TypedResults.Created($"/api/v1/items/{result.Value.Message.Id}",
                new PostedMessageResponse(ItemMapping.ToResponse(result.Value.Message, false), result.Value.Pets, result.Value.Budget))
            : Problem(context, result.Error);
    }

    private static async Task<Results<Ok<MessagePetStatesResponse>, ProblemHttpResult>> PetTurns(
        Guid itemId, HttpContext context, [FromServices] MessageHandler handler)
    {
        context.Response.Headers.CacheControl = "no-store";
        var result = await handler.PetStates(ItemId.From(itemId), context.RequestAborted).ConfigureAwait(false);
        return result.IsSuccess ? TypedResults.Ok(result.Value) : Problem(context, result.Error);
    }

    private static Task<Results<Ok<MessagePetState>, ProblemHttpResult>> Approve(
        Guid itemId, Guid petId, HttpContext context, [FromServices] MessageHandler handler) => Decide(itemId, petId, true, context, handler);

    private static Task<Results<Ok<MessagePetState>, ProblemHttpResult>> Dismiss(
        Guid itemId, Guid petId, HttpContext context, [FromServices] MessageHandler handler) => Decide(itemId, petId, false, context, handler);

    private static async Task<Results<Ok<MessagePetState>, ProblemHttpResult>> Decide(
        Guid itemId, Guid petId, bool approve, HttpContext context, MessageHandler handler)
    {
        var result = await handler.Decide(ItemId.From(itemId), petId, approve, context.RequestAborted).ConfigureAwait(false);
        return result.IsSuccess ? TypedResults.Ok(result.Value) : Problem(context, result.Error);
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
            "messages.interactive_only" or "messages.pets_interactive_only" or "messages.pets_scope_required" or "pets.budget_exhausted" => 403,
            "messages.pet_turn_limit" => 429,
            "items.locked" => 423,
            "items.children_protected" or "items.reserved_type" or "messages.memory_off" or "messages.memory_full" or "pets.settings_conflict" => 409,
            _ => 404,
        };
        return TypedResults.Problem(ApiProblem.Create(context, status, error.Code, "Message request refused", error.Message));
    }
}
