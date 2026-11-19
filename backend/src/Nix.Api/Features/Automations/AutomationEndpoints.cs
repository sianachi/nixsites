using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Automations;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Features.Linear;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.Automations;

/// <summary>The automation rule routes (ADR-0051 section 6). Every rule is private to its owner.</summary>
internal static class AutomationEndpoints
{
    internal static IEndpointRouteBuilder MapAutomationEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var workspaces = endpoints.MapGroup("/api/v1/workspaces/{workspaceId:guid}/automations").WithTags("Automations");
        workspaces.MapGet("", List).WithName("ListAutomations");
        workspaces.MapPost("", Create).WithName("CreateAutomation")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        var automations = endpoints.MapGroup("/api/v1/automations/{ruleId:guid}").WithTags("Automations");
        automations.MapGet("", Get).WithName("GetAutomation");
        automations.MapPut("", Update).WithName("UpdateAutomation")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        automations.MapDelete("", Delete).WithName("DeleteAutomation")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        automations.MapGet("/runs", ListRuns).WithName("ListAutomationRuns");
        automations.MapPost("/run", Run).WithName("RunAutomation")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        automations.MapPost("/test", Test).WithName("TestAutomation")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        return endpoints;
    }

    private static async Task<Results<Ok<AutomationListResponse>, ProblemHttpResult>> List(
        Guid workspaceId, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Map(context, await dispatcher.SendAsync<ListAutomations, AutomationListResponse>(
            new(WorkspaceId.From(workspaceId)), context.RequestAborted).ConfigureAwait(false));

    private static async Task<Results<Created<AutomationRuleResponse>, ProblemHttpResult>> Create(
        Guid workspaceId, AutomationRuleInput request, HttpContext context, [FromServices] NixDispatcher dispatcher,
        [FromServices] LinearBrowserAccess browser)
    {
        var result = await dispatcher.SendAsync<CreateAutomation, AutomationRuleResponse>(
            new(WorkspaceId.From(workspaceId), request)
            {
                VerifiedBrowserOwner = await VerifyRoutineOwnerAsync(request, context, browser).ConfigureAwait(false),
            }, context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Created<AutomationRuleResponse>, ProblemHttpResult>>(
            value => TypedResults.Created($"/api/v1/automations/{value.Id:D}", value),
            error => Problem(context, error));
    }

    private static async Task<Results<Ok<AutomationRuleResponse>, ProblemHttpResult>> Get(
        Guid ruleId, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Map(context, await dispatcher.SendAsync<GetAutomation, AutomationRuleResponse>(new(ruleId), context.RequestAborted).ConfigureAwait(false));

    private static async Task<Results<Ok<AutomationRuleResponse>, ProblemHttpResult>> Update(
        Guid ruleId, UpdateAutomationRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher,
        [FromServices] LinearBrowserAccess browser) =>
        Map(context, await dispatcher.SendAsync<UpdateAutomation, AutomationRuleResponse>(
            new(ruleId, request.ExpectedRevision, request.Rule)
            {
                VerifiedBrowserOwner = await VerifyRoutineOwnerAsync(request.Rule, context, browser).ConfigureAwait(false),
            }, context.RequestAborted).ConfigureAwait(false));

    private static async ValueTask<bool> VerifyRoutineOwnerAsync(AutomationRuleInput request, HttpContext context, LinearBrowserAccess browser) =>
        request.Actions is JsonArray actions && actions.OfType<JsonObject>().Any(action =>
            action["type"] is JsonValue field && field.TryGetValue<string>(out var type)
            && type is StartPetRunAction.Type or PollPetMailboxAction.Type)
        && await browser.VerifyAsync(context, requireOrigin: true).ConfigureAwait(false) is not null;

    private static async Task<Results<NoContent, ProblemHttpResult>> Delete(
        Guid ruleId, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<DeleteAutomation, bool>(new(ruleId), context.RequestAborted).ConfigureAwait(false);
        return result.IsSuccess ? TypedResults.NoContent() : Problem(context, result.Error);
    }

    private static async Task<Results<Ok<AutomationRunsPageResponse>, ProblemHttpResult>> ListRuns(
        Guid ruleId, HttpContext context, [FromServices] NixDispatcher dispatcher, string? cursor = null) =>
        Map(context, await dispatcher.SendAsync<ListAutomationRuns, AutomationRunsPageResponse>(
            new(ruleId, cursor), context.RequestAborted).ConfigureAwait(false));

    private static async Task<Results<Ok<AutomationRunResponse>, ProblemHttpResult>> Run(
        Guid ruleId, AutomationItemRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Map(context, await dispatcher.SendAsync<RunAutomation, AutomationRunResponse>(
            new(ruleId, request.ItemId), context.RequestAborted).ConfigureAwait(false));

    private static async Task<Results<Ok<AutomationTestResponse>, ProblemHttpResult>> Test(
        Guid ruleId, AutomationItemRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Map(context, await dispatcher.SendAsync<TestAutomation, AutomationTestResponse>(
            new(ruleId, request.ItemId), context.RequestAborted).ConfigureAwait(false));

    private static Results<Ok<T>, ProblemHttpResult> Map<T>(HttpContext context, Result<T> result) =>
        result.Match<Results<Ok<T>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));

    private static ProblemHttpResult Problem(HttpContext context, NixError error)
    {
        var (status, title) = error.Code switch
        {
            AutomationErrors.NotFoundCode => (StatusCodes.Status404NotFound, "Automation is unavailable"),
            AutomationErrors.ConflictCode => (StatusCodes.Status409Conflict, "Automation changed"),
            AutomationErrors.LimitReachedCode => (StatusCodes.Status422UnprocessableEntity, "Too many automations"),
            AutomationErrors.ActionUnavailableCode => (StatusCodes.Status422UnprocessableEntity, "Action is unavailable"),
            AutomationErrors.PetRoutineOwnerRequiredCode => (StatusCodes.Status403Forbidden, "A browser session is required"),
            _ => (StatusCodes.Status422UnprocessableEntity, "Automation is invalid"),
        };
        return TypedResults.Problem(ApiProblem.Create(context, status, error.Code, title, error.Message));
    }
}
