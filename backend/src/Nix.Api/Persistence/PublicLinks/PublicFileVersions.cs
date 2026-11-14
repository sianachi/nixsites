using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Files;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.PublicLinks;

/// <summary>The file rows a public note's file verdict reads.</summary>
public sealed class PublicFileVersions(NixDbContext db) : IPublicFileVersions
{
    /// <inheritdoc />
    public async ValueTask<FileBody?> FindBodyAsync(TenantId tenant, ItemId itemId, CancellationToken cancellationToken) =>
        await db.FileBodies.AsNoTracking().SingleOrDefaultAsync(
            candidate => candidate.TenantId == tenant && candidate.ItemId == itemId,
            cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<FileVersion?> FindLatestApprovedAsync(
        TenantId tenant,
        WorkspaceId workspace,
        ItemId itemId,
        CancellationToken cancellationToken,
        bool anyUnrevoked = false) =>
        await db.FileVersions.AsNoTracking()
            .Where(version => version.TenantId == tenant && version.ItemId == itemId && version.WorkspaceId == workspace
                && (anyUnrevoked ? version.State != FileVersionStates.Revoked : version.State == FileVersionStates.Approved)
                && version.ObjectReady)
            .OrderByDescending(version => version.Version)
            .FirstOrDefaultAsync(cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<FileVersion?> FindVersionAsync(
        TenantId tenant,
        ItemId itemId,
        FileVersionId versionId,
        CancellationToken cancellationToken) =>
        await db.FileVersions.AsNoTracking().SingleOrDefaultAsync(
            version => version.TenantId == tenant && version.ItemId == itemId && version.Id == versionId,
            cancellationToken).ConfigureAwait(false);
}
