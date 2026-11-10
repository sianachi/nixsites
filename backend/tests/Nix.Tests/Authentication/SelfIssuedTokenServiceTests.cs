using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Configuration;
using Microsoft.IdentityModel.Tokens;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Tests.Authentication;

/// <summary>
/// Core's own issuer: what it mints validates against exactly its own parameters, and against
/// nothing else.
/// </summary>
public sealed class SelfIssuedTokenServiceTests
{
    private const string Issuer = "https://nix.test/core";
    private const string Audience = "nix";
    private const string KeyId = "test-signing-key";

    [Fact]
    public void Unconfigured_it_says_so_and_refuses_to_mint()
    {
        using var service = Service(configuration: Configuration(signingKeyPem: null));

        Assert.False(service.IsConfigured);
        Assert.Throws<InvalidOperationException>(() =>
            service.Mint(PrincipalId.Create(), TenantId.From(Guid.NewGuid()), PersonalAccessTokenId.Create()));
        Assert.Empty(service.DescribePublicKeys().Keys);
    }

    [Fact]
    public void A_key_on_the_wrong_curve_is_treated_as_unconfigured()
    {
        using var wrongCurve = ECDsa.Create(ECCurve.NamedCurves.nistP384);
        using var service = Service(Configuration(wrongCurve.ExportECPrivateKeyPem()));

        Assert.False(service.IsConfigured);
    }

    [Fact]
    public void A_malformed_key_is_treated_as_unconfigured()
    {
        using var service = Service(Configuration("not a pem at all"));

        Assert.False(service.IsConfigured);
    }

    [Fact]
    public async Task A_minted_token_validates_and_carries_its_claims_back()
    {
        using var service = Service(Configuration(FreshKeyPem()));
        var tenantId = TenantId.From(Guid.NewGuid());
        var principalId = PrincipalId.Create();
        var accessTokenId = PersonalAccessTokenId.Create();

        var token = service.Mint(principalId, tenantId, accessTokenId);

        var handler = new JwtSecurityTokenHandler { MapInboundClaims = false };
        var result = await handler.ValidateTokenAsync(token, service.CreateValidationParameters());

        Assert.True(result.IsValid);
        Assert.Equal(principalId.ToString(), result.ClaimsIdentity.FindFirst("sub")?.Value);
        Assert.True(SelfIssuedTokenService.TryReadClaims(
            result.ClaimsIdentity,
            out var readTenant,
            out var readPrincipal,
            out var readToken));
        Assert.Equal(tenantId, readTenant);
        Assert.Equal(principalId, readPrincipal);
        Assert.Equal(accessTokenId, readToken);
    }

    [Fact]
    public async Task A_browser_token_carries_only_its_revocable_session_identity()
    {
        using var service = Service(Configuration(FreshKeyPem()));
        var tenantId = TenantId.From(Guid.NewGuid());
        var principalId = PrincipalId.Create();
        var browserSessionId = BrowserSessionId.Create();

        var token = service.MintBrowserSession(principalId, tenantId, browserSessionId);

        var handler = new JwtSecurityTokenHandler { MapInboundClaims = false };
        var result = await handler.ValidateTokenAsync(token, service.CreateValidationParameters());
        Assert.True(result.IsValid);
        Assert.True(SelfIssuedTokenService.TryReadBrowserSessionClaims(
            result.ClaimsIdentity,
            out var readTenant,
            out var readPrincipal,
            out var readSession));
        Assert.Equal(tenantId, readTenant);
        Assert.Equal(principalId, readPrincipal);
        Assert.Equal(browserSessionId, readSession);
        Assert.Null(result.ClaimsIdentity.FindFirst(SelfIssuedTokenService.AccessTokenClaim));
    }

    [Fact]
    public async Task A_worker_token_carries_only_its_exact_lease_identity()
    {
        using var service = Service(Configuration(FreshKeyPem()));
        var tenantId = TenantId.From(Guid.NewGuid());
        var principalId = PrincipalId.Create();
        var jobId = Guid.CreateVersion7();
        var itemId = Guid.CreateVersion7();
        var workspaceId = Guid.CreateVersion7();
        const string executionId = "exporter:019946d1-fbc1-7d99-9ce7-1c721b406ff0";

        var token = service.MintWorkerExecution(
            principalId,
            tenantId,
            jobId,
            itemId,
            workspaceId,
            "subtree",
            executionId);

        var handler = new JwtSecurityTokenHandler { MapInboundClaims = false };
        var result = await handler.ValidateTokenAsync(token, service.CreateValidationParameters());
        Assert.True(result.IsValid);
        Assert.True(SelfIssuedTokenService.TryReadWorkerExecutionClaims(
            result.ClaimsIdentity,
            out var readTenant,
            out var readPrincipal,
            out var readJob,
            out var readItem,
            out var readWorkspace,
            out var readScope,
            out var readExecution));
        Assert.Equal(tenantId, readTenant);
        Assert.Equal(principalId, readPrincipal);
        Assert.Equal(jobId, readJob);
        Assert.Equal(itemId, readItem);
        Assert.Equal(workspaceId, readWorkspace);
        Assert.Equal("subtree", readScope);
        Assert.Equal(executionId, readExecution);
        Assert.Null(result.ClaimsIdentity.FindFirst(SelfIssuedTokenService.AccessTokenClaim));
        Assert.Null(result.ClaimsIdentity.FindFirst(SelfIssuedTokenService.BrowserSessionClaim));
    }

