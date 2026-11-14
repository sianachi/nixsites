using System.Collections.Concurrent;
using System.IdentityModel.Tokens.Jwt;
using Microsoft.IdentityModel.Tokens;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Authentication;

/// <summary>
/// Validates a bearer token against the issuer that a tenant registered for it.
/// </summary>
/// <remarks>
/// <para>
/// <b>Multi-issuer, so the order is unusual and deliberate.</b> A conventional handler is
/// configured with one authority and validates against it. Here the issuer is per-tenant data, so
/// the token has to be read before it can be validated: its <c>iss</c> and <c>aud</c> are looked up
/// in <c>identity_provider</c>, and only a registration that matches both, and is enabled, produces
/// the signing keys the signature is then checked against.
/// </para>
/// <para>
/// Reading claims before validating them is normally a mistake, so it is worth being precise about
/// what is trusted at each step: the unvalidated read is used <i>only</i> to choose which issuer to
/// validate against, and that choice can only ever select a registration an administrator already
/// created. A forged <c>iss</c> selects nothing and the token is refused. Nothing else about the
/// token is believed until the signature checks out.
/// </para>
/// <para>
/// Signing keys are fetched from the registered provider's JWKS endpoint and cached per immutable
/// registration identity, with refresh and key rollover handled here rather than by a configuration
/// manager: the registration stores the JWKS endpoint directly, so there is no discovery document
/// to manage. See <see cref="KeyLifetime"/> for how long a key set is trusted and
/// <see cref="MinimumRefetchInterval"/> for the floor that keeps a rotation refetch from becoming a
/// fetch storm. Without the cache every request would fetch a key set, which is both slow and a way
/// to have the identity provider rate-limit us out of service.
/// </para>
/// </remarks>
public sealed class NixTokenValidator
{
    private const int MaximumAudiences = 16;

    private readonly IIdentityDirectory _directory;
    private readonly SelfIssuedTokenService _selfIssued;
    private readonly HttpClient _keyFetcher;
    private readonly TimeProvider _clock;
    // MapInboundClaims off, deliberately. The handler's legacy default rewrites standard JWT claim
    // names into WS-Federation URIs - `sub` becomes ...claims/nameidentifier - so a lookup for
    // "sub" silently finds nothing and every token is refused with no error to explain it.
    private readonly JwtSecurityTokenHandler _handler = new() { MapInboundClaims = false };

    // Keyed by the complete immutable provider registration identity, not issuer alone. One issuer
    // can legitimately register separate audiences and JWKS sets for separate tenants. Reusing one
    // audience's set for another would become a cross-tenant acceptance bug when both sets contain
    // the same kid.
    private static readonly ConcurrentDictionary<ProviderCacheKey, ProviderCacheState> KeyCache = [];

    private static readonly HttpClient DefaultKeyFetcher = new() { Timeout = TimeSpan.FromSeconds(10) };

    /// <summary>How long a key set is trusted before it is fetched again.</summary>
    /// <remarks>
    /// A cache with no expiry is a correctness and a security problem, not just a staleness one.
    /// An issuer that rotates its signing keys would break every token until this process was
    /// restarted, and a key withdrawn because it leaked would go on being trusted for exactly as
    /// long as the process lived. Twelve hours bounds both without making the identity provider
    /// serve a key set per request.
    /// </remarks>
    private static readonly TimeSpan KeyLifetime = TimeSpan.FromHours(12);

    /// <summary>
    /// Shortest gap between refetches triggered by an unknown key id.
    /// </summary>
    /// <remarks>
    /// A token signed with a key we have not seen is the signal that a rotation happened, so it is
    /// worth refetching immediately rather than waiting out the lifetime. Rate-limited because the
    /// same signal is what a flood of forged tokens with random key ids would produce, and that
    /// must not turn into a fetch storm against the issuer.
    /// </remarks>
    private static readonly TimeSpan MinimumRefetchInterval = TimeSpan.FromMinutes(5);

    private sealed record CachedKeySet(JsonWebKeySet Keys, DateTimeOffset FetchedAt);

    private sealed class ProviderCacheState
    {
        internal object Sync { get; } = new();

        internal SemaphoreSlim Refresh { get; } = new(1, 1);

        internal CachedKeySet? Cached { get; set; }

        internal DateTimeOffset LastAttempt { get; set; } = DateTimeOffset.MinValue;
    }

