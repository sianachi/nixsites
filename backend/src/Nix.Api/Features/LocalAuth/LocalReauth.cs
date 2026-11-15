using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Errors;

namespace Nix.Features.LocalAuth;

/// <summary>How a re-authentication attempt ended.</summary>
public enum ReauthOutcome
{
    /// <summary>Proven: the current password matched, or the session is fresh enough.</summary>
    Ok,

    /// <summary>The current password was missing or wrong.</summary>
    WrongPassword,

    /// <summary>Too many wrong passwords; the account is paused.</summary>
    Paused,

    /// <summary>No password exists to ask for and the session is older than fifteen minutes.</summary>
    StaleSession,
}

/// <summary>An outcome with how long to wait when paused.</summary>
public readonly record struct ReauthResult(ReauthOutcome Outcome, TimeSpan RetryAfter = default)
{
    public bool IsOk => Outcome == ReauthOutcome.Ok;
}

/// <summary>
/// Decision 13 as one check: changing or removing a credential needs the current password when one exists,
/// otherwise a browser session younger than 15 minutes. Wrong passwords here count toward the same account
/// pause as sign-in, so this cannot be used to guess a password through a stolen session.
/// </summary>
public sealed class LocalReauth(
    ILocalAccounts accounts,
    PasswordHasher hasher,
    CredentialSessionContext credential,
    TimeProvider clock)
{
    /// <summary>How young a session must be to stand in for a password.</summary>
    public static readonly TimeSpan FreshSession = TimeSpan.FromMinutes(15);

    /// <summary>Runs the check for the already-authenticated <paramref name="account"/>.</summary>
    public async ValueTask<ReauthResult> CheckAsync(LocalAccountRecord account, string? currentPassword, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(account);
        var now = clock.GetUtcNow();
        if (account.HasPassword)
        {
            if (account.IsPaused(now))
            {
                return new(ReauthOutcome.Paused, account.PausedUntil!.Value - now);
            }

            if (currentPassword is null || !hasher.Verify(currentPassword, account.PasswordHash).Ok)
            {
                return await accounts.RegisterFailureAsync(account.PrincipalId, cancellationToken).ConfigureAwait(false) is { } until
                    ? new(ReauthOutcome.Paused, until - now)
                    : new(ReauthOutcome.WrongPassword);
            }

            await accounts.ClearFailuresAsync(account.PrincipalId, cancellationToken).ConfigureAwait(false);
            return new(ReauthOutcome.Ok);
        }

        return credential.CredentialId is { } sessionId
            && await accounts.FindSessionAsync(BrowserSessionId.From(sessionId), cancellationToken).ConfigureAwait(false) is { } session
            && now - session.CreatedAt <= FreshSession
            ? new(ReauthOutcome.Ok)
            : new(ReauthOutcome.StaleSession);
    }

    /// <summary>The refusal for a failed check; call only when <see cref="ReauthResult.IsOk"/> is false.</summary>
    internal static IResult Refuse(HttpContext httpContext, ReauthResult result) => result.Outcome switch
    {
        ReauthOutcome.Paused => LocalAuthProblems.Paused(httpContext, result.RetryAfter),
        ReauthOutcome.StaleSession => TypedResults.Problem(ApiProblem.Create(
            httpContext,
            StatusCodes.Status403Forbidden,
            "security.recent_sign_in_required",
            "Sign in again first",
            "This change needs a sign-in from the last 15 minutes. Sign out, sign in, then try again.")),
        _ => TypedResults.Problem(ApiProblem.Create(
            httpContext,
            StatusCodes.Status403Forbidden,
            "security.current_password_invalid",
            "Current password is wrong",
            "The current password did not match.")),
    };
}
