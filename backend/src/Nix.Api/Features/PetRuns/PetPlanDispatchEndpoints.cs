using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.BrowserAuth;
using Nix.Http;

namespace Nix.Features.PetRuns;

internal static class PetPlanDispatchEndpoints
{
    internal static bool IsServiceCallback(HttpRequest request)
    {
        if (!HttpMethods.IsPost(request.Method))
        {
            return false;
        }
        var path = request.Path.Value ?? "";
        if (path.Equals("/internal/pet-plans/requests/issue", StringComparison.OrdinalIgnoreCase)
            || path.Equals("/internal/pet-plans/requests/consume", StringComparison.OrdinalIgnoreCase)
            || path.Equals("/internal/pet-plans/requests/settle", StringComparison.OrdinalIgnoreCase)
            || path.Equals("/internal/pet-plans/executions/complete", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }
        const string prefix = "/internal/pet-plans/requests/";
        const string suffix = "/result";
        return path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) && path.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)
            && path.Length == prefix.Length + 36 + suffix.Length
            && Guid.TryParseExact(path.AsSpan(prefix.Length, 36), "D", out var requestId) && requestId != Guid.Empty;
    }

    internal static void MapPetPlanDispatchEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost("/internal/pet-plans/requests/issue", Issue).ExcludeFromDescription().WithRequestBodyLimit(160 * 1024);
        endpoints.MapPost("/internal/pet-plans/requests/{requestId:guid}/result", Poll).ExcludeFromDescription().WithRequestBodyLimit(4096);
        endpoints.MapPost("/internal/pet-plans/requests/consume", Consume).ExcludeFromDescription().WithRequestBodyLimit(160 * 1024);
        endpoints.MapPost("/internal/pet-plans/requests/settle", Settle).ExcludeFromDescription().WithRequestBodyLimit(96 * 1024);
        endpoints.MapPost("/internal/pet-plans/executions/complete", Complete).ExcludeFromDescription().WithRequestBodyLimit(96 * 1024);
        var owner = endpoints.MapGroup("/api/v1/workspaces/{workspaceId:guid}/pet-plans/{runId:guid}/io").WithTags("Pet Plans");
        owner.MapGet("", Next).WithName("GetPetPlanClientIntent").WithSummary("Read the next server-prepared exact request for an owner client.");
        owner.MapPost("/result", Result).WithName("RecordPetPlanClientIoResult").WithSummary("Return the response to the exact dispatched owner-client request.")
            .WithRequestBodyLimit(96 * 1024);
    }

    private static async Task<IResult> Issue(PetPlanIssueRequest request, HttpContext http,
        [FromServices] PetPlanDispatchService service)
    {
        var result = await service.IssueDetachedAsync(request, http.RequestAborted).ConfigureAwait(false);
        if (result.IsFailure)
        {
            return PetPlanEndpoints.Problem(http, result.Error);
        }
        return TypedResults.Ok(result.Value);
    }

    private static async Task<IResult> Poll(Guid requestId, PetPlanPollRequest request, HttpContext http,
        [FromServices] IIsolatedUnitOfWork isolated)
    {
        var result = await isolated.RunAsync(new(TenantId.From(request.TenantId), WorkspaceId.From(request.WorkspaceId), PrincipalId.From(request.PrincipalId)),
            async (services, ct) => new IsolatedOutcome<Result<PetPlanIoResult>>(
                await services.GetRequiredService<PetPlanDispatchService>().PollResultAsync(requestId, request, ct).ConfigureAwait(false), false),
            http.RequestAborted).ConfigureAwait(false);
        if (result.IsFailure)
        {
            return PetPlanEndpoints.Problem(http, result.Error);
        }
        return TypedResults.Ok(result.Value);
    }

    private static async Task<IResult> Consume(PetPlanConsumeRequest request, HttpContext http,
        [FromServices] NixTokenValidator validator, [FromServices] IIsolatedUnitOfWork isolated,
        [FromServices] IBrowserSessions browserSessions, [FromServices] TimeProvider clock)
    {
        var actor = await CallbackActorAsync(request.Token, request.DispatchPermit, request.RequestId,
            validator, browserSessions, clock, http.RequestAborted).ConfigureAwait(false);
        if (actor is null || request.Body is not null && Encoding.UTF8.GetByteCount(request.Body) > PetActionRequestBinding.MaximumBodyBytes)
        {
            return TypedResults.StatusCode(403);
        }
        var allowed = await isolated.RunAsync(actor.Value.Context, async (services, ct) =>
        {
            var actual = new DefaultHttpContext { RequestServices = services };
            actual.Request.Method = request.Method;
            var split = request.Target.IndexOf('?', StringComparison.Ordinal);
            actual.Request.Path = split < 0 ? request.Target : request.Target[..split];
            actual.Request.QueryString = split < 0 ? QueryString.Empty : new QueryString(request.Target[split..]);
            actual.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(request.Body ?? ""));
            foreach (var header in request.Headers)
            {
                actual.Request.Headers[header.Key] = header.Value;
            }
            if (request.DispatchPermit is not null)
            {
                actual.Request.Headers["X-Nix-Pet-Plan-Request"] = request.DispatchPermit;
            }
            var consumed = await services.GetRequiredService<PetPlanDispatchService>().ConsumeAsync(actual, actor.Value.Pet, ct).ConfigureAwait(false);
            return new IsolatedOutcome<bool>(consumed, consumed);
        }, http.RequestAborted).ConfigureAwait(false);
        return allowed ? TypedResults.Ok(new PetPlanAllowedResponse(true)) : TypedResults.StatusCode(403);
    }

    private static async Task<IResult> Complete(PetPlanRuntimeResult request, HttpContext http, [FromServices] IIsolatedUnitOfWork isolated)
    {
        var result = await isolated.RunAsync(new(TenantId.From(request.TenantId), WorkspaceId.From(request.WorkspaceId), PrincipalId.From(request.PrincipalId)),
            async (services, ct) =>
            {
                var saved = await services.GetRequiredService<PetRunService>().RecordRuntimePlanResultAsync(request, ct).ConfigureAwait(false);
                return new IsolatedOutcome<Result<bool>>(saved, saved.IsSuccess && saved.Value);
            }, http.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(recorded => TypedResults.Ok(new PetPlanRecordedResponse(recorded)), error => PetPlanEndpoints.Problem(http, error));
    }

    private static async Task<IResult> Settle(PetPlanSettleRequest request, HttpContext http,
        [FromServices] NixTokenValidator validator, [FromServices] IIsolatedUnitOfWork isolated,
        [FromServices] IBrowserSessions browserSessions, [FromServices] TimeProvider clock)
    {
        var actor = await CallbackActorAsync(request.Token, request.DispatchPermit, request.RequestId,
            validator, browserSessions, clock, http.RequestAborted).ConfigureAwait(false);
        if (actor is null)
        {
            return TypedResults.StatusCode(403);
        }
        var allowed = await isolated.RunAsync(actor.Value.Context, async (services, ct) =>
        {
            var saved = await services.GetRequiredService<PetPlanDispatchService>().SettleAsync(actor.Value.Pet, request, ct).ConfigureAwait(false);
            return new IsolatedOutcome<bool>(saved, saved);
        }, http.RequestAborted).ConfigureAwait(false);
        return allowed ? TypedResults.Ok(new PetPlanAllowedResponse(true)) : TypedResults.StatusCode(403);
    }

    private static async Task<(NixSessionContext Context, ValidatedPetTurnToken? Pet)?> CallbackActorAsync(string rawToken,
        string? permit, Guid requestId, NixTokenValidator validator, IBrowserSessions sessions, TimeProvider clock, CancellationToken cancellationToken)
    {
        var validated = await validator.ValidateAsync(rawToken, cancellationToken).ConfigureAwait(false);
        if (validated is ValidatedPetTurnToken { PlanRequest: { } plan } pet
            && PetActionRequestBinding.TryReadPlanRequest(plan, out _, out var bound) && bound == requestId)
        {
            return (new(pet.TenantId, null, pet.PrincipalId), pet);
        }
        if (validated is not ValidatedBrowserSessionToken browser || permit is null
            || !PetActionRequestBinding.TryReadPlanRequest(permit, out _, out bound) || bound != requestId)
        {
            return null;
        }
        var session = await sessions.FindByIdAsync(browser.BrowserSessionId, cancellationToken).ConfigureAwait(false);
        return session is not null && session.PrincipalId == browser.PrincipalId && session.TenantId == browser.TenantId
            && session.PrincipalStatus == PrincipalStatus.Active && session.ExpiresAt > clock.GetUtcNow()
                ? (new NixSessionContext(browser.TenantId, null, browser.PrincipalId), null) : null;
    }

    private static async Task<IResult> Next(Guid workspaceId, Guid runId, HttpContext http,
        [FromServices] PetPlanDispatchService service, [FromServices] BrowserAccess browser,
        [FromServices] INixSessionContextAccessor session)
    {
        if (await browser.VerifyAsync(http, requireOrigin: false).ConfigureAwait(false) is null
            || session.Current?.WorkspaceId is { } scoped && scoped.Value != workspaceId)
        {
            return TypedResults.StatusCode(403);
        }
        var result = await service.NextClientIntentAsync(runId, http.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(value => value is null ? TypedResults.Text("null", "application/json") : TypedResults.Ok(value),
            error => PetPlanEndpoints.Problem(http, error));
    }

    private static async Task<IResult> Result(Guid workspaceId, Guid runId, PetPlanClientIoResult request, HttpContext http,
        [FromServices] PetPlanDispatchService service, [FromServices] BrowserAccess browser,
        [FromServices] INixSessionContextAccessor session)
    {
        if (await browser.VerifyAsync(http, requireOrigin: true).ConfigureAwait(false) is null
            || session.Current?.WorkspaceId is { } scoped && scoped.Value != workspaceId)
        {
            return TypedResults.StatusCode(403);
        }
        var result = await service.RecordClientResultAsync(runId, request, http.RequestAborted).ConfigureAwait(false);
        return result.Match<IResult>(value => TypedResults.Ok(new PetPlanRecordedResponse(value)), error => PetPlanEndpoints.Problem(http, error));
    }
}
