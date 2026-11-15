using System.Text.Json;
using System.Text.Json.Serialization;
using Fido2NetLib;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Features.BrowserAuth;
using Nix.Http;

namespace Nix.Features.LocalAuth;

/// <summary>Starts a passkey sign-in.</summary>
internal sealed record LocalPasskeySignInOptionsRequest(string? ReturnTo, string? Native);

/// <summary>A browser's answer to a challenge it was given.</summary>
internal sealed record LocalPasskeyAssertionRequest(Guid ChallengeId, JsonElement Credential);

/// <summary>A security key's answer to the second-step challenge.</summary>
internal sealed record LocalSecurityKeyOptionsRequest(Guid ChallengeId);

/// <summary>A new credential and the name the person gave it.</summary>
internal sealed record LocalPasskeyRegistrationRequest(JsonElement Credential, string? Name);

/// <summary>A new name for a credential.</summary>
internal sealed record LocalPasskeyRenameRequest(string? Name);

/// <summary>Source-generated JSON metadata for passkey requests.</summary>
[JsonSerializable(typeof(LocalPasskeySignInOptionsRequest))]
[JsonSerializable(typeof(LocalPasskeyAssertionRequest))]
[JsonSerializable(typeof(LocalSecurityKeyOptionsRequest))]
[JsonSerializable(typeof(LocalPasskeyRegistrationRequest))]
[JsonSerializable(typeof(LocalPasskeyRenameRequest))]
internal sealed partial class LocalPasskeyJsonContext : JsonSerializerContext;

/// <summary>Passkey sign-in, passkey creation from a link, the security-key second step and /.well-known/webauthn.</summary>
internal static class LocalPasskeyEndpoints
{
    private const int MaxBody = 16 * 1024;

