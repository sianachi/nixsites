using System.Buffers.Text;
using System.Globalization;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Provisioning;
using Nix.Features.Identity;
using Nix.Messaging;
using Nix.Persistence;

namespace Nix.Authentication;

/// <summary>Owns the server side of interactive OIDC and Core browser sessions.</summary>
public sealed class BrowserAuthCoordinator(
    IOptions<BrowserAuthOptions> options,
    OidcMetadataClient metadata,
    IHttpClientFactory clientFactory,
    IDataProtectionProvider dataProtection,
    NixTokenValidator validator,
    IIdentityDirectory identity,
    IUserInfoClient userInfo,
    ScopedNixSessionContextAccessor sessionContext,
    NixDbContext database,
    NixDispatcher dispatcher,
    IBrowserSessions sessions,
    SelfIssuedTokenService tokens,
    TimeProvider clock)
{
    /// <summary>The opaque HttpOnly session cookie.</summary>
    private const string SecureSessionCookieName = "__Host-nix_session";

    /// <summary>The protected, short-lived OIDC transaction cookie.</summary>
    // __Host-, so the browser keeps it host-only with Path=/: when user sites are served below the
    // app's own apex (Nix:Sites:SharedAppDomain), no site can set or shadow it for the callback.
    private const string SecureLoginCookieName = "__Host-nix_oidc";

    private const int MaximumTokenResponseBytes = 32 * 1024;
    private static readonly TimeSpan ProviderDeadline = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan LoginLifetime = TimeSpan.FromMinutes(10);
    private readonly JwtSecurityTokenHandler _jwt = new() { MapInboundClaims = false };

    private readonly BrowserAuthOptions _options = options.Value;
    private readonly OidcMetadataClient _metadata = metadata;
    private readonly IHttpClientFactory _clientFactory = clientFactory;
    private readonly IDataProtector _stateProtector = dataProtection.CreateProtector("Nix.Bff.OidcState.v1");
    private readonly NixTokenValidator _validator = validator;
    private readonly IIdentityDirectory _identity = identity;
    private readonly IUserInfoClient _userInfo = userInfo;
    private readonly ScopedNixSessionContextAccessor _sessionContext = sessionContext;
    private readonly NixDbContext _database = database;
    private readonly NixDispatcher _dispatcher = dispatcher;
    private readonly IBrowserSessions _sessions = sessions;
    private readonly SelfIssuedTokenService _tokens = tokens;
    private readonly TimeProvider _clock = clock;

    /// <summary>Whether the deployment can begin an interactive login.</summary>
    public bool IsConfigured => _options.IsConfigured && _tokens.IsConfigured;

    /// <summary>The deployment-appropriate session cookie name.</summary>
    public string SessionCookieName => SecureCookies ? SecureSessionCookieName : "nix_session";

    /// <summary>The deployment-appropriate OIDC transaction cookie name.</summary>
    public string LoginCookieName => SecureCookies ? SecureLoginCookieName : "nix_oidc";

    /// <summary>Whether cookies must carry Secure in this deployment.</summary>
    public bool SecureCookies => _options.TryPublicOrigin(out var origin) && origin.Scheme == Uri.UriSchemeHttps;

    /// <summary>The configured same-origin application URL, when valid.</summary>
    public Uri? PublicOrigin => _options.TryPublicOrigin(out var origin) ? origin : null;

    /// <summary>The provider's self-service account page, when one is configured and safe.</summary>
    public Uri? AccountPage => _options.TryAccountPage(out var account) ? account : null;

    /// <summary>Creates a protected PKCE transaction and the provider redirect.</summary>
    public async ValueTask<BrowserLoginStart> BeginAsync(
        string? requestedReturnTo,
        CancellationToken cancellationToken)
    {
        AssertConfigured();
        var metadata = await _metadata.GetAsync(cancellationToken).ConfigureAwait(false);
        var state = RandomValue();
        var nonce = RandomValue();
        var verifier = RandomValue();
        var challenge = Base64Url.EncodeToString(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
        var returnTo = SafeReturnTo(requestedReturnTo);
        var issued = _clock.GetUtcNow();
        var payload = string.Join(
            '\n',
            state,
            nonce,
            verifier,
            issued.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture),
            Convert.ToBase64String(Encoding.UTF8.GetBytes(returnTo)));

        var query = QueryString.Create(
        [
            new KeyValuePair<string, string?>("client_id", _options.ClientId),
            new KeyValuePair<string, string?>("redirect_uri", _options.CallbackUri.AbsoluteUri),
            new KeyValuePair<string, string?>("response_type", "code"),
            new KeyValuePair<string, string?>("scope", "openid profile email"),
            new KeyValuePair<string, string?>("state", state),
            new KeyValuePair<string, string?>("nonce", nonce),
            new KeyValuePair<string, string?>("code_challenge", challenge),
            new KeyValuePair<string, string?>("code_challenge_method", "S256"),
        ]);

        return new BrowserLoginStart(
            new Uri(metadata.AuthorizationEndpoint.AbsoluteUri + query, UriKind.Absolute),
            _stateProtector.Protect(payload),
            issued + LoginLifetime);
    }

    /// <summary>Exchanges the callback code, performs JIT and creates the browser session.</summary>
    public async ValueTask<BrowserLoginCompletion> CompleteAsync(
        string code,
        string returnedState,
        string protectedState,
        CancellationToken cancellationToken)
    {
        AssertConfigured();
        var login = ReadState(protectedState, returnedState);
        var metadata = await _metadata.GetAsync(cancellationToken).ConfigureAwait(false);
        var oidcTokens = await ExchangeAsync(metadata.TokenEndpoint, code, login.Verifier, cancellationToken)
            .ConfigureAwait(false);

        var id = await _validator.ValidateAsync(oidcTokens.IdToken, cancellationToken).ConfigureAwait(false)
            as ValidatedExternalToken
            ?? throw new BrowserAuthException(BrowserAuthFailure.InvalidProviderResponse);
        var access = await _validator.ValidateAsync(oidcTokens.AccessToken, cancellationToken).ConfigureAwait(false)
            as ValidatedExternalToken
            ?? throw new BrowserAuthException(BrowserAuthFailure.InvalidProviderResponse);
        var registration = await _identity
            .ResolveProviderAsync(metadata.Issuer.AbsoluteUri.TrimEnd('/'), _options.ClientId, cancellationToken)
            .ConfigureAwait(false)
            ?? throw new BrowserAuthException(BrowserAuthFailure.ProviderNotRegistered);

        if (id.TenantId != registration.TenantId
            || access.TenantId != registration.TenantId
            || !string.Equals(id.Subject, access.Subject, StringComparison.Ordinal)
            || !HasNonce(oidcTokens.IdToken, login.Nonce))
        {
            throw new BrowserAuthException(BrowserAuthFailure.InvalidProviderResponse);
        }

        var profile = await _userInfo.ReadAsync(
            registration.UserInfoUri
                ?? throw new BrowserAuthException(BrowserAuthFailure.UserInfoNotConfigured),
            registration.Issuer,
            oidcTokens.AccessToken,
            access.Subject,
            cancellationToken).ConfigureAwait(false);
        var existing = await _identity.FindExternalPrincipalAsync(
            registration.TenantId,
            registration.Issuer,
            access.Subject,
            cancellationToken).ConfigureAwait(false);
        if (existing is null && !registration.JitProvisioningEnabled)
        {
            throw new BrowserAuthException(BrowserAuthFailure.JitDisabled);
        }

        if (existing is { Status: not PrincipalStatus.Active })
        {
            throw new BrowserAuthException(BrowserAuthFailure.PrincipalInactive);
        }

        var principalId = existing?.Id
            ?? DeterministicProvisioningId.Principal(
                registration.TenantId,
                registration.Issuer,
                access.Subject);
        var secret = BrowserSessionSecret.Mint();
        var now = _clock.GetUtcNow();
        var session = new BrowserSession
        {
            Id = BrowserSessionId.Create(),
            TenantId = registration.TenantId,
            PrincipalId = principalId,
            TokenHash = secret.Hash,
            CreatedAt = now,
            ExpiresAt = now + TimeSpan.FromHours(Math.Clamp(_options.SessionHours, 1, 24)),
        };

        _sessionContext.Set(NixSessionContext.ForTenant(registration.TenantId, principalId));
        var transaction = await _database.Database.BeginTransactionAsync(cancellationToken).ConfigureAwait(false);
        await using (transaction.ConfigureAwait(false))
        {
            var completed = await _dispatcher.SendAsync<CompleteBrowserSignIn, CompletedBrowserSignIn>(
                new CompleteBrowserSignIn(
                    registration.TenantId,
                    registration.Issuer,
                    access.Subject,
                    profile,
                    existing,
                    session),
                cancellationToken).ConfigureAwait(false);
            if (completed.IsFailure)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                throw new BrowserAuthException(BrowserAuthFailure.ProvisioningFailed);
            }

            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return new BrowserLoginCompletion(
                secret.Token,
                session.ExpiresAt,
                login.ReturnTo,
                completed.Value.Principal);
        }
    }

    /// <summary>Resolves the opaque cookie without exposing it beyond this boundary.</summary>
    public ValueTask<AuthenticatedBrowserSession?> ResolveAsync(
        string? cookie,
        CancellationToken cancellationToken) =>
        string.IsNullOrWhiteSpace(cookie) || cookie.Length > 128
            || !cookie.StartsWith(BrowserSessionSecret.Prefix, StringComparison.Ordinal)
            ? ValueTask.FromResult<AuthenticatedBrowserSession?>(null)
            : _sessions.FindByTokenHashAsync(BrowserSessionSecret.Hash(cookie), cancellationToken);

    /// <summary>Mints a short-lived Core JWT for a standing browser session.</summary>
    public string MintAccessToken(AuthenticatedBrowserSession session)
    {
        ArgumentNullException.ThrowIfNull(session);
        return _tokens.MintBrowserSession(session.PrincipalId, session.TenantId, session.Id);
    }

    /// <summary>Revokes one resolved session inside a tenant transaction.</summary>
    public async ValueTask RevokeAsync(
        AuthenticatedBrowserSession session,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(session);
        _sessionContext.Set(NixSessionContext.ForTenant(session.TenantId, session.PrincipalId));
        var transaction = await _database.Database.BeginTransactionAsync(cancellationToken).ConfigureAwait(false);
        await using (transaction.ConfigureAwait(false))
        {
            await _sessions.RevokeAsync(session.Id, _clock.GetUtcNow(), cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        }
    }

    private async ValueTask<OidcTokenPair> ExchangeAsync(
        Uri endpoint,
        string code,
        string verifier,
        CancellationToken cancellationToken)
    {
        using var body = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "authorization_code",
            ["client_id"] = _options.ClientId,
            ["code"] = code,
            ["redirect_uri"] = _options.CallbackUri.AbsoluteUri,
            ["code_verifier"] = verifier,
        });
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint) { Content = body };
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(ProviderDeadline);
        try
        {
            using var client = _clientFactory.CreateClient(BrowserAuthOptions.HttpClientName);
            using var response = await client
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token)
                .ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                throw new BrowserAuthException(BrowserAuthFailure.TokenExchangeFailed);
            }

            var bytes = await BoundedHttpContent
                .ReadAsync(response.Content, MaximumTokenResponseBytes, deadline.Token)
                .ConfigureAwait(false);
            using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 8 });
            return new OidcTokenPair(
                RequiredString(document.RootElement, "access_token"),
                RequiredString(document.RootElement, "id_token"));
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new BrowserAuthException(BrowserAuthFailure.TokenExchangeFailed);
        }
        catch (Exception exception) when (
            exception is HttpRequestException or IOException or InvalidDataException or JsonException)
        {
            throw new BrowserAuthException(BrowserAuthFailure.TokenExchangeFailed);
        }
    }

    private BrowserLoginState ReadState(string protectedState, string returnedState)
    {
        try
        {
            var parts = _stateProtector.Unprotect(protectedState).Split('\n');
            if (parts.Length != 5
                || !FixedEquals(parts[0], returnedState)
                || !long.TryParse(parts[3], NumberStyles.None, CultureInfo.InvariantCulture, out var issuedSeconds))
            {
                throw new BrowserAuthException(BrowserAuthFailure.InvalidState);
            }

            var issued = DateTimeOffset.FromUnixTimeSeconds(issuedSeconds);
            var now = _clock.GetUtcNow();
            if (issued > now || now - issued > LoginLifetime)
            {
                throw new BrowserAuthException(BrowserAuthFailure.InvalidState);
            }

            var returnTo = Encoding.UTF8.GetString(Convert.FromBase64String(parts[4]));
            return new BrowserLoginState(parts[1], parts[2], SafeReturnTo(returnTo));
        }
        catch (Exception exception) when (exception is CryptographicException or FormatException)
        {
            throw new BrowserAuthException(BrowserAuthFailure.InvalidState);
        }
    }

    private bool HasNonce(string idToken, string expected)
    {
        try
        {
            return FixedEquals(_jwt.ReadJwtToken(idToken).Claims.FirstOrDefault(
                static claim => claim.Type == "nonce")?.Value, expected);
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    private void AssertConfigured()
    {
        if (!IsConfigured)
        {
            throw new BrowserAuthException(BrowserAuthFailure.NotConfigured);
        }
    }

    private static string RequiredString(JsonElement root, string name) =>
        root.TryGetProperty(name, out var property)
        && property.ValueKind == JsonValueKind.String
        && property.GetString() is { Length: > 0 } value
            ? value
            : throw new BrowserAuthException(BrowserAuthFailure.InvalidProviderResponse);

    private static string RandomValue() =>
        Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));

    private static bool FixedEquals(string? left, string right)
    {
        if (left is null)
        {
            return false;
        }

        var leftBytes = Encoding.UTF8.GetBytes(left);
        var rightBytes = Encoding.UTF8.GetBytes(right);
        return leftBytes.Length == rightBytes.Length
            && CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
    }

    private static string SafeReturnTo(string? value) => ReturnToPath.Sanitize(value);

    private sealed record OidcTokenPair(string AccessToken, string IdToken);

    private sealed record BrowserLoginState(string Nonce, string Verifier, string ReturnTo);
}

/// <summary>The provider redirect and protected login transaction.</summary>
public sealed record BrowserLoginStart(Uri RedirectUri, string ProtectedState, DateTimeOffset ExpiresAt);

/// <summary>The local browser session produced by a successful callback.</summary>
public sealed record BrowserLoginCompletion(
    string CookieToken,
    DateTimeOffset ExpiresAt,
    string ReturnTo,
    AuthenticatedPrincipal Principal);

/// <summary>Closed, non-sensitive browser authentication failure categories.</summary>
public enum BrowserAuthFailure
{
    NotConfigured,
    InvalidState,
    TokenExchangeFailed,
    InvalidProviderResponse,
    ProviderNotRegistered,
    UserInfoNotConfigured,
    JitDisabled,
    PrincipalInactive,
    ProvisioningFailed,
}

/// <summary>A safe expected browser authentication refusal.</summary>
#pragma warning disable CA1032 // Justification: this internal exception only carries a closed, non-sensitive failure category.
internal sealed class BrowserAuthException(BrowserAuthFailure failure) : Exception
{
    /// <summary>The closed failure category safe to log.</summary>
    public BrowserAuthFailure Failure { get; } = failure;
}
#pragma warning restore CA1032
