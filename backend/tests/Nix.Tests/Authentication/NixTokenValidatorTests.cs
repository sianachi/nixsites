using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.IdentityModel.Tokens;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Tests.Authentication;

public sealed class NixTokenValidatorTests
{
    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("garbage")]
    [InlineData("a.a.a")]
    [InlineData("eyJhbGciOiJSUzI1NiJ9.bm90LWpzb24.a")]
    [InlineData("eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOjQyfQ.a")]
    public async Task Malformed_tokens_are_refused_without_throwing(string token)
    {
        using var selfIssued = new SelfIssuedTokenService(new ConfigurationBuilder().Build(), TimeProvider.System);
        var validator = new NixTokenValidator(
            new RegistrationDirectory(new Dictionary<string, IdentityProviderRegistration>()), selfIssued);

        Assert.Null(await validator.ValidateAsync(token, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Core_issuer_returns_a_core_token_with_only_principal_and_pat_identity()
    {
        using var signingKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                [SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.nix.test",
                [SelfIssuedTokenService.AudienceConfigurationKey] = "nix-core",
                [SelfIssuedTokenService.KeyIdConfigurationKey] = "core-key",
                [SelfIssuedTokenService.SigningKeyConfigurationKey] = signingKey.ExportPkcs8PrivateKeyPem(),
            })
            .Build();
        using var selfIssued = new SelfIssuedTokenService(configuration, TimeProvider.System);
        var tenantId = TenantId.From(Guid.Parse("11111111-1111-4111-8111-111111111111"));
        var principalId = PrincipalId.From(Guid.Parse("22222222-2222-4222-8222-222222222222"));
        var accessTokenId = PersonalAccessTokenId.From(Guid.Parse("33333333-3333-4333-8333-333333333333"));
        var token = selfIssued.Mint(principalId, tenantId, accessTokenId);
        var validator = new NixTokenValidator(
            new RegistrationDirectory(new Dictionary<string, IdentityProviderRegistration>()),
            selfIssued);

        var result = await validator.ValidateAsync(token, TestContext.Current.CancellationToken);

        var core = Assert.IsType<ValidatedCoreToken>(result);
        Assert.Equal(tenantId, core.TenantId);
        Assert.Equal(principalId, core.PrincipalId);
        Assert.Equal(accessTokenId, core.AccessTokenId);
    }

    [Fact]
    public async Task Core_issuer_classifies_an_exact_worker_execution_separately()
    {
        using var signingKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                [SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.nix.test",
                [SelfIssuedTokenService.AudienceConfigurationKey] = "nix-core",
                [SelfIssuedTokenService.KeyIdConfigurationKey] = "core-key",
                [SelfIssuedTokenService.SigningKeyConfigurationKey] = signingKey.ExportPkcs8PrivateKeyPem(),
            })
            .Build();
        using var selfIssued = new SelfIssuedTokenService(configuration, TimeProvider.System);
        var tenantId = TenantId.From(Guid.Parse("11111111-1111-4111-8111-111111111111"));
        var principalId = PrincipalId.From(Guid.Parse("22222222-2222-4222-8222-222222222222"));
        var jobId = Guid.Parse("33333333-3333-4333-8333-333333333333");
        var itemId = Guid.Parse("44444444-4444-4444-8444-444444444444");
        var workspaceId = Guid.Parse("55555555-5555-4555-8555-555555555555");
        const string executionId = "exporter:019946d1-fbc1-7d99-9ce7-1c721b406ff0";
        var token = selfIssued.MintWorkerExecution(
            principalId,
            tenantId,
            jobId,
            itemId,
            workspaceId,
            "subtree",
            executionId);
        var validator = new NixTokenValidator(
            new RegistrationDirectory(new Dictionary<string, IdentityProviderRegistration>()),
            selfIssued);

        var result = await validator.ValidateAsync(token, TestContext.Current.CancellationToken);

        var worker = Assert.IsType<ValidatedWorkerExecutionToken>(result);
        Assert.Equal(tenantId, worker.TenantId);
        Assert.Equal(principalId, worker.PrincipalId);
        Assert.Equal(jobId, worker.JobId);
        Assert.Equal(itemId, worker.ItemId);
        Assert.Equal(workspaceId, worker.WorkspaceId);
        Assert.Equal("subtree", worker.Scope);
        Assert.Equal(executionId, worker.ExecutionId);
    }

    [Fact]
    public async Task Core_issuer_classifies_a_pet_turn_token_and_refuses_a_stolen_claim_shape()
    {
        using var signingKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                [SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.nix.test",
                [SelfIssuedTokenService.AudienceConfigurationKey] = "nix-core",
                [SelfIssuedTokenService.KeyIdConfigurationKey] = "core-key",
                [SelfIssuedTokenService.SigningKeyConfigurationKey] = signingKey.ExportPkcs8PrivateKeyPem(),
            })
            .Build();
        using var selfIssued = new SelfIssuedTokenService(configuration, TimeProvider.System);
        var tenantId = TenantId.From(Guid.Parse("11111111-1111-4111-8111-111111111111"));
        var principalId = PrincipalId.From(Guid.Parse("22222222-2222-4222-8222-222222222222"));
        var requestId = Guid.Parse("33333333-3333-4333-8333-333333333333");
        var validator = new NixTokenValidator(
            new RegistrationDirectory(new Dictionary<string, IdentityProviderRegistration>()),
            selfIssued);

        var result = await validator.ValidateAsync(
            selfIssued.MintPetTurn(principalId, tenantId, requestId, PetTurnMode.Write),
            TestContext.Current.CancellationToken);

        var pet = Assert.IsType<ValidatedPetTurnToken>(result);
        Assert.Equal(tenantId, pet.TenantId);
        Assert.Equal(principalId, pet.PrincipalId);
        Assert.Equal(requestId, pet.RequestId);
        Assert.Equal(PetTurnMode.Write, pet.Mode);
        Assert.True(pet.MayWrite);
        Assert.False(pet.MayAdminister);

        // A signed token naming an unknown mode is refused whole, not half-trusted as another kind.
        var unknownMode = new JwtSecurityTokenHandler { MapInboundClaims = false }.WriteToken(new JwtSecurityToken(
            issuer: "https://core.nix.test",
            audience: "nix-core",
            claims:
            [
                new Claim("sub", principalId.ToString()),
                new Claim(SelfIssuedTokenService.TenantClaim, tenantId.ToString()),
                new Claim(SelfIssuedTokenService.PetTurnClaim, requestId.ToString("D")),
                new Claim(SelfIssuedTokenService.PetModeClaim, "superuser"),
            ],
            expires: DateTime.UtcNow.AddMinutes(5),
            signingCredentials: new SigningCredentials(
                new ECDsaSecurityKey(signingKey) { KeyId = "core-key" }, SecurityAlgorithms.EcdsaSha256)));
        Assert.Null(await validator.ValidateAsync(unknownMode, TestContext.Current.CancellationToken));
    }

    [Theory]
    [InlineData("api", "service")]
    [InlineData("service", "api")]
    public async Task Provider_key_sets_are_isolated_in_both_cache_orders(
        string firstAudience,
        string secondAudience)
    {
        var issuer = $"https://{firstAudience}-first.issuer.example.test";
        var firstTenant = TenantId.From(Guid.Parse("11111111-1111-4111-8111-111111111111"));
        var secondTenant = TenantId.From(Guid.Parse("22222222-2222-4222-8222-222222222222"));
        using var firstRsa = RSA.Create(2048);
        using var secondRsa = RSA.Create(2048);
        var firstKey = SigningKey(firstRsa);
        var secondKey = SigningKey(secondRsa);
        var firstJwksUri = new Uri($"{issuer}/{firstAudience}/keys");
        var secondJwksUri = new Uri($"{issuer}/{secondAudience}/keys");
        var registrations = new Dictionary<string, IdentityProviderRegistration>(StringComparer.Ordinal)
        {
            [firstAudience] = Registration(firstTenant, issuer, firstAudience, firstJwksUri),
            [secondAudience] = Registration(secondTenant, issuer, secondAudience, secondJwksUri),
        };
        var keySets = new Dictionary<Uri, string>
        {
            [firstJwksUri] = Jwks(firstRsa, firstKey.KeyId),
            [secondJwksUri] = Jwks(secondRsa, secondKey.KeyId),
        };
        using var keyHandler = new JwksHandler(keySets);
        using var keyClient = new HttpClient(keyHandler);
        using var selfIssued = Unconfigured();
        var validator = new NixTokenValidator(new RegistrationDirectory(registrations), selfIssued, keyClient);

        var first = await validator.ValidateAsync(
            SignedToken(issuer, firstAudience, firstKey),
            TestContext.Current.CancellationToken);
        var second = await validator.ValidateAsync(
            SignedToken(issuer, secondAudience, secondKey),
            TestContext.Current.CancellationToken);
        var crossTenant = await validator.ValidateAsync(
            SignedToken(issuer, secondAudience, firstKey),
            TestContext.Current.CancellationToken);

        Assert.Equal(firstTenant, Assert.IsType<ValidatedExternalToken>(first).TenantId);
        Assert.Equal(secondTenant, Assert.IsType<ValidatedExternalToken>(second).TenantId);
        Assert.Null(crossTenant);
        Assert.Equal(1, keyHandler.Requests[firstJwksUri]);
        Assert.Equal(1, keyHandler.Requests[secondJwksUri]);
    }

    [Theory]
    [InlineData("api,service")]
    [InlineData("service,api")]
    public async Task Cross_tenant_audiences_are_refused_regardless_of_claim_order(string ordered)
    {
        ArgumentNullException.ThrowIfNull(ordered);
        var audiences = ordered.Split(',');
        var directory = new AmbiguousDirectory(audiences);
        using var selfIssued = Unconfigured();
        var validator = new NixTokenValidator(directory, selfIssued);

        var result = await validator.ValidateAsync(Token(audiences), TestContext.Current.CancellationToken);

        Assert.Null(result);
        Assert.Equal(audiences, directory.Lookups);
    }

    [Theory]
    [InlineData("api,service")]
    [InlineData("service,api")]
    public async Task Audiences_for_one_provider_are_coalesced_regardless_of_claim_order(string ordered)
    {
        ArgumentNullException.ThrowIfNull(ordered);
        var audiences = ordered.Split(',');
        var issuer = $"https://same-provider-{audiences[0]}.issuer.example.test";
        var tenant = TenantId.From(Guid.Parse("11111111-1111-4111-8111-111111111111"));
        var jwksUri = new Uri($"{issuer}/keys");
        using var rsa = RSA.Create(2048);
        var key = SigningKey(rsa);
        var registrations = audiences.ToDictionary(
            audience => audience,
            audience => Registration(tenant, issuer, audience, jwksUri),
            StringComparer.Ordinal);
        using var keyHandler = new JwksHandler(
            new Dictionary<Uri, string> { [jwksUri] = Jwks(rsa, key.KeyId) });
        using var keyClient = new HttpClient(keyHandler);
        using var selfIssued = Unconfigured();
        var validator = new NixTokenValidator(new RegistrationDirectory(registrations), selfIssued, keyClient);

        var result = await validator.ValidateAsync(
            SignedToken(issuer, audiences, key),
            TestContext.Current.CancellationToken);

        var validated = Assert.IsType<ValidatedExternalToken>(result);
        Assert.Equal(tenant, validated.TenantId);
        Assert.Contains(validated.Registration.Audience, audiences);
        Assert.Equal(1, keyHandler.Requests[jwksUri]);
    }

    [Theory]
    [InlineData("web,project", "web", "web", true)]
    [InlineData("project,web", "web", "web", true)]
    [InlineData("web,project", "project", "project", false)]
    [InlineData("service,web", "service", "service", false)]
    [InlineData("web,project", null, null, false)]
    [InlineData("project,web", "unmatched", null, false)]
    public async Task Signed_authorized_party_alone_selects_the_jit_registration(
        string ordered,
        string? authorizedParty,
        string? expectedAudience,
        bool expectedJit)
    {
        ArgumentNullException.ThrowIfNull(ordered);
        var audiences = ordered.Split(',');
        var issuer = $"https://azp-{Guid.NewGuid():N}.issuer.example.test";
        var tenant = TenantId.From(Guid.Parse("11111111-1111-4111-8111-111111111111"));
        var jwksUri = new Uri($"{issuer}/keys");
        using var rsa = RSA.Create(2048);
        var key = SigningKey(rsa);
        var registrations = audiences.ToDictionary(
            audience => audience,
            audience => new IdentityProviderRegistration(
                tenant,
                issuer,
                audience,
                jwksUri,
                ["RS256"],
                IdentityProviderId.Create(),
                JitProvisioningEnabled: string.Equals(audience, "web", StringComparison.Ordinal),
                UserInfoUri: string.Equals(audience, "web", StringComparison.Ordinal)
                    ? new Uri($"{issuer}/userinfo")
                    : null),
            StringComparer.Ordinal);
        using var keyHandler = new JwksHandler(
            new Dictionary<Uri, string> { [jwksUri] = Jwks(rsa, key.KeyId) });
        using var keyClient = new HttpClient(keyHandler);
        using var selfIssued = Unconfigured();
        var validator = new NixTokenValidator(new RegistrationDirectory(registrations), selfIssued, keyClient);

        var result = await validator.ValidateAsync(
            SignedToken(issuer, audiences, key, authorizedParty),
            TestContext.Current.CancellationToken);

        var validated = Assert.IsType<ValidatedExternalToken>(result);
        if (expectedAudience is null)
        {
            Assert.Null(validated.AuthorizedPartyRegistration);
        }
        else
        {
            Assert.Equal(expectedAudience, validated.AuthorizedPartyRegistration?.Audience);
            Assert.Equal(expectedJit, validated.AuthorizedPartyRegistration?.JitProvisioningEnabled);
        }
    }

    [Fact]
    public async Task Concurrent_unknown_key_ids_trigger_one_provider_refresh()
    {
        var issuer = $"https://single-flight-{Guid.NewGuid():N}.issuer.example.test";
        var audience = "api";
        var tenant = TenantId.From(Guid.Parse("11111111-1111-4111-8111-111111111111"));
        var jwksUri = new Uri($"{issuer}/keys");
        using var knownRsa = RSA.Create(2048);
        using var unknownRsa = RSA.Create(2048);
        var knownKey = SigningKey(knownRsa);
        var unknownKey = new RsaSecurityKey(unknownRsa) { KeyId = "unknown-key-id" };
        var registrations = new Dictionary<string, IdentityProviderRegistration>(StringComparer.Ordinal)
        {
            [audience] = Registration(tenant, issuer, audience, jwksUri),
        };
        using var handler = new MutableJwksHandler(Jwks(knownRsa, knownKey.KeyId));
        using var client = new HttpClient(handler);
        var clock = new ManualTimeProvider(new DateTimeOffset(2026, 8, 17, 0, 0, 0, TimeSpan.Zero));
        using var selfIssued = Unconfigured();
        var validator = new NixTokenValidator(new RegistrationDirectory(registrations), selfIssued, client, clock);

        Assert.NotNull(await validator.ValidateAsync(
            SignedToken(issuer, audience, knownKey),
            TestContext.Current.CancellationToken));
        clock.Advance(TimeSpan.FromMinutes(6));

        var attempts = Enumerable.Range(0, 32)
            .Select(_ => validator.ValidateAsync(
                SignedToken(issuer, audience, unknownKey),
                TestContext.Current.CancellationToken).AsTask())
            .ToArray();
        Assert.All(await Task.WhenAll(attempts), Assert.Null);
        Assert.Equal(2, handler.Requests);
    }

    [Fact]
    public async Task Failed_unknown_key_refresh_is_single_flight_and_backed_off()
    {
        var issuer = $"https://failure-backoff-{Guid.NewGuid():N}.issuer.example.test";
        var audience = "api";
        var tenant = TenantId.From(Guid.Parse("11111111-1111-4111-8111-111111111111"));
        var jwksUri = new Uri($"{issuer}/keys");
        using var knownRsa = RSA.Create(2048);
        using var unknownRsa = RSA.Create(2048);
        var knownKey = SigningKey(knownRsa);
        var unknownKey = new RsaSecurityKey(unknownRsa) { KeyId = "unknown-failure-key-id" };
        var registrations = new Dictionary<string, IdentityProviderRegistration>(StringComparer.Ordinal)
        {
            [audience] = Registration(tenant, issuer, audience, jwksUri),
        };
        using var handler = new MutableJwksHandler(Jwks(knownRsa, knownKey.KeyId));
        using var client = new HttpClient(handler);
        var clock = new ManualTimeProvider(new DateTimeOffset(2026, 8, 17, 0, 0, 0, TimeSpan.Zero));
        using var selfIssued = Unconfigured();
        var validator = new NixTokenValidator(new RegistrationDirectory(registrations), selfIssued, client, clock);

        Assert.NotNull(await validator.ValidateAsync(
            SignedToken(issuer, audience, knownKey),
            TestContext.Current.CancellationToken));
        handler.Fail = true;
        clock.Advance(TimeSpan.FromMinutes(6));

        var attempts = Enumerable.Range(0, 32)
            .Select(_ => validator.ValidateAsync(
                SignedToken(issuer, audience, unknownKey),
                TestContext.Current.CancellationToken).AsTask())
            .ToArray();
        Assert.All(await Task.WhenAll(attempts), Assert.Null);
        Assert.Null(await validator.ValidateAsync(
            SignedToken(issuer, audience, unknownKey),
            TestContext.Current.CancellationToken));
        Assert.Equal(2, handler.Requests);
    }

    private static string Token(IReadOnlyList<string> audiences)
    {
        var payload = new JwtPayload
        {
            ["iss"] = "https://issuer.example.test",
            ["aud"] = audiences,
            ["sub"] = "subject",
            ["exp"] = DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeSeconds(),
        };
        return new JwtSecurityTokenHandler().WriteToken(new JwtSecurityToken(new JwtHeader(), payload));
    }

    private static RsaSecurityKey SigningKey(RSA rsa) =>
        new(rsa) { KeyId = "shared-key-id" };

    private static IdentityProviderRegistration Registration(
        TenantId tenantId,
        string issuer,
        string audience,
        Uri jwksUri) =>
        new(
            tenantId,
            issuer,
            audience,
            jwksUri,
            ["RS256"],
            IdentityProviderId.Create(),
            JitProvisioningEnabled: false,
            UserInfoUri: null);

    private static string SignedToken(string issuer, string audience, SecurityKey key)
    {
        var token = new JwtSecurityToken(
            issuer,
            audience,
            [new Claim("sub", "subject")],
            DateTime.UtcNow.AddMinutes(-1),
            DateTime.UtcNow.AddMinutes(5),
            new SigningCredentials(key, SecurityAlgorithms.RsaSha256));
        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    private static string SignedToken(
        string issuer,
        IReadOnlyList<string> audiences,
        SecurityKey key,
        string? authorizedParty = null)
    {
        var claims = new List<Claim> { new("sub", "subject") };
        if (authorizedParty is not null)
        {
            claims.Add(new Claim("azp", authorizedParty));
        }

        var payload = new JwtPayload(
            issuer,
            null,
            claims,
            DateTime.UtcNow.AddMinutes(-1),
            DateTime.UtcNow.AddMinutes(5))
        {
            ["aud"] = audiences,
        };
        return new JwtSecurityTokenHandler().WriteToken(
            new JwtSecurityToken(new JwtHeader(new SigningCredentials(key, SecurityAlgorithms.RsaSha256)), payload));
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

    private sealed class AmbiguousDirectory(IReadOnlyList<string> accepted) : IIdentityDirectory
    {
        private readonly HashSet<string> _accepted = accepted.ToHashSet(StringComparer.Ordinal);
        private readonly List<string> _lookups = [];

        internal IReadOnlyList<string> Lookups => _lookups;

        public ValueTask<IdentityProviderRegistration?> ResolveProviderAsync(
            string issuer,
            string audience,
            CancellationToken cancellationToken)
        {
            _lookups.Add(audience);
            var tenantId = audience == accepted[0]
                ? "11111111-1111-4111-8111-111111111111"
                : "22222222-2222-4222-8222-222222222222";
            return ValueTask.FromResult<IdentityProviderRegistration?>(_accepted.Contains(audience)
                ? new IdentityProviderRegistration(
                    TenantId.From(Guid.Parse(tenantId)),
                    issuer,
                    audience,
                    new Uri("https://issuer.example.test/keys"),
                    ["RS256"],
                    IdentityProviderId.Create(),
                    JitProvisioningEnabled: false,
                    UserInfoUri: null)
                : null);
        }

        public ValueTask<AuthenticatedPrincipal?> FindExternalPrincipalAsync(
            TenantId tenantId,
            string externalIssuer,
            string externalSubject,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult<AuthenticatedPrincipal?>(null);

        public ValueTask<AuthenticatedPrincipal?> FindPrincipalByIdAsync(
            TenantId tenantId,
            PrincipalId principalId,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult<AuthenticatedPrincipal?>(null);
    }

    // These tests exercise the registered-issuer path, where Core's own self-issuer is never
    // reached: an unconfigured SelfIssuedTokenService reports IsConfigured false, so the self-issuer
    // branch is skipped and every token routes through the identity_provider resolution under test.
    private static SelfIssuedTokenService Unconfigured() =>
        new(new Microsoft.Extensions.Configuration.ConfigurationBuilder().Build(), TimeProvider.System);

    private sealed class RegistrationDirectory(
        IReadOnlyDictionary<string, IdentityProviderRegistration> registrations) : IIdentityDirectory
    {
        public ValueTask<IdentityProviderRegistration?> ResolveProviderAsync(
            string issuer,
            string audience,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult(
                registrations.TryGetValue(audience, out var registration)
                    && string.Equals(registration.Issuer, issuer, StringComparison.Ordinal)
                    ? registration
                    : null);

        public ValueTask<AuthenticatedPrincipal?> FindExternalPrincipalAsync(
            TenantId tenantId,
            string externalIssuer,
            string externalSubject,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult<AuthenticatedPrincipal?>(null);

        public ValueTask<AuthenticatedPrincipal?> FindPrincipalByIdAsync(
            TenantId tenantId,
            PrincipalId principalId,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult<AuthenticatedPrincipal?>(null);
    }

    private sealed class JwksHandler(IReadOnlyDictionary<Uri, string> keySets) : HttpMessageHandler
    {
        internal Dictionary<Uri, int> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var uri = Assert.IsType<Uri>(request.RequestUri);
            Requests[uri] = Requests.GetValueOrDefault(uri) + 1;
            return Task.FromResult(keySets.TryGetValue(uri, out var keySet)
                ? new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(keySet, Encoding.UTF8, "application/json"),
                }
                : new HttpResponseMessage(HttpStatusCode.NotFound));
        }
    }

    private sealed class MutableJwksHandler(string keySet) : HttpMessageHandler
    {
        private int _requests;

        internal bool Fail { get; set; }

        internal int Requests => Volatile.Read(ref _requests);

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _requests);
            return Task.FromResult(Fail
                ? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
                : new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(keySet, Encoding.UTF8, "application/json"),
                });
        }
    }

    private sealed class ManualTimeProvider(DateTimeOffset initial) : TimeProvider
    {
        private DateTimeOffset _now = initial;

        public override DateTimeOffset GetUtcNow() => _now;

        internal void Advance(TimeSpan elapsed) => _now += elapsed;
    }
}
