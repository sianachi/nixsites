using System.Data;
using System.Net;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Nix.Abstractions;
using Nix.Abstractions.Workers;
using Nix.Domain.Identity;
using Nix.Domain.Provisioning;
using Nix.Errors;
using Nix.Features.Identity;
using Nix.Http;
using Nix.Messaging;
using Nix.Persistence;

namespace Nix.Authentication;

/// <summary>
/// Turns a bearer token into a tenant-scoped unit of work, and commits it if the request succeeds.
/// </summary>
/// <remarks>
/// <para>
/// This is the seam the whole persistence design assumes and nothing previously provided. Six
/// things have to happen in order, and every one of them is load-bearing:
/// </para>
/// <list type="number">
///   <item><description>the token validates against the issuer its tenant registered;</description></item>
///   <item><description>a missing eligible external identity is bounded through UserInfo before a transaction opens;</description></item>
///   <item><description>the deterministic session context is established, once, for this scope;</description></item>
///   <item><description>a transaction is opened, which is where the interceptor publishes <c>SET LOCAL</c>.</description></item>
///   <item><description>the personal foundation is provisioned through the command seam inside that transaction, then the active principal is admitted.</description></item>
///   <item><description>the active principal is admitted to the endpoint and the transaction commits only when it succeeds.</description></item>
/// </list>
/// <para>
/// <b>Why a transaction wraps every request, including reads.</b> The tenant scope is
/// transaction-local by construction: <c>SET LOCAL</c> has no meaning outside one, and the
/// alternative - a session-scoped <c>SET</c> - leaks the tenant onto a pooled connection for
/// whoever leases it next. So a request without a transaction is a request with no tenant, which
/// row-level security answers with nothing.
/// </para>
/// <para>
/// <b>Commit only on success.</b> Anything that leaves the pipeline with a failure status, or by
/// throwing, rolls back. A write that half-happened alongside a 500 is worse than one that did not
/// happen, particularly where the write maintains a derived table.
/// </para>
/// </remarks>
public sealed class NixUnitOfWorkMiddleware(RequestDelegate next)
{
    /// <summary>Stable code for a request with no usable credentials.</summary>
    internal const string UnauthenticatedCode = AuthenticationRefusalCodes.Unauthenticated;

    /// <summary>Stable code for a principal who exists but may no longer act.</summary>
    internal const string PrincipalInactiveCode = AuthenticationRefusalCodes.PrincipalInactive;

    /// <summary>Stable code for a session whose access token has been revoked or deleted.</summary>
    internal const string TokenRevokedCode = AuthenticationRefusalCodes.TokenRevoked;

    /// <summary>Stable code for a session whose access token has passed its chosen expiry.</summary>
    internal const string TokenExpiredCode = AuthenticationRefusalCodes.TokenExpired;

    /// <summary>Stable code for a token that stands but does not reach this route.</summary>
    internal const string InsufficientScopeCode = AuthenticationRefusalCodes.InsufficientScope;

    /// <summary>Stable code for a retryable first-login provisioning failure.</summary>
    internal const string ProvisioningUnavailableCode = AuthenticationRefusalCodes.ProvisioningUnavailable;

    /// <summary>
    /// How stale <c>last_used_at</c> may be before authenticating writes it again. Coarse on
    /// purpose: the column answers "is anything still using this token", which does not need
    /// per-request precision, and a write per authenticated read would put an update on the
    /// hottest path in the system.
    /// </summary>
    private static readonly TimeSpan LastUsedGranularity = TimeSpan.FromMinutes(5);

