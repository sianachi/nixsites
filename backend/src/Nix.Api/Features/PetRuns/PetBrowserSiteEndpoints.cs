using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Abstractions.Connections;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Features.BrowserAuth;
using Nix.Features.Connections;
using Nix.Http;

namespace Nix.Features.PetRuns;

internal sealed record SavePetBrowserSiteRequest(string? Origin, BrowserSiteCookie[]? Cookies, bool AllowSubmissions);

internal static class PetBrowserSiteEndpoints
{
    internal static void MapPetBrowserConnections(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost("/api/v1/workspaces/{workspaceId:guid}/pet-connections/browser-site", Save)
            .WithTags("Pet Connections")
            .WithName("SavePetBrowserSite")
            .WithSummary("Connect a site-scoped browser session")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
    }

    private static async Task<Results<Ok<ConnectorConnection>, ProblemHttpResult>> Save(
        Guid workspaceId, SavePetBrowserSiteRequest request, HttpContext http,
        [FromServices] BrowserAccess browser, [FromServices] IPermissionResolver permissions,
        [FromServices] IConnectorStore connections, [FromServices] IDataProtectionProvider protection,
        [FromServices] IConfiguration configuration)
    {
        http.Response.Headers.CacheControl = "no-store";
        var workspace = WorkspaceId.From(workspaceId);
        if (await browser.VerifyAsync(http, requireOrigin: true).ConfigureAwait(false) is null
            || !ConnectorEndpoints.Enabled(configuration, workspace)
            || !await permissions.CanManageWorkspaceAsync(workspace, http.RequestAborted).ConfigureAwait(false))
        {
            return TypedResults.Problem(ApiProblem.Create(http, 403, "browser.browser_required",
                "Browser connection unavailable", "Use a signed-in workspace owner's browser to connect a site."));
        }

        if (!PetBrowserClient.TryWebUri(request.Origin, out var site) || site.Scheme != "https"
            || site.GetLeftPart(UriPartial.Authority) != request.Origin
            || request.Cookies is not { Length: > 0 and <= 32 } cookies
            || !cookies.All(ValidCookie) || cookies.Sum(cookie => cookie.Value.Length + cookie.Name.Length + cookie.Path.Length) > 32768)
        {
            return TypedResults.Problem(ApiProblem.Create(http, 400, "browser.invalid",
                "Invalid site session", "Provide an HTTPS origin with valid cookies scoped to that site."));
        }

        const string provider = "browser-site";
        const string resourceKind = "origin";
        var secret = protection.CreateProtector(PetBrowserClient.SiteSessionPurpose).Protect(JsonSerializer.Serialize(
            new BrowserSiteSession(request.Origin!, cookies), PetBrowserJson.Default.BrowserSiteSession));
        string[] actions = request.AllowSubmissions ? ["browser.browse", "browser.submitForm"] : ["browser.browse"];

        if (await connections.SaveScopedAsync(workspace, provider, resourceKind, request.Origin!, actions, secret,
                http.RequestAborted).ConfigureAwait(false)
            && (await connections.ListAsync(workspace, http.RequestAborted).ConfigureAwait(false))
                .SingleOrDefault(grant => grant.Provider == provider && grant.ResourceKind == resourceKind
                    && grant.ResourceId == request.Origin) is { } grant)
        {
            return TypedResults.Ok(new ConnectorConnection(grant.Id, provider, resourceKind, grant.ResourceId, actions, grant.Revision));
        }

        return TypedResults.Problem(ApiProblem.Create(http, 409, "browser.connection_changed",
            "Connection changed", "Reload the connections and try again."));
    }

    private static bool ValidCookie(BrowserSiteCookie? cookie)
    {
        const string nameSymbols = "!#$%&'*+.^_" + "\u0060" + "|~-";
        return cookie is { Name.Length: > 0 and <= 128, Value.Length: >= 8 and <= 4096, Path.Length: > 0 and <= 512 }
            && cookie.Name.All(character => char.IsAsciiLetterOrDigit(character)
                || nameSymbols.Contains(character, StringComparison.Ordinal))
            && cookie.Value.All(character => character is '\u0021' or >= '\u0023' and <= '\u002b'
                or >= '\u002d' and <= '\u003a' or >= '\u003c' and <= '\u005b' or >= '\u005d' and <= '\u007e')
            && cookie.Path.StartsWith('/')
            && cookie.Path.All(character => !char.IsControl(character) && character is not (' ' or ';'));
    }
}
