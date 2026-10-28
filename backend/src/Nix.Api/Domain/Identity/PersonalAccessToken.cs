using Nix.Domain.Tenancy;

namespace Nix.Domain.Identity;

/// <summary>
/// A credential a principal issued so a non-browser client can act as them, within a ceiling they
/// chose.
/// </summary>
/// <remarks>
/// <para>
/// <b>Per principal, never shared.</b> A token belongs to the person who issued it and
/// authenticates as them; there is no service identity behind it and no way to mint one that
/// outreaches its issuer. Deprovisioning the principal ends every token they issued, because the
/// request pipeline re-resolves the principal on every request.
/// </para>
/// <para>
/// <b>The secret is not here.</b> Only <see cref="SecretHash"/> is stored; the token string
/// itself is shown once at creation and never again. <see cref="Lookup"/> is the indexed,
/// non-secret half that makes authentication one read instead of a scan.
/// </para>
/// <para>
/// <b>Expiry is chosen, not defaulted away.</b> <see cref="ExpiresAt"/> is required and bounded
/// at creation: a token without an end a person picked is how credentials outlive the reason
/// they exist.
/// </para>
/// </remarks>
public sealed class PersonalAccessToken
{
    /// <summary>How long a token may live at most, in days.</summary>
    public const int MaximumLifetimeDays = 365;

    /// <summary>The longest name a token may carry.</summary>
    public const int MaximumNameLength = 100;

    /// <summary>The most unrevoked, unexpired tokens one principal may hold at once.</summary>
    public const int MaximumLiveTokensPerPrincipal = 25;

    /// <summary>The row's identity. Safe to show and to log; it opens nothing.</summary>
    public required PersonalAccessTokenId Id { get; init; }

    /// <summary>The tenant, carried for row-level security.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>The principal every request this token authenticates will act as.</summary>
    public required PrincipalId PrincipalId { get; init; }

    /// <summary>What the issuer called it, so a list of tokens reads as intentions.</summary>
    public required string Name { get; init; }

    /// <summary>The indexed lookup half of the token string. Not a secret.</summary>
    public required string Lookup { get; init; }

    /// <summary>The SHA-256 of the full token string. The secret itself is never stored.</summary>
    public required ReadOnlyMemory<byte> SecretHash { get; init; }

    /// <summary>The ceiling on what requests this token may make. See <see cref="AccessTokenScope"/>.</summary>
    public required IReadOnlyList<string> Scopes { get; init; }

    /// <summary>When it was issued.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>When it stops working, chosen by the issuer at creation.</summary>
    public required DateTimeOffset ExpiresAt { get; init; }

    /// <summary>When it was revoked, or <see langword="null"/> while it stands.</summary>
    public DateTimeOffset? RevokedAt { get; set; }

    /// <summary>
    /// When it last authenticated a request, coarsened to a few minutes so authenticating is not
    /// a write per request. <see langword="null"/> until it is first used.
    /// </summary>
    public DateTimeOffset? LastUsedAt { get; set; }
}