    /// <summary>Runs the request inside a tenant-scoped unit of work.</summary>
    /// <param name="context">The request.</param>
    /// <param name="validator">Validates the bearer token.</param>
    /// <param name="directory">Resolves the principal behind it.</param>
    /// <param name="accessor">Where the session context is written, once per scope.</param>
    /// <param name="dbContext">The context whose transaction carries the scope.</param>
    /// <param name="throttle">Counts failed validations per client, so guessing meets a 429.</param>
    /// <param name="accessTokens">Re-checks the token row behind a token-authenticated session.</param>
    /// <param name="browserSessions">Re-checks Core-owned interactive browser sessions.</param>
    /// <param name="scopeContext">Carries the validated Core access-token scope ceiling.</param>
    /// <param name="userInfo">Reads bounded claims only for an eligible missing external principal.</param>
    /// <param name="clock">Judges token expiry and stamps last use.</param>
    /// <param name="dispatcher">Dispatches first-login provisioning inside this transaction.</param>
    /// <param name="logger">Where a refusal is recorded.</param>
    /// <returns>A task that completes when the request has been handled.</returns>
    public async Task InvokeAsync(
        HttpContext context,
        NixTokenValidator validator,
        IIdentityDirectory directory,
        ScopedNixSessionContextAccessor accessor,
        NixDbContext dbContext,
        FailedAuthenticationThrottle throttle,
        IPersonalAccessTokens accessTokens,
        IBrowserSessions browserSessions,
        IWorkerDispatchStore workerDispatch,
        AccessTokenSessionContext scopeContext,
        CredentialSessionContext credentialContext,
        IUserInfoClient userInfo,
        NixDispatcher dispatcher,
        TimeProvider clock,
        ILogger<NixUnitOfWorkMiddleware> logger)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(validator);
        ArgumentNullException.ThrowIfNull(directory);
        ArgumentNullException.ThrowIfNull(accessor);
        ArgumentNullException.ThrowIfNull(dbContext);
        ArgumentNullException.ThrowIfNull(throttle);
        ArgumentNullException.ThrowIfNull(accessTokens);
        ArgumentNullException.ThrowIfNull(browserSessions);
        ArgumentNullException.ThrowIfNull(workerDispatch);
        ArgumentNullException.ThrowIfNull(scopeContext);
        ArgumentNullException.ThrowIfNull(credentialContext);
        ArgumentNullException.ThrowIfNull(userInfo);
        ArgumentNullException.ThrowIfNull(dispatcher);
        ArgumentNullException.ThrowIfNull(clock);
        ArgumentNullException.ThrowIfNull(logger);

        var token = ReadBearerToken(context.Request);
        if (token is null)
        {
            await WriteProblemAsync(
                context,
                StatusCodes.Status401Unauthorized,
                UnauthenticatedCode,
                "Not authenticated",
                "This endpoint requires a bearer token issued by a registered identity provider.")
                .ConfigureAwait(false);
            return;
        }

        // The throttle covers requests that present a token, because a presented token is a guess.
        // A request with no token at all took no shot at the oracle and keeps its plain 401 above,
        // so a misconfigured client that lost its token cannot throttle its own address into
        // opacity. Keyed by remote address: it is what a pre-authentication surface has, and the
        // limit is generous enough that people behind one NAT retrying honest failures never meet
        // it. That address is the originating client's only because UseForwardedHeaders runs first
        // and rewrites it from a trusted proxy's X-Forwarded-For; without that, every request
        // behind the proxy shares one window and this throttle is global. Checked before
        // validating, so a client already over the limit costs no signature verification.
        var clientKey = ClientKey.For(context);
        if (throttle.IsThrottled(clientKey, out var retryAfter))
        {
            // Information, not Warning: the crossing was already logged at Warning below, and the
            // refusals that follow it are the same fact repeated once per request in the scan.
            await RateLimitRefusal.WriteAsync(
                context,
                logger,
                RateLimitRefusal.FailedAuthenticationLimiterName,
                retryAfter,
                LogLevel.Information,
                context.RequestAborted).ConfigureAwait(false);
            return;
        }

        var validated = await validator.ValidateAsync(token, context.RequestAborted).ConfigureAwait(false);
        if (validated is null)
        {
            RecordFailure(throttle, logger, context, clientKey);
            await WriteProblemAsync(
                context,
                StatusCodes.Status401Unauthorized,
                UnauthenticatedCode,
                "Not authenticated",
                "The token could not be validated against a registered issuer.")
                .ConfigureAwait(false);
            return;
        }

