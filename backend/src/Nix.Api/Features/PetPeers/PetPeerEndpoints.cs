using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Abstractions.PetPeers;
using Nix.Domain.Items;
using Nix.Errors;
using Nix.Features.BrowserAuth;
using Nix.Features.PetRuns;
using Nix.Http;

namespace Nix.Features.PetPeers;

internal static class PetPeerEndpoints
{
    internal const string RateLimitPolicy = "pet-peer";

    internal static void AddPetPeers(this IServiceCollection services)
    {
        services.AddScoped<PetPeerAccess>();
        services.AddScoped<PetPeerDispatcher>();
        services.AddSingleton<PetPeerCredential>();
        services.AddScoped<IPetRunCapability, DelegateToPeer>();
        services.AddScoped<IPetRunCapability, SharePeerResult>();
        services.AddScoped<IPetRunCapability, ReadPeerResult>();
    }

    internal static void MapPetPeers(this IEndpointRouteBuilder endpoints)
    {
        var peers = endpoints.MapGroup("/api/v1/items/{itemId:guid}/pet-peers").WithTags("Pet peers");
        peers.MapGet("", List).WithName("ListPetPeers").Produces<PetPeersResponse>();
        peers.MapGet("/work", ListWork).WithName("ListPetPeerWork").Produces<PetPeerWorkResponse>();
        peers.MapPost("", Register).WithName("RegisterPetPeer").Produces<RegisteredPetPeer>(StatusCodes.Status201Created)
            .WithRequestBodyLimit(4 * 1024).RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        peers.MapDelete("/{peerId:guid}", Revoke).WithName("RevokePetPeer").Produces(StatusCodes.Status204NoContent)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        endpoints.MapPost("/public/v1/pet-mcp/{petId:guid}/dispatch", Dispatch).ExcludeFromDescription()
            .WithRequestBodyLimit(128 * 1024).RequireRateLimiting(RateLimitPolicy);
    }

    private static async Task<IResult> List(Guid itemId, HttpContext http, [FromServices] BrowserAccess browser,
        [FromServices] PetPeerAccess access, [FromServices] IPetPeerStore store)
    {
        if (await browser.VerifyAsync(http, requireOrigin: false).ConfigureAwait(false) is null
            || await access.GetOwnedTaskAsync(ItemId.From(itemId), http.RequestAborted).ConfigureAwait(false) is null)
        {
            return Refused(http);
        }
        return TypedResults.Json(new PetPeersResponse(await store.ListAsync(itemId, http.RequestAborted).ConfigureAwait(false)),
            PetPeerJsonContext.Default.PetPeersResponse);
    }

    private static async Task<IResult> ListWork(Guid itemId, HttpContext http, [FromServices] BrowserAccess browser,
        [FromServices] PetPeerAccess access, [FromServices] IPetPeerStore store, [FromServices] TimeProvider clock)
    {
        if (await browser.VerifyAsync(http, requireOrigin: false).ConfigureAwait(false) is null
            || await access.GetTaskAsync(ItemId.From(itemId), http.RequestAborted).ConfigureAwait(false) is null)
        {
            return Refused(http);
        }
        var now = clock.GetUtcNow();
        var work = (await store.ListWorkAsync(itemId, http.RequestAborted).ConfigureAwait(false))
            .Select(row => Project(row, now)).ToArray();
        return TypedResults.Json(new PetPeerWorkResponse(work), PetPeerJsonContext.Default.PetPeerWorkResponse);
    }

