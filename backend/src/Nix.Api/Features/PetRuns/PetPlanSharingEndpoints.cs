using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Abstractions.PetRuns;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Features.Pets;
using Nix.Http;
using Nix.Messaging;
using Nix.Persistence.PetRuns;

namespace Nix.Features.PetRuns;

internal static class PetPlanSharingEndpoints
{
    internal static void AddPetPlanSharing(this IServiceCollection services)
    {
        services.AddScoped<IPetPlanConsentStore, PetPlanConsentStore>();
        services.AddScoped<PetPlanSharingService>();
        services.AddScoped<PetPlanHistoryGuard>();
        services.AddScoped<PetPlanDecisionAccess>();
        services.AddScoped<PetPlanDecisionContextService>();
        services.AddScoped(service => new PetDisclosureConsentGuard(service.GetRequiredService<PetPlanSharingService>()));
        services.AddScoped<IPetDisclosureConsentGuard>(service => service.GetRequiredService<PetDisclosureConsentGuard>());
    }

    internal static void MapPetPlanSharingEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/v1/workspaces/{workspaceId:guid}/pet-plans/{runId:guid}").WithTags("Pet Plans");
        group.MapPost("/decision-handoffs", CreateHandoff).WithName("CreatePetPlanDecisionHandoff").WithRequestBodyLimit(2048)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapGet("/decision-handoffs/{handoffId:guid}", ReadHandoff).WithName("GetPetPlanDecisionHandoff");
        group.MapDelete("/decision-handoffs/{handoffId:guid}", RevokeHandoff).WithName("RevokePetPlanDecisionHandoff")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapPost("/decision-contexts", AuthorizeHandoff).WithName("AuthorizePetPlanDecisionContext").WithRequestBodyLimit(2048)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
    }

    internal static void MapPetSharingInternalEndpoints(this IEndpointRouteBuilder endpoints) =>
        endpoints.MapPost("/internal/pets/sharing/validate", ValidateSharing)
            .ExcludeFromDescription().WithRequestBodyLimit(20 * 1024);

    private static async Task<Results<Ok<PetPlanDecisionHandoffResponse>, ProblemHttpResult>> CreateHandoff(
        Guid workspaceId, Guid runId, CreatePetPlanDecisionHandoffRequest request, HttpContext http, [FromServices] PetPlanDecisionContextService contexts) =>
        Respond(http, await contexts.CreateAsync(workspaceId, runId, request, http.RequestAborted).ConfigureAwait(false));

    private static async Task<Results<Ok<PetPlanDecisionHandoffStatus>, ProblemHttpResult>> ReadHandoff(
        Guid workspaceId, Guid runId, Guid handoffId, HttpContext http, [FromServices] PetPlanDecisionContextService contexts) =>
        Respond(http, await contexts.ReadAsync(workspaceId, runId, handoffId, http.RequestAborted).ConfigureAwait(false));

    private static async Task<Results<Ok<PetPlanDecisionHandoffStatus>, ProblemHttpResult>> AuthorizeHandoff(
        Guid workspaceId, Guid runId, CreatePetPlanDecisionContextRequest request, HttpContext http, [FromServices] PetPlanDecisionContextService contexts) =>
        Respond(http, await contexts.AuthorizeAsync(workspaceId, runId, request, http.RequestAborted).ConfigureAwait(false));

    private static async Task<Results<Ok<PetPlanDecisionHandoffStatus>, ProblemHttpResult>> RevokeHandoff(
        Guid workspaceId, Guid runId, Guid handoffId, HttpContext http, [FromServices] PetPlanDecisionContextService contexts) =>
        Respond(http, await contexts.RevokeAsync(workspaceId, runId, handoffId, http.RequestAborted).ConfigureAwait(false));

    private static async Task<Ok<ValidatePetSharingResponse>> ValidateSharing(ValidatePetSharingRequest request,
        HttpContext http, [FromServices] PetPlanSharingService sharing, [FromServices] IIsolatedUnitOfWork isolated)
    {
        http.Response.Headers.CacheControl = "no-store";
        var bound = sharing.Unprotect(request.Attestation);
        if (bound is null || bound.TenantId != request.TenantId || bound.PrincipalId != request.PrincipalId
            || bound.WorkspaceId != request.WorkspaceId || bound.PetId != request.PetId || bound.Provider != request.Provider
            || bound.TurnId != request.TurnId || bound.TenantId == Guid.Empty || bound.PrincipalId == Guid.Empty || bound.WorkspaceId == Guid.Empty)
        {
            return TypedResults.Ok(new ValidatePetSharingResponse(false));
        }

        var context = new NixSessionContext(TenantId.From(bound.TenantId), WorkspaceId.From(bound.WorkspaceId), PrincipalId.From(bound.PrincipalId));
        var allowed = await isolated.RunAsync(context, async (services, token) => new IsolatedOutcome<bool>(
            await services.GetRequiredService<PetPlanSharingService>().ValidateAsync(request.Attestation, token).ConfigureAwait(false)
            && await services.GetRequiredService<PetPlanHistoryGuard>().ValidateAsync(bound, request, token).ConfigureAwait(false), false),
            http.RequestAborted).ConfigureAwait(false);
        return TypedResults.Ok(new ValidatePetSharingResponse(allowed, allowed ? bound.RecipientRevision : null,
            allowed ? bound.SourceScope : null));
    }

    private static Results<Ok<T>, ProblemHttpResult> Respond<T>(HttpContext http, Result<T> result)
    {
        http.Response.Headers.CacheControl = "no-store";
        return result.Match<Results<Ok<T>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(http, error));
    }

    private static ProblemHttpResult Problem(HttpContext http, NixError error) => TypedResults.Problem(ApiProblem.Create(http,
        error.Code is "pet_plans.owner_decision_required" or "pet_plans.context_denied" ? 403 : 422,
        error.Code, "Companion sharing request failed", error.Message));
}
