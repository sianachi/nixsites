using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Abstractions.Calendar;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Calendar;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Features.CalendarSync;
using Nix.Features.Tokens;
using Nix.Messaging;
using Nix.Persistence.Workers;

namespace Nix.Integration.Tests.Harness;

/// <summary>
/// One Core host wired for calendar sync against the Postgres fixture and a
/// <see cref="FakeCalendarProviderServer"/>: both providers configured at the fake's loopback
/// origin, a temporary persisted Data Protection key ring, the internal secret, and signed-in
/// browser sessions on demand.
/// </summary>
internal sealed class CalendarSyncHost : IAsyncDisposable
{
    public const string InternalSecret = "calendar-internal-secret";
    public const string PublicOrigin = "https://nix.calendar.test";

    private readonly string _keysPath;

    private CalendarSyncHost(FakeCalendarProviderServer provider, WebApplicationFactory<Program> factory, HttpClient client, string keysPath)
    {
        Provider = provider;
        Factory = factory;
        Client = client;
        _keysPath = keysPath;
    }

    public FakeCalendarProviderServer Provider { get; }

    public WebApplicationFactory<Program> Factory { get; }

    public HttpClient Client { get; }

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public static async Task<CalendarSyncHost> StartAsync(NixPostgresFixture fixture)
    {
        var provider = await FakeCalendarProviderServer.StartAsync();
        var keysPath = Path.Combine(Path.GetTempPath(), $"nix-calendar-keys-{Guid.NewGuid():N}");
        string signingKey;
        using (var key = ECDsa.Create(ECCurve.NamedCurves.nistP256))
        {
            signingKey = key.ExportECPrivateKeyPem();
        }

        var settings = new Dictionary<string, string?>
        {
            ["ConnectionStrings:Nix"] = fixture.ApplicationConnectionString,
            ["Nix:Scheduling:Enabled"] = "false",
            [InternalBoundaryMiddleware.SecretConfigurationKey] = InternalSecret,
            [SelfIssuedTokenService.IssuerConfigurationKey] = "https://core.calendar.test",
            [SelfIssuedTokenService.AudienceConfigurationKey] = "nix",
            [SelfIssuedTokenService.KeyIdConfigurationKey] = "calendar-key",
            [SelfIssuedTokenService.SigningKeyConfigurationKey] = signingKey,
            ["Nix:Bff:PublicOrigin"] = PublicOrigin,
            ["Nix:Bff:DataProtectionKeysPath"] = keysPath,
            ["Nix:Calendar:PublicOrigin"] = PublicOrigin,
        };
        foreach (var name in new[] { "Google", "Microsoft" })
        {
            settings[$"Nix:Calendar:{name}:ClientId"] = $"{name}-client";
            settings[$"Nix:Calendar:{name}:ClientSecret"] = $"{name}-secret";
            settings[$"Nix:Calendar:{name}:AuthorizeOrigin"] = provider.Origin;
            settings[$"Nix:Calendar:{name}:TokenOrigin"] = provider.Origin;
            settings[$"Nix:Calendar:{name}:ApiOrigin"] = provider.Origin;
        }

        var factory = new ConfiguredApplicationFactory(settings);
        var client = factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            AllowAutoRedirect = false,
            HandleCookies = false,
            BaseAddress = new Uri(PublicOrigin),
        });
        return new CalendarSyncHost(provider, factory, client, keysPath);
    }

    /// <summary>Opens a unit of work against this host's own container.</summary>
    public Task<NixUnitOfWork> BeginAsync(NixSessionContext context) =>
        NixUnitOfWork.StartAsync(Factory.Services.CreateAsyncScope(), context, System.Data.IsolationLevel.ReadCommitted, Cancellation);

    /// <summary>Creates a browser session for a principal and returns its cookie value.</summary>
    public async Task<string> SignInAsync(NixSessionContext context)
    {
        var secret = BrowserSessionSecret.Mint();
        await using var work = await BeginAsync(NixSessionContext.ForTenant(context.TenantId, context.PrincipalId));
        await work.Resolve<IBrowserSessions>().AddAsync(new BrowserSession
        {
            Id = BrowserSessionId.Create(),
            TenantId = context.TenantId,
            PrincipalId = context.PrincipalId,
            TokenHash = secret.Hash,
            CreatedAt = DateTimeOffset.UtcNow,
            ExpiresAt = DateTimeOffset.UtcNow.AddHours(1),
        }, Cancellation);
        await work.CommitAsync(Cancellation);
        return secret.Token;
    }

    /// <summary>The interactive bearer a signed-in browser receives from <c>/auth/session</c>.</summary>
    public async Task<string> BearerAsync(string sessionCookie)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "/auth/session");
        request.Headers.Add("Cookie", $"__Host-nix_session={sessionCookie}");
        using var response = await Client.SendAsync(request, Cancellation);
        response.EnsureSuccessStatusCode();
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Cancellation));
        return body.RootElement.GetProperty("accessToken").GetString()!;
    }

    /// <summary>A personal access token's exchanged bearer.</summary>
    public async Task<string> AccessTokenAsync(NixSessionContext context, string[] scopes)
    {
        await using var work = await BeginAsync(context);
        var result = await work.Resolve<NixDispatcher>().SendAsync<CreateAccessToken, IssuedAccessToken>(
            new CreateAccessToken($"calendar-{Guid.NewGuid():N}", scopes, 1), Cancellation);
        await work.CommitAsync(Cancellation);
        using var exchange = await Client.PostAsJsonAsync("/public/v1/auth/token", new { token = result.Value.Secret }, Cancellation);
        exchange.EnsureSuccessStatusCode();
        using var body = JsonDocument.Parse(await exchange.Content.ReadAsStringAsync(Cancellation));
        return body.RootElement.GetProperty("accessToken").GetString()!;
    }

    /// <summary>Sends an authenticated API request.</summary>
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

    /// <summary>Stores an active connection whose refresh token is <paramref name="refreshToken"/>.</summary>
    public async Task<Guid> ConnectAsync(NixSessionContext context, string provider = "google", string refreshToken = "refresh-initial", string? cachedAccessToken = null)
    {
        var protector = Factory.Services.GetRequiredService<CalendarTokenProtector>();
        await using var work = await BeginAsync(context);
        var id = await work.Resolve<ICalendarSyncStore>().UpsertConnectionAsync(
            context.TenantId,
            context.PrincipalId,
            new CalendarConnectionGrant(
                provider,
                $"{provider}-subject-{Guid.NewGuid():N}",
                "person@example.test",
                "openid email",
                protector.ProtectRefreshToken(refreshToken),
                protector.ProtectAccessToken(cachedAccessToken ?? "access-stale"),
                cachedAccessToken is null ? DateTimeOffset.UtcNow.AddMinutes(-1) : DateTimeOffset.UtcNow.AddHours(1)),
            DateTimeOffset.UtcNow,
            Cancellation);
        await work.CommitAsync(Cancellation);
        return id;
    }

    /// <summary>Creates a container with the calendar schema and a link to it, straight in the store.</summary>
    public async Task<CalendarLink> LinkAsync(NixSessionContext context, Guid connectionId, string direction = "two_way", string externalCalendarId = "primary")
    {
        await using var work = await BeginAsync(context);
        var created = await work.Resolve<NixDispatcher>().SendAsync<Nix.Features.Views.CreateStructuredItem, Item>(
            new Nix.Features.Views.CreateStructuredItem(
                context.WorkspaceId!.Value,
                "folder",
                $"Calendar {Guid.NewGuid():N}",
                null,
                CalendarContainerSchema.Schema,
                [CalendarContainerSchema.CalendarView],
                CalendarContainerSchema.ViewId),
            Cancellation);
        Assert.True(created.IsSuccess, created.IsSuccess ? string.Empty : created.Error.Message);
        var now = DateTimeOffset.UtcNow;
        var link = new CalendarLink
        {
            TenantId = context.TenantId,
            Id = Guid.CreateVersion7(),
            PrincipalId = context.PrincipalId,
            ConnectionId = connectionId,
            WorkspaceId = context.WorkspaceId!.Value,
            ContainerItemId = created.Value.Id,
            ExternalCalendarId = externalCalendarId,
            Name = "Work",
            Direction = direction,
            WindowPastDays = 30,
            WindowFutureDays = 365,
            Status = "active",
            Revision = 1,
            CreatedAt = now,
            UpdatedAt = now,
        };
        Assert.Equal(CalendarLinkWrite.Created, await work.Resolve<ICalendarSyncStore>().InsertLinkAsync(link, Cancellation));
        await work.CommitAsync(Cancellation);
        return link;
    }

    /// <summary>
    /// Enqueues and claims a <c>calendar.sync</c> job for a link, recording it as the link's last
    /// job the way every production enqueue does; returns its job id and execution id.
    /// </summary>
    public async Task<(Guid JobId, string Execution)> ClaimJobAsync(NixSessionContext context, CalendarLink link, bool full = false, string? key = null)
    {
        Guid jobId;
        await using (var work = await BeginAsync(context))
        {
            var job = await work.Resolve<IWorkerJobStore>().CreateAsync(
                context.TenantId, context.PrincipalId, link.WorkspaceId, "calendar.sync",
                key ?? $"test:{Guid.NewGuid():N}",
                $$"""{"linkId":"{{link.Id:D}}","full":{{(full ? "true" : "false")}}}""",
                Cancellation);
            jobId = job.Id;
            await work.Resolve<ICalendarSyncStore>().SetLastJobAsync(link.Id, jobId, DateTimeOffset.UtcNow, Cancellation);
            await work.CommitAsync(Cancellation);
        }

        var execution = $"calendar-worker:{Guid.NewGuid():D}";
        await using var scope = Factory.Services.CreateAsyncScope();
        Assert.NotNull(await scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>().ClaimJobAsync(jobId, execution, 120, Cancellation));
        return (jobId, execution);
    }

    /// <summary>Sends a worker-execution request.</summary>
    public async Task<HttpResponseMessage> WorkerAsync(HttpMethod method, string path, Guid jobId, string execution, string? json = null)
    {
        using var request = new HttpRequestMessage(method, path)
        {
            Content = json is null ? null : new StringContent(json, System.Text.Encoding.UTF8, "application/json"),
        };
        request.Headers.TryAddWithoutValidation(InternalBoundaryMiddleware.SecretHeaderName, InternalSecret);
        request.Headers.TryAddWithoutValidation(WorkerExecutionMiddleware.JobHeaderName, jobId.ToString("D"));
        request.Headers.TryAddWithoutValidation(WorkerExecutionMiddleware.ExecutionHeaderName, execution);
        return await Client.SendAsync(request, Cancellation);
    }

    public async ValueTask DisposeAsync()
    {
        Client.Dispose();
        await Factory.DisposeAsync();
        await Provider.DisposeAsync();
        if (Directory.Exists(_keysPath))
        {
            Directory.Delete(_keysPath, recursive: true);
        }
    }
}
