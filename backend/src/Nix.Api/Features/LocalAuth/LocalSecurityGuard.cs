using Nix.Abstractions;
using Nix.Errors;

namespace Nix.Features.LocalAuth;

/// <summary>
/// The door every /api/v1/me/security and People route goes through: a person's own browser session, never an
/// access token, pet turn, command-line session or other bearer, plus their local account record. The passkey and authenticator lanes use it too.
/// </summary>
public sealed class LocalSecurityGuard(
    INixSessionContextAccessor session,
    AccessTokenSessionContext scope,
    CredentialSessionContext credential,
    ILocalAccounts accounts)
{
    /// <summary>The signed-in person's account, or the refusal to return.</summary>
    internal async ValueTask<(LocalAccountRecord? Account, IResult? Refusal)> ResolveAsync(HttpContext httpContext)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        // The command line's device sign-in also holds a session; it is a tool, not a person at a browser.
        if (!scope.IsInteractive || session.Current is not { } current || CurrentSession is not { } sessionId
            || await accounts.FindSessionAsync(sessionId, httpContext.RequestAborted).ConfigureAwait(false) is not { IsCommandLine: false })
        {
            return (null, TypedResults.Problem(ApiProblem.Create(
                httpContext,
                StatusCodes.Status403Forbidden,
                "security.interactive_only",
                "Sign-in settings are for people",
                "Only a person's own browser session can change how they sign in.")));
        }

        var account = await accounts.FindByPrincipalAsync(current.PrincipalId, httpContext.RequestAborted).ConfigureAwait(false);
        return account is null
            ? (null, TypedResults.Problem(ApiProblem.Create(
                httpContext,
                StatusCodes.Status404NotFound,
                "security.no_local_account",
                "No local sign-in",
                "This person does not sign in with a local account.")))
            : (account, null);
    }

    /// <summary>The browser session making this request, so a password change can keep it.</summary>
    internal Nix.Domain.Identity.BrowserSessionId? CurrentSession =>
        credential.CredentialId is { } id ? Nix.Domain.Identity.BrowserSessionId.From(id) : null;
}
