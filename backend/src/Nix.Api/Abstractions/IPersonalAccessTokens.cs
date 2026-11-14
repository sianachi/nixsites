using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>
/// Reads and writes personal access tokens: the pre-authentication lookup the exchange endpoint
/// needs, and the session-scoped reads and writes everything else needs.
/// </summary>
/// <remarks>
/// <para>
/// The port has two halves and the split is the point. <see cref="FindForExchangeAsync"/> runs
/// before any session exists - it is the third pre-authentication lookup in the system, beside
/// the two on <see cref="IIdentityDirectory"/>, and goes through a security-definer function with
/// the same constraints: exact match, at most one row, no listing. Everything else runs inside a
/// unit of work and is scoped by row-level security and the acting principal like any other
/// store; none of it takes a principal as input.
/// </para>
/// <para>
/// An interface rather than the concrete store because every consumer that matters to a unit
/// test - the exchange endpoint, the unit-of-work middleware, the use cases - is exercised
/// against a fake; the real implementation is I/O end to end.
/// </para>
/// </remarks>
public interface IPersonalAccessTokens
{
    /// <summary>
    /// Resolves a presented token's lookup key to the row that can judge it, before any tenant or
    /// session is known.
    /// </summary>
    /// <param name="lookup">The indexed, non-secret half of the presented token.</param>
    /// <param name="cancellationToken">Cancels the lookup.</param>
    /// <returns>
    /// The row and the principal behind it, or <see langword="null"/> when nothing matches. The
    /// caller still owes the hash comparison; this only finds the candidate.
    /// </returns>
    public ValueTask<AccessTokenExchangeCandidate?> FindForExchangeAsync(
        string lookup,
        CancellationToken cancellationToken);

    /// <summary>Lists the acting principal's tokens, newest first, revoked and expired included.</summary>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The tokens.</returns>
    public ValueTask<IReadOnlyList<PersonalAccessToken>> ListOwnAsync(
        CancellationToken cancellationToken);

    /// <summary>Counts the acting principal's live tokens, so issuance can be bounded.</summary>
    /// <param name="now">The moment expiry is judged against.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>How many unrevoked, unexpired tokens they hold.</returns>
    public ValueTask<int> CountLiveAsync(DateTimeOffset now, CancellationToken cancellationToken);

    /// <summary>Stores a freshly minted token.</summary>
    /// <param name="token">The row to store. Carries the hash, never the secret.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>A task that completes when the row is staged.</returns>
    public ValueTask AddAsync(PersonalAccessToken token, CancellationToken cancellationToken);

    /// <summary>
    /// Revokes one of the acting principal's tokens.
    /// </summary>
    /// <param name="id">The token to revoke.</param>
    /// <param name="at">When the revocation happened.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>
    /// Whether a row changed. Revoking an already-revoked token changes nothing and is not an
    /// error; revoking a token that is not the caller's changes nothing either, and the two are
    /// deliberately not told apart.
    /// </returns>
    public ValueTask<bool> RevokeOwnAsync(
        PersonalAccessTokenId id,
        DateTimeOffset at,
        CancellationToken cancellationToken);

    /// <summary>Reads one of the acting principal's tokens, or <see langword="null"/> when it is not theirs.</summary>
    /// <param name="id">The token to read.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The row, untracked.</returns>
    public ValueTask<PersonalAccessToken?> FindOwnAsync(
        PersonalAccessTokenId id,
        CancellationToken cancellationToken);

    /// <summary>
    /// Swaps a live token's secret and expiry in place, keeping its identity, name and scopes.
    /// </summary>
    /// <param name="id">The token to rotate.</param>
    /// <param name="lookup">The new lookup half.</param>
    /// <param name="secretHash">The new secret's hash.</param>
    /// <param name="expiresAt">The restarted expiry.</param>
    /// <param name="now">The moment liveness is judged against.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>Whether a row changed: false when it is not the caller's, revoked or expired.</returns>
    public ValueTask<bool> RotateOwnAsync(
        PersonalAccessTokenId id,
        string lookup,
        ReadOnlyMemory<byte> secretHash,
        DateTimeOffset expiresAt,
        DateTimeOffset now,
        CancellationToken cancellationToken);

    /// <summary>
    /// Reads the row the unit-of-work middleware re-checks on every token-authenticated request.
    /// </summary>
    /// <param name="id">The token the session's JWT names.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The row's current state, or <see langword="null"/> when it is gone.</returns>
    public ValueTask<AccessTokenSessionState?> FindSessionStateAsync(
        PersonalAccessTokenId id,
        CancellationToken cancellationToken);

    /// <summary>
    /// Records that a token authenticated a request, coarsely.
    /// </summary>
    /// <param name="id">The token that authenticated.</param>
    /// <param name="at">When.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>A task that completes when the row is updated.</returns>
    public ValueTask TouchAsync(
        PersonalAccessTokenId id,
        DateTimeOffset at,
        CancellationToken cancellationToken);
}

/// <summary>
/// What the exchange endpoint needs to judge a presented token: the stored hash to compare, the
/// row's own state, and the principal it would authenticate as.
/// </summary>
/// <param name="Id">The token row.</param>
/// <param name="TenantId">The tenant the minted session will be scoped to.</param>
/// <param name="PrincipalId">The principal the token acts as.</param>
/// <param name="PrincipalStatus">Whether that principal may still act.</param>
/// <param name="SecretHash">The stored hash the presented token is compared against.</param>
/// <param name="Scopes">The ceiling the issuer chose.</param>
/// <param name="ExpiresAt">When the token stops working.</param>
/// <param name="RevokedAt">When it was revoked, if it was.</param>
public sealed record AccessTokenExchangeCandidate(
    PersonalAccessTokenId Id,
    TenantId TenantId,
    PrincipalId PrincipalId,
    PrincipalStatus PrincipalStatus,
    ReadOnlyMemory<byte> SecretHash,
    IReadOnlyList<string> Scopes,
    DateTimeOffset ExpiresAt,
    DateTimeOffset? RevokedAt);

/// <summary>
/// The per-request state of a token-authenticated session: is the token still standing, and what
/// may it do.
/// </summary>
/// <param name="PrincipalId">The principal the row belongs to, asserted against the JWT's.</param>
/// <param name="Scopes">The ceiling the issuer chose.</param>
/// <param name="ExpiresAt">When the token stops working.</param>
/// <param name="RevokedAt">When it was revoked, if it was.</param>
/// <param name="LastUsedAt">When it last authenticated, coarsened.</param>
/// <param name="Lookup">The lookup half of the current secret; rotation replaces it.</param>
public sealed record AccessTokenSessionState(
    PrincipalId PrincipalId,
    IReadOnlyList<string> Scopes,
    DateTimeOffset ExpiresAt,
    DateTimeOffset? RevokedAt,
    DateTimeOffset? LastUsedAt,
    string Lookup);
