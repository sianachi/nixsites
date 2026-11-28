using System.Data.Common;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Features.Items;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence;
using Nix.Persistence.ObjectStorage;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class UnitOfWorkResponseTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_read_only_event_stream_still_reaches_the_client_before_the_endpoint_finishes()
    {
        await using var app = BuildApp(new CommitGate(false));
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        app.MapGet("/stream", async (HttpContext context) =>
        {
            context.Response.ContentType = "text/event-stream";
            await context.Response.WriteAsync("data: first\n\n", context.RequestAborted);
            await context.Response.Body.FlushAsync(context.RequestAborted);
            await resume.Task.WaitAsync(context.RequestAborted);
            return TypedResults.Empty;
        }).Produces(StatusCodes.Status200OK, contentType: "text/event-stream");
        var bearer = await SeedSessionAsync(app);
        await app.StartAsync(Cancellation);
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        try
        {
            using var response = await client.GetAsync(new Uri("/stream", UriKind.Relative), HttpCompletionOption.ResponseHeadersRead, Cancellation)
                .WaitAsync(TimeSpan.FromSeconds(10), Cancellation);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(Cancellation));
            Assert.Equal("data: first", await reader.ReadLineAsync(Cancellation));
        }
        finally
        {
            resume.TrySetResult();
        }
        await app.StopAsync(Cancellation);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task A_success_response_waits_for_commit_and_a_failed_commit_returns_a_problem(bool failCommit)
    {
        var gate = new CommitGate(failCommit);
        await using var app = BuildApp(gate);
        var bearer = await SeedSessionAsync(app);
        await app.StartAsync(Cancellation);
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        gate.Enabled = true;

        var request = new HttpRequestMessage(HttpMethod.Post, "/write");
        HttpResponseMessage? response = null;
        try
        {
            var pending = client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, Cancellation);
            try
            {
                await gate.BeforeCommit.Task.WaitAsync(TimeSpan.FromSeconds(10), Cancellation);
                Assert.False(gate.ResponseStarted);
            }
            finally
            {
                gate.Resume.TrySetResult();
                response = await pending;
            }
            Assert.Equal(failCommit ? HttpStatusCode.InternalServerError : HttpStatusCode.Created, response.StatusCode);
            Assert.Equal(failCommit ? "application/problem+json" : "application/json", response.Content.Headers.ContentType?.MediaType);
            var body = await response.Content.ReadAsStringAsync(Cancellation);
            if (failCommit)
            {
                Assert.DoesNotContain("Committed HTTP item", body, StringComparison.Ordinal);
            }
            else
            {
                Assert.Contains("Committed HTTP item", body, StringComparison.Ordinal);
            }
        }
        finally
        {
            response?.Dispose();
            request.Dispose();
        }

        await using var verify = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        Assert.Equal(failCommit ? 0 : 1, await verify.DbContext.Database.SqlQuery<int>(
            $"SELECT count(*)::integer AS \"Value\" FROM item WHERE properties ->> 'title' = 'Committed HTTP item'").SingleAsync(Cancellation));
        await app.StopAsync(Cancellation);
    }

    [Theory]
    [InlineData("a.a.a")]
    [InlineData("")]
    public async Task Malformed_bearers_return_401_and_use_the_failed_authentication_throttle(string token)
    {
        await using var app = BuildApp(new CommitGate(false));
        await app.StartAsync(Cancellation);
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
        for (var attempt = 0; attempt <= FailedAuthenticationThrottle.DefaultLimit; attempt++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/write");
            request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + token);
            using var response = await client.SendAsync(request, Cancellation);
            Assert.Equal(attempt < FailedAuthenticationThrottle.DefaultLimit
                ? HttpStatusCode.Unauthorized : HttpStatusCode.TooManyRequests, response.StatusCode);
        }
        Assert.Equal(1, app.Services.GetRequiredService<FailedAuthenticationThrottle>().TrackedClients);
        await app.StopAsync(Cancellation);
    }

    private WebApplication BuildApp(CommitGate gate)
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            [SelfIssuedTokenService.IssuerConfigurationKey] = "https://response.test",
            [SelfIssuedTokenService.AudienceConfigurationKey] = "nix-response-test",
            [SelfIssuedTokenService.KeyIdConfigurationKey] = "response-test",
            [SelfIssuedTokenService.SigningKeyConfigurationKey] = key.ExportPkcs8PrivateKeyPem(),
        });
        builder.Services.AddNixPersistence(fixture.ApplicationConnectionString);
        builder.Services.AddNixObjectStorage(builder.Configuration);
        builder.Services.AddSingleton<SelfIssuedTokenService>();
        builder.Services.AddSingleton<NixTokenValidator>();
        builder.Services.AddSingleton(new FailedAuthenticationThrottle(TimeProvider.System,
            FailedAuthenticationThrottle.DefaultLimit, FailedAuthenticationThrottle.DefaultWindow));
        builder.Services.AddHttpClient<IUserInfoClient, UserInfoClient>();
        builder.Services.AddProblemDetails();
        builder.Services.AddHttpContextAccessor();
        builder.Services.AddDbContext<NixDbContext>((services, options) =>
        {
            gate.Context = services.GetRequiredService<IHttpContextAccessor>();
            options.AddInterceptors(gate);
        });
        var app = builder.Build();
        app.UseExceptionHandler();
        app.UseMiddleware<NixUnitOfWorkMiddleware>();
        app.MapPost("/write", async (NixDispatcher dispatcher, HttpContext context) =>
        {
            var result = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(TestTenants.AlphaContext.WorkspaceId!.Value, "note", "Committed HTTP item", null, null),
                context.RequestAborted);
            Assert.True(result.IsSuccess);
            return TypedResults.Created("/items/" + result.Value.Id, new { title = "Committed HTTP item" });
        });
        return app;
    }

    private static async Task<string> SeedSessionAsync(WebApplication app)
    {
        var sessionId = BrowserSessionId.Create();
        await using var scope = app.Services.CreateAsyncScope();
        var services = scope.ServiceProvider;
        var context = TestTenants.AlphaContext;
        services.GetRequiredService<ScopedNixSessionContextAccessor>().Set(context);
        var database = services.GetRequiredService<NixDbContext>();
        await using var transaction = await database.Database.BeginTransactionAsync(Cancellation);
        await services.GetRequiredService<IBrowserSessions>().AddAsync(new BrowserSession
        {
            Id = sessionId,
            TenantId = context.TenantId,
            PrincipalId = context.PrincipalId,
            TokenHash = BrowserSessionSecret.Mint().Hash,
            CreatedAt = DateTimeOffset.UtcNow,
            ExpiresAt = DateTimeOffset.UtcNow.AddHours(1),
        }, Cancellation);
        await transaction.CommitAsync(Cancellation);
        return services.GetRequiredService<SelfIssuedTokenService>()
            .MintBrowserSession(context.PrincipalId, context.TenantId, sessionId);
    }

    private sealed class CommitGate(bool failCommit) : DbTransactionInterceptor
    {
        internal bool Enabled { get; set; }
        internal bool ResponseStarted { get; private set; }
        internal IHttpContextAccessor Context { get; set; } = null!;
        internal TaskCompletionSource BeforeCommit { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource Resume { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override async ValueTask<InterceptionResult> TransactionCommittingAsync(DbTransaction transaction,
            TransactionEventData eventData, InterceptionResult result, CancellationToken cancellationToken = default)
        {
            if (Enabled)
            {
                ResponseStarted = Context.HttpContext!.Response.HasStarted;
                BeforeCommit.TrySetResult();
                await Resume.Task.WaitAsync(cancellationToken);
                if (failCommit)
                {
                    throw new IOException("Injected commit failure.");
                }
            }
            return result;
        }
    }
}
