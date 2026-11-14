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
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.IdentityModel.Tokens;
using Nix.Abstractions;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Features.Workspaces;
using Nix.Messaging;
using Nix.Persistence;

namespace Nix.Tests.Authentication;

/// <summary>
/// <c>IsInteractive</c> is set only for a validated browser-session credential. The middleware is
/// driven up to the point it opens the transaction (the database address is unreachable on
/// purpose), which is after the credential switch that sets the flag.
/// </summary>
public sealed class InteractiveSessionTests
{
    private static readonly TenantId Tenant = TenantId.From(Guid.NewGuid());
    private static readonly PrincipalId Person = PrincipalId.Create();

    [Fact]
    public void A_fresh_context_is_not_interactive_and_a_token_ceiling_does_not_make_it_so()
    {
        var inProcess = new AccessTokenSessionContext();
        Assert.False(inProcess.IsInteractive);

        // What the middleware records for a worker delegation.
        var worker = new AccessTokenSessionContext();
        worker.SetTokenCeiling(mayWrite: false, mayAdminister: false);
        Assert.False(worker.IsInteractive);
    }

    [Fact]
    public async Task A_browser_session_is_interactive()
    {
        using var issuer = new TestIssuer();
        var selfIssued = issuer.Service;
        var token = selfIssued.MintBrowserSession(Person, Tenant, BrowserSessionId.From(Guid.NewGuid()));

        var scope = await RunAsync(token, new NixTokenValidator(new Directory(), selfIssued));

        Assert.True(scope.IsInteractive);
    }

    [Fact]
    public async Task An_access_token_session_is_not_interactive()
    {
        using var issuer = new TestIssuer();
        var selfIssued = issuer.Service;
        var token = selfIssued.Mint(Person, Tenant, PersonalAccessTokenId.Create());

        var scope = await RunAsync(token, new NixTokenValidator(new Directory(), selfIssued));

        Assert.False(scope.IsInteractive);
    }

    [Fact]
    public async Task An_external_bearer_is_not_interactive()
    {
        using var issuer = new TestIssuer();
        var selfIssued = issuer.Service;
        var issuerUrl = $"https://interactive-{Guid.NewGuid():N}.example.test";
        var registration = new IdentityProviderRegistration(
            Tenant,
            issuerUrl,
            "web",
            new Uri($"{issuerUrl}/keys"),
            ["RS256"],
            IdentityProviderId.Create(),
            false,
            null);
        using var rsa = RSA.Create(2048);
        var key = new RsaSecurityKey(rsa) { KeyId = "interactive-key" };
        var jwt = new JwtSecurityTokenHandler().WriteToken(new JwtSecurityToken(
            issuerUrl,
            "web",
            [new Claim("sub", "external-subject")],
            DateTime.UtcNow.AddMinutes(-1),
            DateTime.UtcNow.AddMinutes(5),
            new SigningCredentials(key, SecurityAlgorithms.RsaSha256)));
        var parameters = rsa.ExportParameters(includePrivateParameters: false);
        var jwks = JsonSerializer.Serialize(new
        {
            keys = new[]
            {
                new
                {
                    kty = "RSA",
                    use = "sig",
                    kid = key.KeyId,
                    alg = "RS256",
                    n = Base64UrlEncoder.Encode(parameters.Modulus),
                    e = Base64UrlEncoder.Encode(parameters.Exponent),
                },
            },
        });
#pragma warning disable CA2000 // HttpClient owns and disposes its handler.
        using var keyClient = new HttpClient(new StaticHandler(jwks));
#pragma warning restore CA2000

        var scope = await RunAsync(jwt, new NixTokenValidator(new Directory(registration), selfIssued, keyClient));

        Assert.False(scope.IsInteractive);
        Assert.True(scope.IsExternalBearer);
    }

    [Fact]
    public void Agent_gate_refuses_in_process_and_worker_work_even_with_the_switches_on()
    {
        var workspace = Switched(approve: true, publicLinks: true);

        var inProcess = new AccessTokenSessionContext();
        // What the middleware records for a worker delegation.
        var worker = new AccessTokenSessionContext();
        worker.SetTokenCeiling(mayWrite: false, mayAdminister: false);

        foreach (var session in new[] { inProcess, worker })
        {
            Assert.False(AgentPolicyGate.MayChangeVersionState(session, workspace));
            Assert.False(AgentPolicyGate.MayCreatePublicLink(session, workspace));
        }
    }

