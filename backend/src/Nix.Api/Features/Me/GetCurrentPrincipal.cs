using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Sites;
using Nix.Messaging;

namespace Nix.Features.CurrentUser;

/// <summary>
/// Asks for the caller's own profile.
/// </summary>
/// <remarks>
/// Carries no parameters, because the caller is already established by the session context.
/// "Who am I" cannot take an argument without becoming "who is that", which is a different
/// question with different authorization.
/// </remarks>
public sealed record GetCurrentPrincipal : IQuery<Result<CurrentPrincipal>>;

/// <summary>Describes the caller to themselves: who they are, and what the interface may offer them.</summary>
/// <remarks>
/// <para>
/// <b>The administrator flag is read from the database on every request, never from the token.</b>
/// Roles live in the database and never in tokens - a role inside a bearer artefact minted minutes
/// ago by a system we do not control cannot be revoked before it expires. That principle is what
/// makes this endpoint necessary at all: the shell cannot decide whether to show an administrative
/// entry by decoding the identity token it already holds, because the answer is not in there and
/// must not be.
/// </para>
/// <para>
/// <b>It is a display decision, not an authorization one.</b> Hiding an entry stops nobody from
/// requesting the route behind it; the endpoints answer that question for themselves through the
/// same resolver. What this prevents is offering somebody a door that will not open, which is a
/// truthfulness problem rather than a security one.
/// </para>
/// </remarks>
public sealed class GetCurrentPrincipalHandler(
    IPrincipalDirectory principals,
    IPermissionResolver permissions,
    INixSessionContextAccessor session)
    : IQueryHandler<GetCurrentPrincipal, Result<CurrentPrincipal>>
{
    private readonly INixSessionContextAccessor _session = session;

    /// <summary>Reads the caller's own profile.</summary>
    /// <param name="query">The query, which carries no parameters.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The profile, or why it could not be read.</returns>
    public async ValueTask<Result<CurrentPrincipal>> HandleAsync(
        GetCurrentPrincipal query,
        CancellationToken cancellationToken)
    {
        var context = _session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

        var principal = await principals.FindAsync(context.PrincipalId, cancellationToken).ConfigureAwait(false);
        if (principal is null)
        {
            // Reachable only if the row disappeared between authentication and here, which the
            // request's own transaction makes vanishingly unlikely - but returning a half-populated
            // profile from the session context alone would be inventing data to avoid a branch.
            return Result.Failure<CurrentPrincipal>(
                new NixError("identity.principal_not_found", "The acting principal no longer exists."));
        }

        var isAdministrator = await permissions
            .IsTenantAdministratorAsync(cancellationToken)
            .ConfigureAwait(false);

        return Result.Success(
            new CurrentPrincipal(
                principal.Id,
                principal.TenantId,
                principal.DisplayName,
                principal.Email,
                isAdministrator));
    }
}

/// <summary>The caller, as the caller is allowed to see themselves.</summary>
/// <param name="Id">Their principal identifier.</param>
/// <param name="TenantId">The tenant they are acting in.</param>
/// <param name="DisplayName">Their name, for the shell.</param>
/// <param name="Email">Their email address, or <see langword="null"/> when the provider supplies none.</param>
/// <param name="IsTenantAdministrator">Whether tenant-wide administrative surfaces apply to them.</param>
public sealed record CurrentPrincipal(
    PrincipalId Id,
    TenantId TenantId,
    string DisplayName,
    string? Email,
    bool IsTenantAdministrator);

/// <summary>
/// Route handler for the caller's own profile.
/// </summary>
/// <remarks>
/// Named apart from <see cref="GetCurrentPrincipal"/> itself: the query record already owns that
/// identifier in this namespace, and a route handler with the same name would be an ambiguous
/// simple name at the <c>MapGet</c> call site.
/// </remarks>
internal static class GetCurrentPrincipalEndpoint
{
    /// <summary>Handles a request for the caller's own profile.</summary>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the query to its handler.</param>
    /// <returns>The caller's profile, or a problem describing why it could not be read.</returns>
    internal static async Task<Results<Ok<CurrentPrincipalResponse>, ProblemHttpResult>> Handle(
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher,
        [FromServices] SiteOptions sites,
        [FromServices] SiteOperators operators,
        [FromServices] IConfiguration configuration)
    {
        var result = await dispatcher
            .QueryAsync<GetCurrentPrincipal, Result<CurrentPrincipal>>(
                new GetCurrentPrincipal(),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        // Display only; the backups route checks the same list for itself.
        var isOperator = operators.IsInstanceOperator();
        var isApprover = await operators.IsOperatorAsync(httpContext.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<CurrentPrincipalResponse>, ProblemHttpResult>>(
            principal => TypedResults.Ok(
                new CurrentPrincipalResponse(
                    principal.Id.Value,
                    principal.TenantId.Value,
                    principal.DisplayName,
                    principal.Email,
                    principal.IsTenantAdministrator,
                    new CurrentPrincipalFeatures(
                        sites.IsEnabled,
                        // Display only: the address people paste into an MCP client. Absent means
                        // the deployment serves MCP on stdio through nixctl alone.
                        Uri.TryCreate(configuration["Nix:Mcp:PublicUrl"], UriKind.Absolute, out var mcp) ? mcp.ToString() : null,
                        isOperator,
                        isApprover))),
            error => TypedResults.Problem(MeEndpoints.Problem(httpContext, error)));
    }
}
