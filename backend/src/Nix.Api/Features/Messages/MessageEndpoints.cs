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
            .WithDescription("'to' lists people, pets and agents by id (kind person, pet or agent); the text is never parsed. A token that addresses a pet or an agent needs the agents scope "
                + "and the workspace's 'agents may address pets' switch: off posts the message and starts no turn, ask holds each pet's turn "
                + "until its owner approves it in the app (7 days), on starts it at once (50 pet turns per token per day, 429 'messages.pet_turn_limit'). "
                + "The response says where each addressed pet's turn stands (pending, working, answered, failed, declined or expired) and the poster's monthly pet budget; "
                + "a used-up budget is 403 'pets.budget_exhausted'. An agent is one of your own live tokens holding the agents scope (not the posting token); "
                + "the message lands in its inbox and nothing starts. A token may post 500 messages a day (429 'messages.token_message_limit'), and once the last 30 messages of a thread "
                + "all came from agents or pets, a token's message that addresses agents or pets is refused (409 'messages.thread_agent_limit') until a person writes in the app.")
            .Produces<PostedMessageResponse>(StatusCodes.Status201Created).ProducesProblem(403).ProducesProblem(404).ProducesProblem(409).ProducesProblem(422).ProducesProblem(429)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapGet("/pet-turns", PetTurns).WithName("GetMessagePetTurns")
            .WithSummary("Where each pet a message addressed stands")
            .Produces<MessagePetStatesResponse>().ProducesProblem(404);
        group.MapPost("/pet-turns/{petId:guid}/approve", Approve).WithName("ApproveMessagePetTurn")
            .WithSummary("Start a pet's waiting turn or save the fact it wants remembered (the app only)")
            .Produces<MessagePetState>().ProducesProblem(403).ProducesProblem(404).ProducesProblem(409)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapPost("/pet-turns/{petId:guid}/dismiss", Dismiss).WithName("DismissMessagePetTurn")
            .WithSummary("Decline a pet's waiting turn, or drop the fact it wants remembered (the app only)")
            .Produces<MessagePetState>().ProducesProblem(403).ProducesProblem(404)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapGet("/message-directory", Directory).WithName("GetMessageDirectory")
            .WithDescription("The people who can read the item and, for the app or a token with the agents scope, the caller's own pets and its other live agent tokens (kind agent). A token without the agents scope sees people only.")
            .Produces<MessageDirectoryResponse>().ProducesProblem(404);
        var me = endpoints.MapGroup("/api/v1/me/message-inbox").WithTags("Messages");
        me.MapGet(string.Empty, Inbox).WithName("GetMessageInbox")
            .WithSummary("The calling agent token's unread messages")
            .WithDescription("Unread messages addressed to the token that makes the call, newest first, each with its thread's first message, the item the thread sits under, its author and text. "
                + "Only a token with the agents scope has an inbox (403 'messages.agents_only'); nobody else reads it. 'after' is the 'next' of the previous page.")
            .Produces<MessageInboxResponse>().ProducesProblem(403);
        me.MapPost("/read", MarkRead).WithName("MarkMessagesRead")
            .WithSummary("Mark messages read in the calling agent token's inbox")
            .Produces<MarkMessagesReadResponse>().ProducesProblem(403).ProducesProblem(422)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        return endpoints;
    }

    private static async Task<Results<Ok<MessageInboxResponse>, ProblemHttpResult>> Inbox(
        HttpContext context, [FromServices] MessageHandler handler, Guid? after = null, int? limit = null)
    {
        context.Response.Headers.CacheControl = "no-store";
        var result = await handler.InboxAsync(after, limit, context.RequestAborted).ConfigureAwait(false);
        return result.IsSuccess ? TypedResults.Ok(result.Value) : Problem(context, result.Error);
    }

    private static async Task<Results<Ok<MarkMessagesReadResponse>, ProblemHttpResult>> MarkRead(
        MarkMessagesReadRequest request, HttpContext context, [FromServices] MessageHandler handler)
    {
        var result = await handler.MarkReadAsync(request.MessageIds, context.RequestAborted).ConfigureAwait(false);
        return result.IsSuccess ? TypedResults.Ok(result.Value) : Problem(context, result.Error);
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
            "messages.interactive_only" or "messages.pets_interactive_only" or "messages.pets_scope_required" or "messages.agents_only" or "pets.budget_exhausted" => 403,
            "messages.pet_turn_limit" or "messages.token_message_limit" => 429,
            "messages.thread_agent_limit" => 409,
            "items.locked" => 423,
            "items.children_protected" or "items.reserved_type" or "messages.memory_off" or "messages.memory_full" or "pets.settings_conflict" => 409,
            _ => 404,
        };
        return TypedResults.Problem(ApiProblem.Create(context, status, error.Code, "Message request refused", error.Message));
    }
}
