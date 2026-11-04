using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.IdentityModel.Tokens;
using Nix.Abstractions;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence;
using Nix.Persistence.Identity;
using Nix.Persistence.Sql;

namespace Nix.Tests.Authentication;

public sealed class NixUnitOfWorkJitTests
{
    [Fact]
    public async Task Jit_disabled_missing_subject_stays_unauthorized_and_never_calls_userinfo()
    {
        await using var scenario = ExternalScenario(jitEnabled: false, UserInfoBehavior.Unavailable);

        await scenario.InvokeAsync();

        Assert.Equal(StatusCodes.Status401Unauthorized, scenario.Context.Response.StatusCode);
        Assert.Equal(0, scenario.UserInfo.Calls);
        Assert.Equal(1, scenario.Throttle.TrackedClients);
        Assert.Contains(scenario.Logger.Messages, message => message.Contains(
            "jit_disabled",
            StringComparison.Ordinal));
        Assert.DoesNotContain(scenario.RawToken, scenario.Logger.Messages, StringComparer.Ordinal);
        Assert.DoesNotContain("sensitive-subject", scenario.Logger.Messages, StringComparer.Ordinal);
    }

    [Fact]
    public async Task Missing_authorized_party_refuses_jit_with_a_safe_diagnostic()
    {
        await using var scenario = ExternalScenario(
            jitEnabled: true,
            UserInfoBehavior.Unavailable,
            includeAuthorizedParty: false);

        await scenario.InvokeAsync();

        Assert.Equal(StatusCodes.Status401Unauthorized, scenario.Context.Response.StatusCode);
        Assert.Equal(0, scenario.UserInfo.Calls);
        Assert.Contains(scenario.Logger.Messages, message => message.Contains(
            "authorized_party_claim_missing",
            StringComparison.Ordinal));
        Assert.DoesNotContain(scenario.RawToken, scenario.Logger.Messages, StringComparer.Ordinal);
        Assert.DoesNotContain("sensitive-subject", scenario.Logger.Messages, StringComparer.Ordinal);
    }

    [Fact]
    public async Task Core_pat_missing_subject_never_enters_external_provisioning()
    {
        await using var scenario = CoreScenario();

        await scenario.InvokeAsync();

        Assert.Equal(StatusCodes.Status401Unauthorized, scenario.Context.Response.StatusCode);
        Assert.Equal(0, scenario.UserInfo.Calls);
    }