    private readonly record struct ProviderCacheKey(
        TenantId TenantId,
        string Issuer,
        string Audience,
        Uri JwksUri);

    /// <summary>Initializes a new instance of the <see cref="NixTokenValidator"/> class.</summary>
    /// <param name="directory">The pre-authentication lookups.</param>
    /// <param name="selfIssued">Core's own issuer, for tokens minted by the exchange endpoint.</param>
    public NixTokenValidator(IIdentityDirectory directory, SelfIssuedTokenService selfIssued)
        : this(directory, selfIssued, DefaultKeyFetcher, TimeProvider.System)
    {
    }

    /// <summary>Initializes a validator with a specific signing-key client.</summary>
    /// <param name="directory">The pre-authentication lookups.</param>
    /// <param name="selfIssued">Core's own issuer, for tokens minted by the exchange endpoint.</param>
    /// <param name="keyFetcher">The client used to retrieve registered JWKS documents.</param>
    public NixTokenValidator(
        IIdentityDirectory directory,
        SelfIssuedTokenService selfIssued,
        HttpClient keyFetcher)
        : this(directory, selfIssued, keyFetcher, TimeProvider.System)
    {
    }

    /// <summary>Initializes a validator with explicit signing-key I/O and time.</summary>
    /// <param name="directory">The pre-authentication lookups.</param>
    /// <param name="selfIssued">Core's own issuer, for tokens minted by the exchange endpoint.</param>
    /// <param name="keyFetcher">The client used to retrieve registered JWKS documents.</param>
    /// <param name="clock">The time source used for refresh and failure backoff.</param>
    public NixTokenValidator(
        IIdentityDirectory directory,
        SelfIssuedTokenService selfIssued,
        HttpClient keyFetcher,
        TimeProvider clock)
    {
        ArgumentNullException.ThrowIfNull(directory);
        ArgumentNullException.ThrowIfNull(selfIssued);
        ArgumentNullException.ThrowIfNull(keyFetcher);
        ArgumentNullException.ThrowIfNull(clock);
        _directory = directory;
        _selfIssued = selfIssued;
        _keyFetcher = keyFetcher;
        _clock = clock;
    }

    /// <summary>
    /// Validates a token and reports which tenant and subject it belongs to.
    /// </summary>
    /// <param name="token">The raw bearer token.</param>
    /// <param name="cancellationToken">Cancels the validation.</param>
    /// <returns>
    /// The registration and subject, or <see langword="null"/> when the token is unreadable, comes
    /// from an unregistered issuer, or fails signature or lifetime validation. Every one of those
    /// is the same answer to the caller - refused - because telling them apart would tell an
    /// attacker which part of a forged token to fix.
    /// </returns>
    public async ValueTask<ValidatedToken?> ValidateAsync(string token, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(token) || !_handler.CanReadToken(token))
        {
            return null;
        }

        // Unvalidated, and used only to choose an issuer to validate against. See the note above.
        JwtSecurityToken unverified;
        try
        {
            unverified = _handler.ReadJwtToken(token);
        }
        catch (ArgumentException)
        {
            return null;
        }
        catch (SecurityTokenException)
        {
            return null;
        }
        var issuer = unverified.Issuer;
        var audiences = unverified.Audiences
            .Where(static audience => !string.IsNullOrWhiteSpace(audience))
            .Distinct(StringComparer.Ordinal)
            .Take(MaximumAudiences + 1)
            .ToArray();

        if (string.IsNullOrWhiteSpace(issuer)
            || audiences.Length is 0 or > MaximumAudiences)
        {
            return null;
        }

        // Core's own issuer, checked before the registration lookup for the same reason the
        // lookup exists: the unvalidated `iss` only ever selects which trusted configuration to
        // validate against. This branch selects a locally-held public key instead of a fetched
        // key set; a forged `iss` naming Core's issuer still faces the signature check, and an
        // unconfigured self-issuer makes the branch unreachable rather than permissive.
        if (_selfIssued.IsConfigured
            && string.Equals(issuer, _selfIssued.Issuer, StringComparison.Ordinal))
        {
            return await ValidateSelfIssuedAsync(token).ConfigureAwait(false);
        }

