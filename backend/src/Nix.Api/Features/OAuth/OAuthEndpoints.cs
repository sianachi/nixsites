using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Features.BrowserAuth;
using Nix.Features.Tokens;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.OAuth;

/// <summary>RFC 9728 protected-resource metadata.</summary>
internal sealed record OAuthProtectedResource(
    [property: JsonPropertyName("resource")] string Resource,
    [property: JsonPropertyName("authorization_servers")] IReadOnlyList<string> AuthorizationServers,
    [property: JsonPropertyName("bearer_methods_supported")] IReadOnlyList<string> BearerMethodsSupported);

/// <summary>RFC 8414 authorization-server metadata.</summary>
internal sealed record OAuthServerMetadata(
    [property: JsonPropertyName("issuer")] string Issuer,
    [property: JsonPropertyName("authorization_endpoint")] string AuthorizationEndpoint,
    [property: JsonPropertyName("token_endpoint")] string TokenEndpoint,
    [property: JsonPropertyName("registration_endpoint")] string RegistrationEndpoint,
    [property: JsonPropertyName("response_types_supported")] IReadOnlyList<string> ResponseTypesSupported,
    [property: JsonPropertyName("grant_types_supported")] IReadOnlyList<string> GrantTypesSupported,
    [property: JsonPropertyName("code_challenge_methods_supported")] IReadOnlyList<string> CodeChallengeMethodsSupported,
    [property: JsonPropertyName("token_endpoint_auth_methods_supported")] IReadOnlyList<string> TokenEndpointAuthMethodsSupported,
    [property: JsonPropertyName("authorization_response_iss_parameter_supported")] bool AuthorizationResponseIssParameterSupported);

/// <summary>RFC 7591 registration request; fields this server does not use are ignored.</summary>
internal sealed record OAuthRegisterRequest(
    [property: JsonPropertyName("client_name")] string? ClientName,
    [property: JsonPropertyName("redirect_uris")] IReadOnlyList<string>? RedirectUris);

/// <summary>RFC 7591 registration response.</summary>
internal sealed record OAuthRegisterResponse(
    [property: JsonPropertyName("client_id")] string ClientId,
    [property: JsonPropertyName("client_name")] string ClientName,
    [property: JsonPropertyName("redirect_uris")] IReadOnlyList<string> RedirectUris,
    [property: JsonPropertyName("token_endpoint_auth_method")] string TokenEndpointAuthMethod,
    [property: JsonPropertyName("grant_types")] IReadOnlyList<string> GrantTypes,
    [property: JsonPropertyName("response_types")] IReadOnlyList<string> ResponseTypes);

/// <summary>RFC 6749 token response.</summary>
internal sealed record OAuthTokenResponse(
    [property: JsonPropertyName("access_token")] string AccessToken,
    [property: JsonPropertyName("token_type")] string TokenType,
    [property: JsonPropertyName("expires_in")] long ExpiresIn);

/// <summary>RFC 6749 error response.</summary>
internal sealed record OAuthError(
    [property: JsonPropertyName("error")] string Error,
    [property: JsonPropertyName("error_description")] string ErrorDescription);

