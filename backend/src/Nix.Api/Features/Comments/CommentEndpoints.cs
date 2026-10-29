using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Errors;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.Comments;

internal static class CommentEndpoints
{
    internal static IEndpointRouteBuilder MapCommentEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/v1/items/{itemId:guid}/comments").WithTags("Comments");
        group.MapGet("", List).WithName("ListComments")
            .Produces<CommentsResponse>().ProducesProblem(404).ProducesProblem(422).ProducesProblem(423);

        // Not rate limited by the writes policy (it is a read); bounded per principal instead, see
        // CommentWatchGate. NixUnitOfWorkMiddleware keeps one connection open for the whole wait.
        group.MapGet("/watch", Watch).WithName("WatchComments")
            .Produces<CommentsResponse>().ProducesProblem(404).ProducesProblem(422).ProducesProblem(423).ProducesProblem(429);
        group.MapPost("", Add).WithName("AddComment").ThreadWrite();
        group.MapPost("/{threadId:guid}/replies", Reply).WithName("ReplyComment").ThreadWrite();
        group.MapPatch("/{commentId:guid}", Edit).WithName("EditComment").ThreadWrite();
        group.MapPut("/{threadId:guid}/anchor", Anchor).WithName("SetCommentAnchor").ThreadWrite();
        group.MapPut("/{threadId:guid}/resolved", Resolve).WithName("SetCommentResolved").ThreadWrite();
        group.MapDelete("/{commentId:guid}", Delete).WithName("DeleteComment")
            .Produces(204).ProducesProblem(403).ProducesProblem(404).ProducesProblem(409).ProducesProblem(423)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        return endpoints;
    }

    private static RouteHandlerBuilder ThreadWrite(this RouteHandlerBuilder builder) => builder
        .Produces<CommentThreadDto>().ProducesProblem(403).ProducesProblem(404).ProducesProblem(409).ProducesProblem(422).ProducesProblem(423)
        .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

    private static async Task<Results<Ok<CommentsResponse>, ProblemHttpResult>> List(Guid itemId, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.QueryAsync<ListComments, Result<CommentsResponse>>(new(ItemId.From(itemId)), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<CommentsResponse>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));
    }

    private static async Task<Results<Ok<CommentsResponse>, ProblemHttpResult>> Watch(
        Guid itemId, HttpContext context, [FromServices] NixDispatcher dispatcher, [FromServices] INixSessionContextAccessor session,
        [FromServices] CommentWatchGate gate, long revision = 0)
    {
        context.Response.Headers.CacheControl = "no-store";
        var principalId = (session.Current ?? throw new InvalidOperationException("A session is required.")).PrincipalId.Value;
        if (!gate.TryEnter(principalId))
        {
            context.Response.Headers.RetryAfter = "5";
            return TypedResults.Problem(ApiProblem.Create(context, StatusCodes.Status429TooManyRequests,
                "comments.too_many_watches", "Too many active watches", "Close another tab and try again."));
        }

        try
        {
            var result = await dispatcher.QueryAsync<WatchComments, Result<CommentsResponse>>(new(ItemId.From(itemId), revision), context.RequestAborted).ConfigureAwait(false);
            return result.Match<Results<Ok<CommentsResponse>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));
        }
        finally
        {
            gate.Exit(principalId);
        }
    }

    private static Task<Results<Ok<CommentThreadDto>, ProblemHttpResult>> Add(Guid itemId, AddCommentRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Send(context, dispatcher, new AddComment(ItemId.From(itemId), request));

    private static Task<Results<Ok<CommentThreadDto>, ProblemHttpResult>> Reply(Guid itemId, Guid threadId, ReplyCommentRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Send(context, dispatcher, new ReplyComment(ItemId.From(itemId), threadId, request));

    private static Task<Results<Ok<CommentThreadDto>, ProblemHttpResult>> Edit(Guid itemId, Guid commentId, EditCommentRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Send(context, dispatcher, new EditComment(ItemId.From(itemId), commentId, request));

    private static Task<Results<Ok<CommentThreadDto>, ProblemHttpResult>> Anchor(Guid itemId, Guid threadId, CommentAnchorPositions request, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Send(context, dispatcher, new SetCommentAnchor(ItemId.From(itemId), threadId, request));

    private static Task<Results<Ok<CommentThreadDto>, ProblemHttpResult>> Resolve(Guid itemId, Guid threadId, CommentResolvedRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Send(context, dispatcher, new SetCommentResolved(ItemId.From(itemId), threadId, request.Resolved));

    private static async Task<Results<NoContent, ProblemHttpResult>> Delete(Guid itemId, Guid commentId, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<DeleteComment, Guid>(new(ItemId.From(itemId), commentId), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<NoContent, ProblemHttpResult>>(_ => TypedResults.NoContent(), error => Problem(context, error));
    }

    private static async Task<Results<Ok<CommentThreadDto>, ProblemHttpResult>> Send<TCommand>(HttpContext context, NixDispatcher dispatcher, TCommand command)
        where TCommand : ICommand<CommentThreadDto>
    {
        var result = await dispatcher.SendAsync<TCommand, CommentThreadDto>(command, context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<CommentThreadDto>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));
    }

    private static ProblemHttpResult Problem(HttpContext context, NixError error)
    {
        var status = error.Code switch
        {
            "comments.not_found" => 404,
            "items.locked" => 423,
            "items.lifecycle_conflict" => 409,
            "comments.forbidden" or "comments.not_author" => 403,
            _ => 422,
        };
        return TypedResults.Problem(ApiProblem.Create(context, status, error.Code, "Comment request refused", error.Message));
    }
}
