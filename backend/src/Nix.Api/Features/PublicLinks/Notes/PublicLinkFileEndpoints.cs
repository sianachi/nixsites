using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Http;
using Nix.Persistence;
using Nix.Persistence.ObjectStorage;

namespace Nix.Features.PublicLinks.Notes;

/// <summary>
/// [SEC] A file named by a note's public link: 302 to a short-lived signed URL, <c>no-store</c>.
/// The note is re-rendered on every request on purpose, so a reference removed from the body, or a
/// file that lost its approval, stops serving at once.
/// </summary>
internal static class PublicLinkFileEndpoints
{
    internal static IEndpointRouteBuilder MapPublicLinkFileEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        PublicNoteInternalEndpoints.Map(endpoints);
        endpoints.MapGet("/public/v1/links/{token}/files/{fileItemId:guid}", Serve)
            .WithTags("PublicLinks")
            .WithName("GetPublicLinkFile")
            .Produces(StatusCodes.Status302Found)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .RequireRateLimiting(RateLimitRefusal.PublicLinksPolicyName);
        return endpoints;
    }

    private static async Task<IResult> Serve(
        string token,
        Guid fileItemId,
        HttpContext context,
        [FromServices] IPublicLinkResolver resolver,
        [FromServices] IPublicNoteReader reader,
        [FromServices] IIsolatedUnitOfWork units,
        [FromServices] S3CapabilitySigner signer)
    {
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers["X-Robots-Tag"] = "noindex, nofollow";
        context.Response.Headers["Referrer-Policy"] = "no-referrer";
        context.Response.Headers.XContentTypeOptions = "nosniff";

        var cancellation = context.RequestAborted;
        var link = await resolver.ResolveAsync(token, cancellation).ConfigureAwait(false);
        if (link is null || link.FileVersionId is not null || !signer.IsConfigured)
        {
            return DeadLink();
        }

        var render = await reader.RenderAsync(link, cancellation).ConfigureAwait(false);
        if (render is null || !render.ServableFileIds.Contains(fileItemId))
        {
            return DeadLink();
        }

        // A servable id is an inline image or has an approved version, so the image rule is the
        // widest this id can have been served under: the latest approved version wins either way.
        var verdict = await units.RunAsync(
            NixSessionContext.ForTenant(link.TenantId, new PrincipalId(link.ServicePrincipalId)),
            async (services, ct) => new IsolatedOutcome<PublicFileVerdict>(
                await PublicFileAccess.ResolveAsync(
                    services.GetRequiredService<IItemTree>(),
                    services.GetRequiredService<IFileStore>(),
                    services.GetRequiredService<NixDbContext>(),
                    link.TenantId,
                    link.WorkspaceId,
                    fileItemId,
                    asImage: true,
                    ct).ConfigureAwait(false),
                false),
            cancellation).ConfigureAwait(false);
        if (verdict is not { Disposition: PublicFileDisposition.Servable, Choice: { } choice })
        {
            return DeadLink();
        }

        return TypedResults.Redirect(SignShortLived(signer, choice));
    }

    private static string SignShortLived(S3CapabilitySigner signer, PublicFileChoice choice) =>
        signer.GetForPublicLink(choice.ObjectKey, choice.FileName, choice.MediaType).Url.ToString();

    // The same 404 every other dead public link gives, with no reason.
    private static Microsoft.AspNetCore.Http.HttpResults.NotFound DeadLink() => TypedResults.NotFound();
}
