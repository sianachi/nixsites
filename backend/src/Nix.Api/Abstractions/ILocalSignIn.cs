using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>A local account and the facts the sign-in decision needs.</summary>
/// <param name="PrincipalId">The person.</param>
/// <param name="TenantId">Their tenant.</param>
/// <param name="Email">The address as stored on the principal.</param>
/// <param name="DisplayName">Their name.</param>
/// <param name="Status">Whether they may act; a disabled person is Suspended.</param>
/// <param name="PasswordHash">The stored hash, or null when they have none.</param>
/// <param name="PasswordChangedAt">When the password was last set, if ever.</param>
/// <param name="PausedUntil">The end of a failed-password pause, which may already be in the past.</param>
/// <param name="TotpEnabled">Whether a confirmed authenticator app exists.</param>
/// <param name="PasskeyCount">How many full-sign-in passkeys they hold.</param>
/// <param name="SecurityKeyCount">How many second-step-only security keys they hold.</param>
public sealed record LocalAccountRecord(
    PrincipalId PrincipalId,
    TenantId TenantId,
    string Email,
    string DisplayName,
    PrincipalStatus Status,
    string? PasswordHash,
    DateTimeOffset? PasswordChangedAt,
    DateTimeOffset? PausedUntil,
    bool TotpEnabled,
    int PasskeyCount,
    int SecurityKeyCount)
{
    /// <summary>Whether a password is set.</summary>
    public bool HasPassword => PasswordHash is not null;

    /// <summary>Whether password sign-in is paused at the given moment.</summary>
    public bool IsPaused(DateTimeOffset now) => PausedUntil is { } until && until > now;
}

/// <summary>
/// Local accounts. Lookups and failure counting run before any tenant is known and use narrow
/// security-definer functions; only <see cref="CreateAsync"/> needs the caller's unit of work.
/// </summary>
public interface ILocalAccounts
{
    /// <summary>Whether any local account exists, which is what closes the first-run setup page.</summary>
    public ValueTask<bool> AnyAsync(CancellationToken cancellationToken);

    /// <summary>Finds an account by normalized email, across the whole install.</summary>
    public ValueTask<LocalAccountRecord?> FindByEmailAsync(string normalizedEmail, CancellationToken cancellationToken);

    /// <summary>Finds an account by principal.</summary>
    public ValueTask<LocalAccountRecord?> FindByPrincipalAsync(PrincipalId principalId, CancellationToken cancellationToken);

    /// <summary>
    /// Provisions a principal (with their personal workspace) and its local account inside the caller's
    /// tenant unit of work, so the caller commits or rolls back both. Returns null when the email is already
    /// taken; the caller must then roll back, since the principal was already written.
    /// </summary>
    public ValueTask<AuthenticatedPrincipal?> CreateAsync(
        TenantId tenantId,
        string normalizedEmail,
        string displayName,
        string? passwordHash,
        CancellationToken cancellationToken);

    /// <summary>
    /// Stores a new hash, or null to remove the password. <paramref name="changed"/> false is a silent
    /// rehash; true also stamps the change time and lifts any pause.
    /// </summary>
    public ValueTask<bool> SetPasswordAsync(PrincipalId principalId, string? hash, bool changed, CancellationToken cancellationToken);

    /// <summary>Counts one wrong password; returns the end of the pause when ten in five minutes have now paused the account.</summary>
    public ValueTask<DateTimeOffset?> RegisterFailureAsync(PrincipalId principalId, CancellationToken cancellationToken);

    /// <summary>Clears the failure window after a correct password.</summary>
    public ValueTask ClearFailuresAsync(PrincipalId principalId, CancellationToken cancellationToken);

    /// <summary>Revokes every standing browser session of the person, except <paramref name="except"/>.</summary>
    public ValueTask<int> RevokeSessionsAsync(PrincipalId principalId, BrowserSessionId? except, CancellationToken cancellationToken);

    /// <summary>
    /// The tenant first-run setup creates the first account in: the install's only tenant, made on the spot
    /// when there is none. Null when the install has several. Call only after the setup code checked out.
    /// </summary>
    public ValueTask<TenantId?> SetupTenantAsync(CancellationToken cancellationToken);

    /// <summary>A standing session's facts, or null when it is gone.</summary>
    public ValueTask<LocalSessionFacts?> FindSessionAsync(BrowserSessionId sessionId, CancellationToken cancellationToken);

