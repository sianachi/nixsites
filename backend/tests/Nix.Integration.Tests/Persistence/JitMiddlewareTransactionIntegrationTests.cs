using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.IdentityModel.Tokens;
using Nix.Abstractions;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Audit;
using Nix.Domain.Identity;
using Nix.Domain.Provisioning;
using Nix.Domain.Tenancy;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence;
using Nix.Persistence.Identity;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class JitMiddlewareTransactionIntegrationTests : IAsyncLifetime
{
    private readonly NixPostgresFixture _fixture;

    public JitMiddlewareTransactionIntegrationTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null,
                $"""
                UPDATE identity_provider
                   SET jit_provisioning_enabled = true
                 WHERE provider_id = '{M0SchemaSeed.Alpha.ProviderId:D}'::uuid
                """);
        }
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Successful_bounded_userinfo_provisioning_and_endpoint_work_commit_together()
    {
        var principalId = await RunAsync(EndpointOutcome.Success);

        await AssertDurableCountsAsync(principalId, expectedPrincipal: 1, expectedEndpointAudit: 1);
    }

    [Fact]
    public async Task An_endpoint_failure_status_rolls_back_provisioning_and_endpoint_work_together()
    {
        var principalId = await RunAsync(EndpointOutcome.FailureStatus);

        await AssertDurableCountsAsync(principalId, expectedPrincipal: 0, expectedEndpointAudit: 0);
    }

    [Fact]
    public async Task An_endpoint_exception_rolls_back_provisioning_and_endpoint_work_together()
    {
        var principalId = DeterministicPrincipal();

        await Assert.ThrowsAsync<InvalidOperationException>(() => RunAsync(EndpointOutcome.Throw));
        await AssertDurableCountsAsync(principalId, expectedPrincipal: 0, expectedEndpointAudit: 0);
    }

    [System.Diagnostics.CodeAnalysis.SuppressMessage(
        "Reliability",
        "CA2000:Dispose objects before losing scope",
        Justification = "Each HttpClient owns its handler and both clients are disposed by this method.")]
    private async Task<PrincipalId> RunAsync(EndpointOutcome outcome)
    {
        const string issuer = "https://issuer.alpha.test";
        const string subject = "middleware-jit-subject";
        var jwksUri = $"{issuer}/keys/{Guid.NewGuid():N}";
        var setupConnection = await _fixture.OpenMigratorConnectionAsync();
        await using (setupConnection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(setupConnection, null,
                $"""
                UPDATE identity_provider
                   SET jwks_uri = '{jwksUri}'
                 WHERE provider_id = '{M0SchemaSeed.Alpha.ProviderId:D}'::uuid
                """);
        }

        using var rsa = RSA.Create(2048);
        var signingKey = new RsaSecurityKey(rsa) { KeyId = "middleware-jit-key" };
        var rawToken = SignedToken(issuer, "nix-api", subject, signingKey);
        using var jwksClient = new HttpClient(new StaticHandler(Jwks(rsa, signingKey.KeyId)));
        using var userInfoClient = new HttpClient(new StaticHandler(
            "{\"sub\":\"middleware-jit-subject\",\"name\":\"Middleware Person\","
            + "\"email\":\"middleware@example.test\",\"email_verified\":true}"));
        using var selfIssued = new SelfIssuedTokenService(
            new ConfigurationBuilder().Build(),
            TimeProvider.System);

        var scope = _fixture.Application.CreateUnscopedScope();
        await using (scope.ConfigureAwait(false))
        {
            var services = scope.ServiceProvider;
            var directory = services.GetRequiredService<IIdentityDirectory>();
            var database = services.GetRequiredService<NixDbContext>();
            var principalId = DeterministicPrincipal();
            var workspaceId = DeterministicProvisioningId.PersonalWorkspace(principalId);
            var endpointEventId = AuditEventId.Create();
            var middleware = new NixUnitOfWorkMiddleware(async context =>
            {
                database.AuditEvents.Add(new AuditEvent
                {
                    Id = endpointEventId,
                    TenantId = TenantId.From(M0SchemaSeed.Alpha.TenantId),
                    WorkspaceId = workspaceId,
                    ActorId = principalId,
                    Action = "test.endpoint_executed",
                    SubjectId = endpointEventId.Value,
                    SubjectType = "test",
                    OccurredAt = DateTimeOffset.UtcNow,
                });
                await database.SaveChangesAsync(context.RequestAborted);

                if (outcome == EndpointOutcome.FailureStatus)
                {
                    context.Response.StatusCode = StatusCodes.Status409Conflict;
                }
                else if (outcome == EndpointOutcome.Throw)
                {
                    throw new InvalidOperationException("Injected endpoint failure.");
                }
            });
            var context = new DefaultHttpContext();
            context.Connection.RemoteIpAddress = IPAddress.Parse("192.0.2.30");
            context.Request.Path = "/api/v1/workspaces";
            context.Request.Headers.Authorization = $"Bearer {rawToken}";
            context.Response.Body = new MemoryStream();

            await middleware.InvokeAsync(
                context,
                new NixTokenValidator(directory, selfIssued, jwksClient),
                directory,
                services.GetRequiredService<ScopedNixSessionContextAccessor>(),
                database,
                new FailedAuthenticationThrottle(TimeProvider.System, 3, TimeSpan.FromMinutes(5)),
                services.GetRequiredService<IPersonalAccessTokens>(),
                services.GetRequiredService<IBrowserSessions>(),
                services.GetRequiredService<IWorkerDispatchStore>(),
                services.GetRequiredService<AccessTokenSessionContext>(),
                services.GetRequiredService<CredentialSessionContext>(),
                new UserInfoClient(userInfoClient, TimeSpan.FromSeconds(5)),
                services.GetRequiredService<NixDispatcher>(),
                TimeProvider.System,
                NullLogger<NixUnitOfWorkMiddleware>.Instance);

            Assert.Equal(
                outcome == EndpointOutcome.FailureStatus
                    ? StatusCodes.Status409Conflict
                    : StatusCodes.Status200OK,
                context.Response.StatusCode);
            return principalId;
        }
    }

    private async Task AssertDurableCountsAsync(
        PrincipalId principalId,
        long expectedPrincipal,
        long expectedEndpointAudit)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            Assert.Equal(expectedPrincipal, await RawSql.CountAsync(connection, null,
                $"SELECT count(*) FROM principal WHERE principal_id = '{principalId.Value:D}'::uuid"));
            Assert.Equal(expectedEndpointAudit, await RawSql.CountAsync(connection, null,
                $"SELECT count(*) FROM audit_event WHERE actor_id = '{principalId.Value:D}'::uuid AND action = 'test.endpoint_executed'"));
        }
    }

    private static PrincipalId DeterministicPrincipal() =>
        DeterministicProvisioningId.Principal(
            TenantId.From(M0SchemaSeed.Alpha.TenantId),
            "https://issuer.alpha.test",
            "middleware-jit-subject");

    private static string SignedToken(string issuer, string audience, string subject, SecurityKey key)
    {
        var token = new JwtSecurityToken(
            issuer,
            audience,
            [new Claim("sub", subject), new Claim("azp", audience)],
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

    private enum EndpointOutcome
    {
        Success,
        FailureStatus,
        Throw,
    }

    private sealed class StaticHandler(string response) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(response, Encoding.UTF8, "application/json"),
            });
    }
}
