using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Features.BrowserAuth;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.PetRuns;

internal static class PetPlanEndpoints
{
    internal static void AddPetPlans(this IServiceCollection services)
    {
        services.ConfigureHttpJsonOptions(options =>
        {
            options.SerializerOptions.TypeInfoResolverChain.Add(PetPlanJsonContext.Default);
            options.SerializerOptions.TypeInfoResolverChain.Add(PetPlanDispatchJsonContext.Default);
        });
        services.AddScoped<IQueryHandler<ListPetPlans, Result<PetPlansResponse>>, PetRunService>();
        services.AddScoped<IQueryHandler<ReadPetPlan, Result<PetPlanResponse>>, PetRunService>();
        services.AddScoped<ICommandHandler<StartPetPlan, PetPlanResponse>, PetRunService>();
        services.AddScoped<ICommandHandler<RevisePetPlan, PetPlanResponse>, PetRunService>();
        services.AddScoped<ICommandHandler<DecidePetPlan, PetPlanResponse>, PetRunService>();
        services.AddScoped<ICommandHandler<AnswerPetPlan, PetPlanResponse>, PetRunService>();
        services.AddScoped<ICommandHandler<CancelPetPlan, PetPlanResponse>, PetRunService>();
        services.AddScoped<ICommandHandler<ClaimPetPlanStep, PetPlanStepClaimResponse>, PetRunService>();
        services.AddScoped<ICommandHandler<RecordPetPlanStep, PetPlanResponse>, PetRunService>();
        services.AddScoped<ICommandHandler<UndoPetPlanStep, PetPlanResponse>, PetRunService>();
        services.AddPetPlanSharing();
        PetWorkspaceToolCapability.Register(services);
        services.AddScoped<PetPlanDispatchService>();
        services.AddScoped<PetPlanSourceGuard>();
    }