    /// <summary>How many stored passwords are carried-over bcrypt hashes, for the unknown-email decoy.</summary>
    public ValueTask<LocalHashMix> HashMixAsync(CancellationToken cancellationToken);
}

/// <summary>What the sign-in settings need to know about the session asking.</summary>
/// <param name="IsCommandLine">Made by the command line's device sign-in, so not a person at a browser.</param>
/// <param name="CreatedAt">When the person signed in.</param>
public sealed record LocalSessionFacts(bool IsCommandLine, DateTimeOffset CreatedAt);

/// <summary>The stored password formats in use.</summary>
/// <param name="Total">Accounts with a password.</param>
/// <param name="Bcrypt">Of those, carried-over bcrypt hashes.</param>
/// <param name="BcryptCost">The highest bcrypt cost among them, or zero.</param>
public readonly record struct LocalHashMix(int Total, int Bcrypt, int BcryptCost);

/// <summary>Whether a credential signs in alone or is only a second step.</summary>
public enum LocalPasskeyKind
{
    /// <summary>A discoverable, user-verifying passkey: a complete sign-in.</summary>
    Passkey,

    /// <summary>A security key imported as a second factor: second step only.</summary>
    SecurityKey,
}

/// <summary>One stored WebAuthn credential.</summary>
public sealed record LocalPasskeyRecord(
    Guid Id,
    ReadOnlyMemory<byte> CredentialId,
    ReadOnlyMemory<byte> PublicKey,
    long SignCount,
    Guid? Aaguid,
    IReadOnlyList<string> Transports,
    string RpId,
    LocalPasskeyKind Kind,
    string Name,
    DateTimeOffset CreatedAt,
    DateTimeOffset? LastUsedAt);

/// <summary>A credential found by id, with who owns it.</summary>
public sealed record LocalPasskeyOwner(
    Guid Id,
    PrincipalId PrincipalId,
    TenantId TenantId,
    ReadOnlyMemory<byte> PublicKey,
    long SignCount,
    string RpId,
    LocalPasskeyKind Kind,
    PrincipalStatus Status,
    string DisplayName);

/// <summary>The authenticator-app secret of a person; <see cref="ConfirmedAt"/> is null until a first code is accepted.</summary>
public sealed record LocalTotpRecord(ReadOnlyMemory<byte> Secret, DateTimeOffset? ConfirmedAt, long? LastUsedStep);

/// <summary>Passkeys, security keys and the authenticator app. All keyed by a principal the caller already authenticated.</summary>
public interface ILocalCredentials
{
    /// <summary>Finds a credential by its WebAuthn credential id (the discoverable sign-in path).</summary>
    public ValueTask<LocalPasskeyOwner?> FindPasskeyAsync(byte[] credentialId, CancellationToken cancellationToken);

    /// <summary>Lists a person's credentials, oldest first.</summary>
    public ValueTask<IReadOnlyList<LocalPasskeyRecord>> ListPasskeysAsync(PrincipalId principalId, CancellationToken cancellationToken);

    /// <summary>Adds a credential. False when the person already has 20 or the credential id exists.</summary>
    public ValueTask<bool> AddPasskeyAsync(PrincipalId principalId, LocalPasskeyRecord passkey, CancellationToken cancellationToken);

    /// <summary>Records a successful use and the new signature counter.</summary>
    public ValueTask TouchPasskeyAsync(Guid id, long signCount, CancellationToken cancellationToken);

    /// <summary>Renames one of the person's credentials.</summary>
    public ValueTask<bool> RenamePasskeyAsync(PrincipalId principalId, Guid id, string name, CancellationToken cancellationToken);

    /// <summary>Removes one of the person's credentials.</summary>
    public ValueTask<bool> RemovePasskeyAsync(PrincipalId principalId, Guid id, CancellationToken cancellationToken);

    /// <summary>Reads the authenticator secret, decrypted.</summary>
    public ValueTask<LocalTotpRecord?> GetTotpAsync(PrincipalId principalId, CancellationToken cancellationToken);

    /// <summary>Stores a new unconfirmed secret, replacing any earlier one.</summary>
    public ValueTask<bool> SetPendingTotpAsync(PrincipalId principalId, byte[] secret, CancellationToken cancellationToken);