    internal static IEndpointRouteBuilder MapLocalPasskeySignInEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);
        var local = endpoints.MapGroup("/auth/local").WithTags("LocalAuth")
            .RequireAuthMode(AuthMode.Local)
            .RequireRateLimiting(BrowserAuthEndpoints.LoginPolicy);
        local.MapPost("/passkey/options", SignInOptions).WithRequestBodyLimit(MaxBody);
        local.MapPost("/passkey/verify", SignInVerify).WithRequestBodyLimit(MaxBody);
        local.MapPost("/second-step/security-key/options", SecurityKeyOptions).WithRequestBodyLimit(MaxBody);
        local.MapPost("/second-step/security-key/verify", SecurityKeyVerify).WithRequestBodyLimit(MaxBody);
        local.MapPost("/link/{token}/passkey/options", LinkOptions);
        local.MapPost("/link/{token}/passkey/verify", LinkVerify).WithRequestBodyLimit(MaxBody);

        // Related origins: the RP id is an older host name, and its owner lists the public origin that may use it.
        endpoints.MapGet("/.well-known/webauthn", WellKnown).WithTags("LocalAuth").RequireAuthMode(AuthMode.Local);
        return endpoints;
    }

    internal static IEndpointRouteBuilder MapLocalPasskeySecurityEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);
        var security = endpoints.MapGroup("/api/v1/me/security/passkeys").WithTags("LocalSecurity").RequireAuthMode(AuthMode.Local);
        security.MapPost("/options", AddOptions).WithName("StartAddLocalPasskey")
            .WithSummary("Start adding a passkey; returns WebAuthn creation options")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        security.MapPost("/verify", AddVerify).WithName("FinishAddLocalPasskey")
            .WithSummary("Finish adding a passkey")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName).WithRequestBodyLimit(MaxBody);
        security.MapPatch("/{id:guid}", Rename).WithName("RenameLocalPasskey")
            .WithSummary("Rename a passkey")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        security.MapDelete("/{id:guid}", Remove).WithName("RemoveLocalPasskey")
            .WithSummary("Remove a passkey; the last sign-in method cannot be removed")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        return endpoints;
    }

    // ---- sign-in -------------------------------------------------------------------------------------------

    private static async Task<IResult> SignInOptions(
        [FromBody(EmptyBodyBehavior = EmptyBodyBehavior.Allow)] LocalPasskeySignInOptionsRequest? request,
        HttpContext httpContext,
        [FromServices] BrowserAuthCoordinator coordinator,
        [FromServices] LocalPasskeyCeremony ceremony,
        [FromServices] ILocalChallenges challenges,
        [FromServices] TimeProvider clock)
    {
        if (Guard(httpContext, coordinator, ceremony) is { } refusal)
        {
            return refusal;
        }

        if (request?.Native is not null && !NativeHandoffCoordinator.IsChallenge(request.Native))
        {
            return BrowserAuthEndpoints.Problem(httpContext, BrowserAuthFailure.InvalidState);
        }

        var options = ceremony.SignInOptions();
        var id = Guid.CreateVersion7();
        return await challenges.CreateAsync(
                id, LocalChallengeKind.PasskeySignIn, null, options.ToJson(), Truncate(request?.ReturnTo), request?.Native,
                clock.GetUtcNow() + ILocalChallenges.Lifetime, httpContext.RequestAborted).ConfigureAwait(false)
            ? Json($$"""{"challengeId":"{{id}}","options":{{options.ToJson()}}}""")
            : BrowserAuthEndpoints.Problem(httpContext, BrowserAuthFailure.HandoffBusy);
    }

    private static async Task<IResult> SignInVerify(
        [FromBody] LocalPasskeyAssertionRequest? request,
        HttpContext httpContext,
        [FromServices] BrowserAuthCoordinator coordinator,
        [FromServices] LocalPasskeyCeremony ceremony,
        [FromServices] AuthSettings settings,
        [FromServices] ILocalChallenges challenges,
        [FromServices] ILocalCredentials credentials,
        [FromServices] LocalSignInCompleter completer)
    {
        if (Guard(httpContext, coordinator, ceremony) is { } refusal)
        {
            return refusal;
        }

        var ct = httpContext.RequestAborted;
        // Taken before anything is checked: one challenge, one try, so a captured challenge cannot be replayed.
        if (request is null
            || await challenges.TakeAsync(request.ChallengeId, LocalChallengeKind.PasskeySignIn, ct).ConfigureAwait(false) is not { State: { } state } challenge
            || LocalPasskeyCeremony.ReadAssertion(request.Credential) is not { } response
            || await credentials.FindPasskeyAsync(response.RawId, ct).ConfigureAwait(false) is not { Kind: LocalPasskeyKind.Passkey, Status: PrincipalStatus.Active } owner
            || !string.Equals(owner.RpId, settings.PasskeyRpId, StringComparison.OrdinalIgnoreCase)
            || await ceremony.VerifyAssertionAsync(AssertionOptions.FromJson(state), response, owner.PublicKey, owner.SignCount, ct).ConfigureAwait(false) is not { } signCount)
        {
            return LocalAuthProblems.InvalidCredentials(httpContext);
        }

        await credentials.TouchPasskeyAsync(owner.Id, signCount, ct).ConfigureAwait(false);
        return await completer.CompleteAsync(httpContext, owner.PrincipalId, challenge.ReturnTo, challenge.Native).ConfigureAwait(false);
    }

    // ---- security key as the second step ---------------------------------------------------------------------

    private static async Task<IResult> SecurityKeyOptions(
        [FromBody] LocalSecurityKeyOptionsRequest? request,
        HttpContext httpContext,
        [FromServices] BrowserAuthCoordinator coordinator,
        [FromServices] LocalPasskeyCeremony ceremony,
        [FromServices] ILocalChallenges challenges,
        [FromServices] ILocalCredentials credentials)
    {
        if (Guard(httpContext, coordinator, ceremony) is { } refusal)
        {
            return refusal;
        }

        var ct = httpContext.RequestAborted;
        if (request is null
            || await challenges.GetAsync(request.ChallengeId, LocalChallengeKind.SecondStep, ct).ConfigureAwait(false) is not { PrincipalId: { } principal })
        {
            return LocalAuthProblems.InvalidCredentials(httpContext);
        }

        var keys = (await credentials.ListPasskeysAsync(principal, ct).ConfigureAwait(false))
            .Where(static k => k.Kind == LocalPasskeyKind.SecurityKey).ToList();
        if (keys.Count == 0)
        {
            return await FailAsync(challenges, request.ChallengeId, httpContext).ConfigureAwait(false);
        }

        var options = ceremony.SecurityKeyOptions(keys);
        return await challenges.SetStateAsync(request.ChallengeId, options.ToJson(), ct).ConfigureAwait(false)
            ? Json(options.ToJson())
            : LocalAuthProblems.InvalidCredentials(httpContext);
    }

    private static async Task<IResult> SecurityKeyVerify(
        [FromBody] LocalPasskeyAssertionRequest? request,
        HttpContext httpContext,
        [FromServices] BrowserAuthCoordinator coordinator,
        [FromServices] LocalPasskeyCeremony ceremony,
        [FromServices] AuthSettings settings,
        [FromServices] ILocalChallenges challenges,
        [FromServices] ILocalCredentials credentials,
        [FromServices] LocalSignInCompleter completer)
    {
        if (Guard(httpContext, coordinator, ceremony) is { } refusal)
        {
            return refusal;
        }

        var ct = httpContext.RequestAborted;
        if (request is null
            || await challenges.GetAsync(request.ChallengeId, LocalChallengeKind.SecondStep, ct).ConfigureAwait(false) is not { PrincipalId: { } principal, State: { } state })
        {
            return LocalAuthProblems.InvalidCredentials(httpContext);
        }

        // Every wrong answer from here on counts against the challenge, which ends after five.
        if (LocalPasskeyCeremony.ReadAssertion(request.Credential) is not { } response
            || await credentials.FindPasskeyAsync(response.RawId, ct).ConfigureAwait(false) is not { Kind: LocalPasskeyKind.SecurityKey, Status: PrincipalStatus.Active } owner
            || owner.PrincipalId != principal
            || !string.Equals(owner.RpId, settings.PasskeyRpId, StringComparison.OrdinalIgnoreCase)
            || await ceremony.VerifyAssertionAsync(AssertionOptions.FromJson(state), response, owner.PublicKey, owner.SignCount, ct).ConfigureAwait(false) is not { } signCount)
        {
            return await FailAsync(challenges, request.ChallengeId, httpContext).ConfigureAwait(false);
        }

        if (await challenges.TakeAsync(request.ChallengeId, LocalChallengeKind.SecondStep, ct).ConfigureAwait(false) is not { } taken)
        {
            return LocalAuthProblems.InvalidCredentials(httpContext);
        }

        await credentials.TouchPasskeyAsync(owner.Id, signCount, ct).ConfigureAwait(false);
        return await completer.CompleteAsync(httpContext, principal, taken.ReturnTo, taken.Native).ConfigureAwait(false);
    }

    // ---- first passkey from a setup or reset link ------------------------------------------------------------

    private static async Task<IResult> LinkOptions(
        string token,
        HttpContext httpContext,
        [FromServices] BrowserAuthCoordinator coordinator,
        [FromServices] LocalPasskeyCeremony ceremony,
        [FromServices] ILocalAccountLinks links,
        [FromServices] ILocalChallenges challenges,
        [FromServices] ILocalCredentials credentials,
        [FromServices] TimeProvider clock)
    {
        if (Guard(httpContext, coordinator, ceremony) is { } refusal)
        {
            return refusal;
        }

        var ct = httpContext.RequestAborted;
        if (await LocalAuthEndpoints.FindLinkAsync(token, links, ct).ConfigureAwait(false) is not { } link)
        {
            return TypedResults.NotFound();
        }

        var options = ceremony.CreationOptions(
            link.PrincipalId, link.Email ?? string.Empty, link.DisplayName,
            await credentials.ListPasskeysAsync(link.PrincipalId, ct).ConfigureAwait(false));
        // The verify body carries no challenge id, so the id comes from the link: one pending ceremony per link.
        var id = LocalPasskeyCeremony.DeterministicId("link-passkey", token);
        _ = await challenges.TakeAsync(id, LocalChallengeKind.LinkPasskey, ct).ConfigureAwait(false);
        return await challenges.CreateAsync(
                id, LocalChallengeKind.LinkPasskey, link.PrincipalId, options.ToJson(), null, null,
                clock.GetUtcNow() + ILocalChallenges.Lifetime, ct).ConfigureAwait(false)
            ? Json(options.ToJson())
            : BrowserAuthEndpoints.Problem(httpContext, BrowserAuthFailure.HandoffBusy);
    }

    private static async Task<IResult> LinkVerify(
        string token,
        [FromBody] LocalPasskeyRegistrationRequest? request,
        HttpContext httpContext,
        [FromServices] BrowserAuthCoordinator coordinator,
        [FromServices] LocalPasskeyCeremony ceremony,
        [FromServices] AuthSettings settings,
        [FromServices] ILocalAccountLinks links,
        [FromServices] ILocalAccounts accounts,
        [FromServices] ILocalChallenges challenges,
        [FromServices] ILocalCredentials credentials,
        [FromServices] TimeProvider clock,
        [FromServices] LocalSignInCompleter completer)
    {
        if (Guard(httpContext, coordinator, ceremony) is { } refusal)
        {
            return refusal;
        }

        var ct = httpContext.RequestAborted;
        if (await LocalAuthEndpoints.FindLinkAsync(token, links, ct).ConfigureAwait(false) is not { } found)
        {
            return TypedResults.NotFound();
        }

        if (!LocalPasskeyRules.TryName(request?.Name, out var name))
        {
            return LocalAuthProblems.Invalid(httpContext, "invalid_name", $"A name needs 1 to {LocalPasskeyRules.MaxName} characters.");
        }

        var registration = await RegisterAsync(
            ceremony, challenges, credentials, LocalPasskeyCeremony.DeterministicId("link-passkey", token),
            LocalChallengeKind.LinkPasskey, found.PrincipalId, request, ct).ConfigureAwait(false);
        if (registration is null)
        {
            return LocalAuthProblems.InvalidCredentials(httpContext);
        }

        // The link is spent only now that the credential is real, so a failed ceremony does not cost the person it.
        if (LocalAuthEndpoints.LinkHash(token) is not { } hash
            || await links.ConsumeAsync(hash, ct).ConfigureAwait(false) is not { } link
            || !await credentials.AddPasskeyAsync(link.PrincipalId, ToRecord(registration, settings, name, clock), ct).ConfigureAwait(false))
        {
            return TypedResults.NotFound();
        }

        if (link.Purpose == LocalLinkPurpose.Reset)
        {
            _ = await accounts.RevokeSessionsAsync(link.PrincipalId, null, ct).ConfigureAwait(false);
        }

        return await completer.CompleteAsync(httpContext, link.PrincipalId, null, null).ConfigureAwait(false);
    }

    // ---- Settings > Security ---------------------------------------------------------------------------------

    private static async Task<IResult> AddOptions(
        [FromBody(EmptyBodyBehavior = EmptyBodyBehavior.Allow)] LocalCurrentPasswordRequest? request,
        HttpContext httpContext,
        [FromServices] LocalPasskeyCeremony ceremony,
        [FromServices] LocalSecurityGuard guard,
        [FromServices] LocalReauth reauth,
        [FromServices] ILocalChallenges challenges,
        [FromServices] ILocalCredentials credentials,
        [FromServices] TimeProvider clock)
    {
        if (!ceremony.IsAvailable)
        {
            return Unavailable(httpContext);
        }

        var (account, refusal) = await guard.ResolveAsync(httpContext).ConfigureAwait(false);
        if (account is null)
        {
            return refusal!;
        }

        var ct = httpContext.RequestAborted;
        var check = await reauth.CheckAsync(account, request?.CurrentPassword, ct).ConfigureAwait(false);
        if (!check.IsOk)
        {
            return LocalReauth.Refuse(httpContext, check);
        }

        var options = ceremony.CreationOptions(
            account.PrincipalId, account.Email, account.DisplayName,
            await credentials.ListPasskeysAsync(account.PrincipalId, ct).ConfigureAwait(false));
        var id = LocalPasskeyCeremony.DeterministicId("add-passkey", account.PrincipalId.ToString());
        _ = await challenges.TakeAsync(id, LocalChallengeKind.AddPasskey, ct).ConfigureAwait(false);
        return await challenges.CreateAsync(
                id, LocalChallengeKind.AddPasskey, account.PrincipalId, options.ToJson(), null, null,
                clock.GetUtcNow() + ILocalChallenges.Lifetime, ct).ConfigureAwait(false)
            ? Json(options.ToJson())
            : LocalAuthProblems.Refuse(httpContext, StatusCodes.Status503ServiceUnavailable, "busy", "Try again", "Too many sign-ins are pending.");
    }

    private static async Task<IResult> AddVerify(
        [FromBody] LocalPasskeyRegistrationRequest? request,
        HttpContext httpContext,
        [FromServices] LocalPasskeyCeremony ceremony,
        [FromServices] AuthSettings settings,
        [FromServices] LocalSecurityGuard guard,
        [FromServices] ILocalChallenges challenges,
        [FromServices] ILocalCredentials credentials,
        [FromServices] TimeProvider clock)
    {
        if (!ceremony.IsAvailable)
        {
            return Unavailable(httpContext);
        }

        var (account, refusal) = await guard.ResolveAsync(httpContext).ConfigureAwait(false);
        if (account is null)
        {
            return refusal!;
        }

        if (!LocalPasskeyRules.TryName(request?.Name, out var name))
        {
            return LocalAuthProblems.Invalid(httpContext, "invalid_name", $"A name needs 1 to {LocalPasskeyRules.MaxName} characters.");
        }

        var ct = httpContext.RequestAborted;
        // The current password was checked when the options were issued, and the challenge is bound to this person.
        var registration = await RegisterAsync(
            ceremony, challenges, credentials, LocalPasskeyCeremony.DeterministicId("add-passkey", account.PrincipalId.ToString()),
            LocalChallengeKind.AddPasskey, account.PrincipalId, request, ct).ConfigureAwait(false);
        if (registration is null)
        {
            return LocalAuthProblems.Invalid(httpContext, "passkey_not_accepted", "The passkey could not be verified. Start again.");
        }

        var record = ToRecord(registration, settings, name, clock);
        return await credentials.AddPasskeyAsync(account.PrincipalId, record, ct).ConfigureAwait(false)
            ? TypedResults.Ok(new LocalPasskeySummary(record.Id, record.Name, "passkey", record.CreatedAt, null))
            : LocalAuthProblems.Refuse(httpContext, StatusCodes.Status409Conflict, "security.passkey_limit", "Too many passkeys", "Remove one before adding another.");
    }

    private static async Task<IResult> Rename(
        Guid id,
        [FromBody] LocalPasskeyRenameRequest? request,
        HttpContext httpContext,
        [FromServices] LocalSecurityGuard guard,
        [FromServices] ILocalCredentials credentials)
    {
        var (account, refusal) = await guard.ResolveAsync(httpContext).ConfigureAwait(false);
        if (account is null)
        {
            return refusal!;
        }

        if (!LocalPasskeyRules.TryName(request?.Name, out var name) || request?.Name is null)
        {
            return LocalAuthProblems.Invalid(httpContext, "invalid_name", $"A name needs 1 to {LocalPasskeyRules.MaxName} characters.");
        }

        return await credentials.RenamePasskeyAsync(account.PrincipalId, id, name, httpContext.RequestAborted).ConfigureAwait(false)
            ? TypedResults.NoContent()
            : TypedResults.NotFound();
    }

    private static async Task<IResult> Remove(
        Guid id,
        [FromBody(EmptyBodyBehavior = EmptyBodyBehavior.Allow)] LocalCurrentPasswordRequest? request,
        HttpContext httpContext,
        [FromServices] LocalSecurityGuard guard,
        [FromServices] LocalReauth reauth,
        [FromServices] ILocalCredentials credentials)
    {
        var (account, refusal) = await guard.ResolveAsync(httpContext).ConfigureAwait(false);
        if (account is null)
        {
            return refusal!;
        }

        var ct = httpContext.RequestAborted;
        var all = await credentials.ListPasskeysAsync(account.PrincipalId, ct).ConfigureAwait(false);
        if (all.FirstOrDefault(p => p.Id == id) is not { } target)
        {
            return TypedResults.NotFound();
        }

        var check = await reauth.CheckAsync(account, request?.CurrentPassword, ct).ConfigureAwait(false);
        if (!check.IsOk)
        {
            return LocalReauth.Refuse(httpContext, check);
        }

        if (LocalPasskeyRules.RemovalLeavesNoSignIn(account.HasPassword, all, target))
        {
            return LocalAuthProblems.Refuse(
                httpContext,
                StatusCodes.Status409Conflict,
                "security.last_method",
                "This is your last way to sign in",
                "Set a password or add another passkey first.");
        }

        return await credentials.RemovePasskeyAsync(account.PrincipalId, id, ct).ConfigureAwait(false)
            ? TypedResults.NoContent()
            : TypedResults.NotFound();
    }

    // ---- well-known ----------------------------------------------------------------------------------------

    private static IResult WellKnown([FromServices] AuthSettings settings) =>
        LocalPasskeyRules.RelatedOriginsJson(settings) is { } json ? Json(json) : TypedResults.NotFound();

    // ---- shared --------------------------------------------------------------------------------------------

    private static async Task<LocalPasskeyRegistration?> RegisterAsync(
        LocalPasskeyCeremony ceremony,
        ILocalChallenges challenges,
        ILocalCredentials credentials,
        Guid challengeId,
        LocalChallengeKind kind,
        PrincipalId principal,
        LocalPasskeyRegistrationRequest? request,
        CancellationToken cancellationToken)
    {
        // Taking the challenge is the single-use gate, whether or not the credential then holds up.
        if (request is null
            || await challenges.TakeAsync(challengeId, kind, cancellationToken).ConfigureAwait(false) is not { State: { } state } challenge
            || challenge.PrincipalId != principal
            || LocalPasskeyCeremony.ReadAttestation(request.Credential) is not { } response)
        {
            return null;
        }

        return await ceremony.VerifyRegistrationAsync(
            CredentialCreateOptions.FromJson(state),
            response,
            async id => await credentials.FindPasskeyAsync(id, cancellationToken).ConfigureAwait(false) is null,
            cancellationToken).ConfigureAwait(false);
    }

    private static LocalPasskeyRecord ToRecord(LocalPasskeyRegistration made, AuthSettings settings, string name, TimeProvider clock) =>
        new(
            Guid.CreateVersion7(), made.CredentialId, made.PublicKey, made.SignCount, made.Aaguid, made.Transports,
            settings.PasskeyRpId ?? string.Empty, LocalPasskeyKind.Passkey, name, clock.GetUtcNow(), null);

    private static async Task<IResult> FailAsync(ILocalChallenges challenges, Guid challengeId, HttpContext httpContext)
    {
        _ = await challenges.BumpAsync(challengeId, httpContext.RequestAborted).ConfigureAwait(false);
        return LocalAuthProblems.InvalidCredentials(httpContext);
    }

    /// <summary>CSRF and availability checks every anonymous passkey route starts with.</summary>
    private static IResult? Guard(HttpContext httpContext, BrowserAuthCoordinator coordinator, LocalPasskeyCeremony ceremony)
    {
        BrowserAuthEndpoints.SetNoStore(httpContext);
        if (!BrowserAuthEndpoints.HasSameOrigin(httpContext, coordinator))
        {
            return BrowserAuthEndpoints.CsrfProblem(httpContext);
        }

        return ceremony.IsAvailable ? null : Unavailable(httpContext);
    }

    private static IResult Unavailable(HttpContext httpContext) => LocalAuthProblems.Refuse(
        httpContext,
        StatusCodes.Status503ServiceUnavailable,
        "passkeys_unavailable",
        "Passkeys are not available",
        "This install has no public origin to bind passkeys to.");

    private static string? Truncate(string? value) => value is { Length: > 2048 } ? null : value;

    private static Microsoft.AspNetCore.Http.HttpResults.ContentHttpResult Json(string json) => TypedResults.Content(json, "application/json");
}
