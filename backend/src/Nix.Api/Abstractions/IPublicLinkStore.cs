using Nix.Domain.Audit;
using Nix.Domain.Files;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.PublicLinks;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>[SEC] Storage behind the public link endpoints, inside the current unit of work.</summary>
public interface IPublicLinkStore
{
    /// <summary>Whether the item, or any ancestor, carries a lock (a lock covers its subtree).</summary>
    public ValueTask<bool> IsUnderLockAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>Whether the tenant's administrators allow public links (the tenant switch; the install flag is separate).</summary>
    public ValueTask<bool> TenantAllowsAsync(TenantId tenant, CancellationToken cancellationToken);

    /// <summary>Whether this note link is unrevoked and matches the scope it was resolved under.</summary>
    public ValueTask<bool> IsLiveNoteLinkAsync(
        TenantId tenant,
        Guid linkId,
        ItemId itemId,
        WorkspaceId workspace,
        PrincipalId principal,
        CancellationToken cancellationToken);

    /// <summary>The workspace, or null when it is not visible.</summary>
    public ValueTask<Workspace?> FindWorkspaceAsync(WorkspaceId id, CancellationToken cancellationToken);

    /// <summary>The item's unrevoked link, tracked for update.</summary>
    public ValueTask<PublicLink?> FindActiveAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>The service principal of the item's most recent link, when still active, so a replace reuses it.</summary>
    public ValueTask<PrincipalId?> FindReusablePrincipalAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>The named version of the file, or its latest approved one when none is named.</summary>
    public ValueTask<FileVersion?> FindVersionAsync(ItemId itemId, Guid? versionId, CancellationToken cancellationToken);

    /// <summary>Stages a link and, for a new one, its service principal and membership.</summary>
    public void Add(PublicLink link, Principal? principal, WorkspaceMember? membership);

    /// <summary>Stages an audit event for the link.</summary>
    public void AddAudit(NixSessionContext context, PublicLink link, string action, DateTimeOffset at);

    /// <summary>Saves what was staged.</summary>
    public Task SaveAsync(CancellationToken cancellationToken);
}

/// <summary>[SEC] The file rows a public note's file verdict reads.</summary>
public interface IPublicFileVersions
{
    /// <summary>The file's body row, or null.</summary>
    public ValueTask<FileBody?> FindBodyAsync(TenantId tenant, ItemId itemId, CancellationToken cancellationToken);

    /// <summary>The latest approved, ready version of the file, or null.</summary>
    public ValueTask<FileVersion?> FindLatestApprovedAsync(
        TenantId tenant,
        WorkspaceId workspace,
        ItemId itemId,
        CancellationToken cancellationToken);

    /// <summary>One version of the file, or null.</summary>
    public ValueTask<FileVersion?> FindVersionAsync(
        TenantId tenant,
        ItemId itemId,
        FileVersionId versionId,
        CancellationToken cancellationToken);
}

/// <summary>The rows an export reads before and after its worker runs.</summary>
public interface IExportSources
{
    /// <summary>The note body's current revision, or null when nobody has opened it yet.</summary>
    public ValueTask<long?> HeadSeqAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>The newest file upload opened for the export's destination call, or null.</summary>
    public ValueTask<Guid?> FindExportUploadAsync(Guid exportId, CancellationToken cancellationToken);
}