    [Fact]
    public async Task Provider_unavailability_is_retryable_without_charging_the_failed_token_throttle_or_logging_claims()
    {
        await using var scenario = ExternalScenario(jitEnabled: true, UserInfoBehavior.Unavailable);

        await scenario.InvokeAsync();

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, scenario.Context.Response.StatusCode);
        Assert.Equal("5", scenario.Context.Response.Headers.RetryAfter);
        Assert.Equal(0, scenario.Throttle.TrackedClients);
        Assert.Contains(scenario.Logger.Messages, message => message.Contains(
            "UserInfoMalformed", StringComparison.Ordinal));
        Assert.DoesNotContain(scenario.RawToken, scenario.Logger.Messages, StringComparer.Ordinal);
        Assert.DoesNotContain("sensitive-subject", scenario.Logger.Messages, StringComparer.Ordinal);
        Assert.DoesNotContain("sensitive@example.test", scenario.Logger.Messages, StringComparer.Ordinal);
    }

    [Fact]
    public async Task Caller_cancellation_during_userinfo_is_preserved_without_a_response_or_throttle_charge()
    {
        await using var scenario = ExternalScenario(jitEnabled: true, UserInfoBehavior.Cancel);
        await scenario.Cancellation.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(scenario.InvokeAsync);

        Assert.Equal(0, scenario.Throttle.TrackedClients);
        Assert.Empty(scenario.Logger.Messages);
    }

    [System.Diagnostics.CodeAnalysis.SuppressMessage(
        "Reliability",
        "CA2000:Dispose objects before losing scope",
        Justification = "Scenario owns and disposes the HttpClient and SelfIssuedTokenService; HttpClient owns its handler.")]
    private static Scenario ExternalScenario(
        bool jitEnabled,
        UserInfoBehavior behavior,
        bool includeAuthorizedParty = true)
    {
        var issuer = $"https://jit-{Guid.NewGuid():N}.example.test";
        var tenantId = TenantId.From(Guid.NewGuid());
        var registration = new IdentityProviderRegistration(
            tenantId,
            issuer,
            "web",
            new Uri($"{issuer}/keys"),
            ["RS256"],
            IdentityProviderId.Create(),
            jitEnabled,
            new Uri($"{issuer}/userinfo"));
        using var rsa = RSA.Create(2048);
        var key = new RsaSecurityKey(rsa) { KeyId = "jit-test-key" };
        var rawToken = SignedExternalToken(issuer, registration.Audience, key, includeAuthorizedParty);
        var directory = new MissingDirectory(registration);
        var keyClient = new HttpClient(new StaticHandler(Jwks(rsa, key.KeyId)));
        var selfIssued = new SelfIssuedTokenService(new ConfigurationBuilder().Build(), TimeProvider.System);
        return new Scenario(
            rawToken,
            new NixTokenValidator(directory, selfIssued, keyClient),
            directory,
            new StubUserInfo(behavior),
            [keyClient, selfIssued]);
    }

    [System.Diagnostics.CodeAnalysis.SuppressMessage(
        "Reliability",
        "CA2000:Dispose objects before losing scope",
        Justification = "Scenario owns and disposes the transferred SelfIssuedTokenService.")]
    private static Scenario CoreScenario()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                [SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.jit-test",
                [SelfIssuedTokenService.AudienceConfigurationKey] = "nix-core",
                [SelfIssuedTokenService.KeyIdConfigurationKey] = "core-test-key",
                [SelfIssuedTokenService.SigningKeyConfigurationKey] = key.ExportPkcs8PrivateKeyPem(),
            })
            .Build();
        var selfIssued = new SelfIssuedTokenService(configuration, TimeProvider.System);
        var directory = new MissingDirectory(registration: null);
        var rawToken = selfIssued.Mint(
            PrincipalId.Create(),
            TenantId.From(Guid.NewGuid()),
            PersonalAccessTokenId.Create());
        return new Scenario(
            rawToken,
            new NixTokenValidator(directory, selfIssued),
            directory,
            new StubUserInfo(UserInfoBehavior.Unavailable),
            [selfIssued]);
    }

    private static string SignedExternalToken(
        string issuer,
        string audience,
        SecurityKey key,
        bool includeAuthorizedParty)
    {
        var claims = new List<Claim>
        {
            new Claim("sub", "sensitive-subject"),
        };
        if (includeAuthorizedParty)
        {
            claims.Add(new Claim("azp", audience));
        }

        var token = new JwtSecurityToken(
            issuer,
            audience,
            claims,
            DateTime.UtcNow.AddMinutes(-1),
            DateTime.UtcNow.AddMinutes(5),
            new SigningCredentials(key, SecurityAlgorithms.RsaSha256));
        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    private static string Jwks(RSA rsa, string keyId)
    {
        var parameters = rsa.ExportParameters(includePrivateParameters: false);
        return JsonSerializer.Serialize(new
        {
            keys = new[]
            {
                new
                {
                    kty = "RSA",
                    use = "sig",
                    kid = keyId,
                    alg = "RS256",
                    n = Base64UrlEncoder.Encode(parameters.Modulus),
                    e = Base64UrlEncoder.Encode(parameters.Exponent),
                },
            },
        });
    }

    private enum UserInfoBehavior
    {
        Unavailable,
        Cancel,
    }

    private sealed class Scenario : IAsyncDisposable
    {
        private readonly IDisposable[] _owned;
        private readonly NixUnitOfWorkMiddleware _middleware;
        private readonly NixTokenValidator _validator;
        private readonly IIdentityDirectory _directory;
        private readonly NixDbContext _database;

        public Scenario(
            string rawToken,
            NixTokenValidator validator,
            IIdentityDirectory directory,
            StubUserInfo userInfo,
            IDisposable[] owned)
        {
            RawToken = rawToken;
            _validator = validator;
            _directory = directory;
            UserInfo = userInfo;
            _owned = owned;
            Context = new DefaultHttpContext();
            Context.Connection.RemoteIpAddress = IPAddress.Parse("192.0.2.20");
            Context.Request.Path = "/api/v1/workspaces";
            Context.Request.Headers.Authorization = $"Bearer {rawToken}";
            Context.Response.Body = new MemoryStream();
            Cancellation = new CancellationTokenSource();
            Context.RequestAborted = Cancellation.Token;
            Throttle = new FailedAuthenticationThrottle(TimeProvider.System, 3, TimeSpan.FromMinutes(5));
            Logger = new CapturingLogger<NixUnitOfWorkMiddleware>();
            _middleware = new NixUnitOfWorkMiddleware(_ => Task.CompletedTask);
            _database = new NixDbContext(
                new DbContextOptionsBuilder<NixDbContext>()
                    .UseNpgsql("Host=127.0.0.1;Port=1;Database=unused;Username=unused;Password=unused")
                    .Options);
        }

        public string RawToken { get; }

        public DefaultHttpContext Context { get; }

        public StubUserInfo UserInfo { get; }

        public FailedAuthenticationThrottle Throttle { get; }

        public CapturingLogger<NixUnitOfWorkMiddleware> Logger { get; }

        public CancellationTokenSource Cancellation { get; }

        public Task InvokeAsync() => _middleware.InvokeAsync(
            Context,
            _validator,
            _directory,
            new ScopedNixSessionContextAccessor(),
            _database,
            Throttle,
            new StubAccessTokens(),
            new StubBrowserSessions(),
            new UnusedWorkerDispatch(),
            new AccessTokenSessionContext(),
            new CredentialSessionContext(),
            UserInfo,
            new NixDispatcher(new ServiceCollection().BuildServiceProvider()),
            TimeProvider.System,
            Logger);

        private sealed class UnusedWorkerDispatch : IWorkerDispatchStore
        {
            public ValueTask<IReadOnlyList<DispatchedWorkerJob>> LeaseJobsAsync(string? kind, string owner, int limit, int leaseSeconds, CancellationToken cancellationToken) => throw new NotSupportedException();
            public ValueTask<DispatchedWorkerJob?> ClaimJobAsync(Guid jobId, string owner, int leaseSeconds, CancellationToken cancellationToken) => throw new NotSupportedException();
            public ValueTask<bool> RenewJobAsync(Guid jobId, string owner, int leaseSeconds, CancellationToken cancellationToken) => throw new NotSupportedException();
            public ValueTask<WorkerExecutionState?> GetJobStateAsync(Guid jobId, string owner, CancellationToken cancellationToken) => throw new NotSupportedException();
            public ValueTask<WorkerExecutionAuthorization?> AuthorizeExecutionAsync(Guid jobId, string owner, CancellationToken cancellationToken) => throw new NotSupportedException();
            public ValueTask<WorkerResultApplication> ApplyResultAsync(Guid jobId, string owner, bool succeeded, bool retryable, string? result, string? errorCode, string? errorDetail, CancellationToken cancellationToken) => throw new NotSupportedException();
            public ValueTask<bool> FinishJobAsync(Guid jobId, string owner, bool succeeded, bool retryable, string? result, string? errorCode, string? errorDetail, CancellationToken cancellationToken) => throw new NotSupportedException();
            public ValueTask<bool> ScheduleExportCleanupAsync(Guid jobId, CancellationToken cancellationToken) => throw new NotSupportedException();
            public ValueTask<IReadOnlyList<DispatchedOutboxEvent>> LeaseOutboxAsync(string? kind, string owner, int limit, int leaseSeconds, CancellationToken cancellationToken) => throw new NotSupportedException();
            public ValueTask<IReadOnlyList<DispatchedWorkerJob>> InterruptJobsAsync(string ownerPrefix, IReadOnlyList<string> kinds, string errorCode, CancellationToken cancellationToken) => throw new NotSupportedException();
            public ValueTask<bool> FinishOutboxAsync(Guid eventId, string owner, bool succeeded, string? failureDetail, CancellationToken cancellationToken) => throw new NotSupportedException();
        }

        public async ValueTask DisposeAsync()
        {
            Cancellation.Dispose();
            await _database.DisposeAsync();
            foreach (var owned in _owned)
            {
                owned.Dispose();
            }
        }
    }

    private sealed class MissingDirectory(IdentityProviderRegistration? registration) : IIdentityDirectory
    {
        public ValueTask<IdentityProviderRegistration?> ResolveProviderAsync(
            string issuer,
            string audience,
            CancellationToken cancellationToken) => ValueTask.FromResult(
                registration is not null
                && registration.Issuer == issuer
                && registration.Audience == audience
                    ? registration
                    : null);

        public ValueTask<AuthenticatedPrincipal?> FindExternalPrincipalAsync(
            TenantId tenantId,
            string externalIssuer,
            string externalSubject,
            CancellationToken cancellationToken) => ValueTask.FromResult<AuthenticatedPrincipal?>(null);

        public ValueTask<AuthenticatedPrincipal?> FindPrincipalByIdAsync(
            TenantId tenantId,
            PrincipalId principalId,
            CancellationToken cancellationToken) => ValueTask.FromResult<AuthenticatedPrincipal?>(null);
    }

    private sealed class StubBrowserSessions : IBrowserSessions
    {
        public ValueTask<AuthenticatedBrowserSession?> FindByTokenHashAsync(
            string tokenHash,
            CancellationToken cancellationToken) => ValueTask.FromResult<AuthenticatedBrowserSession?>(null);

        public ValueTask<AuthenticatedBrowserSession?> FindByIdAsync(
            BrowserSessionId id,
            CancellationToken cancellationToken) => ValueTask.FromResult<AuthenticatedBrowserSession?>(null);

        public ValueTask AddAsync(BrowserSession session, CancellationToken cancellationToken) => ValueTask.CompletedTask;

        public ValueTask<bool> RevokeAsync(
            BrowserSessionId id,
            DateTimeOffset revokedAt,
            CancellationToken cancellationToken) => ValueTask.FromResult(false);
    }

    private sealed class StubUserInfo(UserInfoBehavior behavior) : IUserInfoClient
    {
        public int Calls { get; private set; }

        public ValueTask<UserInfoProfile> ReadAsync(
            Uri endpoint,
            string validatedIssuer,
            string accessToken,
            string expectedSubject,
            CancellationToken cancellationToken)
        {
            Calls++;
            return behavior == UserInfoBehavior.Cancel
                ? ValueTask.FromCanceled<UserInfoProfile>(cancellationToken)
                : ValueTask.FromException<UserInfoProfile>(new UserInfoUnavailableException());
        }
    }

    private sealed class StaticHandler(string jwks) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(jwks, Encoding.UTF8, "application/json"),
            });
    }

    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public List<string> Messages { get; } = [];

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter) => Messages.Add(formatter(state, exception));
    }

    private sealed class StubAccessTokens : IPersonalAccessTokens
    {
        public ValueTask<AccessTokenExchangeCandidate?> FindForExchangeAsync(
            string lookup,
            CancellationToken cancellationToken) => ValueTask.FromResult<AccessTokenExchangeCandidate?>(null);

        public ValueTask<IReadOnlyList<PersonalAccessToken>> ListOwnAsync(CancellationToken cancellationToken) =>
            ValueTask.FromResult<IReadOnlyList<PersonalAccessToken>>([]);

        public ValueTask<int> CountLiveAsync(DateTimeOffset now, CancellationToken cancellationToken) =>
            ValueTask.FromResult(0);

        public ValueTask AddAsync(PersonalAccessToken token, CancellationToken cancellationToken) =>
            ValueTask.CompletedTask;

        public ValueTask<bool> RevokeOwnAsync(
            PersonalAccessTokenId id,
            DateTimeOffset at,
            CancellationToken cancellationToken) => ValueTask.FromResult(false);

        public ValueTask<AccessTokenSessionState?> FindSessionStateAsync(
            PersonalAccessTokenId id,
            CancellationToken cancellationToken) => ValueTask.FromResult<AccessTokenSessionState?>(null);

        public ValueTask TouchAsync(
            PersonalAccessTokenId id,
            DateTimeOffset at,
            CancellationToken cancellationToken) => ValueTask.CompletedTask;
    }
}