    internal static void MapPetPlanEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var plans = endpoints.MapGroup("/api/v1/workspaces/{workspaceId:guid}/pet-plans").WithTags("Pet Plans");
        plans.MapGet("", List).WithName("ListPetPlans").WithSummary("List the caller's workspace plans.");
        plans.MapGet("/{runId:guid}", Read).WithName("GetPetPlan").WithSummary("Inspect an owned plan and its observed results.");
        plans.MapGet("/{runId:guid}/watch", Watch).WithName("WatchPetPlan").WithSummary("Poll the current plan revision.");
        plans.MapPost("", Start).WithName("CreatePetPlan").WithSummary("Prepare a workspace plan for owner review.")
            .WithRequestBodyLimit(64 * 1024).RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        plans.MapPost("/{runId:guid}/drafts", Revise).WithName("RevisePetPlan").WithSummary("Prepare a fresh plan from stored editable fields or feedback.")
            .WithRequestBodyLimit(128 * 1024).RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        plans.MapPost("/{runId:guid}/plans/{planId:guid}/decision", Decide).WithName("DecidePetPlan")
            .WithSummary("Record exact owner or explicitly delegated consent for a prepared plan version.")
            .WithRequestBodyLimit(4096).RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        plans.MapPost("/{runId:guid}/answer", Answer).WithName("AnswerPetPlan").WithSummary("Answer a clarification without approving effects.")
            .WithRequestBodyLimit(16 * 1024).RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        plans.MapPost("/{runId:guid}/cancel", Cancel).WithName("CancelPetPlan").WithSummary("Cancel the plan's undispatched effects.")
            .WithRequestBodyLimit(1024).RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        plans.MapPost("/{runId:guid}/plans/{planId:guid}/steps/{stepId:guid}/claim", Claim).WithName("ClaimPetPlanStep")
            .WithSummary("Claim the next frozen effect requiring an owner client.").WithRequestBodyLimit(2048)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        plans.MapPost("/{runId:guid}/plans/{planId:guid}/steps/{stepId:guid}/result", Record).WithName("RecordPetPlanStep")
            .WithSummary("Record a bounded receipt for the exact active client claim.").WithRequestBodyLimit(96 * 1024)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        plans.MapPost("/{runId:guid}/plans/{planId:guid}/steps/{stepId:guid}/undo", Undo).WithName("UndoPetPlanStep")
            .WithSummary("Queue the supported undo of one applied receipt.").WithRequestBodyLimit(1024)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        endpoints.MapPetPlanSharingEndpoints();
        endpoints.MapPetSharingInternalEndpoints();
        endpoints.MapPetPlanDispatchEndpoints();
    }

    private static Task<Results<Ok<PetPlansResponse>, ProblemHttpResult>> List(Guid workspaceId, HttpContext context,
        [FromServices] BrowserAccess browser, [FromServices] NixDispatcher dispatcher) =>
        Handle(context, browser, false, ct => dispatcher.QueryAsync<ListPetPlans, Result<PetPlansResponse>>(new(WorkspaceId.From(workspaceId)), ct));
    private static Task<Results<Ok<PetPlanResponse>, ProblemHttpResult>> Read(Guid workspaceId, Guid runId, HttpContext context,
        [FromServices] BrowserAccess browser, [FromServices] NixDispatcher dispatcher) =>
        Handle(context, browser, false, ct => dispatcher.QueryAsync<ReadPetPlan, Result<PetPlanResponse>>(new(WorkspaceId.From(workspaceId), runId), ct));
    private static Task<Results<Ok<PetPlanResponse>, ProblemHttpResult>> Watch(Guid workspaceId, Guid runId, HttpContext context,
        [FromServices] BrowserAccess browser, [FromServices] NixDispatcher dispatcher, long after = 0) => after < 0
            ? Task.FromResult<Results<Ok<PetPlanResponse>, ProblemHttpResult>>(Problem(context, new("pet_plans.invalid", "Revision cannot be negative.")))
            : Read(workspaceId, runId, context, browser, dispatcher);
    private static Task<Results<Ok<PetPlanResponse>, ProblemHttpResult>> Start(Guid workspaceId, StartPetPlanRequest request, HttpContext context,
        [FromServices] BrowserAccess browser, [FromServices] NixDispatcher dispatcher) =>
        Handle(context, browser, true, ct => dispatcher.SendAsync<StartPetPlan, PetPlanResponse>(new(WorkspaceId.From(workspaceId), request), ct));
    private static Task<Results<Ok<PetPlanResponse>, ProblemHttpResult>> Revise(Guid workspaceId, Guid runId, RevisePetPlanRequest request,
        HttpContext context, [FromServices] BrowserAccess browser, [FromServices] NixDispatcher dispatcher) =>
        Handle(context, browser, true, ct => dispatcher.SendAsync<RevisePetPlan, PetPlanResponse>(new(WorkspaceId.From(workspaceId), runId, request), ct));
    private static Task<Results<Ok<PetPlanResponse>, ProblemHttpResult>> Decide(Guid workspaceId, Guid runId, Guid planId, DecidePetPlanRequest request,
        HttpContext context, [FromServices] BrowserAccess browser, [FromServices] NixDispatcher dispatcher) =>
        Handle(context, browser, false, ct => dispatcher.SendAsync<DecidePetPlan, PetPlanResponse>(new(WorkspaceId.From(workspaceId), runId, planId, request), ct));
    private static Task<Results<Ok<PetPlanResponse>, ProblemHttpResult>> Answer(Guid workspaceId, Guid runId, AnswerPetPlanRequest request,
        HttpContext context, [FromServices] BrowserAccess browser, [FromServices] NixDispatcher dispatcher) =>
        Handle(context, browser, true, ct => dispatcher.SendAsync<AnswerPetPlan, PetPlanResponse>(new(WorkspaceId.From(workspaceId), runId, request), ct));
    private static Task<Results<Ok<PetPlanResponse>, ProblemHttpResult>> Cancel(Guid workspaceId, Guid runId, CancelPetPlanRequest request,
        HttpContext context, [FromServices] BrowserAccess browser, [FromServices] NixDispatcher dispatcher) =>
        Handle(context, browser, false, ct => dispatcher.SendAsync<CancelPetPlan, PetPlanResponse>(new(WorkspaceId.From(workspaceId), runId, request), ct));
    private static Task<Results<Ok<PetPlanStepClaimResponse>, ProblemHttpResult>> Claim(Guid workspaceId, Guid runId, Guid planId, Guid stepId,
        ClaimPetPlanStepRequest request, HttpContext context, [FromServices] BrowserAccess browser, [FromServices] NixDispatcher dispatcher) =>
        Handle(context, browser, true, ct => dispatcher.SendAsync<ClaimPetPlanStep, PetPlanStepClaimResponse>(new(WorkspaceId.From(workspaceId), runId, planId, stepId, request), ct));
    private static Task<Results<Ok<PetPlanResponse>, ProblemHttpResult>> Record(Guid workspaceId, Guid runId, Guid planId, Guid stepId,
        RecordPetPlanStepRequest request, HttpContext context, [FromServices] BrowserAccess browser, [FromServices] NixDispatcher dispatcher) =>
        Handle(context, browser, true, ct => dispatcher.SendAsync<RecordPetPlanStep, PetPlanResponse>(new(WorkspaceId.From(workspaceId), runId, planId, stepId, request), ct));
    private static Task<Results<Ok<PetPlanResponse>, ProblemHttpResult>> Undo(Guid workspaceId, Guid runId, Guid planId, Guid stepId,
        UndoPetPlanStepRequest request, HttpContext context, [FromServices] BrowserAccess browser, [FromServices] NixDispatcher dispatcher) =>
        Handle(context, browser, true, ct => dispatcher.SendAsync<UndoPetPlanStep, PetPlanResponse>(new(WorkspaceId.From(workspaceId), runId, planId, stepId, request), ct));

    private static async Task<Results<Ok<T>, ProblemHttpResult>> Handle<T>(HttpContext context, BrowserAccess browser,
        bool requireBrowser, Func<CancellationToken, ValueTask<Result<T>>> work)
    {
        context.Response.Headers.CacheControl = "no-store";
        if (requireBrowser && await browser.VerifyAsync(context, requireOrigin: true).ConfigureAwait(false) is null)
        {
            return Problem(context, new("pet_plans.browser_required", "Open this plan in a signed-in Nix browser."));
        }
        var result = await work(context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<T>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));
    }

    internal static ProblemHttpResult Problem(HttpContext context, NixError error) => TypedResults.Problem(ApiProblem.Create(context,
        error.Code switch
        {
            "pet_runs.not_found" => 404,
            "pet_plans.browser_required" or "pet_runs.disabled" or "pet_plans.decision_forbidden" => 403,
            "pet_plans.conflict" or "pet_runs.conflict" or "pet_runs.stale_review" => 409,
            _ => 422,
        }, error.Code, "Plan request failed", error.Message));
}