/// <summary>What the consent page asks about before showing the person anything.</summary>
/// <param name="ClientId">The signed client identifier.</param>
/// <param name="RedirectUri">One of the client's registered redirect URIs.</param>
/// <param name="CodeChallenge">The PKCE S256 challenge.</param>
/// <param name="CodeChallengeMethod">Always <c>S256</c>.</param>
/// <param name="Resource">The resource the client named, when it named one.</param>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1056:URI-like properties should not be strings", Justification = "The wire contract carries the URI as a plain string.")]
[System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1054:URI-like parameters should not be strings", Justification = "The wire contract carries the URI as a plain string.")]
public sealed record OAuthConsentPreviewRequest(
    string? ClientId,
    string? RedirectUri,
    string? CodeChallenge,
    string? CodeChallengeMethod,
    string? Resource);

/// <summary>What a client is and where approval will send the browser.</summary>
/// <param name="ClientName">The name the client registered under.</param>
/// <param name="RedirectHost">The host the browser will be sent to.</param>
public sealed record OAuthConsentPreviewResponse(string ClientName, string RedirectHost);

/// <summary>The access the person grants; the name and expiry are the server's.</summary>
/// <param name="Scopes">Token scopes from <c>read</c>, <c>write</c> and <c>admin</c>.</param>
public sealed record OAuthConsentTokenChoice(IReadOnlyList<string>? Scopes);

/// <summary>A person's decision on a client's request.</summary>
/// <param name="ClientId">The signed client identifier.</param>
/// <param name="RedirectUri">One of the client's registered redirect URIs.</param>
/// <param name="CodeChallenge">The PKCE S256 challenge.</param>
/// <param name="CodeChallengeMethod">Always <c>S256</c>.</param>
/// <param name="State">The client's opaque state, echoed back.</param>
/// <param name="Resource">The resource the client named, when it named one.</param>
/// <param name="Decision"><c>approve</c> or <c>deny</c>.</param>
/// <param name="Token">The access granted; required to approve.</param>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1056:URI-like properties should not be strings", Justification = "The wire contract carries the URI as a plain string.")]
[System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1054:URI-like parameters should not be strings", Justification = "The wire contract carries the URI as a plain string.")]
public sealed record OAuthConsentRequest(
    string? ClientId,
    string? RedirectUri,
    string? CodeChallenge,
    string? CodeChallengeMethod,
    string? State,
    string? Resource,
    string? Decision,
    OAuthConsentTokenChoice? Token);

/// <summary>Where to send the browser next.</summary>
/// <param name="RedirectTo">The client's redirect URI carrying the code or the refusal.</param>
public sealed record OAuthConsentResponse(string RedirectTo);

/// <summary>Source-generated JSON metadata for the OAuth routes.</summary>
[JsonSerializable(typeof(OAuthProtectedResource))]
[JsonSerializable(typeof(OAuthServerMetadata))]
[JsonSerializable(typeof(OAuthRegisterRequest))]
[JsonSerializable(typeof(OAuthRegisterResponse))]
[JsonSerializable(typeof(OAuthTokenResponse))]
[JsonSerializable(typeof(OAuthError))]
[JsonSerializable(typeof(OAuthConsentPreviewRequest))]
[JsonSerializable(typeof(OAuthConsentPreviewResponse))]
[JsonSerializable(typeof(OAuthConsentRequest))]
[JsonSerializable(typeof(OAuthConsentResponse))]
internal sealed partial class OAuthJsonContext : JsonSerializerContext;

/// <summary>
/// Core as a small OAuth 2.1 authorization server for remote MCP: the access token it issues is an ordinary
/// personal access token, so every permission check downstream is unchanged. Discovery, registration and the
/// token exchange are anonymous protocol routes; consent runs in a person's own browser session only.
/// </summary>
internal static class OAuthEndpoints
{
    private const string InvalidRequest = "oauth.invalid_request";
    private const int TokenDays = 90;
    private const int MaxState = 1024;
    private static readonly TimeSpan CodeLifetime = TimeSpan.FromSeconds(60);

    internal static IEndpointRouteBuilder MapOAuthEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        endpoints.MapGet("/.well-known/oauth-protected-resource", ProtectedResource).ExcludeFromDescription();
        endpoints.MapGet("/.well-known/oauth-protected-resource/mcp", ProtectedResource).ExcludeFromDescription();
        endpoints.MapGet("/.well-known/oauth-authorization-server", ServerMetadata).ExcludeFromDescription();

        var oauth = endpoints.MapGroup("/api/v1/oauth").WithTags("OAuth");
        oauth.MapPost("/register", Register).ExcludeFromDescription()
            .WithRequestBodyLimit(8 * 1024).RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        oauth.MapPost("/token", Token).ExcludeFromDescription()
            .WithRequestBodyLimit(8 * 1024).RequireRateLimiting(RateLimitRefusal.TokenExchangePolicyName);
        oauth.MapPost("/consent/preview", Preview).WithName("PreviewOAuthConsent")
            .WithSummary("Check an OAuth authorization request before asking the person")
            .WithDescription("Browser session only. Succeeds only for a registered client and one of its redirect URIs, so the page never redirects anywhere else.")
            .Produces<OAuthConsentPreviewResponse>(StatusCodes.Status200OK)
            .WithRequestBodyLimit(8 * 1024).RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        oauth.MapPost("/consent", Decide).WithName("DecideOAuthConsent")
            .WithSummary("Approve or deny an OAuth authorization request")
            .WithDescription("Browser session only. Returns the redirect carrying a one-time code, or access_denied. The token is minted when the client redeems the code.")
            .Produces<OAuthConsentResponse>(StatusCodes.Status200OK)
            .WithRequestBodyLimit(8 * 1024).RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        return endpoints;
    }

    // ---- discovery ------------------------------------------------------------------------------------------

    private static IResult ProtectedResource(IConfiguration configuration, IOptions<BrowserAuthOptions> browser) =>
        OAuthSettings.TryGet(configuration, browser, out var origin, out var mcp)
            ? TypedResults.Json(new OAuthProtectedResource(mcp, [origin], ["header"]), OAuthJsonContext.Default.OAuthProtectedResource)
            : TypedResults.NotFound();

    private static IResult ServerMetadata(IConfiguration configuration, IOptions<BrowserAuthOptions> browser) =>
        OAuthSettings.TryGet(configuration, browser, out var origin, out _)
            ? TypedResults.Json(
                new OAuthServerMetadata(
                    origin,
                    origin + "/oauth/authorize",
                    origin + "/api/v1/oauth/token",
                    origin + "/api/v1/oauth/register",
                    ["code"],
                    ["authorization_code"],
                    ["S256"],
                    ["none"],
                    true),
                OAuthJsonContext.Default.OAuthServerMetadata)
            : TypedResults.NotFound();

    // ---- registration ---------------------------------------------------------------------------------------

    private static async Task<IResult> Register(
        HttpContext httpContext,
        [FromServices] IConfiguration configuration,
        [FromServices] IOptions<BrowserAuthOptions> browser,
        [FromServices] OAuthClients clients)
    {
        if (!OAuthSettings.TryGet(configuration, browser, out _, out _))
        {
            return TypedResults.NotFound();
        }

        OAuthRegisterRequest? request;
        try
        {
            request = await httpContext.Request.ReadFromJsonAsync(OAuthJsonContext.Default.OAuthRegisterRequest, httpContext.RequestAborted).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is JsonException or InvalidOperationException or BadHttpRequestException)
        {
            request = null;
        }

        var name = OAuthClients.CleanName(request?.ClientName);
        if (name is null)
        {
            return Error(StatusCodes.Status400BadRequest, "invalid_client_metadata", "client_name is required, needs visible characters, and may not present the client as Nix.");
        }

        var uris = request?.RedirectUris;
        if (uris is null || uris.Count is 0 or > OAuthClients.MaxRedirectUris
            || uris.Any(static uri => !OAuthClients.IsRedirectUri(uri))
            || uris.Sum(static uri => uri.Length) > OAuthClients.MaxRedirectTotal)
        {
            return Error(
                StatusCodes.Status400BadRequest,
                "invalid_redirect_uri",
                $"redirect_uris needs 1 to {OAuthClients.MaxRedirectUris} https URIs (http only for loopback), without fragments.");
        }

        var client = new OAuthClients.Client(name, uris.Distinct(StringComparer.Ordinal).ToArray());
        return TypedResults.Json(
            new OAuthRegisterResponse(clients.Issue(client), name, client.RedirectUris, "none", ["authorization_code"], ["code"]),
            OAuthJsonContext.Default.OAuthRegisterResponse,
            statusCode: StatusCodes.Status201Created);
    }

    // ---- consent --------------------------------------------------------------------------------------------

    private static async Task<IResult> Preview(
        OAuthConsentPreviewRequest request,
        HttpContext httpContext,
        [FromServices] OAuthConsentGuard guard)
    {
        var (client, refusal) = await guard.CheckAsync(
            httpContext, request.ClientId, request.RedirectUri, request.CodeChallenge, request.CodeChallengeMethod, request.Resource).ConfigureAwait(false);
        return refusal
            ?? TypedResults.Ok(new OAuthConsentPreviewResponse(client!.Name, OAuthClients.RedirectHost(request.RedirectUri!)));
    }

    private static async Task<IResult> Decide(
        OAuthConsentRequest request,
        HttpContext httpContext,
        [FromServices] OAuthConsentGuard guard,
        [FromServices] IOAuthCodes codes,
        [FromServices] IPersonalAccessTokens tokens,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IConfiguration configuration,
        [FromServices] IOptions<BrowserAuthOptions> browser,
        [FromServices] TimeProvider clock)
    {
        var (client, refusal) = await guard.CheckAsync(
            httpContext, request.ClientId, request.RedirectUri, request.CodeChallenge, request.CodeChallengeMethod, request.Resource).ConfigureAwait(false);
        if (refusal is not null)
        {
            return refusal;
        }

        var state = request.State;
        if (state is { Length: > MaxState })
        {
            return Problem(httpContext, StatusCodes.Status400BadRequest, InvalidRequest, "state is too long.");
        }

        // RFC 9207: the issuer rides on every response, so a client talking to several servers can tell whose answer it got.
        _ = OAuthSettings.TryGet(configuration, browser, out var issuer, out _);
        switch (request.Decision)
        {
            case "deny":
                return TypedResults.Ok(new OAuthConsentResponse(Redirect(request.RedirectUri!, ("error", "access_denied"), ("state", state), ("iss", issuer))));
            case "approve":
                break;
            default:
                return Problem(httpContext, StatusCodes.Status400BadRequest, InvalidRequest, "decision must be approve or deny.");
        }

        var scopes = request.Token?.Scopes?.Distinct(StringComparer.Ordinal).ToList();
        if (scopes is not { Count: > 0 } || scopes.Any(static scope => !AccessTokenScopes.All.Contains(scope)))
        {
            return Problem(httpContext, StatusCodes.Status422UnprocessableEntity, "oauth.invalid_scopes", "Scopes must name at least one of: " + string.Join(", ", AccessTokenScopes.All) + ".");
        }

        // Refused here, before a code exists, rather than at the token step after the code is burned.
        var now = clock.GetUtcNow();
        var own = await tokens.ListOwnAsync(httpContext.RequestAborted).ConfigureAwait(false);
        var name = OAuthClients.ConnectorTokenName(client!.Name, OAuthClients.RedirectHost(request.RedirectUri!));
        if (own.Count(token => IsLive(token, now)) - Retiring(own, name, now).Count() >= PersonalAccessToken.MaximumLiveTokensPerPrincipal)
        {
            return Problem(
                httpContext,
                StatusCodes.Status409Conflict,
                TokenErrors.LimitReachedCode,
                $"You already hold {PersonalAccessToken.MaximumLiveTokensPerPrincipal} live access tokens, the most one person may. Revoke one you no longer use in Settings > Access tokens, then try again.");
        }

        var context = session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var code = Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));
        var stored = await codes.CreateAsync(
            new OAuthCodeRecord(
                BrowserSessionSecret.Hash(code),
                context.TenantId.Value,
                context.PrincipalId.Value,
                request.ClientId!,
                request.RedirectUri!,
                request.CodeChallenge!,
                string.Join(',', scopes),
                string.IsNullOrEmpty(request.Resource) ? null : request.Resource,
                clock.GetUtcNow() + CodeLifetime),
            httpContext.RequestAborted).ConfigureAwait(false);
        return stored
            ? TypedResults.Ok(new OAuthConsentResponse(Redirect(request.RedirectUri!, ("code", code), ("state", state), ("iss", issuer))))
            : Problem(httpContext, StatusCodes.Status429TooManyRequests, "oauth.too_many_pending", "Too many sign-ins are waiting; try again in a minute.");
    }

    // ---- token ----------------------------------------------------------------------------------------------

    private static async Task<IResult> Token(
        HttpContext httpContext,
        [FromServices] IConfiguration configuration,
        [FromServices] IOptions<BrowserAuthOptions> browser,
        [FromServices] OAuthClients clients,
        [FromServices] IOAuthCodes codes,
        [FromServices] IIsolatedUnitOfWork isolated,
        [FromServices] TimeProvider clock)
    {
        httpContext.Response.Headers.CacheControl = "no-store";
        httpContext.Response.Headers.Pragma = "no-cache";
        if (!OAuthSettings.TryGet(configuration, browser, out _, out var mcpUrl))
        {
            return TypedResults.NotFound();
        }

        IFormCollection form;
        try
        {
            form = httpContext.Request.HasFormContentType
                ? await httpContext.Request.ReadFormAsync(httpContext.RequestAborted).ConfigureAwait(false)
                : FormCollection.Empty;
        }
        catch (Exception exception) when (exception is InvalidDataException or InvalidOperationException or BadHttpRequestException)
        {
            form = FormCollection.Empty;
        }

        if (form["grant_type"] != "authorization_code")
        {
            return Error(StatusCodes.Status400BadRequest, "unsupported_grant_type", "Only authorization_code is supported.");
        }

        string? code = form["code"], redirectUri = form["redirect_uri"], clientId = form["client_id"], verifier = form["code_verifier"], resource = form["resource"];
        if (string.IsNullOrEmpty(code) || string.IsNullOrEmpty(redirectUri) || string.IsNullOrEmpty(clientId) || !OAuthClients.IsVerifier(verifier))
        {
            return Error(StatusCodes.Status400BadRequest, "invalid_request", "code, redirect_uri, client_id and code_verifier are required.");
        }

        if (!string.IsNullOrEmpty(resource) && !OAuthSettings.IsResource(resource, mcpUrl))
        {
            return Error(StatusCodes.Status400BadRequest, "invalid_target", "resource does not name this server.");
        }

        var client = clients.Read(clientId);
        if (client is null)
        {
            return Error(StatusCodes.Status400BadRequest, "invalid_client", "Unknown client.");
        }

        // The code is burned before it is judged, so a guesser or a mismatched client gets one try per code.
        var row = await codes.ConsumeAsync(BrowserSessionSecret.Hash(code), httpContext.RequestAborted).ConfigureAwait(false);
        if (row is null
            || row.ExpiresAt <= clock.GetUtcNow()
            || row.ClientId != clientId
            || row.RedirectUri != redirectUri
            || !OAuthClients.VerifierMatches(verifier!, row.Challenge))
        {
            return Error(StatusCodes.Status400BadRequest, "invalid_grant", "The code is unknown, used, expired or does not match this request.");
        }

        // Minted here, as the approving person, by the handler a signed-in person's own request uses;
        // an abandoned code leaves no token behind.
        var name = OAuthClients.ConnectorTokenName(client.Name, OAuthClients.RedirectHost(row.RedirectUri));
        var scopes = row.Scopes.Split(',');
        var result = await isolated.RunAsync(
            NixSessionContext.ForTenant(TenantId.From(row.TenantId), PrincipalId.From(row.PrincipalId)),
            async (provider, cancellationToken) =>
            {
                var settings = await provider.GetRequiredService<ITenantSettingsStore>().GetAsync(cancellationToken).ConfigureAwait(false);
                if (!settings.McpEnabled)
                {
                    return new IsolatedOutcome<Result<IssuedAccessToken>>(
                        Result.Failure<IssuedAccessToken>("oauth.mcp_disabled", "Remote MCP is turned off for this organisation."),
                        Commit: false);
                }

                // Reconnecting retires the oldest tokens of this name; they roll back with the mint if it fails.
                var now = clock.GetUtcNow();
                var revoke = provider.GetRequiredService<ICommandHandler<RevokeAccessToken, bool>>();
                var own = await provider.GetRequiredService<IPersonalAccessTokens>().ListOwnAsync(cancellationToken).ConfigureAwait(false);
                foreach (var old in Retiring(own, name, now))
                {
                    await revoke.HandleAsync(new RevokeAccessToken(old.Id), cancellationToken).ConfigureAwait(false);
                }

                var minted = await provider
                    .GetRequiredService<ICommandHandler<CreateAccessToken, IssuedAccessToken>>()
                    .HandleAsync(new CreateAccessToken(name, scopes, TokenDays), cancellationToken)
                    .ConfigureAwait(false);
                return new IsolatedOutcome<Result<IssuedAccessToken>>(minted, minted.IsSuccess);
            },
            httpContext.RequestAborted).ConfigureAwait(false);

        return result.IsSuccess
            ? TypedResults.Json(new OAuthTokenResponse(result.Value.Secret, "Bearer", TokenDays * 86400L), OAuthJsonContext.Default.OAuthTokenResponse)
            : Error(StatusCodes.Status400BadRequest, "invalid_grant", result.Error.Message);
    }

    // ---- helpers --------------------------------------------------------------------------------------------

    // Three, not one: a loopback client (a desktop app on several machines) shares one name, and keeping one would make the machines revoke each other in a loop.
    private const int KeptPerConnectorName = 3;

    private static bool IsLive(PersonalAccessToken token, DateTimeOffset now) => token.RevokedAt is null && token.ExpiresAt > now;

    /// <summary>The live tokens of this name that minting one more would revoke; <paramref name="own"/> is newest first.</summary>
    private static IEnumerable<PersonalAccessToken> Retiring(IReadOnlyList<PersonalAccessToken> own, string name, DateTimeOffset now) =>
        own.Where(token => token.Name == name && IsLive(token, now)).Skip(KeptPerConnectorName - 1);

    private static Microsoft.AspNetCore.Http.HttpResults.JsonHttpResult<OAuthError> Error(int status, string error, string description) =>
        TypedResults.Json(new OAuthError(error, description), OAuthJsonContext.Default.OAuthError, statusCode: status);

    internal static IResult Problem(HttpContext httpContext, int status, string code, string detail) =>
        TypedResults.Problem(ApiProblem.Create(httpContext, status, code, "Request refused", detail));

    private static string Redirect(string redirectUri, params (string Name, string? Value)[] parameters) =>
        redirectUri + (redirectUri.Contains('?', StringComparison.Ordinal) ? "&" : "?")
        + string.Join('&', parameters.Where(static p => p.Value is not null).Select(static p => p.Name + "=" + Uri.EscapeDataString(p.Value!)));
}

