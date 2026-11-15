using System.Globalization;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;

namespace Nix.Features.LocalAuth;

/// <summary>A freshly minted link; the URL is the only place the secret ever appears.</summary>
internal sealed record LocalIssuedLink(string Url, DateTimeOffset ExpiresAt);

/// <summary>Mints a one-hour setup or reset link, replacing any unused earlier link of that person.</summary>
public sealed class LocalLinkIssuer(ILocalAccountLinks links, AuthSettings settings, TimeProvider clock)
{
    /// <returns>The link, or null when the person has no local account.</returns>
    internal async ValueTask<LocalIssuedLink?> IssueAsync(
        PrincipalId principalId,
        LocalLinkPurpose purpose,
        PrincipalId? createdBy,
        CancellationToken cancellationToken)
    {
        var origin = settings.PublicOrigin
            ?? throw new InvalidOperationException("Nix:Bff:PublicOrigin must be set to build account links.");
        var minted = LocalLinkToken.Mint();
        var expiresAt = clock.GetUtcNow() + LocalLinkToken.Lifetime;
        return await links.CreateAsync(principalId, purpose, minted.Hash, expiresAt, createdBy, cancellationToken).ConfigureAwait(false)
            ? new LocalIssuedLink(new Uri(origin, string.Create(CultureInfo.InvariantCulture, $"/account-link/{minted.Token}")).AbsoluteUri, expiresAt)
            : null;
    }
}
