using System.Diagnostics.CodeAnalysis;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;

namespace Nix.Features.BrowserAuth;

/// <summary>Confirms a request comes from the caller's own signed-in browser session, not a token.</summary>
[SuppressMessage("Performance", "CA1812", Justification = "Created by ASP.NET Core dependency injection.")]
internal sealed class BrowserAccess(
    BrowserAuthCoordinator browser,
    AccessTokenSessionContext access,
    CredentialSessionContext credential,
    INixSessionContextAccessor session)
{
    internal Uri? PublicOrigin => browser.PublicOrigin;

    internal async ValueTask<AuthenticatedBrowserSession?> VerifyAsync(HttpContext http, bool requireOrigin)
    {
        if (!access.IsInteractive || session.Current is not { } caller
            || (requireOrigin && !BrowserAuthEndpoints.HasSameOrigin(http, browser)))
        {
            return null;
        }

        var verified = await browser.ResolveAsync(http.Request.Cookies[browser.SessionCookieName], http.RequestAborted)
            .ConfigureAwait(false);
        return verified is { PrincipalStatus: PrincipalStatus.Active } && verified.TenantId == caller.TenantId
            && verified.PrincipalId == caller.PrincipalId && verified.Id.Value == credential.CredentialId
            ? verified
            : null;
    }
}