        var registrations = new IdentityProviderRegistration[MaximumAudiences];
        var registrationCount = 0;
        foreach (var audience in audiences)
        {
            var candidate = await _directory
                .ResolveProviderAsync(issuer, audience, cancellationToken)
                .ConfigureAwait(false);
            if (candidate is null)
            {
                continue;
            }

            // A token can legitimately carry both the web-client and project audiences. They are
            // one provider match when every validation-policy field is identical; the selected
            // audience only gives TokenValidationParameters one of the token's accepted values.
            // Different tenants, key sets, or algorithms remain ambiguous and fail closed, so
            // attacker-controlled audience order can never select a different validation policy.
            if (registrationCount > 0 && !SameProviderPolicy(registrations[0], candidate))
            {
                return null;
            }

            registrations[registrationCount++] = candidate;
        }

        if (registrationCount == 0)
        {
            // An unregistered issuer is refused outright and never just-in-time mapped to a tenant.
            return null;
        }

        var registration = registrations[0];

        var keys = await ResolveSigningKeysAsync(registration, unverified.Header.Kid, cancellationToken)
            .ConfigureAwait(false);
        if (keys is null)
        {
            return null;
        }

        var parameters = new TokenValidationParameters
        {
            ValidIssuer = registration.Issuer,
            ValidAudience = registration.Audience,
            IssuerSigningKeys = keys,
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateIssuerSigningKey = true,
            ValidateLifetime = true,

            // The allowlist is per-registration, so an issuer trusted for RS256 cannot present a
            // token signed some other way. An empty allowlist accepts nothing, which is the correct
            // reading of "no algorithm is permitted".
            ValidAlgorithms = registration.AllowedAlgorithms,

            // Five minutes of default clock skew is generous for tokens that live five to fifteen.
            ClockSkew = TimeSpan.FromSeconds(30),
        };