/// <summary>The checks the two consent routes share: a person's own session, MCP on, and a request that names a real client.</summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Performance", "CA1812", Justification = "Created by dependency injection.")]
internal sealed class OAuthConsentGuard(
    IConfiguration configuration,
    IOptions<BrowserAuthOptions> browser,
    OAuthClients clients,
    AccessTokenSessionContext scope,
    ITenantSettingsStore tenant)
{
    /// <summary>The client, or the response to return instead.</summary>
    internal async ValueTask<(OAuthClients.Client? Client, IResult? Refusal)> CheckAsync(
        HttpContext httpContext, string? clientId, string? redirectUri, string? challenge, string? method, string? resource)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        if (!OAuthSettings.TryGet(configuration, browser, out _, out var mcpUrl))
        {
            return (null, TypedResults.NotFound());
        }

        // A token, pet turn, worker or external bearer never signs a client in on someone's behalf.
        if (!scope.IsInteractive)
        {
            return (null, OAuthEndpoints.Problem(httpContext, StatusCodes.Status403Forbidden, "oauth.interactive_only", "Only a person's own browser session can approve a connection."));
        }

        if (!(await tenant.GetAsync(httpContext.RequestAborted).ConfigureAwait(false)).McpEnabled)
        {
            return (null, OAuthEndpoints.Problem(httpContext, StatusCodes.Status403Forbidden, "oauth.mcp_disabled", "Remote MCP is turned off for this organisation."));
        }

        var client = clients.Read(clientId);
        if (client is null)
        {
            return (null, OAuthEndpoints.Problem(httpContext, StatusCodes.Status400BadRequest, "oauth.invalid_client", "Unknown client."));
        }

        if (redirectUri is null || !client.RedirectUris.Contains(redirectUri, StringComparer.Ordinal))
        {
            return (null, OAuthEndpoints.Problem(httpContext, StatusCodes.Status400BadRequest, "oauth.invalid_redirect_uri", "That redirect URI is not registered for this client."));
        }

        if (!NativeHandoffCoordinator.IsChallenge(challenge) || method != "S256")
        {
            return (null, OAuthEndpoints.Problem(httpContext, StatusCodes.Status400BadRequest, InvalidRequestCode, "A PKCE S256 code challenge is required."));
        }

        return !string.IsNullOrEmpty(resource) && !OAuthSettings.IsResource(resource, mcpUrl)
            ? (null, OAuthEndpoints.Problem(httpContext, StatusCodes.Status400BadRequest, InvalidRequestCode, "resource does not name this server."))
            : (client, null);
    }

    private const string InvalidRequestCode = "oauth.invalid_request";
}
