using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Abstractions.Connections;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Features.Linear;
using Nix.Features.PetRuns;
using Nix.Http;
using Nix.Persistence.Connections;

namespace Nix.Features.Connections;

internal static class ConnectorEndpoints
{
    internal static void AddPetConnections(this IServiceCollection services)
    {
        services.AddScoped<IConnectorStore, ConnectorStore>();
        services.AddScoped<ConnectorOAuth>();
        services.AddScoped<ConnectorActions>();
        services.AddScoped<ConnectorCalendars>();
        services.AddScoped<IPetRunCapability, ConnectorRunCapability>();
        services.AddScoped<IPetRunCapability, ConnectorCatalogCapability>();
        services.AddHttpClient<ConnectorWorkerClient>(client => Configure(client, 1024 * 1024))
            .ConfigurePrimaryHttpMessageHandler(NoRedirect);
        services.AddHttpClient<ConnectorTokenClient>(client => Configure(client, 64 * 1024))
            .ConfigurePrimaryHttpMessageHandler(NoRedirect);
    }

    internal static void MapPetConnections(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/v1/workspaces/{workspaceId:guid}/pet-connections").WithTags("Pet Connections");
        group.MapGet("", List).WithName("ListPetConnections").WithSummary("List the owner’s scoped pet connections and provider actions.");
        group.MapPost("/authorize", Authorize).WithName("AuthorizePetConnection").WithSummary("Begin browser consent for a scoped pet connection.")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapDelete("/{connectionId:guid}", Disconnect).WithName("DisconnectPetConnection").WithSummary("Revoke a pet connection in Nix.")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapPost("/register-mcp", RegisterMcp).WithName("RegisterPetMcpConnection")
            .WithSummary("Register one exact remote MCP tool against its input schema.")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        endpoints.MapGet(ConnectorOAuth.CallbackPath, Complete).ExcludeFromDescription();
    }

    internal static bool Enabled(IConfiguration config, WorkspaceId workspace)
    {
        return config.GetValue<bool>("Nix:PetRuns:Enabled")
            && config.GetSection("Nix:PetRuns:AllowedWorkspaces").GetChildren()
                .Any(entry => Guid.TryParse(entry.Value, out var id) && id == workspace.Value);
    }

    private static void Configure(HttpClient client, int responseBytes)
    {
        client.Timeout = TimeSpan.FromSeconds(25);
        client.MaxResponseContentBufferSize = responseBytes;
    }

    private static HttpClientHandler NoRedirect() => new() { AllowAutoRedirect = false, UseCookies = false };

    private static async Task<Results<Ok<ConnectorList>, ProblemHttpResult>> List(
        Guid workspaceId, HttpContext http, [FromServices] LinearBrowserAccess browser,
        [FromServices] IPermissionResolver permissions, [FromServices] IConnectorStore store,
        [FromServices] ConnectorWorkerClient worker, [FromServices] IConfiguration config, [FromServices] ConnectorCalendars calendars)
    {
        NoStore(http);
        var token = http.RequestAborted;
        var workspace = WorkspaceId.From(workspaceId);
        if (await browser.VerifyAsync(http, requireOrigin: false).ConfigureAwait(false) is null
            || !await permissions.CanManageWorkspaceAsync(workspace, token).ConfigureAwait(false))
        {
            return Problem(http, ConnectorErrors.Missing());
        }
        var rows = await store.ListAsync(workspace, token).ConfigureAwait(false);
        ConnectorConnection[] connections =
            [.. rows.Select(row => new ConnectorConnection(row.Id, row.Provider, row.ResourceKind, row.ResourceId, row.Actions, row.Revision))];
        if (!Enabled(config, workspace))
        {
            return TypedResults.Ok(new ConnectorList(false, connections, [], []));
        }
        var catalog = await worker.SendAsync(new("catalog"), token).ConfigureAwait(false);
        var links = await calendars.ListAsync(workspace, token).ConfigureAwait(false);
        return TypedResults.Ok(new ConnectorList(true, connections,
            [.. (catalog?.Actions ?? []).Select(action => action with
            {
                Configured = ConnectorProvider.Find(config, action.Provider) is not null
                    || action.ResourceKind == "calendar" && links.Any(link => link.Provider == action.Provider),
            })], links));
    }

