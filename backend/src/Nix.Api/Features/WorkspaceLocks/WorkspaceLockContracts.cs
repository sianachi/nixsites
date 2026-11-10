using System.Globalization;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Locks;
using Nix.Messaging;

namespace Nix.Features.WorkspaceLocks;

/// <summary>Sets a workspace's password, or changes it.</summary>
/// <param name="WorkspaceId">The workspace.</param>
/// <param name="Password">The new password.</param>
/// <param name="CurrentPassword">The existing password, required when the workspace already has one.</param>
public sealed record SetWorkspacePassword(WorkspaceId WorkspaceId, string Password, string? CurrentPassword)
    : ICommand<bool>;

/// <summary>Removes a workspace's password.</summary>
/// <param name="WorkspaceId">The workspace.</param>
/// <param name="Password">The current password.</param>
public sealed record RemoveWorkspacePassword(WorkspaceId WorkspaceId, string Password) : ICommand<bool>;

/// <summary>Opens a locked workspace to the calling credential for a while.</summary>
/// <param name="WorkspaceId">The workspace.</param>
/// <param name="Password">The workspace password.</param>
public sealed record UnlockWorkspace(WorkspaceId WorkspaceId, string Password) : ICommand<DateTimeOffset>;

/// <summary>Closes a workspace to the calling credential again.</summary>
/// <param name="WorkspaceId">The workspace.</param>
public sealed record RelockWorkspace(WorkspaceId WorkspaceId) : ICommand<bool>;

/// <summary>Joins a workspace by its password.</summary>
/// <param name="WorkspaceId">The workspace named by the join link.</param>
/// <param name="Password">The workspace password.</param>
public sealed record JoinWorkspace(WorkspaceId WorkspaceId, string Password) : ICommand<DateTimeOffset>;

/// <summary>Stable failure codes for workspace passwords.</summary>
public static class WorkspaceLockErrors
{
    /// <summary>A new password outside the accepted length.</summary>
    public const string PasswordInvalidCode = "workspaces.password_invalid";

    /// <summary>A password that does not match.</summary>
    public const string WrongPasswordCode = "workspaces.wrong_password";

    /// <summary>Setting a password on a workspace that has one, without the current password.</summary>
    public const string PasswordExistsCode = "workspaces.password_exists";

    /// <summary>An operation that needs a password on a workspace that has none.</summary>
    public const string PasswordNotSetCode = "workspaces.password_not_set";

    /// <summary>A credential that cannot hold an unlock.</summary>
    public const string CredentialCannotUnlockCode = "workspaces.credential_cannot_unlock";

    /// <summary>Repeated wrong passwords against one target.</summary>
    public const string TooManyAttemptsCode = "workspaces.too_many_attempts";

    /// <summary>The server is at its ceiling of password checks.</summary>
    public const string BusyCode = "workspaces.password_busy";

    /// <summary>
    /// Every way a join can fail for somebody who is not a member: no such workspace, no password,
    /// closed to new members, archived, or a wrong password. One code, one status, one message.
    /// </summary>
    public const string JoinRefusedCode = "workspaces.join_refused";

    /// <summary>The shortest workspace password: longer than an item lock's, because one password guards a whole workspace and many people may guess at it.</summary>
    public const int MinimumLength = 8;

    internal static bool IsAcceptable(string? password) =>
        password is { Length: >= MinimumLength } && LockPasswordHasher.IsAcceptable(password);

    internal static NixError PasswordInvalid() =>
        new(
            PasswordInvalidCode,
            $"A workspace password must be {MinimumLength} to "
            + $"{LockPasswordHasher.MaximumLength} characters long.");

    internal static NixError WrongPassword() =>
        new(WrongPasswordCode, "That password does not open this workspace.");

    internal static NixError PasswordExists() =>
        new(PasswordExistsCode, "This workspace already has a password. Give the current one to change it.");

    internal static NixError PasswordNotSet() =>
        new(PasswordNotSetCode, "This workspace has no password.");

    internal static NixError CredentialCannotUnlock() =>
        new(
            CredentialCannotUnlockCode,
            "Only a signed-in browser or a personal access token can unlock a workspace.");

    internal static NixError JoinRefused() =>
        new(JoinRefusedCode, "That link and password do not open a workspace.");

    internal static NixError TooManyAttempts(TimeSpan retryAfter) =>
        new(
            TooManyAttemptsCode,
            "Too many wrong passwords. Try again in "
            + Math.Ceiling(retryAfter.TotalMinutes).ToString(CultureInfo.InvariantCulture)
            + " minute(s).");

    internal static NixError Busy() =>
        new(BusyCode, "Passwords cannot be checked right now. Try again in a moment.");

    /// <summary>The refusal a check that did not match stands for, or null when it matched.</summary>
    internal static NixError? For(PasswordCheck check) => check.Outcome switch
    {
        PasswordCheckOutcome.Matched => null,
        PasswordCheckOutcome.Wrong => WrongPassword(),
        PasswordCheckOutcome.Throttled => TooManyAttempts(check.RetryAfter),
        PasswordCheckOutcome.Busy => Busy(),
        _ => throw new InvalidOperationException($"Unknown password check outcome {check.Outcome}."),
    };
}

/// <summary>Sets or changes a workspace password.</summary>
/// <param name="Password">The new password.</param>
/// <param name="CurrentPassword">The existing password; required when the workspace already has one.</param>
internal sealed record SetWorkspacePasswordRequest(string Password, string? CurrentPassword);

/// <summary>Carries a workspace password, to unlock, join or remove it.</summary>
/// <param name="Password">The workspace password.</param>
internal sealed record WorkspacePasswordRequest(string Password);

/// <summary>The result of an unlock or a join.</summary>
/// <param name="UnlockedUntil">When the calling session's unlock ends.</param>
internal sealed record WorkspaceUnlockResponse(DateTimeOffset UnlockedUntil);
