using System.Globalization;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Locks;

/// <summary>Reads an item's lock as the calling credential sees it.</summary>
/// <param name="ItemId">The item.</param>
public sealed record GetItemLock(ItemId ItemId) : IQuery<Result<ItemLockState>>;

/// <summary>Locks an item, or changes the password of one already locked.</summary>
/// <param name="ItemId">The item.</param>
/// <param name="Password">The new password.</param>
/// <param name="CurrentPassword">The existing password, required when the item is already locked.</param>
public sealed record LockItem(ItemId ItemId, string Password, string? CurrentPassword) : ICommand<bool>;

/// <summary>Removes an item's lock.</summary>
/// <param name="ItemId">The item.</param>
/// <param name="Password">The lock's password.</param>
public sealed record RemoveItemLock(ItemId ItemId, string Password) : ICommand<bool>;

/// <summary>Opens a locked item's body to the calling credential for a while.</summary>
/// <param name="ItemId">The item.</param>
/// <param name="Password">The lock's password.</param>
public sealed record UnlockItem(ItemId ItemId, string Password) : ICommand<DateTimeOffset>;

/// <summary>Closes a locked item's body to the calling credential again, before its grant ends.</summary>
/// <param name="ItemId">The item.</param>
public sealed record RelockItem(ItemId ItemId) : ICommand<bool>;

/// <summary>Stable failure codes for item locks.</summary>
public static class LockErrors
{
    /// <summary>Stable code for "no such item, or the caller cannot see it".</summary>
    public const string NotFoundCode = "items.not_found";

    /// <summary>Stable code for a password outside the accepted length.</summary>
    public const string PasswordInvalidCode = "locks.password_invalid";

    /// <summary>Stable code for a password that does not match the lock.</summary>
    public const string WrongPasswordCode = "locks.wrong_password";

    /// <summary>Stable code for setting a lock on an item that already has one, without its password.</summary>
    public const string AlreadyLockedCode = "locks.already_locked";

    /// <summary>Stable code for an operation that needs a lock on an item that has none.</summary>
    public const string NotLockedCode = "locks.not_locked";

    /// <summary>Stable code for a credential that cannot hold an unlock.</summary>
    public const string CredentialCannotUnlockCode = "locks.credential_cannot_unlock";

    /// <summary>Stable code for a lock refusing attempts after repeated wrong passwords.</summary>
    public const string TooManyAttemptsCode = "locks.too_many_attempts";

    /// <summary>Stable code for a password check refused because the server is at its ceiling.</summary>
    public const string BusyCode = "locks.busy";

    internal static NixError NotFound(ItemId itemId) =>
        new(NotFoundCode, $"No item {itemId} is visible.");

    internal static NixError PasswordInvalid() =>
        new(
            PasswordInvalidCode,
            $"A lock password must be {LockPasswordHasher.MinimumLength} to "
            + $"{LockPasswordHasher.MaximumLength} characters long.");

    internal static NixError WrongPassword() =>
        new(WrongPasswordCode, "That password does not open this item.");

    internal static NixError AlreadyLocked() =>
        new(AlreadyLockedCode, "This item is already locked. Give its current password to change it.");

    internal static NixError NotLocked() =>
        new(NotLockedCode, "This item is not locked.");

    internal static NixError CredentialCannotUnlock() =>
        new(
            CredentialCannotUnlockCode,
            "Only a signed-in browser or a personal access token can unlock an item.");

    internal static NixError TooManyAttempts(TimeSpan retryAfter) =>
        new(
            TooManyAttemptsCode,
            "Too many wrong passwords for this item. Try again in "
            + Math.Ceiling(retryAfter.TotalMinutes).ToString(CultureInfo.InvariantCulture)
            + " minute(s).");

    internal static NixError Busy() =>
        new(BusyCode, "Passwords cannot be checked right now. Try again in a moment.");