    private static async Task<Results<Ok<AuthorizePetConnectionResponse>, ProblemHttpResult>> Authorize(
        Guid workspaceId, AuthorizePetConnectionRequest request, HttpContext http,
        [FromServices] LinearBrowserAccess browser, [FromServices] BrowserAuthCoordinator coordinator,
        [FromServices] ConnectorOAuth oauth, [FromServices] IConfiguration config)
    {
        NoStore(http);
        var workspace = WorkspaceId.From(workspaceId);
        if (!Enabled(config, workspace) || coordinator.PublicOrigin is not { } origin
            || await browser.VerifyAsync(http, requireOrigin: true).ConfigureAwait(false) is not { } verified)
        {
            return Problem(http, ConnectorErrors.Browser());
        }
        var result = await oauth.BeginAsync(workspace, verified.Id.Value, new Uri(origin, ConnectorOAuth.CallbackPath),
            request, http.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<AuthorizePetConnectionResponse>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(http, error));
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> Disconnect(
        Guid workspaceId, Guid connectionId, HttpContext http, [FromServices] LinearBrowserAccess browser,
        [FromServices] IPermissionResolver permissions, [FromServices] IConnectorStore store)
    {
        NoStore(http);
        var workspace = WorkspaceId.From(workspaceId);
        var token = http.RequestAborted;
        if (await browser.VerifyAsync(http, requireOrigin: true).ConfigureAwait(false) is null
            || !await permissions.CanManageWorkspaceAsync(workspace, token).ConfigureAwait(false)
            || !await store.DisconnectAsync(workspace, connectionId, token).ConfigureAwait(false))
        {
            return Problem(http, ConnectorErrors.Missing());
        }
        return TypedResults.NoContent();
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> RegisterMcp(
        Guid workspaceId, RegisterPetMcpConnectionRequest request, HttpContext http,
        [FromServices] LinearBrowserAccess browser, [FromServices] ConnectorOAuth oauth, [FromServices] IConfiguration config)
    {
        NoStore(http);
        var workspace = WorkspaceId.From(workspaceId);
        if (!Enabled(config, workspace) || await browser.VerifyAsync(http, requireOrigin: true).ConfigureAwait(false) is null)
        {
            return Problem(http, ConnectorErrors.Browser());
        }
        var result = await oauth.RegisterRemoteMcpAsync(workspace, request, http.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<NoContent, ProblemHttpResult>>(_ => TypedResults.NoContent(), error => Problem(http, error));
    }

    private static async Task<IResult> Complete(HttpContext http, string? state, string? code, string? error,
        [FromServices] BrowserAuthCoordinator browser, [FromServices] IIsolatedUnitOfWork isolated,
        [FromServices] IConfiguration config)
    {
        NoStore(http);
        http.Response.Headers["Referrer-Policy"] = "no-referrer";
        var session = await browser.ResolveAsync(http.Request.Cookies[browser.SessionCookieName], http.RequestAborted).ConfigureAwait(false);
        if (session is not { PrincipalStatus: PrincipalStatus.Active } || browser.PublicOrigin is not { } origin)
        {
            return Results.Redirect(ConnectorOAuth.Redirect(null, "failed"));
        }
        var context = NixSessionContext.ForTenant(session.TenantId, session.PrincipalId);
        var receipt = await isolated.RunAsync(context, async (services, token) =>
        {
            var consumed = await services.GetRequiredService<ConnectorOAuth>().ConsumeAsync(session.Id.Value, state, token).ConfigureAwait(false);
            return new IsolatedOutcome<ConnectorPending?>(consumed, Commit: consumed is not null);
        }, http.RequestAborted).ConfigureAwait(false);
        if (receipt is null || !Enabled(config, receipt.WorkspaceId))
        {
            return Results.Redirect(ConnectorOAuth.Redirect(null, "failed"));
        }
        var redirect = await isolated.RunAsync(context with { WorkspaceId = receipt.WorkspaceId }, async (services, token) =>
        {
            var destination = await services.GetRequiredService<ConnectorOAuth>()
                .CompleteAsync(receipt, new Uri(origin, ConnectorOAuth.CallbackPath), code, error, token).ConfigureAwait(false);
            return new IsolatedOutcome<string>(destination, Commit: true);
        }, http.RequestAborted).ConfigureAwait(false);
        return Results.Redirect(redirect);
    }

    private static ProblemHttpResult Problem(HttpContext http, NixError error)
    {
        var (status, title) = error.Code switch
        {
            "connector.not_found" => (StatusCodes.Status404NotFound, "Connection unavailable"),
            "connector.browser_required" => (StatusCodes.Status403Forbidden, "Browser approval required"),
            "connector.changed" => (StatusCodes.Status409Conflict, "Connection changed"),
            _ => (StatusCodes.Status422UnprocessableEntity, "Invalid connection"),
        };
        return TypedResults.Problem(ApiProblem.Create(http, status, error.Code, title, error.Message));
    }

    private static void NoStore(HttpContext http) => http.Response.Headers.CacheControl = "no-store";
}
