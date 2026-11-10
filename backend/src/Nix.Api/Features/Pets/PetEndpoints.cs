using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Primitives;
using Nix.Errors;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.Pets;

internal static class PetEndpoints
{
    internal static IEndpointRouteBuilder MapPetEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/v1/me/pets").WithTags("Pets");
        group.MapGet("/settings", Get).WithName("GetPetSettings");
        group.MapPut("/settings", Save).WithName("SavePetSettings")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapGet("/connection", Connection)
            .WithName("GetPetConnection");
        // Provider API keys: stored protected, shown as hints, never returned. Interactive only
        // (AccessTokenScopePolicy): a personal access token must not be able to swap the key a
        // person's pets bill to.
        group.MapGet("/providers", ListProviderKeys).WithName("ListPetProviderKeys");
        group.MapPut("/providers/{provider}/key", SaveProviderKey).WithName("SavePetProviderKey")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity);
        group.MapDelete("/providers/{provider}/key", RemoveProviderKey).WithName("RemovePetProviderKey")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName)
            .ProducesProblem(StatusCodes.Status404NotFound);
        group.MapPost("/runtime", Runtime).WithName("PetRuntime")
            .WithRequestBodyLimit(PetWorkerClient.MaxRuntimeRequestBytes)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName)
            .ProducesProblem(StatusCodes.Status409Conflict);
        group.MapPost("/runtime/note", RuntimeNote).WithName("PetNoteRuntime")
            .WithRequestBodyLimit(PetWorkerClient.MaxRuntimeRequestBytes)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity);
        group.MapPost("/inline", PetInlineEndpoint.Handle).WithName("PetInlineWrite")
            .WithSummary("Stream an inline writing result for text selected in a note")
            .WithDescription(
                "Sends the selected text to the companion and streams the answer back as server-sent "
                + "events, unchanged from the worker. 'delta' events carry {\"text\": \"...\"} for each "
                + "piece as it is written; the stream then ends with exactly one 'done' event carrying "
                + "{\"text\": \"<the whole text>\"} or one 'error' event carrying {\"code\": \"inline.provider_failed"
                + " | inline.timeout | inline.too_long | inline.refused | inline.cancelled\", \"message\": \"...\"}. "
                + "Comment lines ': keep-alive' arrive after 15 seconds of silence. Closing the "
                + "connection cancels the model's turn. The request is refused before anything is sent "
                + "when it is malformed (422 'pets.invalid_request', byte limits apply to the UTF-8 "
                + "encoding), when inline writing is not turned on in the caller's pet settings (409 "
                + "'pets.inline_disabled'), when the item is not readable in that workspace (404 "
                + "'pets.not_found'), when the item is locked or under a locked ancestor even if this "
                + "credential has it unlocked (409 'pets.inline_item_locked'), or when two requests are "
                + "already open (429 'pets.inline_busy'). A companion that cannot answer is 503 "
                + "'pets.unavailable'. The server does not read the item's body: 'selection' and "
                + "'context' come from the client and are not verified to belong to 'itemId'.")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName)
            .Produces(StatusCodes.Status200OK, contentType: "text/event-stream")
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable);
        // Not rate limited by the writes policy: this is a read, and it must never wait behind
        // one, however often the client long-polls it. Cost: NixUnitOfWorkMiddleware keeps a
        // Postgres connection and transaction open for the whole wait (up to 20 s). The worker
        // caps concurrent watches at four per principal and answers the fifth with 429 at once,
        // which is what bounds the connections one person can pin.
        group.MapGet("/runtime/watch", Watch).WithName("WatchPetRuntime")
            .ProducesProblem(StatusCodes.Status429TooManyRequests);
        group.MapGet("/runtime/note/watch", WatchNote).WithName("WatchPetNoteRuntime")
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);
        // A stream pins a connection for up to 130 s; the companion's watcher cap bounds that per person, as for watch.
        group.MapPost("/runtime/stream", Stream).WithName("StreamPetRuntime")
            .WithSummary("Stream a conversation as server-sent events")
            .WithDescription(
                "Server-sent events for one conversation: 'snapshot' (the whole connection response, first on every "
                + "open and after any change that is not a text append), 'delta' ({revision, base, id, append}, "
                + "applicable only when the client's revision equals base) and 'end' ({revision}, at the lifetime, "
                + "after which the client reopens). Each event's id is the revision. A companion that cannot stream "
                + "is 501 'pets.stream_unavailable'; the caller then uses the watch endpoint.")
            .Produces(StatusCodes.Status200OK, contentType: "text/event-stream")
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status501NotImplemented)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable);
        group.MapPost("/runtime/note/stream", StreamNote).WithName("StreamPetNoteRuntime")
            .WithSummary("Stream a note conversation as server-sent events")
            .WithDescription("The same events as the chat stream, for the conversation attached to 'rootItemId'.")
            .Produces(StatusCodes.Status200OK, contentType: "text/event-stream")
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status501NotImplemented)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable);
        return endpoints;
    }

    private static Task<IResult> StreamNote(PetStreamRequest request, HttpContext context, [FromServices] PetWorkerClient worker, [FromServices] ILogger<PetWorkerClient> log) =>
        request.RootItemId is null
            ? Task.FromResult<IResult>(TypedResults.Problem(ApiProblem.Create(context, 422, "pets.invalid_request", "Companion request failed", "Choose a note for this conversation.")))
            : Stream(request, context, worker, log);

    private static async Task<IResult> Stream(PetStreamRequest request, HttpContext context, [FromServices] PetWorkerClient worker, [FromServices] ILogger<PetWorkerClient> log)
    {
        context.Response.Headers.CacheControl = "no-store";
        CancellationTokenSource? deadline = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
        try
        {
            deadline.CancelAfter(PetInlineLimits.StreamDeadline);
            var opened = await worker.OpenWatchStreamAsync(request.WorkspaceId, request.PetId, request.Mode, request.RootItemId, deadline.Token).ConfigureAwait(false);
            if (opened.IsFailure)
            {
                return TypedResults.Problem(ApiProblem.Create(context,
                    opened.Error.Code switch
                    {
                        "pets.not_found" => 404,
                        "pets.invalid_request" => 422,
                        "pets.too_many_watches" => 429,
                        "pets.stream_unavailable" => 501,
                        _ => 503,
                    }, opened.Error.Code, "Companion request failed", opened.Error.Message));
            }

            var result = new PetStreamResult(opened.Value, null, deadline, 32 * 1024 * 1024, (outcome, copied, _) =>
            {
                // A cap, a deadline or a client leaving is the normal end; only a broken worker is worth a line.
                if (outcome == "upstream_error")
                {
                    ApiLog.PetWorkerFailed(log, "watch_stream", $"the stream broke after {copied} bytes", "pets.unavailable");
                }
            });
            deadline = null;
            return result;
        }
        catch (OperationCanceledException) when (!context.RequestAborted.IsCancellationRequested)
        {
            return TypedResults.Problem(ApiProblem.Create(context, 503, "pets.unavailable", "Companion request failed", "The companion did not answer in time."));
        }
        finally
        {
            deadline?.Dispose();
        }
    }

    private static Task<Results<Ok<PetConnectionResponse>, ProblemHttpResult>> Connection(
        HttpContext context, [FromServices] PetWorkerClient worker) => Runtime(new("status"), context, worker);

    private static async Task<Results<Ok<PetConnectionResponse>, ProblemHttpResult>> Runtime(
        PetRuntimeRequest request, HttpContext context, [FromServices] PetWorkerClient worker)
    {
        context.Response.Headers.CacheControl = "no-store";
        var result = await worker.ExecuteAsync(request, context.RequestAborted).ConfigureAwait(false);
        return Respond(result, context);
    }

    private static async Task<Results<Ok<PetConnectionResponse>, ProblemHttpResult>> RuntimeNote(
        PetRuntimeRequest request, HttpContext context, [FromServices] PetWorkerClient worker)
    {
        if (request.RootItemId is null)
        {
            context.Response.Headers.CacheControl = "no-store";
            return Respond(Result.Failure<PetConnectionResponse>(new("pets.invalid_request", "Choose a note for this conversation.")), context);
        }

        return await Runtime(request, context, worker).ConfigureAwait(false);
    }

    private static Task<Results<Ok<PetConnectionResponse>, ProblemHttpResult>> WatchNote(
        Guid workspaceId, Guid petId, Guid rootItemId, HttpContext context, [FromServices] PetWorkerClient worker,
        string? mode = null, long after = 0) => Watch(workspaceId, petId, context, worker, mode, after, rootItemId);

    private static async Task<Results<Ok<PetConnectionResponse>, ProblemHttpResult>> Watch(
        Guid workspaceId, Guid petId, HttpContext context, [FromServices] PetWorkerClient worker, string? mode = null, long after = 0, Guid? rootItemId = null)
    {
        context.Response.Headers.CacheControl = "no-store";
        var result = await worker.ExecuteWatchAsync(workspaceId, petId, mode ?? string.Empty, after, context.RequestAborted, rootItemId).ConfigureAwait(false);
        return Respond(result, context);
    }

    private static Results<Ok<PetConnectionResponse>, ProblemHttpResult> Respond(
        Result<PetConnectionResponse> result, HttpContext context) =>
        result.Match<Results<Ok<PetConnectionResponse>, ProblemHttpResult>>(
            value => TypedResults.Ok(value),
            error => TypedResults.Problem(ApiProblem.Create(context,
                error.Code == "pets.not_found" ? 404
                    : error.Code == "pets.invalid_request" ? 422
                    : error.Code == "pets.busy" ? 409
                    : error.Code == "pets.too_many_watches" ? 429
                    : 503,
                error.Code, "Companion request failed", error.Message)));

    private static async Task<Ok<PetSettingsResponse>> Get(HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        TypedResults.Ok(await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), context.RequestAborted).ConfigureAwait(false));

    private static async Task<Results<Ok<PetSettingsResponse>, ProblemHttpResult>> Save(
        SavePetSettingsRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<SavePetSettings, PetSettingsResponse>(
            new(request.ExpectedRevision, request.Settings), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<PetSettingsResponse>, ProblemHttpResult>>(
            settings => TypedResults.Ok(settings),
            error => TypedResults.Problem(ApiProblem.Create(context,
                error.Code == "pets.settings_conflict" ? StatusCodes.Status409Conflict : StatusCodes.Status422UnprocessableEntity,
                error.Code, "Pet settings could not be saved", error.Message)));
    }

    private static async Task<Ok<PetProvidersResponse>> ListProviderKeys(HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        TypedResults.Ok(await dispatcher.QueryAsync<ListPetProviderKeys, PetProvidersResponse>(new(), context.RequestAborted).ConfigureAwait(false));

    private static async Task<Results<Ok<PetProviderKeyResponse>, ProblemHttpResult>> SaveProviderKey(
        string provider, SavePetProviderKeyRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        ArgumentNullException.ThrowIfNull(request);
        var result = await dispatcher.SendAsync<SavePetProviderKey, PetProviderKeyResponse>(new(provider, request.Key ?? string.Empty), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<PetProviderKeyResponse>, ProblemHttpResult>>(
            saved => TypedResults.Ok(saved),
            error => TypedResults.Problem(ApiProblem.Create(context, StatusCodes.Status422UnprocessableEntity, error.Code, "The key could not be saved", error.Message)));
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> RemoveProviderKey(
        string provider, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<RemovePetProviderKey, bool>(new(provider), context.RequestAborted).ConfigureAwait(false);
        if (result.IsFailure)
        {
            return TypedResults.Problem(ApiProblem.Create(context, StatusCodes.Status422UnprocessableEntity, result.Error.Code, "The key could not be removed", result.Error.Message));
        }

        return result.Value
            ? TypedResults.NoContent()
            : TypedResults.Problem(ApiProblem.Create(context, StatusCodes.Status404NotFound, "pets.no_key", "No key is stored", "There is no key stored for that provider."));
    }
}
