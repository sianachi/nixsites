using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Persistence;

namespace Nix.Features.PublicLinks.Notes;

/// <summary>
/// [SEC] The two calls collaboration makes back to Core while rendering a public note. The shared
/// secret only says which service is calling; every answer here is re-derived from the live link
/// row, so a revoked, trashed or locked note renders nothing even to a caller holding the secret.
/// </summary>
public static class PublicNoteInternalEndpoints
{
    private const int MaximumFiles = 200;

    internal static void Map(IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost("/internal/public-links/{linkId:guid}/authorize", Authorize).ExcludeFromDescription();
        endpoints.MapPost("/internal/public-links/{linkId:guid}/files", Files).ExcludeFromDescription();
    }

    private static async Task<IResult> Authorize(
        Guid linkId,
        HttpRequest request,
        [FromServices] IIsolatedUnitOfWork units,
        CancellationToken cancellationToken)
    {
        var scope = await request.ReadFromJsonAsync(PublicNotesJsonContext.Default.PublicNoteScope, cancellationToken).ConfigureAwait(false);
        if (scope is null)
        {
            return TypedResults.NotFound();
        }

        var grant = await units.RunAsync(
            Session(scope.TenantId, scope.PrincipalId),
            async (services, token) => new IsolatedOutcome<PublicNoteGrant?>(
                await GrantAsync(services, linkId, scope, token).ConfigureAwait(false), false),
            cancellationToken).ConfigureAwait(false);
        return grant is null
            ? TypedResults.NotFound()
            : TypedResults.Json(grant, PublicNotesJsonContext.Default.PublicNoteGrant);
    }

    private static async Task<IResult> Files(
        Guid linkId,
        HttpRequest request,
        [FromServices] IIsolatedUnitOfWork units,
        CancellationToken cancellationToken)
    {
        var files = await request.ReadFromJsonAsync(PublicNotesJsonContext.Default.PublicNoteFilesRequest, cancellationToken).ConfigureAwait(false);
        if (files is null || files.Blocks.Count > MaximumFiles || files.Images.Count > MaximumFiles)
        {
            return TypedResults.NotFound();
        }

        var scope = new PublicNoteScope(files.TenantId, files.PrincipalId, files.WorkspaceId, files.ItemId);
        var answer = await units.RunAsync(
            Session(scope.TenantId, scope.PrincipalId),
            async (services, token) =>
            {
                if (await GrantAsync(services, linkId, scope, token).ConfigureAwait(false) is null)
                {
                    return new IsolatedOutcome<PublicNoteFilesResponse?>(null, false);
                }

                var tree = services.GetRequiredService<IItemTree>();
                var store = services.GetRequiredService<IFileStore>();
                var db = services.GetRequiredService<NixDbContext>();
                var tenant = new TenantId(scope.TenantId);
                var workspace = new WorkspaceId(scope.WorkspaceId);

                async Task<List<PublicFileVerdictResponse>> Resolve(IEnumerable<Guid> ids, bool image)
                {
                    var verdicts = new List<PublicFileVerdictResponse>();
                    foreach (var id in ids.Distinct())
                    {
                        var verdict = await PublicFileAccess.ResolveAsync(tree, store, db, tenant, workspace, id, image, token).ConfigureAwait(false);
                        verdicts.Add(new(
                            id,
                            verdict.Disposition switch
                            {
                                PublicFileDisposition.Servable => "servable",
                                PublicFileDisposition.Withheld => "withheld",
                                _ => "hidden",
                            },
                            verdict.Disposition == PublicFileDisposition.Hidden ? null : verdict.Name,
                            verdict.Disposition == PublicFileDisposition.Servable ? verdict.MediaType : null));
                    }
                    return verdicts;
                }

                return new IsolatedOutcome<PublicNoteFilesResponse?>(
                    new(await Resolve(files.Blocks, false).ConfigureAwait(false), await Resolve(files.Images, true).ConfigureAwait(false)),
                    false);
            },
            cancellationToken).ConfigureAwait(false);
        return answer is null
            ? TypedResults.NotFound()
            : TypedResults.Json(answer, PublicNotesJsonContext.Default.PublicNoteFilesResponse);
    }

    private static NixSessionContext Session(Guid tenantId, Guid principalId) =>
        NixSessionContext.ForTenant(new TenantId(tenantId), new PrincipalId(principalId));

    /// <summary>The note's grant when its link is live and its principal may still read it, else null.</summary>
    public static async Task<PublicNoteGrant?> GrantAsync(
        IServiceProvider services,
        Guid linkId,
        PublicNoteScope scope,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(scope);
        var configuration = services.GetRequiredService<IConfiguration>();
        if (!PublicLinkSettings.IsEnabled(configuration))
        {
            return null;
        }

        var tenant = new TenantId(scope.TenantId);
        var principal = new PrincipalId(scope.PrincipalId);
        var db = services.GetRequiredService<NixDbContext>();
        var itemId = new ItemId(scope.ItemId);
        var workspace = new WorkspaceId(scope.WorkspaceId);
        var live = await db.PublicLinks.AsNoTracking().AnyAsync(
            link => link.TenantId == tenant && link.Id == linkId && link.RevokedAt == null
                && link.ItemId == itemId && link.WorkspaceId == workspace
                && link.ServicePrincipalId == principal && link.FileVersionId == null,
            cancellationToken).ConfigureAwait(false);
        if (!live)
        {
            return null;
        }

        var identity = await services.GetRequiredService<IIdentityDirectory>()
            .FindPrincipalByIdAsync(tenant, principal, cancellationToken).ConfigureAwait(false);
        var item = await services.GetRequiredService<IItemTree>().FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (identity?.Status != PrincipalStatus.Active
            || item is null
            || item.WorkspaceId.Value != scope.WorkspaceId
            || !await services.GetRequiredService<IPermissionResolver>().CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false)
            || !await services.GetRequiredService<IItemLocks>().MayReadBodyAsync(item.Id, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        return new(item.Id.Value, item.WorkspaceId.Value, "read", item.Type, ItemProperties.ReadTitle(item.Properties));
    }
}
