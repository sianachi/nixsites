using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Features.Tokens;
using Nix.Messaging;

namespace Nix.Integration.Tests.Harness;

/// <summary>
/// The real application hosted against the fixture's database with sites enabled, for tests that
/// go through routes: people send requests with their own access tokens, and a worker sends the
/// lease-bound internal ones.
/// </summary>
internal sealed class SiteHttpHost : IAsyncDisposable
{
    /// <summary>The shared secret the internal boundary expects.</summary>
    public const string InternalSecret = "sites-http-internal-secret";

    private readonly NixPostgresFixture _fixture;
    private readonly WebApplicationFactory<Program> _factory;
    private int _tokens;

    private SiteHttpHost(NixPostgresFixture fixture, WebApplicationFactory<Program> factory)
    {
        _fixture = fixture;
        _factory = factory;
        Client = factory.CreateClient();
    }

    /// <summary>Gets the client for the hosted application.</summary>
    public HttpClient Client { get; }

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    /// <summary>Starts the application.</summary>
    public static SiteHttpHost Create(
        NixPostgresFixture fixture,
        IReadOnlyDictionary<string, string?>? extra = null,
        Action<Microsoft.Extensions.DependencyInjection.IServiceCollection>? services = null)
    {
        ArgumentNullException.ThrowIfNull(fixture);
        string signingKey;
        using (var key = ECDsa.Create(ECCurve.NamedCurves.nistP256))
        {
            signingKey = key.ExportECPrivateKeyPem();
        }

        var settings = SiteScenario.Settings;
        settings["ConnectionStrings:Nix"] = fixture.ApplicationConnectionString;
        settings[InternalBoundaryMiddleware.SecretConfigurationKey] = InternalSecret;
        settings[SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.sites-http.test";
        settings[SelfIssuedTokenService.AudienceConfigurationKey] = "nix";
        settings[SelfIssuedTokenService.KeyIdConfigurationKey] = "sites-http-key";
        settings[SelfIssuedTokenService.SigningKeyConfigurationKey] = signingKey;
        settings["Nix:Collaboration:BaseUrl"] = "http://127.0.0.1:8100";
        settings["Nix:Scheduling:Enabled"] = "false";
        foreach (var (key, value) in extra ?? new Dictionary<string, string?>())
        {
            settings[key] = value;
        }

#pragma warning disable CA2000 // Justification: the host owns the factory and disposes it.
        return new SiteHttpHost(fixture, new ConfiguredFactory(settings, services));
#pragma warning restore CA2000
    }

    /// <summary>
    /// Issues an access token to <paramref name="who"/> and exchanges it for a bearer. Site changes
    /// need the admin scope, so the default token holds it; pass <paramref name="admin"/> false for
    /// the ordinary read and write ceiling.
    /// </summary>
    public async Task<string> TokenAsync(NixSessionContext who, bool admin = true)
    {
        _tokens++;
        await using var work = await _fixture.Application.BeginUnitOfWorkAsync(who, Cancellation);
        var issued = await work.Resolve<NixDispatcher>().SendAsync<CreateAccessToken, IssuedAccessToken>(
            new CreateAccessToken(
                "sites-http-" + _tokens,
                admin ? [AccessTokenScopes.Read, AccessTokenScopes.Write, AccessTokenScopes.Admin] : [AccessTokenScopes.Read, AccessTokenScopes.Write],
                1),
            Cancellation);
        Assert.True(issued.IsSuccess, issued.IsFailure ? issued.Error.Message : string.Empty);
        await work.CommitAsync(Cancellation);
        using var exchange = await Client.PostAsJsonAsync("/public/v1/auth/token", new { token = issued.Value.Secret }, Cancellation);
        exchange.EnsureSuccessStatusCode();
        using var body = JsonDocument.Parse(await exchange.Content.ReadAsStringAsync(Cancellation));
        return body.RootElement.GetProperty("accessToken").GetString()!;
    }

    /// <summary>
    /// Signs <paramref name="who"/> in with a browser session and returns its interactive bearer, the
    /// kind no access token scope reaches interactive-only routes with.
    /// </summary>
    public async Task<string> InteractiveTokenAsync(NixSessionContext who)
    {
        var sessionId = BrowserSessionId.Create();
        await using (var work = await NixUnitOfWork.StartAsync(
            _factory.Services.CreateAsyncScope(),
            NixSessionContext.ForTenant(who.TenantId, who.PrincipalId),
            System.Data.IsolationLevel.ReadCommitted,
            Cancellation))
        {
            await work.Resolve<IBrowserSessions>().AddAsync(new BrowserSession
            {
                Id = sessionId,
                TenantId = who.TenantId,
                PrincipalId = who.PrincipalId,
                TokenHash = BrowserSessionSecret.Mint().Hash,
                CreatedAt = DateTimeOffset.UtcNow,
                ExpiresAt = DateTimeOffset.UtcNow.AddHours(1),
            }, Cancellation);
            await work.CommitAsync(Cancellation);
        }

        return _factory.Services.GetRequiredService<SelfIssuedTokenService>()
            .MintBrowserSession(who.PrincipalId, who.TenantId, sessionId);
    }

    /// <summary>Sends a public API request with a bearer.</summary>
    public async Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, string bearer, object? body = null)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        return await Client.SendAsync(request, Cancellation);
    }

    /// <summary>Sends a lease-bound internal request as a worker.</summary>
    public async Task<HttpResponseMessage> InternalAsync(HttpMethod method, string path, Guid jobId, string execution, object? body = null)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.TryAddWithoutValidation(InternalBoundaryMiddleware.SecretHeaderName, InternalSecret);
        request.Headers.TryAddWithoutValidation(WorkerExecutionMiddleware.JobHeaderName, jobId.ToString("D"));
        request.Headers.TryAddWithoutValidation(WorkerExecutionMiddleware.ExecutionHeaderName, execution);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        return await Client.SendAsync(request, Cancellation);
    }

    /// <summary>Sends an internal request carrying a bearer, as the collaboration service does for a delegation.</summary>
    public async Task<HttpResponseMessage> InternalBearerAsync(HttpMethod method, string path, string bearer)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        request.Headers.TryAddWithoutValidation(InternalBoundaryMiddleware.SecretHeaderName, InternalSecret);
        return await Client.SendAsync(request, Cancellation);
    }

    /// <summary>Reads a response body as JSON.</summary>
    public static async Task<JsonDocument> JsonAsync(HttpResponseMessage response)
    {
        ArgumentNullException.ThrowIfNull(response);
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
    }

    /// <summary>Reads the stable code of a problem response.</summary>
    public static async Task<string?> ProblemCodeAsync(HttpResponseMessage response)
    {
        using var document = await JsonAsync(response);
        return document.RootElement.GetProperty("code").GetString();
    }

    /// <inheritdoc />
    public async ValueTask DisposeAsync()
    {
        Client.Dispose();
        await _factory.DisposeAsync();
    }

    private sealed class ConfiguredFactory(
        Dictionary<string, string?> settings,
        Action<Microsoft.Extensions.DependencyInjection.IServiceCollection>? services) : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
        {
            foreach (var (key, value) in settings)
            {
                builder.UseSetting(key, value);
            }

            if (services is not null)
            {
                // Test seams only: the DNS resolver and the Cloudflare API are replaced by fakes.
                Microsoft.AspNetCore.TestHost.WebHostBuilderExtensions.ConfigureTestServices(builder, services);
            }
        }
    }
}
