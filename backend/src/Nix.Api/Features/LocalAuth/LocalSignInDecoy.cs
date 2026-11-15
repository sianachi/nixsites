using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Nix.Abstractions;
using Nix.Authentication;

namespace Nix.Features.LocalAuth;

/// <summary>
/// Makes a password attempt for an email with no usable account look like one for a real account: the
/// same hashing time, and the same pause after ten attempts in five minutes. Without it the pause and the
/// response time would say which emails have accounts.
/// </summary>
public sealed class LocalSignInDecoy(PasswordHasher hasher)
{
    private const int MaximumFailures = 10;
    private const int MaximumEntries = 20_000;
    private static readonly TimeSpan Window = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan MixLifetime = TimeSpan.FromMinutes(10);

    // shortcut: the windows live in this process, so several Core instances each count their own and a restart
    // forgets them; move them to a table if unknown-email pauses must be exact across instances.
    private readonly ConcurrentDictionary<string, Attempts> _attempts = new(StringComparer.Ordinal);
    private LocalHashMix _mix;
    private DateTimeOffset _mixReadAt = DateTimeOffset.MinValue;

    /// <summary>Counts one attempt for an email that cannot sign in; returns how long it is paused, if it is.</summary>
    public async ValueTask<TimeSpan?> AttemptAsync(
        ILocalAccounts accounts, string? email, string password, DateTimeOffset now, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(accounts);
        var digest = SHA256.HashData(Encoding.UTF8.GetBytes((email ?? string.Empty).Trim().ToUpperInvariant()));
        var key = Convert.ToHexString(digest);
        if (_attempts.TryGetValue(key, out var seen) && seen.PausedUntil > now)
        {
            return seen.PausedUntil - now;
        }

        if (now - _mixReadAt > MixLifetime)
        {
            _mix = await accounts.HashMixAsync(cancellationToken).ConfigureAwait(false);
            _mixReadAt = now;
        }

        // The same share of unknown emails as of real accounts pays the bcrypt time, and a given email always
        // pays the same, so neither a slow nor a fast answer says whether the account exists.
        var mix = _mix;
        var slow = mix.Total > 0 && BitConverter.ToUInt32(digest) % (uint)mix.Total < (uint)mix.Bcrypt;
        hasher.VerifyDummy(password, slow ? mix.BcryptCost : 0);

        if (_attempts.Count >= MaximumEntries)
        {
            // shortcut: a flood of distinct emails resets every window rather than growing without bound.
            _attempts.Clear();
        }

        var next = _attempts.AddOrUpdate(
            key,
            static (_, at) => new Attempts(1, at, DateTimeOffset.MinValue),
            static (_, current, at) => current.Started <= at - Window
                ? new Attempts(1, at, DateTimeOffset.MinValue)
                : current.Count + 1 >= MaximumFailures
                    ? new Attempts(0, DateTimeOffset.MinValue, at + Window)
                    : current with { Count = current.Count + 1 },
            now);
        return next.PausedUntil > now ? next.PausedUntil - now : null;
    }

    private readonly record struct Attempts(int Count, DateTimeOffset Started, DateTimeOffset PausedUntil);
}