    [Theory]
    [InlineData(PetTurnMode.Read, 15)]
    [InlineData(PetTurnMode.Write, 2)]
    [InlineData(PetTurnMode.Admin, 2)]
    public async Task A_pet_turn_token_round_trips_with_its_mode_and_lifetime(PetTurnMode mode, int minutes)
    {
        var mintedAt = DateTimeOffset.UtcNow;
        using var service = Service(Configuration(FreshKeyPem()), new Support.FixedTimeProvider(mintedAt));
        var tenantId = TenantId.From(Guid.NewGuid());
        var principalId = PrincipalId.Create();
        var requestId = Guid.NewGuid();

        var token = service.MintPetTurn(principalId, tenantId, requestId, mode);

        var handler = new JwtSecurityTokenHandler { MapInboundClaims = false };
        var result = await handler.ValidateTokenAsync(token, service.CreateValidationParameters());
        Assert.True(result.IsValid);
        Assert.True(SelfIssuedTokenService.TryReadPetTurnClaims(
            result.ClaimsIdentity, out var readTenant, out var readPrincipal, out var readRequest, out var readMode));
        Assert.Equal(tenantId, readTenant);
        Assert.Equal(principalId, readPrincipal);
        Assert.Equal(requestId, readRequest);
        Assert.Equal(mode, readMode);
        var expires = handler.ReadJwtToken(token).ValidTo;
        Assert.Equal(mintedAt.UtcDateTime.AddMinutes(minutes), expires, TimeSpan.FromSeconds(1));
        Assert.Null(result.ClaimsIdentity.FindFirst(SelfIssuedTokenService.AccessTokenClaim));
        Assert.Null(result.ClaimsIdentity.FindFirst(SelfIssuedTokenService.BrowserSessionClaim));
    }

    [Fact]
    public void A_pet_turn_token_refuses_empty_ids_and_an_unconfigured_service()
    {
        using var service = Service(Configuration(FreshKeyPem()));
        using var unconfigured = Service(Configuration(signingKeyPem: null));

        Assert.Throws<ArgumentException>(() =>
            service.MintPetTurn(PrincipalId.From(Guid.Empty), TenantId.From(Guid.NewGuid()), Guid.NewGuid(), PetTurnMode.Read));
        Assert.Throws<ArgumentException>(() =>
            service.MintPetTurn(PrincipalId.Create(), TenantId.From(Guid.NewGuid()), Guid.Empty, PetTurnMode.Read));
        Assert.Throws<InvalidOperationException>(() =>
            unconfigured.MintPetTurn(PrincipalId.Create(), TenantId.From(Guid.NewGuid()), Guid.NewGuid(), PetTurnMode.Read));
    }

    [Fact]
    public void Pet_turn_claims_are_refused_when_another_token_kind_is_mixed_in_or_the_mode_is_unknown()
    {
        var principal = Guid.NewGuid().ToString("D");
        var tenant = Guid.NewGuid().ToString("D");
        var turn = Guid.NewGuid().ToString("D");
        ClaimsIdentity Identity(string mode, params Claim[] extra) => new(
            [
                new Claim("sub", principal),
                new Claim(SelfIssuedTokenService.TenantClaim, tenant),
                new Claim(SelfIssuedTokenService.PetTurnClaim, turn),
                new Claim(SelfIssuedTokenService.PetModeClaim, mode),
                .. extra,
            ]);

        Assert.True(SelfIssuedTokenService.TryReadPetTurnClaims(Identity("read"), out _, out _, out _, out _));
        Assert.False(SelfIssuedTokenService.TryReadPetTurnClaims(Identity("root"), out _, out _, out _, out _));
        Assert.False(SelfIssuedTokenService.TryReadPetTurnClaims(Identity("READ"), out _, out _, out _, out _));
        Assert.False(SelfIssuedTokenService.TryReadPetTurnClaims(
            Identity("read", new Claim(SelfIssuedTokenService.AccessTokenClaim, Guid.NewGuid().ToString("D"))), out _, out _, out _, out _));
        Assert.False(SelfIssuedTokenService.TryReadPetTurnClaims(
            Identity("read", new Claim(SelfIssuedTokenService.BrowserSessionClaim, Guid.NewGuid().ToString("D"))), out _, out _, out _, out _));
        Assert.False(SelfIssuedTokenService.TryReadPetTurnClaims(
            Identity("read", new Claim(SelfIssuedTokenService.WorkerExecutionClaim, "x")), out _, out _, out _, out _));
    }

