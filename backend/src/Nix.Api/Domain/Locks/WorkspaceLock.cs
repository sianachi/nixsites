using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Locks;

/// <summary>
/// The one password a workspace is closed behind, for its members and for anybody joining.
/// </summary>
/// <remarks>
/// <b>It withholds, it does not encrypt.</b> Like <see cref="ItemLock"/>, this stops other people
/// and other sessions through Core; it does not protect against whoever can read the database.
/// While the workspace is locked to a credential, Core reports it as not found to that credential
/// except for its name and the fact that it is locked.
/// </remarks>
public sealed class WorkspaceLock
{
    /// <summary>Gets the locked workspace.</summary>
    public required WorkspaceId WorkspaceId { get; init; }

    /// <summary>Gets the tenant the workspace belongs to.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the password verifier. Never the password, never returned by any read.</summary>
    public required string PasswordHash { get; init; }

    /// <summary>Gets the principal who set the password, or last changed it.</summary>
    public required PrincipalId LockedBy { get; init; }

    /// <summary>Gets when the password was set or last changed.</summary>
    public required DateTimeOffset LockedAt { get; init; }
}

/// <summary>A short-lived grant that opens one locked workspace to one credential.</summary>
/// <remarks>Keyed by credential, not principal, for the reason <see cref="ItemUnlock"/> is.</remarks>
public sealed class WorkspaceUnlock
{
    /// <summary>Gets the unlocked workspace.</summary>
    public required WorkspaceId WorkspaceId { get; init; }

    /// <summary>Gets the browser session or personal access token the grant belongs to.</summary>
    public required Guid CredentialId { get; init; }

    /// <summary>Gets the tenant the workspace belongs to.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the principal who presented the password.</summary>
    public required PrincipalId PrincipalId { get; init; }

    /// <summary>Gets when the grant stops being honoured.</summary>
    public required DateTimeOffset ExpiresAt { get; init; }
}