        if (validated is ValidatedWorkerExecutionToken workerDelegation
            && !WorkerExportDelegationPolicy.Allows(context.Request, workerDelegation, execution: null))
        {
            await WriteProblemAsync(
                context,
                StatusCodes.Status403Forbidden,
                InsufficientScopeCode,
                "Worker delegation is read-only",
                "This worker execution token can only read metadata needed for its export.")
                .ConfigureAwait(false);
            return;
        }

        var principal = validated switch
        {
            ValidatedCoreToken core => await directory.FindPrincipalByIdAsync(
                core.TenantId,
                core.PrincipalId,
                context.RequestAborted).ConfigureAwait(false),
            ValidatedExternalToken external => await directory.FindExternalPrincipalAsync(
                external.TenantId,
                external.Registration.Issuer,
                external.Subject,
                context.RequestAborted).ConfigureAwait(false),
            ValidatedBrowserSessionToken browser => await directory.FindPrincipalByIdAsync(
                browser.TenantId,
                browser.PrincipalId,
                context.RequestAborted).ConfigureAwait(false),
            ValidatedWorkerExecutionToken worker => await directory.FindPrincipalByIdAsync(
                worker.TenantId,
                worker.PrincipalId,
                context.RequestAborted).ConfigureAwait(false),
            _ => throw new InvalidOperationException("Unknown validated token kind."),
        };

        if (validated is ValidatedBrowserSessionToken browserToken)
        {
            var browserSession = await browserSessions
                .FindByIdAsync(browserToken.BrowserSessionId, context.RequestAborted)
                .ConfigureAwait(false);
            if (browserSession is null
                || browserSession.TenantId != browserToken.TenantId
                || browserSession.PrincipalId != browserToken.PrincipalId)
            {
                await WriteProblemAsync(
                    context,
                    StatusCodes.Status401Unauthorized,
                    TokenRevokedCode,
                    "Session ended",
                    "This browser session has ended. Sign in again.").ConfigureAwait(false);
                return;
            }
        }

        UserInfoProfile? provisioningProfile = null;
        ValidatedExternalToken? provisioningToken = null;
        if (principal is null && validated is ValidatedExternalToken externalToken
            && JitProvisioningPolicy.EligibleRegistration(externalToken) is { } authorizedParty)
        {
            try
            {
                provisioningProfile = await userInfo.ReadAsync(
                    authorizedParty.UserInfoUri!,
                    authorizedParty.Issuer,
                    token,
                    externalToken.Subject,
                    context.RequestAborted).ConfigureAwait(false);
                provisioningToken = externalToken;
            }
            catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
            {
                throw;
            }
            catch (UserInfoUnavailableException exception)
            {
                await WriteProvisioningUnavailableAsync(context, logger, exception.Category, authorizedParty.ProviderId.Value.ToString()).ConfigureAwait(false);
                return;
            }
        }

        if (principal is null && provisioningToken is null)
        {
            // A valid token for a subject nobody provisioned. This lookup never creates one: the
            // dedicated JIT path may do so only for an exact authorized-party registration whose
            // stored policy enables it. A token alone must never mint an identity. The miss also
            // counts against the throttle - enumerating subjects is a guessing loop too.
            if (validated is ValidatedExternalToken refusedExternal)
            {
                var (reason, providerId) = JitAdmissionRefusal(refusedExternal);
                ApiLog.JitAdmissionRefused(
                    logger,
                    context.Request.Path.Value ?? string.Empty,
                    reason,
                    providerId);
            }

            RecordFailure(throttle, logger, context, clientKey);
            await WriteProblemAsync(
                context,
                StatusCodes.Status401Unauthorized,
                UnauthenticatedCode,
                "Not authenticated",
                "The token's subject is not provisioned in this tenant.")
                .ConfigureAwait(false);
            return;
        }

        if (principal is not null && principal.Status != PrincipalStatus.Active)
        {
            // Checked on every request rather than at sign-in, because an access token outlives the
            // decision to revoke it. This is what makes deprovisioning take effect immediately
            // instead of whenever the current token happens to expire.
            await WriteProblemAsync(
                context,
                StatusCodes.Status403Forbidden,
                PrincipalInactiveCode,
                "Account is not active",
                "This account has been suspended or deprovisioned.")
                .ConfigureAwait(false);
            return;
        }