    [Fact]
    public async Task An_expired_pet_turn_token_does_not_validate()
    {
        using var service = Service(
            Configuration(FreshKeyPem()),
            new Support.FixedTimeProvider(new DateTimeOffset(2026, 8, 1, 12, 0, 0, TimeSpan.Zero)));

        var token = service.MintPetTurn(PrincipalId.Create(), TenantId.From(Guid.NewGuid()), Guid.NewGuid(), PetTurnMode.Read);

        var handler = new JwtSecurityTokenHandler { MapInboundClaims = false };
        Assert.False((await handler.ValidateTokenAsync(token, service.CreateValidationParameters())).IsValid);
    }

    [Fact]
    public async Task A_token_signed_by_a_different_key_does_not_validate()
    {
        using var minter = Service(Configuration(FreshKeyPem()));
        using var validator = Service(Configuration(FreshKeyPem()));

        var token = minter.Mint(
            PrincipalId.Create(),
            TenantId.From(Guid.NewGuid()),
            PersonalAccessTokenId.Create());

        var handler = new JwtSecurityTokenHandler { MapInboundClaims = false };
        var result = await handler.ValidateTokenAsync(token, validator.CreateValidationParameters());

        Assert.False(result.IsValid);
    }

    [Fact]
    public async Task A_token_that_has_outlived_its_minutes_does_not_validate()
    {
        var mintedAt = new DateTimeOffset(2026, 8, 1, 12, 0, 0, TimeSpan.Zero);
        using var service = Service(
            Configuration(FreshKeyPem()),
            new Support.FixedTimeProvider(mintedAt));

        var token = service.Mint(
            PrincipalId.Create(),
            TenantId.From(Guid.NewGuid()),
            PersonalAccessTokenId.Create());

        // The validating handler judges lifetime against the real clock, which sits years past
        // the frozen mint. This is the whole reason the mint takes an injected clock: the test
        // can put the expiry wherever it needs it.
        var handler = new JwtSecurityTokenHandler { MapInboundClaims = false };
        var result = await handler.ValidateTokenAsync(token, service.CreateValidationParameters());

        Assert.False(result.IsValid);
    }