        try
        {
            var result = await _handler.ValidateTokenAsync(token, parameters).ConfigureAwait(false);
            if (!result.IsValid)
            {
                return null;
            }

            var subject = result.ClaimsIdentity.FindFirst("sub")?.Value;
            if (string.IsNullOrWhiteSpace(subject))
            {
                return null;
            }

            IdentityProviderRegistration? authorizedPartyRegistration = null;
            var authorizedParty = result.ClaimsIdentity.FindFirst("azp")?.Value;
            if (!string.IsNullOrWhiteSpace(authorizedParty))
            {
                for (var index = 0; index < registrationCount; index++)
                {
                    if (string.Equals(
                            registrations[index].Audience,
                            authorizedParty,
                            StringComparison.Ordinal))
                    {
                        authorizedPartyRegistration = registrations[index];
                        break;
                    }
                }
            }

            return new ValidatedExternalToken(
                registration.TenantId,
                subject,
                registration,
                authorizedPartyRegistration,
                !string.IsNullOrWhiteSpace(authorizedParty));
        }
        catch (SecurityTokenException)
        {
            // An invalid token is an expected outcome on a public endpoint, not an exceptional one.
            return null;
        }
    }

    /// <summary>
    /// Validates a token claiming Core's own issuer, against the locally-held key.
    /// </summary>
    /// <param name="token">The raw bearer token.</param>
    /// <returns>
    /// The tenant, subject and token row it names, or <see langword="null"/> on any defect. A
    /// signed token missing the tenant or token-row claim was not minted by the exchange endpoint
    /// and is refused whole rather than half-trusted.
    /// </returns>
    private async ValueTask<ValidatedToken?> ValidateSelfIssuedAsync(string token)
    {
        try
        {
            var result = await _handler
                .ValidateTokenAsync(token, _selfIssued.CreateValidationParameters())
                .ConfigureAwait(false);

            if (!result.IsValid)
            {
                return null;
            }

            var subject = result.ClaimsIdentity.FindFirst("sub")?.Value;
            if (string.IsNullOrWhiteSpace(subject))
            {
                return null;
            }

            if (SelfIssuedTokenService.TryReadClaims(
                result.ClaimsIdentity,
                out var tenantId,
                out var principalId,
                out var accessTokenId))
            {
                return new ValidatedCoreToken(
                    tenantId, principalId, accessTokenId, result.ClaimsIdentity.FindFirst(SelfIssuedTokenService.SecretLookupClaim)?.Value ?? string.Empty);
            }

            if (SelfIssuedTokenService.TryReadWorkerExecutionClaims(
                result.ClaimsIdentity,
                out tenantId,
                out principalId,
                out var workerJobId,
                out var workerItemId,
                out var workerWorkspaceId,
                out var workerScope,
                out var executionId))
            {
                return new ValidatedWorkerExecutionToken(
                    tenantId,
                    principalId,
                    workerJobId,
                    workerItemId,
                    workerWorkspaceId,
                    workerScope,
                    executionId);
            }

            if (SelfIssuedTokenService.TryReadPetTurnClaims(
                result.ClaimsIdentity,
                out tenantId,
                out principalId,
                out var petRequestId,
                out var petMode))
            {
                return new ValidatedPetTurnToken(tenantId, principalId, petRequestId, petMode);
            }

            // A pet claim that does not read cleanly (unknown mode, mixed with another kind) is refused whole.
            if (result.ClaimsIdentity.FindFirst(SelfIssuedTokenService.PetTurnClaim) is not null
                || result.ClaimsIdentity.FindFirst(SelfIssuedTokenService.PetModeClaim) is not null)
            {
                return null;
            }

            return SelfIssuedTokenService.TryReadBrowserSessionClaims(
                result.ClaimsIdentity,
                out tenantId,
                out principalId,
                out var browserSessionId)
                    ? new ValidatedBrowserSessionToken(tenantId, principalId, browserSessionId)
                    : null;
        }
        catch (SecurityTokenException)
        {
            return null;
        }
    }

    private static bool SameProviderPolicy(
        IdentityProviderRegistration first,
        IdentityProviderRegistration second) =>
        first.TenantId == second.TenantId
        && string.Equals(first.Issuer, second.Issuer, StringComparison.Ordinal)
        && first.JwksUri == second.JwksUri
        && SameAlgorithms(first.AllowedAlgorithms, second.AllowedAlgorithms);

    private static bool SameAlgorithms(IReadOnlyList<string> first, IReadOnlyList<string> second)
    {
        if (first.Count != second.Count)
        {
            return false;
        }

        for (var index = 0; index < first.Count; index++)
        {
            var algorithm = first[index];
            if (CountOccurrences(first, algorithm) != CountOccurrences(second, algorithm))
            {
                return false;
            }
        }

        return true;
    }

    private static int CountOccurrences(IReadOnlyList<string> algorithms, string target)
    {
        var count = 0;
        for (var index = 0; index < algorithms.Count; index++)
        {
            if (string.Equals(algorithms[index], target, StringComparison.Ordinal))
            {
                count++;
            }
        }

        return count;
    }

    private async ValueTask<ICollection<SecurityKey>?> ResolveSigningKeysAsync(
        IdentityProviderRegistration registration,
        string? keyId,
        CancellationToken cancellationToken)
    {
        var now = _clock.GetUtcNow();
        var cacheKey = new ProviderCacheKey(
            registration.TenantId,
            registration.Issuer,
            registration.Audience,
            registration.JwksUri);

        var state = KeyCache.GetOrAdd(cacheKey, static _ => new ProviderCacheState());
        CachedKeySet? cached;
        DateTimeOffset lastAttempt;
        lock (state.Sync)
        {
            cached = state.Cached;
            lastAttempt = state.LastAttempt;
        }

        if (cached is not null)
        {
            var age = now - cached.FetchedAt;
            var knowsKey = keyId is null
                || cached.Keys.Keys.Any(key => string.Equals(key.Kid, keyId, StringComparison.Ordinal));

            // Fresh enough, and it can verify the token in hand: use it.
            if (age < KeyLifetime && knowsKey)
            {
                return cached.Keys.GetSigningKeys();
            }

            // An unknown key id usually means the issuer rotated. Refetch - but not more often
            // than the floor, so forged tokens carrying random key ids cannot become a fetch
            // storm against the identity provider.
            if (!knowsKey && now - lastAttempt < MinimumRefetchInterval)
            {
                return cached.Keys.GetSigningKeys();
            }
        }

        await state.Refresh.WaitAsync(cancellationToken).ConfigureAwait(false);

        try
        {
            // Another request may have completed the refresh while this one waited. Re-evaluate
            // both success freshness and failure backoff under the provider's single-flight gate.
            now = _clock.GetUtcNow();
            lock (state.Sync)
            {
                cached = state.Cached;
                lastAttempt = state.LastAttempt;
            }
            if (cached is not null)
            {
                var knowsKey = keyId is null
                    || cached.Keys.Keys.Any(key => string.Equals(key.Kid, keyId, StringComparison.Ordinal));
                if (now - cached.FetchedAt < KeyLifetime && knowsKey)
                {
                    return cached.Keys.GetSigningKeys();
                }

                if (!knowsKey && now - lastAttempt < MinimumRefetchInterval)
                {
                    return cached.Keys.GetSigningKeys();
                }
            }
            else if (now - lastAttempt < MinimumRefetchInterval)
            {
                return null;
            }

            lock (state.Sync)
            {
                state.LastAttempt = now;
            }
            var json = await _keyFetcher
                .GetStringAsync(registration.JwksUri, cancellationToken)
                .ConfigureAwait(false);

            var keySet = new JsonWebKeySet(json);
            lock (state.Sync)
            {
                state.Cached = new CachedKeySet(keySet, now);
            }
            return keySet.GetSigningKeys();
        }
        catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException or ArgumentException)
        {
            // The issuer's key endpoint is unreachable or malformed.
            //
            // Fall back to a cached set only while it is still inside its lifetime: a brief outage
            // should not sign everybody out, but a key set old enough to have expired must not be
            // kept alive indefinitely by the endpoint staying down. Past that, refuse - accepting
            // a token we cannot verify is worse than a failed request.
            return cached is not null && now - cached.FetchedAt < KeyLifetime
                ? cached.Keys.GetSigningKeys()
                : null;
        }
        finally
        {
            state.Refresh.Release();
        }
    }
}

