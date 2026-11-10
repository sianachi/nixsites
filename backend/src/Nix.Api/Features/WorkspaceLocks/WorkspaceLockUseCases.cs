using Nix.Abstractions;
using Nix.Domain.Authorization;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Locks;
using Nix.Features.Workspaces;
using Nix.Messaging;

namespace Nix.Features.WorkspaceLocks;

/// <summary>Shared checks for the workspace password handlers.</summary>
internal static class WorkspaceLockAccess
{
    /// <summary>
    /// The caller's role in the workspace whether or not it is closed to them. Password management
    /// is the one place that must work on a closed workspace, because it is how one is opened.
    /// </summary>
    internal static ValueTask<WorkspaceRole?> RoleAsync(
        IWorkspaceMembershipIgnoringLock membership,
        WorkspaceId workspaceId,
        CancellationToken cancellationToken) =>
        membership.RoleIgnoringLockAsync(workspaceId, cancellationToken);

    internal static Nix.Domain.Tenancy.TenantId Tenant(INixSessionContextAccessor session) =>
        (session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one."))
        .TenantId;

    internal static Nix.Domain.Identity.PrincipalId Principal(INixSessionContextAccessor session) =>
        (session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one."))
        .PrincipalId;
}

/// <summary>Sets or changes a workspace password. Owner only; a change needs the current password.</summary>
public sealed class SetWorkspacePasswordHandler(
    IWorkspaceMembershipIgnoringLock membership,
    IWorkspaceLocks locks,
    LockPasswordGuard guard,
    INixSessionContextAccessor session,
    CredentialSessionContext credential,
    TimeProvider clock)
    : ICommandHandler<SetWorkspacePassword, bool>
{
    /// <summary>Sets or changes the password.</summary>
    /// <param name="command">The workspace and passwords.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>Success, or why it was refused.</returns>
    public async ValueTask<Result<bool>> HandleAsync(SetWorkspacePassword command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        if (await WorkspaceLockAccess.RoleAsync(membership, command.WorkspaceId, cancellationToken).ConfigureAwait(false)
            != WorkspaceRole.Owner)
        {
            return Result.Failure<bool>(WorkspaceErrors.NotFound());
        }

        if (!WorkspaceLockErrors.IsAcceptable(command.Password))
        {
            return Result.Failure<bool>(WorkspaceLockErrors.PasswordInvalid());
        }

        var existing = await locks.FindVerifierAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false);
        if (existing is not null)
        {
            if (command.CurrentPassword is null)
            {
                return Result.Failure<bool>(WorkspaceLockErrors.PasswordExists());
            }

            var check = await guard
                .VerifyAsync(WorkspaceLockAccess.Tenant(session), command.WorkspaceId.Value, WorkspaceLockAccess.Principal(session).Value, command.CurrentPassword, existing, cancellationToken)
                .ConfigureAwait(false);
            if (WorkspaceLockErrors.For(check) is { } refused)
            {
                return Result.Failure<bool>(refused);
            }
        }

        var verifier = await guard.HashAsync(command.Password, cancellationToken).ConfigureAwait(false);
        if (verifier is null)
        {
            return Result.Failure<bool>(WorkspaceLockErrors.Busy());
        }

        var written = existing is null
            ? await locks.LockAsync(command.WorkspaceId, verifier, cancellationToken).ConfigureAwait(false)
            : await locks.ChangeVerifierAsync(command.WorkspaceId, existing, verifier, cancellationToken).ConfigureAwait(false);
        if (!written)
        {
            // Lost a race with another set, change or removal.
            return Result.Failure<bool>(
                existing is null ? WorkspaceLockErrors.PasswordExists() : WorkspaceLockErrors.WrongPassword());
        }

        await locks.AuditAsync(command.WorkspaceId, existing is null ? "set" : "changed", cancellationToken)
            .ConfigureAwait(false);

        // Whoever just chose the password has just proved they know it: keep their own session open.
        if (credential.CredentialId is not null)
        {
            await locks
                .GrantAsync(command.WorkspaceId, verifier, clock.GetUtcNow() + LockAccess.GrantLifetime, cancellationToken)
                .ConfigureAwait(false);
        }

        return Result.Success(true);
    }
}

/// <summary>Removes a workspace password. Owner only, and needs the password.</summary>
public sealed class RemoveWorkspacePasswordHandler(
    IWorkspaceMembershipIgnoringLock membership,
    IWorkspaceLocks locks,
    LockPasswordGuard guard,
    INixSessionContextAccessor session)
    : ICommandHandler<RemoveWorkspacePassword, bool>
{
    /// <summary>Removes the password.</summary>
    /// <param name="command">The workspace and password.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>Success, or why it was refused.</returns>
    public async ValueTask<Result<bool>> HandleAsync(RemoveWorkspacePassword command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        if (await WorkspaceLockAccess.RoleAsync(membership, command.WorkspaceId, cancellationToken).ConfigureAwait(false)
            != WorkspaceRole.Owner)
        {
            return Result.Failure<bool>(WorkspaceErrors.NotFound());
        }

        var existing = await locks.FindVerifierAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false);
        if (existing is null)
        {
            return Result.Failure<bool>(WorkspaceLockErrors.PasswordNotSet());
        }

        var check = await guard
            .VerifyAsync(WorkspaceLockAccess.Tenant(session), command.WorkspaceId.Value, WorkspaceLockAccess.Principal(session).Value, command.Password ?? string.Empty, existing, cancellationToken)
            .ConfigureAwait(false);
        if (WorkspaceLockErrors.For(check) is { } refused)
        {
            return Result.Failure<bool>(refused);
        }

        if (!await locks.RemoveAsync(command.WorkspaceId, existing, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<bool>(WorkspaceLockErrors.PasswordNotSet());
        }

        await locks.AuditAsync(command.WorkspaceId, "removed", cancellationToken).ConfigureAwait(false);
        return Result.Success(true);
    }
}

/// <summary>Opens a locked workspace to the calling credential. Members only.</summary>
public sealed class UnlockWorkspaceHandler(
    IWorkspaceMembershipIgnoringLock membership,
    IWorkspaceLocks locks,
    LockPasswordGuard guard,
    INixSessionContextAccessor session,
    CredentialSessionContext credential,
    TimeProvider clock)
    : ICommandHandler<UnlockWorkspace, DateTimeOffset>
{
    /// <summary>Unlocks the workspace for this credential.</summary>
    /// <param name="command">The workspace and password.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>When the grant ends, or why it was refused.</returns>
    public async ValueTask<Result<DateTimeOffset>> HandleAsync(UnlockWorkspace command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        if (await membership.RoleIgnoringLockAnyLifecycleAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false)
            is null)
        {
            return Result.Failure<DateTimeOffset>(WorkspaceErrors.NotFound());
        }

        if (credential.CredentialId is null)
        {
            return Result.Failure<DateTimeOffset>(WorkspaceLockErrors.CredentialCannotUnlock());
        }

        var existing = await locks.FindVerifierAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false);
        if (existing is null)
        {
            return Result.Failure<DateTimeOffset>(WorkspaceLockErrors.PasswordNotSet());
        }