    [Fact]
    public void A_key_can_arrive_as_a_file_the_way_a_mounted_secret_does()
    {
        var path = Path.Combine(Path.GetTempPath(), $"nix-test-key-{Guid.NewGuid():N}.pem");
        File.WriteAllText(path, FreshKeyPem());
        try
        {
            var values = new Dictionary<string, string?>
            {
                [SelfIssuedTokenService.IssuerConfigurationKey] = Issuer,
                [SelfIssuedTokenService.AudienceConfigurationKey] = Audience,
                [SelfIssuedTokenService.KeyIdConfigurationKey] = KeyId,
                [SelfIssuedTokenService.SigningKeyFileConfigurationKey] = path,
            };
            using var service = Service(
                new ConfigurationBuilder().AddInMemoryCollection(values).Build());

            Assert.True(service.IsConfigured);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void A_key_file_that_does_not_exist_is_treated_as_unconfigured()
    {
        var values = new Dictionary<string, string?>
        {
            [SelfIssuedTokenService.IssuerConfigurationKey] = Issuer,
            [SelfIssuedTokenService.AudienceConfigurationKey] = Audience,
            [SelfIssuedTokenService.KeyIdConfigurationKey] = KeyId,
            [SelfIssuedTokenService.SigningKeyFileConfigurationKey] = "/nowhere/at/all.pem",
        };
        using var service = Service(
            new ConfigurationBuilder().AddInMemoryCollection(values).Build());

        Assert.False(service.IsConfigured);
    }

    [Fact]
    public void The_key_set_describes_the_public_half_under_its_key_id()
    {
        using var service = Service(Configuration(FreshKeyPem()));

        var jwks = service.DescribePublicKeys();

        var key = Assert.Single(jwks.Keys);
        Assert.Equal("EC", key.Kty);
        Assert.Equal("P-256", key.Crv);
        Assert.Equal(KeyId, key.Kid);
        Assert.Equal("ES256", key.Alg);
        Assert.Equal("sig", key.Use);
        Assert.False(string.IsNullOrEmpty(key.X));
        Assert.False(string.IsNullOrEmpty(key.Y));
    }

    [Fact]
    public void Claims_missing_from_a_signed_token_are_refused_whole()
    {
        var identity = new System.Security.Claims.ClaimsIdentity(
        [
            new System.Security.Claims.Claim("sub", "subject"),
            new System.Security.Claims.Claim(SelfIssuedTokenService.TenantClaim, Guid.NewGuid().ToString("D")),
        ]);

        Assert.False(SelfIssuedTokenService.TryReadClaims(identity, out _, out _, out _));
    }

    // The three forgeries the service's own comment claims immunity to: algorithm confusion has
    // "no algorithm confusion to have". The reviewer proved these refuse by hand; these keep the
    // claim honest across a library upgrade, which is the one thing that could silently break it.

    [Fact]
    public async Task An_alg_none_token_carrying_genuine_claims_does_not_validate()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var service = Service(Configuration(key.ExportECPrivateKeyPem()));

        // header {"alg":"none"}, real payload, empty signature.
        var header = Base64Url("{\"alg\":\"none\",\"typ\":\"JWT\"}");
        var payload = Base64Url(
            $"{{\"iss\":\"{Issuer}\",\"aud\":\"{Audience}\",\"sub\":\"s\","
            + "\"exp\":9999999999,\"nbf\":1000000000}");
        var forged = $"{header}.{payload}.";

        var handler = new JwtSecurityTokenHandler { MapInboundClaims = false };
        var result = await handler.ValidateTokenAsync(forged, service.CreateValidationParameters());

        Assert.False(result.IsValid);
    }

    [Fact]
    public async Task An_hmac_token_keyed_with_the_public_point_does_not_validate()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var service = Service(Configuration(key.ExportECPrivateKeyPem()));

        // The classic asymmetric-to-symmetric confusion: sign HS256 with the server's own public
        // key bytes as the shared secret. A validator that inferred the algorithm from the token
        // would accept it; one pinned to ES256 cannot.
        var publicPoint = key.ExportSubjectPublicKeyInfo();
        var handler = new JwtSecurityTokenHandler { MapInboundClaims = false };
        var forged = handler.CreateEncodedJwt(new SecurityTokenDescriptor
        {
            Issuer = Issuer,
            Audience = Audience,
            Subject = new ClaimsIdentity([new Claim("sub", "s")]),
            Expires = DateTime.UtcNow.AddMinutes(5),
            SigningCredentials = new SigningCredentials(
                new SymmetricSecurityKey(publicPoint),
                SecurityAlgorithms.HmacSha256),
        });

        var result = await handler.ValidateTokenAsync(forged, service.CreateValidationParameters());

        Assert.False(result.IsValid);
    }

    [Fact]
    public async Task A_genuinely_signed_token_for_the_wrong_audience_does_not_validate()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var service = Service(Configuration(key.ExportECPrivateKeyPem()));

        using var signingKey = ECDsa.Create();
        signingKey.ImportECPrivateKey(key.ExportECPrivateKey(), out _);
        var handler = new JwtSecurityTokenHandler { MapInboundClaims = false };
        var forged = handler.CreateEncodedJwt(new SecurityTokenDescriptor
        {
            Issuer = Issuer,
            Audience = "some-other-service",
            Subject = new ClaimsIdentity([new Claim("sub", "s")]),
            Expires = DateTime.UtcNow.AddMinutes(5),
            SigningCredentials = new SigningCredentials(
                new ECDsaSecurityKey(signingKey) { KeyId = KeyId },
                SecurityAlgorithms.EcdsaSha256),
        });

        var result = await handler.ValidateTokenAsync(forged, service.CreateValidationParameters());

        Assert.False(result.IsValid);
    }

    private static string Base64Url(string text) =>
        Microsoft.AspNetCore.WebUtilities.Base64UrlTextEncoder.Encode(Encoding.UTF8.GetBytes(text));

    private static string FreshKeyPem()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        return key.ExportECPrivateKeyPem();
    }

    private static IConfiguration Configuration(string? signingKeyPem)
    {
        var values = new Dictionary<string, string?>
        {
            [SelfIssuedTokenService.IssuerConfigurationKey] = Issuer,
            [SelfIssuedTokenService.AudienceConfigurationKey] = Audience,
            [SelfIssuedTokenService.KeyIdConfigurationKey] = KeyId,
        };

        if (signingKeyPem is not null)
        {
            values[SelfIssuedTokenService.SigningKeyConfigurationKey] = signingKeyPem;
        }

        return new ConfigurationBuilder().AddInMemoryCollection(values).Build();
    }

    private static SelfIssuedTokenService Service(
        IConfiguration configuration,
        TimeProvider? clock = null) =>
        new(configuration, clock ?? TimeProvider.System);
}