/// <summary>A validated token with a tenant and an explicit issuer kind.</summary>
public abstract record ValidatedToken
{
    private protected ValidatedToken(TenantId tenantId) => TenantId = tenantId;

    /// <summary>Gets the tenant selected by trusted token claims.</summary>
    public TenantId TenantId { get; }
}

/// <summary>A token signed by a registered external identity provider.</summary>
/// <param name="TenantId">The tenant that owns the validating registration.</param>
/// <param name="Subject">The provider's stable subject claim.</param>
/// <param name="Registration">The registration whose policy validated the token.</param>
/// <param name="AuthorizedPartyRegistration">
/// The exact signed <c>azp</c> registration, when one matched. Only this registration may authorize
/// JIT; missing or unmatched <c>azp</c> keeps ordinary authentication valid but cannot provision.
/// </param>
/// <param name="HasAuthorizedPartyClaim">
/// Whether the validated token carried a non-empty <c>azp</c>. This retains no claim data and only
/// distinguishes a missing claim from an unregistered value in safe admission diagnostics.
/// </param>
public sealed record ValidatedExternalToken(
    TenantId TenantId,
    string Subject,
    IdentityProviderRegistration Registration,
    IdentityProviderRegistration? AuthorizedPartyRegistration,
    bool HasAuthorizedPartyClaim = true)
    : ValidatedToken(TenantId);

/// <summary>A Core-issued session obtained by exchanging a personal access token.</summary>
/// <param name="TenantId">The tenant claim signed by Core.</param>
/// <param name="PrincipalId">The principal identifier claim signed by Core.</param>
/// <param name="AccessTokenId">The PAT row that must be rechecked on every Core request.</param>
/// <param name="SecretLookup">The lookup half of the secret the session was exchanged with; it must still be the row's.</param>
public sealed record ValidatedCoreToken(
    TenantId TenantId,
    PrincipalId PrincipalId,
    PersonalAccessTokenId AccessTokenId,
    string SecretLookup = "")
    : ValidatedToken(TenantId);

/// <summary>A short-lived Core JWT backed by a revocable browser session.</summary>
public sealed record ValidatedBrowserSessionToken(
    TenantId TenantId,
    PrincipalId PrincipalId,
    BrowserSessionId BrowserSessionId)
    : ValidatedToken(TenantId);

/// <summary>A Core-signed actor delegation bounded by an exact live worker lease.</summary>
public sealed record ValidatedWorkerExecutionToken(
    TenantId TenantId,
    PrincipalId PrincipalId,
    Guid JobId,
    Guid ItemId,
    Guid WorkspaceId,
    string Scope,
    string ExecutionId)
    : ValidatedToken(TenantId);

/// <summary>A short-lived Core JWT a pet turn's server-run tools act with, as the person.</summary>
public sealed record ValidatedPetTurnToken(
    TenantId TenantId,
    PrincipalId PrincipalId,
    Guid RequestId,
    PetTurnMode Mode)
    : ValidatedToken(TenantId)
{
    /// <summary>Gets a value indicating whether the token reaches write routes.</summary>
    public bool MayWrite => Mode != PetTurnMode.Read;

    /// <summary>Gets a value indicating whether the token reaches admin routes.</summary>
    public bool MayAdminister => Mode == PetTurnMode.Admin;
}
