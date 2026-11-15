using Nix.Abstractions;
using Nix.Domain.Identity;

namespace Nix.Features.LocalAuth;

/// <summary>How an authenticator-code attempt ended.</summary>
public enum TotpAttemptKind
{
    /// <summary>Unknown or spent challenge, no app set up, or a wrong or reused code.</summary>
    Invalid,

    /// <summary>Too many wrong answers on the account.</summary>
    Paused,

    /// <summary>The code was right and the challenge is used up; sign the person in.</summary>
    Accepted,
}

/// <summary>The decision, with what the endpoint needs to finish the sign-in.</summary>
public sealed record TotpAttemptOutcome(
    TotpAttemptKind Kind,
    PrincipalId? PrincipalId = null,
    string? ReturnTo = null,
    string? Native = null,
    TimeSpan RetryAfter = default);

/// <summary>An authenticator app as a second step after a correct password (decision 6).</summary>
public sealed class LocalTotpSecondStep(
    ILocalAccounts accounts,
    ILocalCredentials credentials,
    ILocalChallenges challenges,
    TimeProvider clock) : ILocalSecondStepMethod
{
    /// <inheritdoc />
    public string Method => LocalSecondStepMethods.Totp;

    /// <inheritdoc />
    public ValueTask<bool> IsEnrolledAsync(LocalAccountRecord account, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(account);
        return ValueTask.FromResult(account.TotpEnabled);
    }

    /// <summary>Judges a code against the challenge a correct password opened.</summary>
    public async ValueTask<TotpAttemptOutcome> CheckAsync(Guid challengeId, string? code, CancellationToken cancellationToken)
    {
        var invalid = new TotpAttemptOutcome(TotpAttemptKind.Invalid);
        if (await challenges.GetAsync(challengeId, LocalChallengeKind.SecondStep, cancellationToken).ConfigureAwait(false) is not { PrincipalId: { } principal } challenge
            || await accounts.FindByPrincipalAsync(principal, cancellationToken).ConfigureAwait(false) is not { Status: PrincipalStatus.Active } account)
        {
            return invalid;
        }

        var now = clock.GetUtcNow();
        if (account.IsPaused(now))
        {
            return new(TotpAttemptKind.Paused, RetryAfter: account.PausedUntil!.Value - now);
        }

        var totp = await credentials.GetTotpAsync(principal, cancellationToken).ConfigureAwait(false);
        if (totp is not { ConfirmedAt: not null })
        {
            return invalid;
        }

        // A reused step is refused by the store's compare-and-set, so a replayed code fails like a wrong one.
        var accepted = LocalTotp.Match(totp.Secret.Span, code, now) is { } step
            && await credentials.UseTotpStepAsync(principal, step, cancellationToken).ConfigureAwait(false);
        if (!accepted)
        {
            _ = await challenges.BumpAsync(challengeId, cancellationToken).ConfigureAwait(false);
            return await accounts.RegisterFailureAsync(principal, cancellationToken).ConfigureAwait(false) is { } until
                ? new(TotpAttemptKind.Paused, RetryAfter: until - now)
                : invalid;
        }

        // The take is the single-use gate on the challenge itself.
        return await challenges.TakeAsync(challengeId, LocalChallengeKind.SecondStep, cancellationToken).ConfigureAwait(false) is { } taken
            ? new(TotpAttemptKind.Accepted, principal, taken.ReturnTo, taken.Native)
            : invalid;
    }
}
