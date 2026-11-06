using Nix.Domain.Files;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.PublicLinks;

/// <summary>A revocable anonymous-read capability for one note or file item; one active link per item.</summary>
public sealed class PublicLink
{
    public required Guid Id { get; init; }
    public required TenantId TenantId { get; init; }
    public required WorkspaceId WorkspaceId { get; init; }
    public required ItemId ItemId { get; init; }
    public required string Nonce { get; set; }

    /// <summary>The fixed version a file link serves; null for a note link.</summary>
    public FileVersionId? FileVersionId { get; init; }

    /// <summary>The principal anonymous reads act as.</summary>
    public required PrincipalId ServicePrincipalId { get; init; }
    public required PrincipalId CreatedBy { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset? RevokedAt { get; set; }
}
