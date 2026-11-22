using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>One file item in the attachments list. Carries no link URL, only whether a public link exists.</summary>
/// <param name="ShownVersionId">The version the file shows: latest approved, else latest upload.</param>
/// <param name="ShownVersionState">That version's state: draft, in_review, approved or revoked.</param>
/// <param name="ExpiresAt">The item's expiry, or null.</param>
/// <param name="SourceItemId">The note the shown version was exported from, or null.</param>
/// <param name="PinCount">How many references pin a version of this file.</param>
/// <param name="ReviewStates">Whether this file has review states switched on; when false, show no Draft, In review or Approved wording or controls for it.</param>
public sealed record AttachmentRow(
    Guid ItemId,
    string Title,
    string MediaType,
    Guid ShownVersionId,
    string ShownVersionState,
    DateTimeOffset? ExpiresAt,
    Guid? SourceItemId,
    int PinCount,
    bool HasPublicLink,
    bool ReviewStates = false);

/// <summary>Reads the workspace's file items for the attachments page.</summary>
public interface IAttachmentStore
{
    /// <summary>
    /// File items of a workspace, newest first, keyset by item id, for the session's tenant. Files
    /// under a lock the credential has not opened are left out entirely.
    /// </summary>
    /// <param name="workspaceId">The workspace to list.</param>
    /// <param name="state">Only files whose shown version is in this state, or null.</param>
    /// <param name="includeImages">Whether image files are listed.</param>
    /// <param name="expiring">Only files carrying an expiry set by a reference.</param>
    /// <param name="afterItemId">The last item of the previous page, or null.</param>
    /// <param name="limit">The most rows to return.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The rows, at most <paramref name="limit"/>.</returns>
    public ValueTask<IReadOnlyList<AttachmentRow>> ListAsync(
        WorkspaceId workspaceId,
        string? state,
        bool includeImages,
        bool expiring,
        Guid? afterItemId,
        int limit,
        CancellationToken cancellationToken);
}