    [Fact]
    public void Agent_gate_allows_an_access_token_and_an_external_bearer_only_with_the_switch_on()
    {
        var accessToken = new AccessTokenSessionContext();
        accessToken.SetTokenCeiling(mayWrite: true, mayAdminister: true);
        var bearer = new AccessTokenSessionContext();
        bearer.SetExternalBearer();

        foreach (var session in new[] { accessToken, bearer })
        {
            Assert.False(AgentPolicyGate.MayChangeVersionState(session, Switched(approve: false, publicLinks: false)));
            Assert.True(AgentPolicyGate.MayChangeVersionState(session, Switched(approve: true, publicLinks: false)));
            Assert.True(AgentPolicyGate.MayCreatePublicLink(session, Switched(approve: false, publicLinks: true)));
        }
    }

    private static Workspace Switched(bool approve, bool publicLinks) => new()
    {
        Id = WorkspaceId.Create(),
        TenantId = Tenant,
        Name = "w",
        VersionRetentionDays = 30,
        CoalesceWindowMinutes = 5,
        StorageQuotaBytes = 1,
        CreatedAt = DateTimeOffset.UtcNow,
        LifecycleState = WorkspaceLifecycleState.Active,
        AgentsMayApprove = approve,
        AgentsMayCreatePublicLinks = publicLinks,
    };

    private sealed class TestIssuer : IDisposable
    {
        private readonly ECDsa _key = ECDsa.Create(ECCurve.NamedCurves.nistP256);

        public TestIssuer()
        {
            var configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    [SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.interactive-test",
                    [SelfIssuedTokenService.AudienceConfigurationKey] = "nix-core",
                    [SelfIssuedTokenService.KeyIdConfigurationKey] = "interactive-test-key",
                    [SelfIssuedTokenService.SigningKeyConfigurationKey] = _key.ExportPkcs8PrivateKeyPem(),
                })
                .Build();
            Service = new SelfIssuedTokenService(configuration, TimeProvider.System);
        }

        public SelfIssuedTokenService Service { get; }

