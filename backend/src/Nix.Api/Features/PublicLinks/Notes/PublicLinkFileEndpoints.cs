using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Http;
using Nix.Persistence.ObjectStorage;

namespace Nix.Features.PublicLinks.Notes;

/// <summary>
/// [SEC] A file named by a note's public link: 302 to a short-lived signed URL, <c>no-store</c>.
/// Authorization (link, revocation, lock, trash, file approval) is re-checked on every request. Only
/// the body-derived set of servable file ids is cached, briefly, so one page view renders the note
/// once per body revision: an edit that removes a reference takes effect at once.
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
            .RequireRateLimiting(RateLimitRefusal.PublicLinkFilesPolicyName);
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

        var servable = await PublicNoteServing.ServableIdsAsync(reader, link, cancellation).ConfigureAwait(false);
        if (servable is null || !servable.Contains(fileItemId))
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
                    services.GetRequiredService<IPublicFileVersions>(),
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