        WorkerExecutionAuthorization? authorizedWorkerExecution = null;
        if (validated is ValidatedWorkerExecutionToken workerToken)
        {
            var execution = await workerDispatch.AuthorizeExecutionAsync(
                workerToken.JobId,
                workerToken.ExecutionId,
                context.RequestAborted).ConfigureAwait(false);
            if (execution is null
                || execution.TenantId != workerToken.TenantId.Value
                || execution.ActorId != workerToken.PrincipalId.Value
                || !WorkerExportDelegationPolicy.Delegates(execution.Kind)
                || !WorkerExportDelegationPolicy.Allows(context.Request, workerToken, execution))
            {
                await WriteProblemAsync(
                    context,
                    StatusCodes.Status401Unauthorized,
                    TokenRevokedCode,
                    "Worker delegation ended",
                    "The worker execution that delegated this request no longer owns its lease.")
                    .ConfigureAwait(false);
                return;
            }
            authorizedWorkerExecution = execution;

            // Collaboration asks Core whether the delegated actor may write while it establishes
            // the export. Keep that downstream answer read-only too; otherwise a GET-only token
            // could still acquire a writable collaboration session from the authorization reply.
            scopeContext.SetTokenCeiling(mayWrite: false, mayAdminister: false);
        }

        var scopedPrincipalId = principal?.Id
            ?? DeterministicProvisioningId.Principal(
                provisioningToken!.TenantId,
                provisioningToken.Registration.Issuer,
                provisioningToken.Subject);
        accessor.Set(NixSessionContext.ForTenant(validated.TenantId, scopedPrincipalId));

        // The credential an item unlock is issued to and checked against. Only the two a person
        // holds and can revoke: a worker delegation or a raw external token gets no grant, so a
        // locked body stays closed to it.
        switch (validated)
        {
            case ValidatedBrowserSessionToken browserCredential:
                credentialContext.Set(browserCredential.BrowserSessionId.Value);
                break;
            case ValidatedCoreToken tokenCredential:
                credentialContext.Set(tokenCredential.AccessTokenId.Value);
                break;
        }

        var captureSnapshot = context.Request.Path.Value is { } requestPath
            && (requestPath.Contains("/templates/capture-preview/", StringComparison.OrdinalIgnoreCase)
                || requestPath.Equals("/internal/templates/captures/begin", StringComparison.OrdinalIgnoreCase));
        var transaction = await dbContext.Database
            .BeginTransactionAsync(
                captureSnapshot ? IsolationLevel.RepeatableRead : IsolationLevel.ReadCommitted,
                context.RequestAborted)
            .ConfigureAwait(false);

        await using (transaction.ConfigureAwait(false))
        {
            if (principal is null)
            {
                try
                {
                    var provisioned = await dispatcher.SendAsync<ProvisionPersonalWorkspace, AuthenticatedPrincipal>(
                        new ProvisionPersonalWorkspace(
                            provisioningToken!.TenantId,
                            provisioningToken.Registration.Issuer,
                            provisioningToken.Subject,
                            provisioningProfile!),
                        context.RequestAborted).ConfigureAwait(false);
                    principal = provisioned.IsSuccess
                        ? provisioned.Value
                        : throw new PersonalWorkspaceProvisioningInvariantException();
                }
                catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception exception) when (exception is UserInfoUnavailableException
                    or DbUpdateException
                    or Npgsql.NpgsqlException
                    or PersonalWorkspaceProvisioningInvariantException)
                {
                    await transaction.RollbackAsync(context.RequestAborted).ConfigureAwait(false);
                    var category = exception is UserInfoUnavailableException unavailable
                        ? unavailable.Category
                        : exception is PersonalWorkspaceProvisioningInvariantException
                            ? ProvisioningFailureCategory.Invariant
                            : ProvisioningFailureCategory.Database;
                    await WriteProvisioningUnavailableAsync(
                        context,
                        logger,
                        category,
                        provisioningToken!.Registration.ProviderId.Value.ToString()).ConfigureAwait(false);
                    return;
                }

                if (principal.Id != scopedPrincipalId || principal.TenantId != validated.TenantId)
                {
                    await transaction.RollbackAsync(context.RequestAborted).ConfigureAwait(false);
                    await WriteProvisioningUnavailableAsync(
                        context,
                        logger,
                        ProvisioningFailureCategory.Invariant,
                        provisioningToken!.Registration.ProviderId.Value.ToString()).ConfigureAwait(false);
                    return;
                }

                if (principal.Status != PrincipalStatus.Active)
                {
                    await transaction.RollbackAsync(context.RequestAborted).ConfigureAwait(false);
                    await WriteProblemAsync(
                        context,
                        StatusCodes.Status403Forbidden,
                        PrincipalInactiveCode,
                        "Account is not active",
                        "This account has been suspended or deprovisioned.").ConfigureAwait(false);
                    return;
                }
            }