    /// <summary>Confirms a pending secret, spending the step of the code that proved it.</summary>
    public ValueTask<bool> ConfirmTotpAsync(PrincipalId principalId, long timeStep, CancellationToken cancellationToken);

    /// <summary>Atomically accepts a step only if it is later than the last accepted one: a code works once.</summary>
    public ValueTask<bool> UseTotpStepAsync(PrincipalId principalId, long timeStep, CancellationToken cancellationToken);

    /// <summary>Removes the authenticator app.</summary>
    public ValueTask<bool> RemoveTotpAsync(PrincipalId principalId, CancellationToken cancellationToken);
}

/// <summary>What a presented link resolves to.</summary>
public sealed record LocalLinkRecord(
    Guid Id,
    PrincipalId PrincipalId,
    TenantId TenantId,
    LocalLinkPurpose Purpose,
    string? Email,
    string DisplayName);

/// <summary>One-time setup and reset links. Unknown, used, expired and disabled-person links are all just null.</summary>
public interface ILocalAccountLinks
{
    /// <summary>Stores a link hash, replacing every unused link the person had. False when they have no local account.</summary>
    public ValueTask<bool> CreateAsync(
        PrincipalId principalId,
        LocalLinkPurpose purpose,
        string tokenHash,
        DateTimeOffset expiresAt,
        PrincipalId? createdBy,
        CancellationToken cancellationToken);

    /// <summary>Resolves a live link without using it.</summary>
    public ValueTask<LocalLinkRecord?> FindAsync(string tokenHash, CancellationToken cancellationToken);

    /// <summary>Uses a live link; exactly one concurrent caller gets a result.</summary>
    public ValueTask<LocalLinkRecord?> ConsumeAsync(string tokenHash, CancellationToken cancellationToken);
}

/// <summary>What a pending challenge is waiting for.</summary>
public enum LocalChallengeKind
{
    /// <summary>The second step after a correct password.</summary>
    SecondStep,

    /// <summary>A discoverable passkey sign-in; no person is known yet.</summary>
    PasskeySignIn,

    /// <summary>Registering a first passkey through a setup or reset link.</summary>
    LinkPasskey,

    /// <summary>A signed-in person registering a passkey.</summary>
    AddPasskey,
}

/// <summary>A live pending challenge.</summary>
/// <param name="Id">The challenge id the client holds.</param>
/// <param name="Kind">What it awaits.</param>
/// <param name="PrincipalId">The person, when one is known.</param>
/// <param name="TenantId">Their tenant.</param>
/// <param name="State">Caller-owned text, for example the serialized WebAuthn options.</param>
/// <param name="ReturnTo">The sanitized path to land on.</param>
/// <param name="Native">The native handoff challenge, when the app started this sign-in.</param>
/// <param name="Attempts">Wrong answers so far; five end it.</param>
public sealed record LocalChallenge(
    Guid Id,
    LocalChallengeKind Kind,
    PrincipalId? PrincipalId,
    TenantId? TenantId,
    string? State,
    string? ReturnTo,
    string? Native,
    int Attempts);

/// <summary>Short-lived challenge rows (five minutes) for the second step and WebAuthn ceremonies.</summary>
public interface ILocalChallenges
{
    /// <summary>How long a challenge lives.</summary>
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(5);

    /// <summary>Stores a challenge. False when the table is full or the named person does not exist.</summary>
    public ValueTask<bool> CreateAsync(
        Guid id,
        LocalChallengeKind kind,
        PrincipalId? principalId,
        string? state,
        string? returnTo,
        string? native,
        DateTimeOffset expiresAt,
        CancellationToken cancellationToken);

    /// <summary>Reads a live challenge without using it.</summary>
    public ValueTask<LocalChallenge?> GetAsync(Guid id, LocalChallengeKind kind, CancellationToken cancellationToken);

    /// <summary>Counts a wrong answer and returns the new count.</summary>
    public ValueTask<int> BumpAsync(Guid id, CancellationToken cancellationToken);

    /// <summary>Replaces the caller-owned state, for example once WebAuthn options have been issued.</summary>
    public ValueTask<bool> SetStateAsync(Guid id, string state, CancellationToken cancellationToken);

    /// <summary>Uses a live challenge; exactly one concurrent caller gets a result.</summary>
    public ValueTask<LocalChallenge?> TakeAsync(Guid id, LocalChallengeKind kind, CancellationToken cancellationToken);
}