        public void Dispose()
        {
            Service.Dispose();
            _key.Dispose();
        }
    }

    /// <summary>Runs the middleware past authentication and returns the scope context it filled in.</summary>
    private static async Task<AccessTokenSessionContext> RunAsync(string token, NixTokenValidator validator)
    {
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Parse("192.0.2.30");
        context.Request.Path = "/api/v1/workspaces";
        context.Request.Headers.Authorization = $"Bearer {token}";
        context.Response.Body = new MemoryStream();
        var scope = new AccessTokenSessionContext();
        await using var database = new NixDbContext(
            new DbContextOptionsBuilder<NixDbContext>()
                .UseNpgsql("Host=127.0.0.1;Port=1;Database=unused;Username=unused;Password=unused;Timeout=1")
                .Options);

        var middleware = new NixUnitOfWorkMiddleware(_ => Task.CompletedTask);
        var failure = await Record.ExceptionAsync(() => middleware.InvokeAsync(
            context,
            validator,
            new Directory(),
            new ScopedNixSessionContextAccessor(),
            database,
            new FailedAuthenticationThrottle(TimeProvider.System, 3, TimeSpan.FromMinutes(5)),
            new SessionTokens(),
            new Sessions(),
            new NoWorkerDispatch(),
            scope,
            new CredentialSessionContext(),
            new NoUserInfo(),
            new NixDispatcher(new ServiceCollection().BuildServiceProvider()),
            TimeProvider.System,
            NullLogger<NixUnitOfWorkMiddleware>.Instance));

        // Reaching the unreachable database means authentication succeeded and nothing was refused.
        Assert.NotNull(failure);
        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        return scope;
    }

    private sealed class Directory(IdentityProviderRegistration? registration = null) : IIdentityDirectory
    {
        public ValueTask<IdentityProviderRegistration?> ResolveProviderAsync(
            string issuer,
            string audience,
            CancellationToken cancellationToken) => ValueTask.FromResult(
                registration is not null && registration.Issuer == issuer && registration.Audience == audience
                    ? registration
                    : null);

        public ValueTask<AuthenticatedPrincipal?> FindExternalPrincipalAsync(
            TenantId tenantId,
            string externalIssuer,
            string externalSubject,
            CancellationToken cancellationToken) => ValueTask.FromResult<AuthenticatedPrincipal?>(
                new AuthenticatedPrincipal(Person, Tenant, PrincipalStatus.Active, "Person"));

        public ValueTask<AuthenticatedPrincipal?> FindPrincipalByIdAsync(
            TenantId tenantId,
            PrincipalId principalId,
            CancellationToken cancellationToken) => ValueTask.FromResult<AuthenticatedPrincipal?>(
                new AuthenticatedPrincipal(Person, Tenant, PrincipalStatus.Active, "Person"));
    }

    private sealed class Sessions : IBrowserSessions
    {
        public ValueTask<AuthenticatedBrowserSession?> FindByTokenHashAsync(
            string tokenHash,
            CancellationToken cancellationToken) => ValueTask.FromResult<AuthenticatedBrowserSession?>(null);

        public ValueTask<AuthenticatedBrowserSession?> FindByIdAsync(
            BrowserSessionId id,
            CancellationToken cancellationToken) => ValueTask.FromResult<AuthenticatedBrowserSession?>(
                new AuthenticatedBrowserSession(
                    id,
                    Tenant,
                    Person,
                    PrincipalStatus.Active,
                    "Person",
                    DateTimeOffset.UtcNow.AddHours(1)));

        public ValueTask AddAsync(BrowserSession session, CancellationToken cancellationToken) => ValueTask.CompletedTask;

        public ValueTask<bool> RevokeAsync(
            BrowserSessionId id,
            DateTimeOffset revokedAt,
            CancellationToken cancellationToken) => ValueTask.FromResult(false);
    }

    private sealed class SessionTokens : IPersonalAccessTokens
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

        public ValueTask<PersonalAccessToken?> FindOwnAsync(
            PersonalAccessTokenId id,
            CancellationToken cancellationToken) => ValueTask.FromResult<PersonalAccessToken?>(null);

        public ValueTask<bool> RotateOwnAsync(
            PersonalAccessTokenId id,
            string lookup,
            ReadOnlyMemory<byte> secretHash,
            DateTimeOffset expiresAt,
            DateTimeOffset now,
            CancellationToken cancellationToken) => ValueTask.FromResult(false);

        public ValueTask<AccessTokenSessionState?> FindSessionStateAsync(
            PersonalAccessTokenId id,
            CancellationToken cancellationToken) => ValueTask.FromResult<AccessTokenSessionState?>(null);

        public ValueTask TouchAsync(
            PersonalAccessTokenId id,
            DateTimeOffset at,
            CancellationToken cancellationToken) => ValueTask.CompletedTask;
    }

    private sealed class NoWorkerDispatch : IWorkerDispatchStore
    {
        public ValueTask<IReadOnlyList<DispatchedWorkerJob>> LeaseJobsAsync(string? kind, string owner, int limit, int leaseSeconds, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<DispatchedWorkerJob?> ClaimJobAsync(Guid jobId, string owner, int leaseSeconds, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<bool> RenewJobAsync(Guid jobId, string owner, int leaseSeconds, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<WorkerExecutionState?> GetJobStateAsync(Guid jobId, string owner, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<WorkerExecutionAuthorization?> AuthorizeExecutionAsync(Guid jobId, string owner, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<WorkerResultApplication> ApplyResultAsync(Guid jobId, string owner, bool succeeded, bool retryable, string? result, string? errorCode, string? errorDetail, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<bool> FinishJobAsync(Guid jobId, string owner, bool succeeded, bool retryable, string? result, string? errorCode, string? errorDetail, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<bool> ScheduleExportCleanupAsync(Guid jobId, CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask<IReadOnlyList<DispatchedWorkerJob>> InterruptJobsAsync(string ownerPrefix, IReadOnlyList<string> kinds, string errorCode, CancellationToken cancellationToken) => throw new NotSupportedException();
    }

    private sealed class NoUserInfo : IUserInfoClient
    {
        public ValueTask<UserInfoProfile> ReadAsync(
            Uri endpoint,
            string validatedIssuer,
            string accessToken,
            string expectedSubject,
            CancellationToken cancellationToken) => throw new NotSupportedException();
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
}
