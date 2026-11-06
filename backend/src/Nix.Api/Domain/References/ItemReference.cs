using Nix.Domain.Files;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.References;

/// <summary>
/// "This holder item relates to that target item", optionally pinned to one file version of the
/// target. Not a property type and not a graph edge.
/// </summary>
public sealed class ItemReference
{
    public required Guid Id { get; init; }
    public required TenantId TenantId { get; init; }
    public required WorkspaceId WorkspaceId { get; init; }
    public required ItemId HolderItemId { get; init; }
    public required ItemId TargetItemId { get; init; }

    /// <summary>The pinned version of the target, or null for a plain reference.</summary>
    public FileVersionId? TargetFileVersionId { get; init; }

    /// <summary>Free-text relationship label, at most 80 characters, or null.</summary>
    public string? Role { get; init; }
    public required PrincipalId CreatedBy { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
}
