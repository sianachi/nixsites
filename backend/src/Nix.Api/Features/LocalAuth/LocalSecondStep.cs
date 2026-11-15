using Microsoft.AspNetCore.Http.HttpResults;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Features.BrowserAuth;

namespace Nix.Features.LocalAuth;

/// <summary>The names a second step goes by on the wire.</summary>
public static class LocalSecondStepMethods
{
    /// <summary>An authenticator-app code.</summary>
    public const string Totp = "totp";

    /// <summary>A security key (a passkey kept as a second factor only).</summary>
    public const string SecurityKey = "security_key";
}

/// <summary>
/// One way to answer the step after a correct password. The TOTP and security-key lanes each register one
/// (<c>AddScoped&lt;ILocalSecondStepMethod, ...&gt;</c>); a challenge offers every method the person is enrolled in.
/// </summary>
public interface ILocalSecondStepMethod
{
    /// <summary>The wire name, one of <see cref="LocalSecondStepMethods"/>.</summary>
    public string Method { get; }

    /// <summary>Whether this person has set the method up.</summary>
    public ValueTask<bool> IsEnrolledAsync(LocalAccountRecord account, CancellationToken cancellationToken);
}

/// <summary>Works out which second steps a person must answer.</summary>
public sealed class LocalSecondStepGate(IEnumerable<ILocalSecondStepMethod> methods)
{
    /// <summary>
    /// The enrolled methods, or null when the account holds a factor that no registered method can check.
    /// That case must refuse the sign-in: skipping the step would turn a second factor into no factor.
    /// </summary>
    internal async ValueTask<IReadOnlyList<string>?> RequiredAsync(LocalAccountRecord account, CancellationToken cancellationToken)
    {
        var names = new List<string>();
        foreach (var method in methods)
        {
            if (await method.IsEnrolledAsync(account, cancellationToken).ConfigureAwait(false))
            {
                names.Add(method.Method);
            }
        }

        var checkable = (account.TotpEnabled ? names.Contains(LocalSecondStepMethods.Totp) : true)
            && (account.SecurityKeyCount == 0 || names.Contains(LocalSecondStepMethods.SecurityKey));
        return checkable ? names : null;
    }
}

/// <summary>
/// Turns a finished proof of identity into the one browser session every sign-in ends in. Every route that
/// completes a sign-in (password, second step, passkey, link) calls <see cref="CompleteAsync"/>.
/// </summary>
public sealed class LocalSignInCompleter(
    ILocalAccounts accounts,
    BrowserAuthCoordinator coordinator,
    NativeHandoffCoordinator handoffs)
{
    /// <summary>Creates the session and returns <c>{status:"signed_in", redirectTo}</c>, or a refusal.</summary>
    /// <param name="httpContext">The request.</param>
    /// <param name="principalId">The person who has proved who they are.</param>
    /// <param name="returnTo">The path to land on; sanitized by the coordinator.</param>
    /// <param name="native">The native handoff challenge when the phone or desktop app started the sign-in.</param>
    internal async Task<IResult> CompleteAsync(HttpContext httpContext, PrincipalId principalId, string? returnTo, string? native)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        var ct = httpContext.RequestAborted;
        var account = await accounts.FindByPrincipalAsync(principalId, ct).ConfigureAwait(false);
        if (account is not { Status: PrincipalStatus.Active })
        {
            return BrowserAuthEndpoints.Problem(httpContext, BrowserAuthFailure.PrincipalInactive);
        }

        try
        {
            var completed = await coordinator.SignInLocalAsync(
                new AuthenticatedPrincipal(account.PrincipalId, account.TenantId, account.Status, account.DisplayName),
                returnTo,
                native,
                ct).ConfigureAwait(false);
            var redirect = await BrowserAuthEndpoints.FinishSignInAsync(httpContext, coordinator, handoffs, completed).ConfigureAwait(false);
            return redirect is null
                ? BrowserAuthEndpoints.Problem(httpContext, BrowserAuthFailure.HandoffBusy)
                : TypedResults.Ok(LocalSignedInResponse.At(redirect));
        }
        catch (BrowserAuthException exception)
        {
            return BrowserAuthEndpoints.Problem(httpContext, exception.Failure);
        }
    }
}