        var check = await guard
            .VerifyAsync(WorkspaceLockAccess.Tenant(session), command.WorkspaceId.Value, WorkspaceLockAccess.Principal(session).Value, command.Password ?? string.Empty, existing, cancellationToken)
            .ConfigureAwait(false);
        if (WorkspaceLockErrors.For(check) is { } refused)
        {
            return Result.Failure<DateTimeOffset>(refused);
        }

        var expiresAt = clock.GetUtcNow() + LockAccess.GrantLifetime;
        return await locks.GrantAsync(command.WorkspaceId, existing, expiresAt, cancellationToken).ConfigureAwait(false)
            ? Result.Success(expiresAt)
            : Result.Failure<DateTimeOffset>(WorkspaceLockErrors.WrongPassword());
    }
}

/// <summary>Closes the workspace to the calling credential again. Idempotent; members only.</summary>
public sealed class RelockWorkspaceHandler(IWorkspaceMembershipIgnoringLock membership, IWorkspaceLocks locks)
    : ICommandHandler<RelockWorkspace, bool>
{
    /// <summary>Ends the grant.</summary>
    /// <param name="command">The workspace.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>Success, or not found.</returns>
    public async ValueTask<Result<bool>> HandleAsync(RelockWorkspace command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        if (await membership.RoleIgnoringLockAnyLifecycleAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false)
            is null)
        {
            return Result.Failure<bool>(WorkspaceErrors.NotFound());
        }

        await locks.RevokeAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false);
        return Result.Success(true);
    }
}