            // A token-authenticated session re-checks its row on every request, inside the
            // transaction that just published the tenant scope. This is what makes revocation
            // immediate rather than "when the ten-minute JWT runs out", and it is where the
            // scope ceiling is applied - before the endpoint, after the transaction, so a
            // refused request rolls back like any other failure.
            if (validated is ValidatedCoreToken core)
            {
                var admitted = await EnforceAccessTokenAsync(
                    context,
                    accessTokens,
                    scopeContext,
                    clock,
                    core.AccessTokenId,
                    principal.Id)
                    .ConfigureAwait(false);

                if (!admitted)
                {
                    await transaction.RollbackAsync(context.RequestAborted).ConfigureAwait(false);
                    return;
                }
            }

            if (validated is ValidatedWorkerExecutionToken boundedWorker
                && (authorizedWorkerExecution is null
                    || !await WorkerExportDelegationPolicy.AuthorizesTargetAsync(
                        context.Request,
                        boundedWorker,
                        authorizedWorkerExecution,
                        dbContext,
                        context.RequestAborted).ConfigureAwait(false)))
            {
                await transaction.RollbackAsync(context.RequestAborted).ConfigureAwait(false);
                await WriteProblemAsync(
                    context,
                    StatusCodes.Status403Forbidden,
                    InsufficientScopeCode,
                    "Worker delegation is outside its export root",
                    "This worker execution token cannot read metadata outside its signed export boundary.")
                    .ConfigureAwait(false);
                return;
            }

