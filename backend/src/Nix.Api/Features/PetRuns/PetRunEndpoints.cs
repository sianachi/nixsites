using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Features.BrowserAuth;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.PetRuns;

internal static class PetRunEndpoints
{
    internal static void AddPetRuns(this IServiceCollection services)
    {
        services.AddScoped<PetRunService>();
        services.AddScoped<IQueryHandler<ListPetRuns, Result<PetRunsResponse>>, PetRunService>();
        services.AddScoped<IQueryHandler<ReadPetRun, Result<PetRunResponse>>, PetRunService>();
        services.AddScoped<ICommandHandler<StartPetRun, PetRunResponse>, PetRunService>();
        services.AddScoped<ICommandHandler<AnswerPetRun, PetRunResponse>, PetRunService>();
        services.AddScoped<ICommandHandler<DecidePetRunProposal, PetRunResponse>, PetRunService>();
        services.AddScoped<ICommandHandler<DecidePetRunScope, PetRunResponse>, PetRunService>();
        services.AddScoped<ICommandHandler<RevisePetRunProposal, PetRunResponse>, PetRunService>();
        services.AddScoped<ICommandHandler<CancelPetRun, PetRunResponse>, PetRunService>();
        services.AddScoped<ICommandHandler<RetryPetRun, PetRunResponse>, PetRunService>();
        services.AddScoped<ICommandHandler<UndoPetRunStep, PetRunResponse>, PetRunService>();
        services.AddScoped<IPetRunCapability, PetTaskCommentCapability>();
        NixActionPetCapability.Register(services);
        services.AddScoped<IPetRunCapability, SheetPetCapability>();
        PetCanvasCapability.Register(services);
        services.AddPetBrowser();
        services.AddPetRoutines();
        services.AddPetPlans();
    }

