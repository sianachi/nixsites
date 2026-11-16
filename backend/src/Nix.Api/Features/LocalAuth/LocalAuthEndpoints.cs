using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Features.BrowserAuth;
using Nix.Http;
using Nix.Persistence.Identity;
using Npgsql;

namespace Nix.Features.LocalAuth;

/// <summary>Password sign-in, first-run setup and one-time links. Every route answers 404 unless the install is in local mode.</summary>
internal static class LocalAuthEndpoints
{
    private const int MaxName = 100;
    private const int MaxBody = 4096;

    internal static IEndpointRouteBuilder MapLocalAuthEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);
        var local = endpoints.MapGroup("/auth/local").WithTags("LocalAuth")
            .RequireAuthMode(AuthMode.Local)
            .RequireRateLimiting(BrowserAuthEndpoints.LoginPolicy);
        local.MapPost("/setup", Setup).WithRequestBodyLimit(MaxBody);
        local.MapPost("/sign-in", SignIn).WithRequestBodyLimit(MaxBody);
        local.MapGet("/link/{token}", GetLink);
        local.MapPost("/link/{token}/password", SetPasswordWithLink).WithRequestBodyLimit(MaxBody);
        return endpoints;
    }

    private static async Task<IResult> Setup(
        [FromBody] LocalSetupRequest? request,
        HttpContext httpContext,
        [FromServices] BrowserAuthCoordinator coordinator,
        [FromServices] AuthSettings settings,
        [FromServices] ILocalAccounts accounts,
        [FromServices] PasswordHasher hasher,
        [FromServices] LocalAccountProvisioner provisioner,
        [FromServices] LocalSignInCompleter completer)
    {
        BrowserAuthEndpoints.SetNoStore(httpContext);
        if (!BrowserAuthEndpoints.HasSameOrigin(httpContext, coordinator))
        {
            return BrowserAuthEndpoints.CsrfProblem(httpContext);
        }

        var ct = httpContext.RequestAborted;
        if (settings.SetupCode.Length == 0)
        {
            return LocalAuthProblems.Refuse(httpContext, StatusCodes.Status403Forbidden, "setup_unavailable", "Setup is not enabled", "This install has no setup code configured.");
        }

        if (await accounts.AnyAsync(ct).ConfigureAwait(false))
        {
            return LocalAuthProblems.Refuse(httpContext, StatusCodes.Status409Conflict, "setup_closed", "Setup is finished", "The first account already exists.");
        }

        // Hashed first so a wrong-length code costs the same as a wrong-content one.
        if (request?.SetupCode is not { } code
            || !CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(code)), SHA256.HashData(Encoding.UTF8.GetBytes(settings.SetupCode))))
        {
            return LocalAuthProblems.Refuse(httpContext, StatusCodes.Status403Forbidden, "invalid_setup_code", "Setup code is wrong", "The setup code did not match.");
        }

        // Checked before the account exists: a first run started from the phone or desktop app ends in
        // its handoff, and a malformed challenge must not leave an account behind a refusal.
        if (request.Native is not null && !NativeHandoffCoordinator.IsChallenge(request.Native))
        {
            return BrowserAuthEndpoints.Problem(httpContext, BrowserAuthFailure.InvalidState);
        }

        if (!TryReadPerson(request.Email, request.Name, request.Password, httpContext, out var email, out var name, out var invalid))
        {
            return invalid!;
        }

        if (await accounts.SetupTenantAsync(ct).ConfigureAwait(false) is not { } tenant)
        {
            return LocalAuthProblems.Refuse(httpContext, StatusCodes.Status503ServiceUnavailable, "setup_unavailable", "Setup is not ready", "The install has no single tenant to create the first account in.");
        }

        var result = await provisioner.CreateFirstAdminAsync(tenant, email, name, hasher.Hash(request.Password!), ct).ConfigureAwait(false);
        return result.Outcome switch
        {
            LocalProvisionOutcome.Created => await completer.CompleteAsync(httpContext, result.Principal!.Id, request.ReturnTo, request.Native).ConfigureAwait(false),
            _ => LocalAuthProblems.Refuse(httpContext, StatusCodes.Status409Conflict, "setup_closed", "Setup is finished", "The first account already exists."),
        };
    }

    private static async Task<IResult> SignIn(
        [FromBody] LocalSignInRequest? request,
        HttpContext httpContext,
        [FromServices] BrowserAuthCoordinator coordinator,
        [FromServices] ILocalChallenges challenges,
        [FromServices] LocalPasswordSignIn passwords,
        [FromServices] LocalSignInCompleter completer,
        [FromServices] TimeProvider clock)
    {
        BrowserAuthEndpoints.SetNoStore(httpContext);
        if (!BrowserAuthEndpoints.HasSameOrigin(httpContext, coordinator))
        {
            return BrowserAuthEndpoints.CsrfProblem(httpContext);
        }

        var ct = httpContext.RequestAborted;
        if (request?.Native is not null && !NativeHandoffCoordinator.IsChallenge(request.Native))
        {
            return BrowserAuthEndpoints.Problem(httpContext, BrowserAuthFailure.InvalidState);
        }

        var outcome = await passwords.CheckAsync(request?.Email, request?.Password, ct).ConfigureAwait(false);
        switch (outcome.Kind)
        {
            case PasswordSignInKind.Paused:
                return LocalAuthProblems.Paused(httpContext, outcome.RetryAfter);
            case PasswordSignInKind.SecondStepUnavailable:
                return LocalAuthProblems.Refuse(httpContext, StatusCodes.Status503ServiceUnavailable, "second_step_unavailable", "Second step unavailable", "This account has a second step this server cannot check.");
            case PasswordSignInKind.SignedIn:
                return await completer.CompleteAsync(httpContext, outcome.PrincipalId!.Value, request!.ReturnTo, request.Native).ConfigureAwait(false);
            case PasswordSignInKind.SecondStep:
                var id = Guid.CreateVersion7();
                return await challenges.CreateAsync(
                        id,
                        LocalChallengeKind.SecondStep,
                        outcome.PrincipalId,
                        state: null,
                        Truncate(request!.ReturnTo),
                        request.Native,
                        clock.GetUtcNow() + ILocalChallenges.Lifetime,
                        ct).ConfigureAwait(false)
                    ? TypedResults.Ok(new LocalSecondStepResponse("second_step", id, outcome.Methods!))
                    : BrowserAuthEndpoints.Problem(httpContext, BrowserAuthFailure.HandoffBusy);
            default:
                return LocalAuthProblems.InvalidCredentials(httpContext);
        }
    }

    private static async Task<IResult> GetLink(string token, HttpContext httpContext, [FromServices] ILocalAccountLinks links)
    {
        BrowserAuthEndpoints.SetNoStore(httpContext);
        var link = await FindLinkAsync(token, links, httpContext.RequestAborted).ConfigureAwait(false);
        return link is null
            ? TypedResults.NotFound()
            : TypedResults.Ok(new LocalLinkInfoResponse(PurposeName(link.Purpose), link.Email ?? string.Empty, link.DisplayName));
    }

    private static async Task<IResult> SetPasswordWithLink(
        string token,
        [FromBody] LocalLinkPasswordRequest? request,
        HttpContext httpContext,
        [FromServices] BrowserAuthCoordinator coordinator,
        [FromServices] ILocalAccountLinks links,
        [FromServices] ILocalAccounts accounts,
        [FromServices] PasswordHasher hasher,
        [FromServices] LocalSignInCompleter completer)
    {
        BrowserAuthEndpoints.SetNoStore(httpContext);
        if (!BrowserAuthEndpoints.HasSameOrigin(httpContext, coordinator))
        {
            return BrowserAuthEndpoints.CsrfProblem(httpContext);
        }

        var ct = httpContext.RequestAborted;
        // Checked before the link is used up, so a too-short password does not cost the person their link.
        if (!PasswordHasher.IsAcceptable(request?.Password))
        {
            return PasswordRefusal(httpContext);
        }

        if (LinkHash(token) is not { } hash || await links.ConsumeAsync(hash, ct).ConfigureAwait(false) is not { } link)
        {
            return TypedResults.NotFound();
        }

        _ = await accounts.SetPasswordAsync(link.PrincipalId, hasher.Hash(request!.Password!), changed: true, ct).ConfigureAwait(false);
        // Whoever held the old password or a stolen session loses it now; the new sign-in below is the only one left.
        _ = await accounts.RevokeSessionsAsync(link.PrincipalId, null, ct).ConfigureAwait(false);
        return await completer.CompleteAsync(httpContext, link.PrincipalId, null, null).ConfigureAwait(false);
    }

    /// <summary>Resolves a presented link token without using it; shared with the passkey link routes.</summary>
    internal static async ValueTask<LocalLinkRecord?> FindLinkAsync(string token, ILocalAccountLinks links, CancellationToken cancellationToken) =>
        LinkHash(token) is { } hash ? await links.FindAsync(hash, cancellationToken).ConfigureAwait(false) : null;

    /// <summary>Hashes a link token, or null when its shape cannot be one of ours (so no lookup is made).</summary>
    internal static string? LinkHash(string token) =>
        token is { Length: > 0 and <= 64 } && token.All(static c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_')
            ? LocalLinkToken.Hash(token)
            : null;

    internal static string PurposeName(LocalLinkPurpose purpose) => purpose == LocalLinkPurpose.Setup ? "setup" : "reset";

    internal static IResult PasswordRefusal(HttpContext httpContext) => LocalAuthProblems.Invalid(
        httpContext,
        "invalid_password",
        string.Create(
            System.Globalization.CultureInfo.InvariantCulture,
            $"A password needs {PasswordHasher.MinimumLength} to {PasswordHasher.MaximumLength} characters."));

    private static bool TryReadPerson(
        string? rawEmail, string? rawName, string? password, HttpContext httpContext,
        out string email, out string name, out IResult? refusal)
    {
        name = rawName?.Trim() ?? string.Empty;
        refusal = null;
        if (!LocalAccountEmail.TryNormalize(rawEmail, out email))
        {
            refusal = LocalAuthProblems.Invalid(httpContext, "invalid_email", "That is not an email address.");
        }
        else if (name.Length is 0 or > MaxName || name.Any(char.IsControl))
        {
            refusal = LocalAuthProblems.Invalid(httpContext, "invalid_name", "A name needs 1 to 100 characters.");
        }
        else if (!PasswordHasher.IsAcceptable(password))
        {
            refusal = PasswordRefusal(httpContext);
        }

        return refusal is null;
    }

    private static string? Truncate(string? value) => value is { Length: > 2048 } ? null : value;
}
