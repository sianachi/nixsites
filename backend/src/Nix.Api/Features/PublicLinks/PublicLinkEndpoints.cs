using System.Text.Json.Serialization;
using Microsoft.Extensions.Configuration;
using Microsoft.AspNetCore.Http.HttpResults;
using Nix.Errors;
using Nix.Http;

namespace Nix.Features.PublicLinks;

/// <summary>Creates (or replaces) the item's one active public link.</summary>
/// <param name="VersionId">For a file: the version to serve, fixed at creation. Null means the latest approved version; with none approved the request is refused.</param>
public sealed record PutPublicLinkRequest(Guid? VersionId = null);

/// <summary>A file a note's public link withholds because it has no approved version.</summary>
public sealed record WithheldFileResponse(Guid FileItemId, string Name);

/// <summary>The item's active public link. The URL is a bearer capability: anyone holding it can read.</summary>
/// <param name="Url">The absolute public URL.</param>
/// <param name="VersionId">The fixed file version a file link serves, or null for a note link.</param>
/// <param name="VersionState">That version's state at the time of the read, or null for a note link.</param>
/// <param name="WithheldFiles">Files of a note link held back for lack of an approved version.</param>
public sealed record PublicLinkResponse(
    Uri Url,
    Guid ItemId,
    Guid? VersionId,
    string? VersionState,
    Guid CreatedBy,
    DateTimeOffset CreatedAt,
    IReadOnlyList<WithheldFileResponse> WithheldFiles);

/// <summary>
/// What an anonymous reader gets from a link. <c>Kind</c> is <c>note</c> (Title and Html set) or
/// <c>file</c> (Url, Name, MediaType and ExpiresAt set; the URL lives at most 60 seconds). Fields
/// of the other kind are null.
/// </summary>
public sealed record PublicLinkReadResponse(
    string Kind,
    string? Title = null,
    string? Html = null,
    Uri? Url = null,
    string? Name = null,
    string? MediaType = null,
    DateTimeOffset? ExpiresAt = null);

/// <summary>The install-level switch for public links. Off by default.</summary>
public static class PublicLinkSettings
{
    /// <summary>Configuration key of the install switch.</summary>
    public const string EnabledKey = "Nix:PublicLinks:Enabled";

    /// <summary>Whether this install serves and creates public links.</summary>
    public static bool IsEnabled(IConfiguration configuration) =>
        configuration.GetValue(EnabledKey, false);
}

/// <summary>Lane 6 stubs: public links for items and the anonymous read. Replace the handlers; keep the routes and types.</summary>
internal static class PublicLinkEndpoints
{
    internal static IEndpointRouteBuilder MapPublicLinkEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var group = endpoints.MapGroup("/api/v1/items/{itemId:guid}/public-link").WithTags("PublicLinks");
        group.MapGet("", (Guid itemId, HttpContext context) => NotImplemented(context))
            .WithName("GetPublicLink")
            .Produces<PublicLinkResponse>()
            .ProducesProblem(StatusCodes.Status404NotFound);
        group.MapPut("", (Guid itemId, PutPublicLinkRequest request, HttpContext context) => NotImplemented(context))
            .WithName("CreatePublicLink")
            .Produces<PublicLinkResponse>()
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapDelete("", (Guid itemId, HttpContext context) => NotImplemented(context))
            .WithName("RevokePublicLink")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        // Anonymous, outside /api/v1 and so outside the unit of work, like the public form routes.
        endpoints.MapGet("/public/v1/links/{token}", (string token, HttpContext context) => NotImplemented(context))
            .WithTags("PublicLinks")
            .WithName("ReadPublicLink")
            .Produces<PublicLinkReadResponse>()
            .ProducesProblem(StatusCodes.Status404NotFound)
            .RequireRateLimiting(RateLimitRefusal.PublicLinksPolicyName);
        return endpoints;
    }

    private static ProblemHttpResult NotImplemented(HttpContext context) => TypedResults.Problem(ApiProblem.Create(
        context,
        StatusCodes.Status501NotImplemented,
        "public_links.not_implemented",
        "Not implemented",
        "This route is not implemented yet."));
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(PutPublicLinkRequest))]
[JsonSerializable(typeof(PublicLinkResponse))]
[JsonSerializable(typeof(PublicLinkReadResponse))]
internal sealed partial class PublicLinksJsonContext : JsonSerializerContext;