            // Inline writing streams a read-only provider response; hold finite responses until commit.
            var streaming = context.GetEndpoint()?.Metadata.GetOrderedMetadata<IProducesResponseTypeMetadata>()
                .Any(static metadata => metadata.ContentTypes.Contains("text/event-stream", StringComparer.OrdinalIgnoreCase)) == true;
            var originalBody = context.Response.Body;
            using var bufferedBody = streaming ? null : BufferedResponse.Create();
            if (bufferedBody is not null)
            {
                context.Response.Body = bufferedBody;
            }
            try
            {
                await next(context).ConfigureAwait(false);

                if (context.Response.StatusCode >= StatusCodes.Status400BadRequest)
                {
                    await transaction.RollbackAsync(context.RequestAborted).ConfigureAwait(false);
                }
                else if (validated is ValidatedWorkerExecutionToken endingWorker
                    && await workerDispatch.AuthorizeExecutionAsync(
                        endingWorker.JobId,
                        endingWorker.ExecutionId,
                        context.RequestAborted).ConfigureAwait(false) is null)
                {
                    await transaction.RollbackAsync(context.RequestAborted).ConfigureAwait(false);
                    context.Response.Body = originalBody;
                    context.Response.Clear();
                    await WriteProblemAsync(
                        context,
                        StatusCodes.Status403Forbidden,
                        InsufficientScopeCode,
                        "Worker delegation expired",
                        "This worker execution no longer owns a live delegation.").ConfigureAwait(false);
                    return;
                }
                else
                {
                    await transaction.CommitAsync(context.RequestAborted).ConfigureAwait(false);
                }

                if (bufferedBody is not null)
                {
                    await BufferedResponse.PublishAsync(context, bufferedBody, originalBody).ConfigureAwait(false);
                }
            }
            finally
            {
                context.Response.Body = originalBody;
            }
        }
    }

    private static (string Reason, string ProviderId) JitAdmissionRefusal(
        ValidatedExternalToken token)
    {
        var authorizedParty = token.AuthorizedPartyRegistration;
        if (authorizedParty is null)
        {
            return (
                token.HasAuthorizedPartyClaim
                    ? "authorized_party_not_registered"
                    : "authorized_party_claim_missing",
                token.Registration.ProviderId.Value.ToString());
        }

        if (!authorizedParty.JitProvisioningEnabled)
        {
            return ("jit_disabled", authorizedParty.ProviderId.Value.ToString());
        }

        return ("userinfo_not_configured", authorizedParty.ProviderId.Value.ToString());
    }

    private static async Task WriteProvisioningUnavailableAsync(
        HttpContext context,
        ILogger logger,
        ProvisioningFailureCategory category,
        string providerId)
    {
        const int retryAfterSeconds = 5;
        context.Response.Headers.RetryAfter = retryAfterSeconds.ToString(
            System.Globalization.CultureInfo.InvariantCulture);
        ApiLog.ProvisioningUnavailable(
            logger,
            context.Request.Path.Value ?? string.Empty,
            category.ToString(),
            providerId);
        await WriteProblemAsync(
            context,
            StatusCodes.Status503ServiceUnavailable,
            ProvisioningUnavailableCode,
            "Provisioning temporarily unavailable",
            "Nix could not safely complete first-login provisioning. Retry this request.")
            .ConfigureAwait(false);
    }

    /// <summary>
    /// Re-judges a token-authenticated session against its row: standing, unexpired, held by the
    /// resolved principal, and scoped to reach this route.
    /// </summary>
    /// <param name="context">The current request.</param>
    /// <param name="accessTokens">Reads and touches the row.</param>
    /// <param name="clock">Judges expiry and stamps last use.</param>
    /// <param name="accessTokenId">The row the validated JWT names.</param>
    /// <param name="principalId">The principal the session resolved to.</param>
    /// <returns>Whether the request may proceed. A refusal has already been written.</returns>
    private static async Task<bool> EnforceAccessTokenAsync(
        HttpContext context,
        IPersonalAccessTokens accessTokens,
        AccessTokenSessionContext scopeContext,
        TimeProvider clock,
        PersonalAccessTokenId accessTokenId,
        PrincipalId principalId)
    {
        var state = await accessTokens
            .FindSessionStateAsync(accessTokenId, context.RequestAborted)
            .ConfigureAwait(false);

        // A deleted row and a row belonging to a different principal answer identically: the JWT
        // is signed by us and both claims came from one mint, so a mismatch is a defect or a
        // forgery, and neither deserves a more detailed answer than "this token no longer works".
        if (state is null || state.PrincipalId != principalId)
        {
            await WriteProblemAsync(
                context,
                StatusCodes.Status401Unauthorized,
                TokenRevokedCode,
                "Access token no longer valid",
                $"Personal access token '{accessTokenId}' no longer authenticates requests. "
                + "Issue a new token from your settings.")
                .ConfigureAwait(false);
            return false;
        }

        if (state.RevokedAt is { } revokedAt)
        {
            await WriteProblemAsync(
                context,
                StatusCodes.Status401Unauthorized,
                TokenRevokedCode,
                "Access token revoked",
                $"Personal access token '{accessTokenId}' was revoked at {revokedAt:O}.")
                .ConfigureAwait(false);
            return false;
        }

        var now = clock.GetUtcNow();
        if (state.ExpiresAt <= now)
        {
            await WriteProblemAsync(
                context,
                StatusCodes.Status401Unauthorized,
                TokenExpiredCode,
                "Access token expired",
                $"Personal access token '{accessTokenId}' expired at {state.ExpiresAt:O}.")
                .ConfigureAwait(false);
            return false;
        }

        var requirement = AccessTokenScopePolicy.Classify(context.Request.Method, context.Request.Path);
        if (!AccessTokenScopePolicy.Satisfies(state.Scopes, requirement))
        {
            // 403, not 401: the session authenticated. The detail names the principal their own
            // identity and the scope the route wanted, which is the honest refusal MVP-9.4 asks
            // for and discloses nothing the caller does not already hold.
            await WriteProblemAsync(
                context,
                StatusCodes.Status403Forbidden,
                InsufficientScopeCode,
                "Access token out of scope",
                $"Principal '{principalId}' is authenticated, but personal access token "
                + $"'{accessTokenId}' does not reach {context.Request.Method} "
                + $"{context.Request.Path}: it requires {AccessTokenScopePolicy.Describe(requirement)}.")
                .ConfigureAwait(false);
            return false;
        }

        // Record the ceiling for the surfaces Core reports about rather than acts for. The
        // route-level check above closed every endpoint Core owns; this is what carries the same
        // ceiling into GetItemAuthorization's CanWrite, so a read-only token cannot have the
        // collaboration service write a body on its behalf.
        scopeContext.SetTokenCeiling(
            mayWrite: AccessTokenScopePolicy.Satisfies(state.Scopes, AccessTokenScopePolicy.Requirement.Write),
            mayAdminister: AccessTokenScopePolicy.Satisfies(state.Scopes, AccessTokenScopePolicy.Requirement.Admin));

        // The watch long-poll can hold this request open for up to 20 s. Touching last_used_at
        // would hold ExecuteUpdateAsync's row lock on the token for that whole wait, which stalls
        // every other request authenticating with the same token behind it. Skip the touch here;
        // the same token still gets touched by the requests that follow the long poll.
        var isWatchLongPoll = HttpMethods.IsGet(context.Request.Method)
            && (context.Request.Path.StartsWithSegments("/api/v1/me/pets/runtime/watch", StringComparison.OrdinalIgnoreCase)
                || context.Request.Path.StartsWithSegments("/api/v1/me/pets/runtime/note/watch", StringComparison.OrdinalIgnoreCase)
                || context.Request.Path.StartsWithSegments("/api/v1/me/notifications/watch", StringComparison.OrdinalIgnoreCase));
        if (!isWatchLongPoll && (state.LastUsedAt is null || now - state.LastUsedAt >= LastUsedGranularity))
        {
            await accessTokens.TouchAsync(accessTokenId, now, context.RequestAborted).ConfigureAwait(false);
        }

        return true;
    }

    private static void RecordFailure(
        FailedAuthenticationThrottle throttle,
        ILogger logger,
        HttpContext context,
        IPAddress clientKey)
    {
        if (!throttle.RecordFailure(clientKey))
        {
            return;
        }

        // The failure that reached the limit is still answered with a 401; what changes is that
        // every later request from this address is refused without a validation. That transition is
        // the operator-visible event, so it is logged once, here, at Warning.
        throttle.IsThrottled(clientKey, out var window);
        ApiLog.FailedAuthenticationLimitReached(
            logger,
            clientKey,
            context.Request.Path.Value ?? string.Empty,
            Math.Max(1L, (long)Math.Ceiling(window.TotalSeconds)));
    }

    private static string? ReadBearerToken(HttpRequest request)
    {
        const string prefix = "Bearer ";
        var header = request.Headers.Authorization.ToString();

        return header.Equals("Bearer", StringComparison.OrdinalIgnoreCase)
            ? string.Empty
            : header.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
                ? header[prefix.Length..].Trim()
                : null;
    }

    private static async Task WriteProblemAsync(
        HttpContext context,
        int status,
        string code,
        string title,
        string detail)
    {
        var problem = ApiProblem.Create(context, status, code, title, detail);
        context.Response.StatusCode = status;

        // The content type must ride the write call: the two-argument WriteAsJsonAsync overload
        // stamps application/json over anything set on the response beforehand.
        await context.Response
            .WriteAsJsonAsync(problem, options: null, "application/problem+json", context.RequestAborted)
            .ConfigureAwait(false);
    }
}
