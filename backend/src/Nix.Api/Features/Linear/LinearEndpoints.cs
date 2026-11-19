using System.Diagnostics.CodeAnalysis;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Features.BrowserAuth;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.Linear;

internal static class LinearEndpoints
{
    internal static void AddLinear(this IServiceCollection services)
    {
        services.AddHttpClient<LinearWorkerClient>(static client =>
        {
            client.Timeout = TimeSpan.FromSeconds(20);
            client.MaxResponseContentBufferSize = 128 * 1024;
        }).ConfigurePrimaryHttpMessageHandler(static () => new HttpClientHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false,
        });
        services.AddDataProtection();
        services.AddScoped<LinearOAuth>();
        services.AddScoped<LinearRequests>();
        services.AddScoped<LinearLinks>();
        services.AddScoped<IQueryHandler<ReadLinearConnection, Result<LinearConnectionResponse>>, LinearOAuth>();
        services.AddScoped<ICommandHandler<AuthorizeLinearConnection, LinearAuthorizationResponse>, LinearOAuth>();
        services.AddScoped<ICommandHandler<DisconnectLinearConnection, bool>, LinearOAuth>();
        services.AddScoped<IQueryHandler<ListLinearRequests, Result<LinearRequestsResponse>>, LinearRequests>();
        services.AddScoped<IQueryHandler<GetLinearIssueRequest, Result<LinearRequestResponse>>, LinearRequests>();
        services.AddScoped<ICommandHandler<RequestLinearIssue, LinearRequestResponse>, LinearRequests>();
        services.AddScoped<ICommandHandler<HandToPetCommand, LinearRequestResponse>, LinearRequests>();
        services.AddScoped<ICommandHandler<DecideLinearIssueRequestCommand, LinearRequestResponse>, LinearRequests>();
        services.AddScoped<IQueryHandler<ReadLinearLink, Result<LinearLinkResponse>>, LinearLinks>();
        services.AddScoped<ICommandHandler<CreateLinearLink, LinearLinkResponse>, LinearLinks>();
        services.AddScoped<ICommandHandler<RefreshLinearLink, LinearLinkResponse>, LinearLinks>();
        services.AddScoped<ICommandHandler<ApplyLinearLinkStatus, LinearLinkResponse>, LinearLinks>();
        services.AddScoped<ICommandHandler<DeleteLinearLink, bool>, LinearLinks>();
    }

    internal static void MapLinearEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var connections = endpoints.MapGroup("/api/v1/workspaces/{workspaceId:guid}/linear").WithTags("Linear");
        connections.MapGet("", GetConnection).WithName("GetLinearConnection")
            .WithSummary("Read the Linear connection status for this workspace.");
        connections.MapPost("/authorize", Authorize).WithName("AuthorizeLinearConnection")
            .WithSummary("Start a browser OAuth connection to read-only Linear.")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        connections.MapDelete("", Disconnect).WithName("DisconnectLinearConnection")
            .WithSummary("Remove this workspace's Linear connection.")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        var requests = endpoints.MapGroup("/api/v1/items/{itemId:guid}/linear-requests").WithTags("Linear");
        requests.MapGet("", ListRequests).WithName("ListLinearRequests")
            .WithSummary("List visible Linear issue requests for a Nix task.");
        requests.MapGet("/{requestId:guid}", GetRequest).WithName("GetLinearIssueRequest")
            .WithSummary("Read the status of a Linear issue request on a Nix task.");
        requests.MapPost("", RequestIssue).WithName("RequestLinearIssue")
            .WithSummary("Queue a one-issue lookup for approval on a Nix task.")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        requests.MapPost("/hand-to-pet", HandToPet).WithName("HandToPet")
            .WithSummary("Hand a pet a single Linear issue lookup for approval on the task.")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        requests.MapPost("/{requestId:guid}/decision", Decide).WithName("DecideLinearIssueRequest")
            .WithSummary("Approve or decline a single pending Linear issue lookup in the browser.")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        var links = endpoints.MapGroup("/api/v1/items/{itemId:guid}/linear-link").WithTags("Linear");
        links.MapGet("", GetLink).WithName("GetLinearLink").WithSummary("Read an owner's linked Linear issue and observed status.");
        links.MapPut("", LinkIssue).WithName("LinkLinearIssue").WithSummary("Link one exact issue from an authorized Linear team.")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        links.MapPost("/refresh", RefreshLink).WithName("RefreshLinearLink").WithSummary("Refresh the linked issue status in Nix without changing Linear.")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        links.MapPost("/copy-status", CopyStatus).WithName("CopyLinkedLinearStatus").WithSummary("Copy an observed Linear status into the selected Nix task.")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        links.MapDelete("", UnlinkIssue).WithName("UnlinkLinearIssue").WithSummary("Remove the exact linked issue without changing Linear.")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
    }

    internal static void MapLinearOAuthCallback(this IEndpointRouteBuilder endpoints) =>
        endpoints.MapGet(LinearOAuth.CallbackPath, Complete).ExcludeFromDescription();

    private static async Task<Results<Ok<LinearConnectionResponse>, ProblemHttpResult>> GetConnection(
        Guid workspaceId, HttpContext http, [FromServices] NixDispatcher dispatcher) =>
        Map(http, await dispatcher.QueryAsync<ReadLinearConnection, Result<LinearConnectionResponse>>(
            new(WorkspaceId.From(workspaceId)), http.RequestAborted).ConfigureAwait(false));

    private static async Task<Results<Ok<LinearAuthorizationResponse>, ProblemHttpResult>> Authorize(
        Guid workspaceId, AuthorizeLinearConnectionRequest? request, HttpContext http,
        [FromServices] NixDispatcher dispatcher,
        [FromServices] LinearBrowserAccess browser)
    {
        var verified = await browser.VerifyAsync(http, requireOrigin: true).ConfigureAwait(false);
        if (verified is null || browser.Callback is not { } callback)
        {
            return Problem(http, LinearErrors.Browser());
        }

        return Map(http, await dispatcher.SendAsync<AuthorizeLinearConnection, LinearAuthorizationResponse>(
            new(WorkspaceId.From(workspaceId), verified.Id.Value, callback, request?.ReturnTo ?? "/settings?tab=connections"),
            http.RequestAborted).ConfigureAwait(false));
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> Disconnect(
        Guid workspaceId, HttpContext http, [FromServices] NixDispatcher dispatcher, [FromServices] LinearBrowserAccess browser)
    {
        if (await browser.VerifyAsync(http, requireOrigin: true).ConfigureAwait(false) is null)
        {
            return Problem(http, LinearErrors.Browser());
        }

        var result = await dispatcher.SendAsync<DisconnectLinearConnection, bool>(
            new(WorkspaceId.From(workspaceId)), http.RequestAborted).ConfigureAwait(false);
        return result.IsSuccess ? TypedResults.NoContent() : Problem(http, result.Error);
    }

    private static async Task<IResult> Complete(
        HttpContext http, string? state, string? code, string? error,
        [FromServices] BrowserAuthCoordinator browser, [FromServices] IIsolatedUnitOfWork isolated)
    {
        NoStore(http);
        http.Response.Headers["Referrer-Policy"] = "no-referrer";
        var verified = await browser.ResolveAsync(http.Request.Cookies[browser.SessionCookieName], http.RequestAborted)
            .ConfigureAwait(false);
        if (verified is not { PrincipalStatus: PrincipalStatus.Active } || browser.PublicOrigin is not { } origin)
        {
            return Results.Redirect(LinearOAuth.Redirect(null, "failed"));
        }

        var session = NixSessionContext.ForTenant(verified.TenantId, verified.PrincipalId);
        var attempt = await isolated.RunAsync(session, async (services, ct) =>
        {
            var consumed = await services.GetRequiredService<LinearOAuth>().ConsumeAsync(verified.Id.Value, state, ct)
                .ConfigureAwait(false);
            return new IsolatedOutcome<Nix.Abstractions.Linear.LinearOAuthAttempt?>(consumed, Commit: consumed is not null);
        }, http.RequestAborted).ConfigureAwait(false);
        if (attempt is null)
        {
            return Results.Redirect(LinearOAuth.Redirect(null, "failed"));
        }

        var path = await isolated.RunAsync(session with { WorkspaceId = attempt.WorkspaceId }, async (services, ct) =>
        {
            var result = await services.GetRequiredService<LinearOAuth>().CompleteAsync(
                attempt, new Uri(origin, LinearOAuth.CallbackPath), code, error, ct).ConfigureAwait(false);
            return new IsolatedOutcome<string>(result, Commit: true);
        }, CancellationToken.None).ConfigureAwait(false);
        return Results.Redirect(path);
    }

    private static async Task<Results<Ok<LinearRequestsResponse>, ProblemHttpResult>> ListRequests(
        Guid itemId, HttpContext http, [FromServices] NixDispatcher dispatcher, [FromServices] LinearBrowserAccess browser)
    {
        var caller = await browser.CallerAsync(http).ConfigureAwait(false);
        if (!caller.Allowed)
        {
            return Problem(http, LinearErrors.Missing());
        }

        return Map(http, await dispatcher.QueryAsync<ListLinearRequests, Result<LinearRequestsResponse>>(
            new(ItemId.From(itemId), caller.TokenId), http.RequestAborted).ConfigureAwait(false));
    }

    private static async Task<Results<Ok<LinearRequestResponse>, ProblemHttpResult>> GetRequest(
        Guid itemId, Guid requestId, HttpContext http, [FromServices] NixDispatcher dispatcher,
        [FromServices] LinearBrowserAccess browser)
    {
        var caller = await browser.CallerAsync(http).ConfigureAwait(false);
        if (!caller.Allowed)
        {
            return Problem(http, LinearErrors.Missing());
        }

        return Map(http, await dispatcher.QueryAsync<GetLinearIssueRequest, Result<LinearRequestResponse>>(
            new(ItemId.From(itemId), requestId, caller.TokenId), http.RequestAborted).ConfigureAwait(false));
    }

    private static async Task<Results<Ok<LinearRequestResponse>, ProblemHttpResult>> RequestIssue(
        Guid itemId, RequestLinearIssueRequest request, HttpContext http,
        [FromServices] NixDispatcher dispatcher, [FromServices] LinearBrowserAccess browser)
    {
        var caller = await browser.CallerAsync(http, requireOrigin: true).ConfigureAwait(false);
        if (!caller.Allowed)
        {
            return Problem(http, LinearErrors.Missing());
        }

        return Map(http, await dispatcher.SendAsync<RequestLinearIssue, LinearRequestResponse>(
            new(ItemId.From(itemId), request.IssueId, caller.TokenId), http.RequestAborted).ConfigureAwait(false));
    }

    private static async Task<Results<Ok<LinearRequestResponse>, ProblemHttpResult>> HandToPet(
        Guid itemId, HandToPetRequest request, HttpContext http, [FromServices] NixDispatcher dispatcher,
        [FromServices] LinearBrowserAccess browser)
    {
        if (await browser.VerifyAsync(http, requireOrigin: true).ConfigureAwait(false) is null)
        {
            return Problem(http, LinearErrors.Browser());
        }

        return Map(http, await dispatcher.SendAsync<HandToPetCommand, LinearRequestResponse>(
            new(ItemId.From(itemId), request.PetId, request.IssueId), http.RequestAborted).ConfigureAwait(false));
    }

    private static async Task<Results<Ok<LinearRequestResponse>, ProblemHttpResult>> Decide(
        Guid itemId, Guid requestId, DecideLinearIssueRequest request, HttpContext http,
        [FromServices] NixDispatcher dispatcher, [FromServices] LinearBrowserAccess browser)
    {
        if (await browser.VerifyAsync(http, requireOrigin: true).ConfigureAwait(false) is null || browser.Callback is not { } callback)
        {
            return Problem(http, LinearErrors.Browser());
        }

        return Map(http, await dispatcher.SendAsync<DecideLinearIssueRequestCommand, LinearRequestResponse>(
            new(ItemId.From(itemId), requestId, request.Approve, callback), http.RequestAborted).ConfigureAwait(false));
    }

    private static async Task<Results<Ok<LinearLinkResponse>, ProblemHttpResult>> GetLink(
        Guid itemId, HttpContext http, [FromServices] NixDispatcher dispatcher, [FromServices] LinearBrowserAccess browser) =>
        await browser.VerifyAsync(http, requireOrigin: false).ConfigureAwait(false) is null
            ? Problem(http, LinearErrors.Browser())
            : Map(http, await dispatcher.QueryAsync<ReadLinearLink, Result<LinearLinkResponse>>(
                new(ItemId.From(itemId)), http.RequestAborted).ConfigureAwait(false));

    private static Task<Results<Ok<LinearLinkResponse>, ProblemHttpResult>> LinkIssue(
        Guid itemId, LinkLinearIssueRequest request, HttpContext http,
        [FromServices] NixDispatcher dispatcher, [FromServices] LinearBrowserAccess browser) =>
        WriteLinkAsync(new CreateLinearLink(ItemId.From(itemId), request.ConnectionId, request.Issue), http, dispatcher, browser);

    private static Task<Results<Ok<LinearLinkResponse>, ProblemHttpResult>> RefreshLink(
        Guid itemId, HttpContext http, [FromServices] NixDispatcher dispatcher, [FromServices] LinearBrowserAccess browser) =>
        WriteLinkAsync(new RefreshLinearLink(ItemId.From(itemId)), http, dispatcher, browser);

    private static Task<Results<Ok<LinearLinkResponse>, ProblemHttpResult>> CopyStatus(
        Guid itemId, CopyLinearStatusRequest request, HttpContext http,
        [FromServices] NixDispatcher dispatcher, [FromServices] LinearBrowserAccess browser) =>
        WriteLinkAsync(new ApplyLinearLinkStatus(ItemId.From(itemId), request.Revision, request.LocalStatus), http, dispatcher, browser);

    private static async Task<Results<NoContent, ProblemHttpResult>> UnlinkIssue(
        Guid itemId, Guid revision, HttpContext http, [FromServices] NixDispatcher dispatcher, [FromServices] LinearBrowserAccess browser)
    {
        if (await browser.VerifyAsync(http, requireOrigin: true).ConfigureAwait(false) is null)
        {
            return Problem(http, LinearErrors.Browser());
        }

        var result = await dispatcher.SendAsync<DeleteLinearLink, bool>(new(ItemId.From(itemId), revision), http.RequestAborted).ConfigureAwait(false);
        NoStore(http);
        return result.IsSuccess ? TypedResults.NoContent() : Problem(http, result.Error);
    }

    private static async Task<Results<Ok<LinearLinkResponse>, ProblemHttpResult>> WriteLinkAsync<TCommand>(
        TCommand command, HttpContext http, NixDispatcher dispatcher, LinearBrowserAccess browser)
        where TCommand : ICommand<LinearLinkResponse> =>
        await browser.VerifyAsync(http, requireOrigin: true).ConfigureAwait(false) is null
            ? Problem(http, LinearErrors.Browser())
            : Map(http, await dispatcher.SendAsync<TCommand, LinearLinkResponse>(command, http.RequestAborted).ConfigureAwait(false));

    private static Results<Ok<T>, ProblemHttpResult> Map<T>(HttpContext http, Result<T> result)
    {
        NoStore(http);
        return result.Match<Results<Ok<T>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(http, error));
    }

    private static ProblemHttpResult Problem(HttpContext http, NixError error)
    {
        NoStore(http);
        var (status, title) = error.Code switch
        {
            "linear.not_found" => (StatusCodes.Status404NotFound, "Linear request unavailable"),
            "linear.browser_required" or "linear.forbidden" => (StatusCodes.Status403Forbidden, "Linear access refused"),
            "linear.unavailable" => (StatusCodes.Status503ServiceUnavailable, "Linear unavailable"),
            "linear.conflict" => (StatusCodes.Status409Conflict, "Linear request changed"),
            _ => (StatusCodes.Status422UnprocessableEntity, "Invalid Linear request"),
        };
        return TypedResults.Problem(ApiProblem.Create(http, status, error.Code, title, error.Message));
    }

    private static void NoStore(HttpContext http) => http.Response.Headers.CacheControl = "no-store";
}