/// <summary>
/// Joins a workspace by its password, or unlocks it for somebody who is already a member.
/// </summary>
/// <remarks>
/// <para>
/// <b>One failure for every reason.</b> A person who is not a member learns only that the link and
/// password did not work: no such workspace, no password set, closed to new members, archived and
/// a wrong password all return <see cref="WorkspaceLockErrors.JoinRefusedCode"/>. A password check
/// runs in every case, against a dummy verifier when there is nothing real to compare with, and
/// failures are counted per workspace and principal whether or not the workspace exists, so
/// neither the response, its timing nor the throttle separates the cases.
/// </para>
/// <para>
/// Throttled and busy answers are the same for every target and say nothing about it.
/// </para>
/// </remarks>
public sealed class JoinWorkspaceHandler(
    IWorkspaceMembershipIgnoringLock membership,
    IWorkspaceLocks locks,
    LockPasswordGuard guard,
    INixSessionContextAccessor session,
    CredentialSessionContext credential,
    TimeProvider clock)
    : ICommandHandler<JoinWorkspace, DateTimeOffset>
{
    /// <summary>Joins or unlocks.</summary>
    /// <param name="command">The workspace and password.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>When the grant ends, or the one refusal.</returns>
    public async ValueTask<Result<DateTimeOffset>> HandleAsync(JoinWorkspace command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        if (credential.CredentialId is null)
        {
            return Result.Failure<DateTimeOffset>(WorkspaceLockErrors.CredentialCannotUnlock());
        }

        var tenant = WorkspaceLockAccess.Tenant(session);
        var principal = WorkspaceLockAccess.Principal(session);
        var member = await WorkspaceLockAccess.RoleAsync(membership, command.WorkspaceId, cancellationToken)
            .ConfigureAwait(false) is not null;

        // A member's verifier is read whatever the workspace's join state; an outsider's only when
        // it can be joined. Either way a missing one is checked against the dummy.
        var verifier = member
            ? await locks.FindVerifierAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false)
            : await locks.FindJoinVerifierAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false);

        // Outsiders also share one failure count per workspace, so many accounts cannot each take
        // their own free guesses. Members are left out of it: a stranger's wrong guesses must never
        // lock a member, or the owner, out of unlocking. The count is kept for every target alike,
        // real or not, so it separates nothing.
        if (!member
            && guard.ThrottleFor(tenant, command.WorkspaceId.Value, LockPasswordGuard.OutsiderActor) is { } outsiderThrottle)
        {
            return Result.Failure<DateTimeOffset>(WorkspaceLockErrors.For(outsiderThrottle)!.Value);
        }

        var check = await guard
            .VerifyAsync(
                tenant,
                command.WorkspaceId.Value,
                principal.Value,
                command.Password ?? string.Empty,
                verifier ?? guard.DummyVerifier,
                cancellationToken)
            .ConfigureAwait(false);
        if (check.Outcome is PasswordCheckOutcome.Throttled or PasswordCheckOutcome.Busy)
        {
            return Result.Failure<DateTimeOffset>(WorkspaceLockErrors.For(check)!.Value);
        }

        if (check.Outcome != PasswordCheckOutcome.Matched || verifier is null)
        {
            if (!member)
            {
                guard.NoteFailure(tenant, command.WorkspaceId.Value, LockPasswordGuard.OutsiderActor);
            }

            return Result.Failure<DateTimeOffset>(WorkspaceLockErrors.JoinRefused());
        }

        if (!member && !await locks.JoinAsync(command.WorkspaceId, verifier, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<DateTimeOffset>(WorkspaceLockErrors.JoinRefused());
        }

        var expiresAt = clock.GetUtcNow() + LockAccess.GrantLifetime;
        return await locks.GrantAsync(command.WorkspaceId, verifier, expiresAt, cancellationToken).ConfigureAwait(false)
            ? Result.Success(expiresAt)
            : Result.Failure<DateTimeOffset>(WorkspaceLockErrors.JoinRefused());
    }
}
