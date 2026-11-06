using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>A public link token that resolved to a live, servable link.</summary>
/// <param name="FileVersionId">The fixed version a file link serves, or null for a note link.</param>
public sealed record ResolvedPublicLink(
    Guid LinkId,
    TenantId TenantId,
    WorkspaceId WorkspaceId,
    ItemId ItemId,
    Guid? FileVersionId,
    Guid ServicePrincipalId);

/// <summary>
/// [SEC] Turns an anonymous token into a live link, in a session bound to the link's tenant and
/// service principal. Null covers every reason not to serve: a bad signature, a revoked link, the
/// install flag off, an item that is trashed or locked or has a trashed or locked ancestor.
/// </summary>
public interface IPublicLinkResolver
{
    /// <summary>Resolves a token, or null when the link must not serve.</summary>
    public ValueTask<ResolvedPublicLink?> ResolveAsync(string token, CancellationToken cancellationToken);
}

/// <summary>A note as an anonymous reader sees it.</summary>
/// <param name="Html">Escaped, sanitised markup with embeds removed and references flattened.</param>
/// <param name="ServableFileIds">Files the current body may serve through the link.</param>
/// <param name="WithheldFiles">File items the body references with no approved version: id and name.</param>
public sealed record PublicNoteRender(
    string Title,
    string Html,
    IReadOnlyList<Guid> ServableFileIds,
    IReadOnlyList<(Guid FileItemId, string Name)> WithheldFiles);

/// <summary>[SEC] Renders a note's current body for a public link.</summary>
public interface IPublicNoteReader
{
    /// <summary>Renders the note, or null when it has no servable body.</summary>
    public ValueTask<PublicNoteRender?> RenderAsync(ResolvedPublicLink link, CancellationToken cancellationToken);
}

/// <summary>[SEC] Ends public links in the transaction that trashes an item.</summary>
public interface IPublicLinkLifecycle
{
    /// <summary>Permanently ends every active link at or below the item. Restoring does not revive them.</summary>
    public ValueTask EndForSubtreeAsync(ItemId itemId, CancellationToken cancellationToken);
}
