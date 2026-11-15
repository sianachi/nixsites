using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;

namespace Nix.Features.LocalAuth;

/// <summary>How a password attempt ended.</summary>
public enum PasswordSignInKind
{
    /// <summary>Unknown email, no password, disabled person or wrong password: one answer for all of them.</summary>
    Invalid,

    /// <summary>The account is paused after too many wrong passwords.</summary>
    Paused,

    /// <summary>Correct password, but the person holds a second factor this server cannot check.</summary>
    SecondStepUnavailable,

    /// <summary>Correct password and nothing more to prove.</summary>
    SignedIn,

    /// <summary>Correct password; the person must answer one of <see cref="PasswordSignInOutcome.Methods"/>.</summary>
    SecondStep,
}

/// <summary>The decision, with what the endpoint needs to act on it.</summary>
/// <param name="Kind">What happened.</param>
/// <param name="PrincipalId">The person, for <see cref="PasswordSignInKind.SignedIn"/> and <see cref="PasswordSignInKind.SecondStep"/>.</param>
/// <param name="RetryAfter">How long the pause lasts, for <see cref="PasswordSignInKind.Paused"/>.</param>
/// <param name="Methods">The second steps on offer, for <see cref="PasswordSignInKind.SecondStep"/>.</param>
public sealed record PasswordSignInOutcome(
    PasswordSignInKind Kind,
    PrincipalId? PrincipalId = null,
    TimeSpan RetryAfter = default,
    IReadOnlyList<string>? Methods = null);

/// <summary>The sign-in decision table (decisions 7 and 8), kept free of HTTP so it can be tested alone.</summary>
public sealed class LocalPasswordSignIn(
    ILocalAccounts accounts,
    PasswordHasher hasher,
    LocalSecondStepGate secondSteps,
    LocalSignInDecoy decoy,
    TimeProvider clock)
{
    /// <summary>Judges an email and password.</summary>
    public async ValueTask<PasswordSignInOutcome> CheckAsync(string? email, string? password, CancellationToken cancellationToken)
    {
        password ??= string.Empty;
        LocalAccountRecord? account = LocalAccountEmail.TryNormalize(email, out var normalized)
            ? await accounts.FindByEmailAsync(normalized, cancellationToken).ConfigureAwait(false)
            : null;
        var now = clock.GetUtcNow();
        if (account is not { Status: PrincipalStatus.Active, HasPassword: true })
        {
            // Same hashing work, same answers as a wrong password: nothing tells an unknown email from a bad one.
            return await decoy.AttemptAsync(accounts, email, password, now, cancellationToken).ConfigureAwait(false) is { } wait
                ? new(PasswordSignInKind.Paused, RetryAfter: wait)
                : new(PasswordSignInKind.Invalid);
        }

        if (account.IsPaused(now))
        {
            return new(PasswordSignInKind.Paused, RetryAfter: account.PausedUntil!.Value - now);
        }

        var check = hasher.Verify(password, account.PasswordHash);
        if (!check.Ok)
        {
            return await accounts.RegisterFailureAsync(account.PrincipalId, cancellationToken).ConfigureAwait(false) is { } until
                ? new(PasswordSignInKind.Paused, RetryAfter: until - now)
                : new(PasswordSignInKind.Invalid);
        }

        await accounts.ClearFailuresAsync(account.PrincipalId, cancellationToken).ConfigureAwait(false);
        if (check.NeedsRehash)
        {
            _ = await accounts.SetPasswordAsync(account.PrincipalId, hasher.Hash(password), changed: false, cancellationToken).ConfigureAwait(false);
        }

        var methods = await secondSteps.RequiredAsync(account, cancellationToken).ConfigureAwait(false);
        return methods switch
        {
            null => new(PasswordSignInKind.SecondStepUnavailable),
            { Count: 0 } => new(PasswordSignInKind.SignedIn, account.PrincipalId),
            _ => new(PasswordSignInKind.SecondStep, account.PrincipalId, Methods: methods),
        };
    }
}