[SuppressMessage("Performance", "CA1812", Justification = "Created by ASP.NET Core dependency injection.")]
internal sealed class LinearBrowserAccess(
    BrowserAuthCoordinator browser,
    AccessTokenSessionContext access,
    CredentialSessionContext credential,
    INixSessionContextAccessor session)
{
    internal Uri? Callback => browser.PublicOrigin is { } origin ? new Uri(origin, LinearOAuth.CallbackPath) : null;

    internal async ValueTask<AuthenticatedBrowserSession?> VerifyAsync(HttpContext http, bool requireOrigin)
    {
        if (!access.IsInteractive || session.Current is not { } caller
            || (requireOrigin && !BrowserAuthEndpoints.HasSameOrigin(http, browser)))
        {
            return null;
        }

        var verified = await browser.ResolveAsync(http.Request.Cookies[browser.SessionCookieName], http.RequestAborted)
            .ConfigureAwait(false);
        return verified is { PrincipalStatus: PrincipalStatus.Active } && verified.TenantId == caller.TenantId
            && verified.PrincipalId == caller.PrincipalId && verified.Id.Value == credential.CredentialId
            ? verified
            : null;
    }

    internal async ValueTask<(bool Allowed, Guid? TokenId)> CallerAsync(HttpContext http, bool requireOrigin = false) =>
        access.IsTokenSession && credential.CredentialId is { } tokenId
            ? (true, tokenId)
            : (await VerifyAsync(http, requireOrigin).ConfigureAwait(false) is not null, null);
}
