using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>A workspace's password lock as the calling credential sees it.</summary>
/// <param name="PasswordProtected">Whether the workspace has a password.</param>
/// <param name="UnlockedUntil">
/// When this credential's unlock ends, or <see langword="null"/> while the workspace is closed to
/// it (or has no password).
/// </param>
public readonly record struct WorkspaceLockState(bool PasswordProtected, DateTimeOffset? UnlockedUntil)
{
    /// <summary>Gets whether the workspace is closed to the calling credential.</summary>
    public bool Closed => PasswordProtected && UnlockedUntil is null;
}

/// <summary>
/// Workspace passwords and the per-credential grants past them, for the tenant and credential of
/// the current unit of work.
/// </summary>
/// <remarks>
/// <para>
/// <b>Not the enforcement point.</b> Access is enforced by <see cref="IPermissionResolver"/>, whose
/// answers already account for the lock. This port sets, checks and removes the password and
/// issues the grants; the resolver reads the same two tables in its own statements so that the
/// answer costs no extra round trip.
/// </para>
/// <para>
/// The credential comes from <see cref="CredentialSessionContext"/>, never a parameter.
/// </para>
/// </remarks>
public interface IWorkspaceLocks
{
    /// <summary>Reads one workspace's lock state for the current credential.</summary>
    /// <param name="workspaceId">The workspace.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The state.</returns>
    public ValueTask<WorkspaceLockState> GetStateAsync(WorkspaceId workspaceId, CancellationToken cancellationToken);

    /// <summary>Reads the lock state of several workspaces; workspaces without a password are absent.</summary>
    /// <param name="workspaceIds">The workspaces.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The state of each workspace that has a password.</returns>
    public ValueTask<IReadOnlyDictionary<WorkspaceId, WorkspaceLockState>> GetStatesAsync(
        IReadOnlyList<WorkspaceId> workspaceIds,
        CancellationToken cancellationToken);

    /// <summary>The stored verifier, or <see langword="null"/> when the workspace has no password.</summary>
    /// <param name="workspaceId">The workspace.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The verifier.</returns>
    public ValueTask<string?> FindVerifierAsync(WorkspaceId workspaceId, CancellationToken cancellationToken);

    /// <summary>
    /// The verifier of an active, open-to-joining workspace that has a password, or
    /// <see langword="null"/> for any other reason. The caller learns nothing of why.
    /// </summary>
    /// <param name="workspaceId">The workspace.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The verifier.</returns>
    public ValueTask<string?> FindJoinVerifierAsync(WorkspaceId workspaceId, CancellationToken cancellationToken);

    /// <summary>Sets a password on an unprotected workspace; writes nothing if one exists.</summary>
    /// <param name="workspaceId">The workspace.</param>
    /// <param name="verifier">The new verifier.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns><see langword="true"/> when the password was set.</returns>
    public ValueTask<bool> LockAsync(WorkspaceId workspaceId, string verifier, CancellationToken cancellationToken);

    /// <summary>Replaces the verifier if it is still the expected one, and revokes every grant.</summary>
    /// <param name="workspaceId">The workspace.</param>
    /// <param name="expected">The verifier the current password was checked against.</param>
    /// <param name="verifier">The new verifier.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns><see langword="true"/> when the verifier was replaced.</returns>
    public ValueTask<bool> ChangeVerifierAsync(
        WorkspaceId workspaceId,
        string expected,
        string verifier,
        CancellationToken cancellationToken);

    /// <summary>Removes the password if it is still the expected one; grants go with it.</summary>
    /// <param name="workspaceId">The workspace.</param>
    /// <param name="expected">The verifier the current password was checked against.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns><see langword="true"/> when the password was removed.</returns>
    public ValueTask<bool> RemoveAsync(WorkspaceId workspaceId, string expected, CancellationToken cancellationToken);

    /// <summary>Issues the current credential a grant, only while the verifier is still the given one.</summary>
    /// <param name="workspaceId">The workspace.</param>
    /// <param name="verifier">The verifier the password was checked against.</param>
    /// <param name="expiresAt">When the grant ends.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns><see langword="true"/> when the grant was written.</returns>
    public ValueTask<bool> GrantAsync(
        WorkspaceId workspaceId,
        string verifier,
        DateTimeOffset expiresAt,
        CancellationToken cancellationToken);

    /// <summary>Ends the current credential's grant. Idempotent.</summary>
    /// <param name="workspaceId">The workspace.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>A task that completes when the grant is gone.</returns>
    public ValueTask RevokeAsync(WorkspaceId workspaceId, CancellationToken cancellationToken);

    /// <summary>
    /// Adds the acting principal to a workspace as a viewer, only while the verifier is still the
    /// given one and the workspace is active and open to new members. An existing member is left
    /// as they are. Audited.
    /// </summary>
    /// <param name="workspaceId">The workspace.</param>
    /// <param name="verifier">The verifier the password was checked against.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns><see langword="true"/> when the principal is now (or already was) a member.</returns>
    public ValueTask<bool> JoinAsync(WorkspaceId workspaceId, string verifier, CancellationToken cancellationToken);

    /// <summary>Records a password change on the workspace in the audit log.</summary>
    /// <param name="workspaceId">The workspace.</param>
    /// <param name="action">One of <c>set</c>, <c>changed</c>, <c>removed</c>.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>A task that completes when the record is written.</returns>
    public ValueTask AuditAsync(WorkspaceId workspaceId, string action, CancellationToken cancellationToken);
}

/// <summary>
/// Membership questions that deliberately ignore the workspace password lock, for the few callers
/// that must work while a workspace is closed: password management and the workspace list.
/// </summary>
/// <remarks>
/// Never use this to decide whether content may be shown. <see cref="IPermissionResolver"/> is the
/// only answer to that.
/// </remarks>
public interface IWorkspaceMembershipIgnoringLock
{
    /// <summary>
    /// The strongest role the acting principal holds in an active workspace, whether or not it is
    /// locked to them, or <see langword="null"/> when they hold none.
    /// </summary>
    /// <param name="workspaceId">The workspace.</param>
    /// <param name="cancellationToken">Cancels the lookup.</param>
    /// <returns>The role.</returns>
    public ValueTask<Nix.Domain.Authorization.WorkspaceRole?> RoleIgnoringLockAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken);

    /// <summary>
    /// As <see cref="RoleIgnoringLockAsync"/>, but an archived workspace counts too, so a member can
    /// unlock one in order to restore or delete it. Never a way to read anything: the resolver
    /// still answers "no access" for an archived workspace.
    /// </summary>
    /// <param name="workspaceId">The workspace.</param>
    /// <param name="cancellationToken">Cancels the lookup.</param>
    /// <returns>The role.</returns>
    public ValueTask<Nix.Domain.Authorization.WorkspaceRole?> RoleIgnoringLockAnyLifecycleAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken);
}
