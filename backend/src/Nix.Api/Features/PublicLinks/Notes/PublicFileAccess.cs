using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Domain.Files;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Persistence;

namespace Nix.Features.PublicLinks.Notes;

public enum PublicFileDisposition
{
    /// <summary>Not a file this reader may learn anything about: trashed, locked, foreign or not a file.</summary>
    Hidden,

    /// <summary>A readable file with nothing approved to serve. Its name may be shown.</summary>
    Withheld,
    Servable,
}

/// <summary>The one version a public note serves for a file.</summary>
public sealed record PublicFileChoice(string ObjectKey, string FileName, string MediaType);

public sealed record PublicFileVerdict(PublicFileDisposition Disposition, string? Name, string? MediaType, PublicFileChoice? Choice);

/// <summary>
/// [SEC] Which file a public note may hand out, and which version. The draft exposure rule:
/// a file serves its latest approved version; with none, only an inline image in PNG, JPEG, WebP or
/// AVIF serves its current version; anything else is withheld. Hidden files (trashed, locked,
/// another workspace, not a file) never reveal a name.
/// </summary>
public static class PublicFileAccess
{
    private static readonly HashSet<string> InlineImageTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/png", "image/jpeg", "image/webp", "image/avif",
    };

    private static readonly PublicFileVerdict Hidden = new(PublicFileDisposition.Hidden, null, null, null);

    public static async Task<PublicFileVerdict> ResolveAsync(
        IItemTree tree,
        IFileStore files,
        NixDbContext db,
        TenantId tenant,
        WorkspaceId workspace,
        Guid fileId,
        bool asImage,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(tree);
        ArgumentNullException.ThrowIfNull(files);
        ArgumentNullException.ThrowIfNull(db);
        var itemId = ItemId.From(fileId);
        var item = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null || item.WorkspaceId != workspace)
        {
            return Hidden;
        }

        // The store's single read path: permission, trash, lock and the body's existence.
        if (await files.AuthorizeDownloadAsync(itemId, null, cancellationToken).ConfigureAwait(false) is null)
        {
            return Hidden;
        }

        var body = await db.FileBodies.AsNoTracking().SingleOrDefaultAsync(
            candidate => candidate.TenantId == tenant && candidate.ItemId == itemId,
            cancellationToken).ConfigureAwait(false);
        if (body is null)
        {
            return Hidden;
        }

        var approved = await db.FileVersions.AsNoTracking()
            .Where(version => version.TenantId == tenant && version.ItemId == itemId && version.WorkspaceId == workspace
                && version.State == "approved" && version.ObjectReady)
            .OrderByDescending(version => version.Version)
            .FirstOrDefaultAsync(cancellationToken).ConfigureAwait(false);
        if (approved is not null)
        {
            return Serve(approved);
        }

        var current = await db.FileVersions.AsNoTracking().SingleOrDefaultAsync(
            version => version.TenantId == tenant && version.ItemId == itemId && version.Id == body.CurrentVersionId,
            cancellationToken).ConfigureAwait(false);
        if (current is null)
        {
            return Hidden;
        }

        return asImage && current.ObjectReady && InlineImageTypes.Contains(current.MediaType)
            ? Serve(current)
            : new(PublicFileDisposition.Withheld, current.FileName, null, null);
    }

    private static PublicFileVerdict Serve(FileVersion version) =>
        new(PublicFileDisposition.Servable, version.FileName, version.MediaType,
            new(version.ObjectKey, version.FileName, version.MediaType));
}