    /// <summary>The refusal a password check that did not match stands for, or null when it did.</summary>
    internal static NixError? For(PasswordCheck check) => check.Outcome switch
    {
        PasswordCheckOutcome.Matched => null,
        PasswordCheckOutcome.Wrong => WrongPassword(),
        PasswordCheckOutcome.Throttled => TooManyAttempts(check.RetryAfter),
        PasswordCheckOutcome.Busy => Busy(),
        _ => throw new InvalidOperationException($"Unknown password check outcome {check.Outcome}."),
    };
}

/// <summary>Reads an item's lock state.</summary>
/// <remarks>
/// Needs read access only, and says nothing an item read does not already imply: whoever may see
/// an item may see that its body is locked, since that is what they will meet when they open it.
/// </remarks>
public sealed class GetItemLockHandler(
    IItemTree tree,
    IPermissionResolver permissions,
    IItemLocks locks)
    : IQueryHandler<GetItemLock, Result<ItemLockState>>
{
    /// <summary>Reads the state.</summary>
    /// <param name="query">The item.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The state, or not found.</returns>
    public async ValueTask<Result<ItemLockState>> HandleAsync(
        GetItemLock query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        if (!await LockAccess.MayReadAsync(tree, permissions, query.ItemId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ItemLockState>(LockErrors.NotFound(query.ItemId));
        }

        var state = await locks.GetStateAsync(query.ItemId, cancellationToken).ConfigureAwait(false);
        return Result.Success(state);
    }
}

/// <summary>Sets or changes an item's lock.</summary>
/// <remarks>
/// <para>
/// <b>Setting a lock needs write access; changing one also needs its password.</b> Without the
/// second rule anybody who could edit the item could replace the password and read the body, which
/// is the one thing the lock is for.
/// </para>
/// <para>
/// The caller's own credential is unlocked by a successful set or change: somebody who has just
/// chosen the password has just proved they know it, and making them type it again to keep reading
/// would be ceremony. Other credentials, including the same person's other sessions, are closed.
/// </para>
/// </remarks>
public sealed class LockItemHandler(
    IItemTree tree,
    IPermissionResolver permissions,
    IItemLocks locks,
    LockPasswordGuard guard,
    INixSessionContextAccessor session,
    CredentialSessionContext credential,
    TimeProvider clock,
    IFinanceLock? topology = null)
    : ICommandHandler<LockItem, bool>
{
    /// <summary>Sets or changes the lock.</summary>
    /// <param name="command">The item and passwords.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>Success, or why the lock was refused.</returns>
    public async ValueTask<Result<bool>> HandleAsync(LockItem command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        if (!await LockAccess.MayWriteAsync(tree, permissions, command.ItemId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<bool>(LockErrors.NotFound(command.ItemId));
        }

        if (!LockPasswordHasher.IsAcceptable(command.Password))
        {
            return Result.Failure<bool>(LockErrors.PasswordInvalid());
        }

        if (topology is not null)
        {
            var before = await tree.FindAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
            if (before is null)
            {
                return Result.Failure<bool>(LockErrors.NotFound(command.ItemId));
            }
            // A lock above a moving subtree cannot be added after the mover checks that
            // ancestor and before it leaves. Recheck reach after waiting for a transfer too.
            await topology.AcquireWorkspaceTopologyAsync(before.WorkspaceId, cancellationToken).ConfigureAwait(false);
            var current = await tree.FindAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
            if (current is null || current.WorkspaceId != before.WorkspaceId
                || !await LockAccess.MayWriteAsync(tree, permissions, command.ItemId, cancellationToken).ConfigureAwait(false))
            {
                return Result.Failure<bool>(LockErrors.NotFound(command.ItemId));
            }
        }

        var existing = await locks.FindVerifierAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
        if (existing is not null)
        {
            if (command.CurrentPassword is null)
            {
                return Result.Failure<bool>(LockErrors.AlreadyLocked());
            }

            var check = await guard
                .VerifyAsync(LockAccess.Tenant(session), command.ItemId, command.CurrentPassword, existing, cancellationToken)
                .ConfigureAwait(false);
            if (LockErrors.For(check) is { } refused)
            {
                return Result.Failure<bool>(refused);
            }
        }

        var verifier = await guard.HashAsync(command.Password, cancellationToken).ConfigureAwait(false);
        if (verifier is null)
        {
            return Result.Failure<bool>(LockErrors.Busy());
        }

        var written = existing is null
            ? await locks.LockAsync(command.ItemId, verifier, cancellationToken).ConfigureAwait(false)
            : await locks.ChangeVerifierAsync(command.ItemId, existing, verifier, cancellationToken).ConfigureAwait(false);
        if (!written)
        {
            // Lost a race: another lock landed first, or the lock being changed was removed or
            // had its password changed by somebody else since this one was checked.
            return Result.Failure<bool>(
                existing is null ? LockErrors.AlreadyLocked()
                : await locks.IsLockedAsync(command.ItemId, cancellationToken).ConfigureAwait(false)
                    ? LockErrors.WrongPassword()
                    : LockErrors.NotLocked());
        }

        if (credential.CredentialId is not null)
        {
            await locks
                .GrantAsync(command.ItemId, verifier, clock.GetUtcNow() + LockAccess.GrantLifetime, cancellationToken)
                .ConfigureAwait(false);
        }

        return Result.Success(true);
    }
}

/// <summary>Removes an item's lock.</summary>
/// <remarks>Needs write access and the password, for the reason <see cref="LockItemHandler"/> gives.</remarks>
public sealed class RemoveItemLockHandler(
    IItemTree tree,
    IPermissionResolver permissions,
    IItemLocks locks,
    LockPasswordGuard guard,
    INixSessionContextAccessor session)
    : ICommandHandler<RemoveItemLock, bool>
{
    /// <summary>Removes the lock.</summary>
    /// <param name="command">The item and password.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>Success, or why removal was refused.</returns>
    public async ValueTask<Result<bool>> HandleAsync(RemoveItemLock command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        if (!await LockAccess.MayWriteAsync(tree, permissions, command.ItemId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<bool>(LockErrors.NotFound(command.ItemId));
        }

        var existing = await locks.FindVerifierAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
        if (existing is null)
        {
            return Result.Failure<bool>(LockErrors.NotLocked());
        }

        var check = await guard
            .VerifyAsync(LockAccess.Tenant(session), command.ItemId, command.Password ?? string.Empty, existing, cancellationToken)
            .ConfigureAwait(false);
        if (LockErrors.For(check) is { } refused)
        {
            return Result.Failure<bool>(refused);
        }

        return await locks.RemoveAsync(command.ItemId, existing, cancellationToken).ConfigureAwait(false)
            ? Result.Success(true)
            : Result.Failure<bool>(LockErrors.NotLocked());
    }
}

/// <summary>Opens a locked body to the calling credential.</summary>
/// <remarks>
/// Needs read access only: somebody who may read the item and knows the password may read its
/// body. The grant lasts <see cref="LockAccess.GrantLifetime"/> and belongs to this credential
/// alone.
/// </remarks>
public sealed class UnlockItemHandler(
    IItemTree tree,
    IPermissionResolver permissions,
    IItemLocks locks,
    LockPasswordGuard guard,
    INixSessionContextAccessor session,
    CredentialSessionContext credential,
    TimeProvider clock)
    : ICommandHandler<UnlockItem, DateTimeOffset>
{
    private readonly CredentialSessionContext _credential = credential;

    /// <summary>Unlocks the item for this credential.</summary>
    /// <param name="command">The item and password.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>When the grant ends, or why it was refused.</returns>
    public async ValueTask<Result<DateTimeOffset>> HandleAsync(UnlockItem command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        if (!await LockAccess.MayReadAsync(tree, permissions, command.ItemId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<DateTimeOffset>(LockErrors.NotFound(command.ItemId));
        }

        if (_credential.CredentialId is null)
        {
            return Result.Failure<DateTimeOffset>(LockErrors.CredentialCannotUnlock());
        }

        var existing = await locks.FindVerifierAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
        if (existing is null)
        {
            return Result.Failure<DateTimeOffset>(LockErrors.NotLocked());
        }

        var check = await guard
            .VerifyAsync(LockAccess.Tenant(session), command.ItemId, command.Password ?? string.Empty, existing, cancellationToken)
            .ConfigureAwait(false);
        if (LockErrors.For(check) is { } refused)
        {
            return Result.Failure<DateTimeOffset>(refused);
        }

        var expiresAt = clock.GetUtcNow() + LockAccess.GrantLifetime;
        if (!await locks.GrantAsync(command.ItemId, existing, expiresAt, cancellationToken).ConfigureAwait(false))
        {
            // The lock was removed, or its password changed, while this one was being checked.
            return Result.Failure<DateTimeOffset>(
                await locks.IsLockedAsync(command.ItemId, cancellationToken).ConfigureAwait(false)
                    ? LockErrors.WrongPassword()
                    : LockErrors.NotLocked());
        }

        return Result.Success(expiresAt);
    }
}

/// <summary>Ends the calling credential's grant early.</summary>
/// <remarks>
/// Idempotent, and needs read access only - closing something is never riskier than leaving it
/// open, and a "lock again" button that could fail would be the wrong way round.
/// </remarks>
public sealed class RelockItemHandler(
    IItemTree tree,
    IPermissionResolver permissions,
    IItemLocks locks)
    : ICommandHandler<RelockItem, bool>
{
    /// <summary>Ends the grant.</summary>
    /// <param name="command">The item.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>Success, or not found.</returns>
    public async ValueTask<Result<bool>> HandleAsync(RelockItem command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        if (!await LockAccess.MayReadAsync(tree, permissions, command.ItemId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<bool>(LockErrors.NotFound(command.ItemId));
        }

        await locks.RevokeAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
        return Result.Success(true);
    }
}

/// <summary>The visibility checks every lock handler starts with, and the grant lifetime.</summary>
internal static class LockAccess
{
    /// <summary>How long an unlock lasts.</summary>
    /// <remarks>
    /// Long enough to read and edit a note without being interrupted, short enough that a screen
    /// left unattended closes again on its own. Fixed rather than sliding: a grant that renewed
    /// itself on every keystroke would never close on a screen somebody walked away from mid-edit.
    /// The web client closes the body when this runs out; an already-open collaboration session
    /// is refused at its next re-check, up to about ninety seconds later (ADR-0049).
    /// </remarks>
    internal static readonly TimeSpan GrantLifetime = TimeSpan.FromMinutes(15);

    /// <summary>
    /// Whether the caller may see the item, which every lock operation needs.
    /// </summary>
    /// <remarks>
    /// An item inside a template is refused like one the caller cannot see: templates are copied
    /// and applied through their own authorization, which does not consult locks, so a lock there
    /// would be one that does not hold.
    /// </remarks>
    internal static async ValueTask<bool> MayReadAsync(
        IItemTree tree,
        IPermissionResolver permissions,
        ItemId itemId,
        CancellationToken cancellationToken)
    {
        var item = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        return item is { LifecycleState: ItemLifecycleState.Active, TemplateId: null }
            && await permissions.CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Whether the caller may change the item, which setting or removing a lock needs.</summary>
    internal static async ValueTask<bool> MayWriteAsync(
        IItemTree tree,
        IPermissionResolver permissions,
        ItemId itemId,
        CancellationToken cancellationToken)
    {
        var item = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        return item is { LifecycleState: ItemLifecycleState.Active, TemplateId: null }
            && await permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>The tenant the request runs in, which keys the password backoff.</summary>
    internal static Nix.Domain.Tenancy.TenantId Tenant(INixSessionContextAccessor session) =>
        (session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one."))
        .TenantId;
}