    private static async Task<IResult> Register(Guid itemId, RegisterPetPeerRequest request, HttpContext http,
        [FromServices] BrowserAccess browser, [FromServices] PetPeerAccess access, [FromServices] IPetPeerStore store,
        [FromServices] INixSessionContextAccessor session, [FromServices] PetPeerCredential credentials,
        [FromServices] TimeProvider clock)
    {
        http.Response.Headers.CacheControl = "no-store";
        if (await browser.VerifyAsync(http, requireOrigin: true).ConfigureAwait(false) is null
            || session.Current is not { } actor || browser.PublicOrigin is not { } origin
            || await access.GetTaskAsync(ItemId.From(itemId), http.RequestAborted).ConfigureAwait(false) is not { } item
            || await access.ActivePetAsync(http.RequestAborted).ConfigureAwait(false) is not { } petId)
        {
            return Refused(http);
        }

        var name = request.Name?.Trim();
        if (name is null or { Length: < 1 or > 100 } || name.Any(char.IsControl) || PeerEffect.ContainsCredential(name)
            || request.Kind is not ("client" or "claude" or "codex") || request.Days is < 1 or > 90)
        {
            return Error(http, StatusCodes.Status422UnprocessableEntity, "pet_peers.invalid_registration",
                "Provide a visible peer name, a client, claude, or codex kind, and an expiry of 1 to 90 days.");
        }

        var peer = new PetPeerRegistration(Guid.CreateVersion7(), petId, item.WorkspaceId.Value, itemId, name, request.Kind,
            clock.GetUtcNow().AddDays(request.Days), RevokedAt: null);
        if (!await access.AllowsAsync(peer, http.RequestAborted).ConfigureAwait(false))
        {
            return Refused(http);
        }
        await store.InsertAsync(peer, http.RequestAborted).ConfigureAwait(false);

        var ticket = new PetPeerTicket(actor with { WorkspaceId = item.WorkspaceId }, petId, peer.Id);
        var response = new RegisteredPetPeer(peer, new Uri(origin, $"/mcp/pets/{petId:D}").AbsoluteUri, credentials.Issue(ticket));
        return TypedResults.Json(response, PetPeerJsonContext.Default.RegisteredPetPeer, statusCode: StatusCodes.Status201Created);
    }

    private static async Task<IResult> Revoke(Guid itemId, Guid peerId, HttpContext http, [FromServices] BrowserAccess browser,
        [FromServices] PetPeerAccess access, [FromServices] IPetPeerStore store, [FromServices] TimeProvider clock)
    {
        if (await browser.VerifyAsync(http, requireOrigin: true).ConfigureAwait(false) is null
            || await access.GetOwnedTaskAsync(ItemId.From(itemId), http.RequestAborted).ConfigureAwait(false) is null)
        {
            return Refused(http);
        }
        return await store.RevokeAsync(itemId, peerId, clock.GetUtcNow(), http.RequestAborted).ConfigureAwait(false)
            ? TypedResults.NoContent()
            : TypedResults.NotFound();
    }

    private static async Task<IResult> Dispatch(Guid petId, PetPeerDispatchRequest request, HttpContext http,
        [FromServices] PetPeerCredential credentials, [FromServices] IIsolatedUnitOfWork isolated)
    {
        http.Response.Headers.CacheControl = "no-store";
        if (ReadTicket(http, credentials) is not { } ticket || ticket.PetId != petId)
        {
            return Unauthenticated(http);
        }
        return await isolated.RunAsync(ticket.Session,
            (services, cancellationToken) => services.GetRequiredService<PetPeerDispatcher>()
                .DispatchAsync(ticket, request, http, cancellationToken), http.RequestAborted).ConfigureAwait(false);
    }

    internal static PetPeerTicket? ReadTicket(HttpContext http, PetPeerCredential credentials)
    {
        var bearer = http.Request.Headers.Authorization.ToString();
        return bearer.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)
            ? credentials.Read(bearer[7..]) : null;
    }

    internal static PetPeerWorkView Project(PetPeerWork work, DateTimeOffset now) =>
        new(work.Id, work.PeerId, work.RunId, work.Direction,
            work.Status == "running" && work.LeaseExpiresAt <= now ? "review_required" : work.Status,
            work.Result, work.CreatedAt);

    internal static IResult Unauthenticated(HttpContext http)
    {
        http.Response.Headers.WWWAuthenticate = "Bearer realm=\"nix-pet\", error=\"invalid_token\"";
        return Error(http, StatusCodes.Status401Unauthorized, "pet_peers.credential", "A live credential for this pet registration is required.");
    }

    internal static IResult Refused(HttpContext http) =>
        Error(http, StatusCodes.Status403Forbidden, "pet_peers.denied", "This peer operation is unavailable for this task.");

    internal static IResult Error(HttpContext http, int status, string code, string detail) =>
        TypedResults.Problem(ApiProblem.Create(http, status, code, "Pet peer request refused", detail));
}
