using Nix.Domain.Identity;

namespace Nix.Domain.Tenancy;

/// <summary>
/// An organisational container inside one tenant: the unit of item containment, membership, AI
/// credential, quota, and retention configuration.
/// </summary>
/// <remarks>
/// Every item belongs to exactly one workspace, and a workspace belongs to exactly one tenant.
/// The chain is what lets an item's tenant be asserted without joining through the tree.
/// </remarks>
public sealed class Workspace
{
    /// <summary>Gets the workspace's identifier.</summary>
    public required WorkspaceId Id { get; init; }

    /// <summary>Gets the owning tenant.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the workspace's display name.</summary>
    public required string Name { get; init; }

    /// <summary>Gets the protected owner when this is a personal workspace.</summary>
    public PrincipalId? PersonalOwnerPrincipalId { get; init; }

    /// <summary>
    /// Gets how long non-pinned version history is retained, in days.
    /// </summary>
    public required int VersionRetentionDays { get; init; }

    /// <summary>
    /// Gets the window, in minutes, within which consecutive edits by one author collapse into a
    /// single version rather than accumulating one per save.
    /// </summary>
    public required int CoalesceWindowMinutes { get; init; }

    /// <summary>
    /// Gets the stored daily-note settings document, or null when the workspace uses the defaults.
    /// Read it through <see cref="DailyNoteSettings.Read"/>, which tolerates a missing or unknown field.
    /// </summary>
    public string? DailyNotes { get; init; }

    /// <summary>Gets the workspace's storage ceiling in bytes.</summary>
    public required long StorageQuotaBytes { get; init; }

    /// <summary>Gets when the workspace was created.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets whether the workspace is active, archived, or being permanently purged.</summary>
    public required WorkspaceLifecycleState LifecycleState { get; init; }

    /// <summary>Gets when the workspace was archived, when applicable.</summary>
    public DateTimeOffset? ArchivedAt { get; init; }

    /// <summary>Gets whether owners closed the workspace to new members: no invitation is sent or accepted.</summary>
    public bool MembershipLocked { get; init; }

    /// <summary>Gets whether several people may edit a file at once; when off, one editor at a time.</summary>
    public bool Collaboration { get; init; } = true;
}