    internal static void MapPetRunEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPetPlanEndpoints();
        var runs = endpoints.MapGroup("/api/v1/items/{itemId:guid}/pet-runs").WithTags("Pet Runs");
        runs.MapGet("", ListItem).WithName("ListItemPetRuns").WithSummary("List the caller's pet jobs on the task.");
        runs.MapGet("/{runId:guid}", Read).WithName("GetPetRun").WithSummary("Read an owned pet job and its action receipts.");
        runs.MapGet("/{runId:guid}/watch", Watch).WithName("WatchPetRun").WithSummary("Read the current pet job checkpoint for polling.");
        runs.MapPost("", Start).WithName("CreatePetRun").WithSummary("Queue a task-scoped pet job.")
            .WithRequestBodyLimit(64 * 1024).RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        runs.MapPost("/{runId:guid}/answer", Answer).WithName("AnswerPetRun").WithSummary("Answer the pet's pending question.")
            .WithRequestBodyLimit(16 * 1024).RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        runs.MapPost("/{runId:guid}/proposals/{proposalId:guid}/decision", Decide).WithName("DecidePetRunProposal")
            .WithSummary("Approve or decline the exact pending proposal in an active browser.")
            .WithRequestBodyLimit(1024).RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        runs.MapPost("/{runId:guid}/scope", DecideScope).WithName("DecidePetRunScope")
            .WithSummary("Decide the exact pending request for a read-only source or one ability.")
            .WithRequestBodyLimit(1024).RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        runs.MapPost("/{runId:guid}/proposals/{proposalId:guid}/revise", Revise).WithName("RevisePetRunProposal")
            .WithSummary("Supersede the current proposal and prepare a fresh draft in the same job.")
            .WithRequestBodyLimit(16 * 1024).RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        runs.MapPost("/{runId:guid}/cancel", Cancel).WithName("CancelPetRun").WithSummary("Cancel an owned pet job.")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        runs.MapPost("/{runId:guid}/retry", Retry).WithName("RetryPetRun").WithSummary("Retry a failed pet job with a known outcome.")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        runs.MapPost("/{runId:guid}/steps/{stepId:guid}/undo", Undo).WithName("UndoPetRunStep")
            .WithSummary("Queue the supported undo of an applied step.").RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        endpoints.MapGet("/api/v1/workspaces/{workspaceId:guid}/pet-runs", ListWorkspace)
            .WithTags("Pet Runs").WithName("ListWorkspacePetRuns").WithSummary("List the caller's pet jobs in a workspace.");
    }

    private static Task<Results<Ok<PetRunsResponse>, ProblemHttpResult>> ListItem(
        Guid itemId, HttpContext context, [FromServices] BrowserAccess browser, [FromServices] NixDispatcher dispatcher) =>
        Handle(context, browser, false, ct => dispatcher.QueryAsync<ListPetRuns, Result<PetRunsResponse>>(
            new ListPetRuns(ItemId.From(itemId), null), ct));

    private static Task<Results<Ok<PetRunsResponse>, ProblemHttpResult>> ListWorkspace(
        Guid workspaceId, HttpContext context, [FromServices] BrowserAccess browser, [FromServices] NixDispatcher dispatcher) =>
        Handle(context, browser, false, ct => dispatcher.QueryAsync<ListPetRuns, Result<PetRunsResponse>>(
            new ListPetRuns(null, WorkspaceId.From(workspaceId)), ct));

    private static Task<Results<Ok<PetRunResponse>, ProblemHttpResult>> Read(
        Guid itemId, Guid runId, HttpContext context, [FromServices] BrowserAccess browser, [FromServices] NixDispatcher dispatcher) =>
        Handle(context, browser, false, ct => dispatcher.QueryAsync<ReadPetRun, Result<PetRunResponse>>(
            new ReadPetRun(ItemId.From(itemId), runId), ct));

    private static Task<Results<Ok<PetRunResponse>, ProblemHttpResult>> Watch(
        Guid itemId, Guid runId, HttpContext context, [FromServices] BrowserAccess browser,
        [FromServices] NixDispatcher dispatcher, long after = 0)
    {
        context.Response.Headers.CacheControl = "no-store";
        return after < 0
            ? Task.FromResult<Results<Ok<PetRunResponse>, ProblemHttpResult>>(Problem(context, new NixError("pet_runs.invalid", "Revision cannot be negative.")))
            : Read(itemId, runId, context, browser, dispatcher);
    }

    private static Task<Results<Ok<PetRunResponse>, ProblemHttpResult>> Start(
        Guid itemId, StartPetRunRequest request, HttpContext context, [FromServices] BrowserAccess browser, [FromServices] NixDispatcher dispatcher) =>
        Handle(context, browser, true, ct => dispatcher.SendAsync<StartPetRun, PetRunResponse>(
            new StartPetRun(ItemId.From(itemId), request), ct));

    private static Task<Results<Ok<PetRunResponse>, ProblemHttpResult>> Answer(
        Guid itemId, Guid runId, AnswerPetRunRequest request, HttpContext context,
        [FromServices] BrowserAccess browser, [FromServices] NixDispatcher dispatcher) =>
        Handle(context, browser, true, ct => dispatcher.SendAsync<AnswerPetRun, PetRunResponse>(
            new AnswerPetRun(ItemId.From(itemId), runId, request), ct));

    private static Task<Results<Ok<PetRunResponse>, ProblemHttpResult>> Decide(
        Guid itemId, Guid runId, Guid proposalId, DecidePetProposalRequest request, HttpContext context,
        [FromServices] BrowserAccess browser, [FromServices] NixDispatcher dispatcher) =>
        Handle(context, browser, true, ct => dispatcher.SendAsync<DecidePetRunProposal, PetRunResponse>(
            new DecidePetRunProposal(ItemId.From(itemId), runId, proposalId, request.Approve), ct));

    private static Task<Results<Ok<PetRunResponse>, ProblemHttpResult>> DecideScope(
        Guid itemId, Guid runId, DecidePetRunScopeRequest request, HttpContext context,
        [FromServices] BrowserAccess browser, [FromServices] NixDispatcher dispatcher) =>
        Handle(context, browser, true, ct => dispatcher.SendAsync<DecidePetRunScope, PetRunResponse>(
            new DecidePetRunScope(ItemId.From(itemId), runId, request), ct));

    private static Task<Results<Ok<PetRunResponse>, ProblemHttpResult>> Revise(
        Guid itemId, Guid runId, Guid proposalId, RevisePetRunProposalRequest request, HttpContext context,
        [FromServices] BrowserAccess browser, [FromServices] NixDispatcher dispatcher) =>
        Handle(context, browser, true, ct => dispatcher.SendAsync<RevisePetRunProposal, PetRunResponse>(
            new RevisePetRunProposal(ItemId.From(itemId), runId, proposalId, request), ct));

    private static Task<Results<Ok<PetRunResponse>, ProblemHttpResult>> Cancel(
        Guid itemId, Guid runId, HttpContext context, [FromServices] BrowserAccess browser, [FromServices] NixDispatcher dispatcher) =>
        Handle(context, browser, true, ct => dispatcher.SendAsync<CancelPetRun, PetRunResponse>(
            new CancelPetRun(ItemId.From(itemId), runId), ct));

    private static Task<Results<Ok<PetRunResponse>, ProblemHttpResult>> Retry(
        Guid itemId, Guid runId, HttpContext context, [FromServices] BrowserAccess browser, [FromServices] NixDispatcher dispatcher) =>
        Handle(context, browser, true, ct => dispatcher.SendAsync<RetryPetRun, PetRunResponse>(
            new RetryPetRun(ItemId.From(itemId), runId), ct));

    private static Task<Results<Ok<PetRunResponse>, ProblemHttpResult>> Undo(
        Guid itemId, Guid runId, Guid stepId, HttpContext context, [FromServices] BrowserAccess browser, [FromServices] NixDispatcher dispatcher) =>
        Handle(context, browser, true, ct => dispatcher.SendAsync<UndoPetRunStep, PetRunResponse>(
            new UndoPetRunStep(ItemId.From(itemId), runId, stepId), ct));

    private static async Task<Results<Ok<T>, ProblemHttpResult>> Handle<T>(
        HttpContext context, BrowserAccess browser, bool write, Func<CancellationToken, ValueTask<Result<T>>> work)
    {
        context.Response.Headers.CacheControl = "no-store";
        if (await browser.VerifyAsync(context, requireOrigin: write).ConfigureAwait(false) is null)
        {
            return Problem(context, new NixError("pet_runs.browser_required", "Open this task in a signed-in Nix browser."));
        }

        var result = await work(context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<T>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));
    }

    private static ProblemHttpResult Problem(HttpContext context, NixError error) => TypedResults.Problem(ApiProblem.Create(
        context, error.Code switch
        {
            "pet_runs.not_found" => 404,
            "pet_runs.browser_required" or "pet_runs.disabled" => 403,
            "pet_runs.conflict" or "pet_runs.sources_unavailable" => 409,
            _ => 422,
        }, error.Code, "Pet job request failed", error.Message));
}
