using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Abstractions.Connections;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Features.BrowserAuth;
using Nix.Features.PetRuns;
using Nix.Http;
using Nix.Persistence.Connections;

namespace Nix.Features.Connections;

internal static class ConnectorEndpoints
{
    internal static void AddPetConnections(this IServiceCollection services)
    {
        services.AddScoped<IConnectorStore, ConnectorStore>();
        services.AddScoped<ConnectorRegistration>();
        services.AddScoped<ConnectorSecrets>();
        services.AddScoped<ConnectorActions>();
        services.AddScoped<IPetRunCapability, ConnectorRunCapability>();
        services.AddScoped<IPetRunCapability, ConnectorCatalogCapability>();
        services.AddHttpClient<ConnectorWorkerClient>(static client =>
        {
            client.Timeout = TimeSpan.FromSeconds(25);
            client.MaxResponseContentBufferSize = 1024 * 1024;
        }).ConfigurePrimaryHttpMessageHandler(static () => new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false });
    }

    internal static void MapPetConnections(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/v1/workspaces/{workspaceId:guid}/pet-connections").WithTags("Pet Connections");
        group.MapGet("", List).WithName("ListPetConnections").WithSummary("List the owner’s scoped pet connections.");
        group.MapDelete("/{connectionId:guid}", Disconnect).WithName("DisconnectPetConnection").WithSummary("Revoke a pet connection in Nix.")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapPost("/register-mcp", RegisterMcp).WithName("RegisterPetMcpConnection")
            .WithSummary("Register one exact remote MCP tool against its input schema.")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
    }

    internal static bool Enabled(IConfiguration config, WorkspaceId workspace)
    {
        return config.GetValue<bool>("Nix:PetRuns:Enabled")
            && config.GetSection("Nix:PetRuns:AllowedWorkspaces").GetChildren()
                .Any(entry => Guid.TryParse(entry.Value, out var id) && id == workspace.Value);
    }

    private static async Task<Results<Ok<ConnectorList>, ProblemHttpResult>> List(
        Guid workspaceId, HttpContext http, [FromServices] BrowserAccess browser,
        [FromServices] IPermissionResolver permissions, [FromServices] IConnectorStore store, [FromServices] IConfiguration config)
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
        return TypedResults.Ok(new ConnectorList(Enabled(config, workspace),
            [.. rows.Select(row => new ConnectorConnection(row.Id, row.Provider, row.ResourceKind, row.ResourceId, row.Actions, row.Revision))]));
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> Disconnect(
        Guid workspaceId, Guid connectionId, HttpContext http, [FromServices] BrowserAccess browser,
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
        [FromServices] BrowserAccess browser, [FromServices] ConnectorRegistration registration, [FromServices] IConfiguration config)
    {
        NoStore(http);
        var workspace = WorkspaceId.From(workspaceId);
        if (!Enabled(config, workspace) || await browser.VerifyAsync(http, requireOrigin: true).ConfigureAwait(false) is null)
        {
            return Problem(http, ConnectorErrors.Browser());
        }
        var result = await registration.RegisterRemoteMcpAsync(workspace, request, http.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<NoContent, ProblemHttpResult>>(_ => TypedResults.NoContent(), error => Problem(http, error));
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
