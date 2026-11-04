using System.Net;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Notifications;
using Nix.Features.Notifications;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Workers;
using Nix.Workers.Push;

namespace Nix.Integration.Tests.Workers;

/// <summary>
/// The whole in-process notify path, once: a created notification enqueues <c>notify.push</c>,
/// the hosted notify worker leases it, fetches the delivery over loopback, pushes to a fake push
/// service, reports, and the job completes. A second hand-out of the same notification yields no
/// devices, so a re-run can never push twice.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class NotifyPushEndToEndTests : IAsyncLifetime
{
    private const string InternalSecret = "notify-e2e-internal-secret";
    private readonly NixPostgresFixture _fixture;
    private readonly FakePushService _pushService = new();
    private ConfiguredApplicationFactory _configured = null!;
    private WebApplicationFactory<Program> _factory = null!;

    public NotifyPushEndToEndTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, "DELETE FROM push_subscription");
            await RawSql.ExecuteAsync(connection, transaction: null, "DELETE FROM notification");
        }
        _configured = new ConfiguredApplicationFactory(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Nix"] = _fixture.ApplicationConnectionString,
            [InternalBoundaryMiddleware.SecretConfigurationKey] = InternalSecret,
            ["Nix:Push:VapidPublicKey"] = "test-vapid-public-key",
            ["Nix:Push:VapidPrivateKey"] = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
            ["Nix:Push:VapidSubject"] = "mailto:ops@example.com",
            ["Nix:Workers:LoopbackUrl"] = "http://localhost",
            ["Nix:Workers:SweepSeconds"] = "1",
        });
        _factory = _configured.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            // The test server binds no socket: loopback calls go through its in-memory handler.
            services.AddHttpClient(WorkerLoopbackClient.HttpClientName)
                .ConfigurePrimaryHttpMessageHandler(() => _factory.Server.CreateHandler());
#pragma warning disable CA2000 // Justification: the transport owns and disposes the client with the host.
            services.AddSingleton(new PushTransport(new HttpClient(_pushService)));
#pragma warning restore CA2000
        }));
        _ = _factory.Server;
    }

    public async ValueTask DisposeAsync()
    {
        await _factory.DisposeAsync();
        await _configured.DisposeAsync();
        _pushService.Dispose();
    }

    [Fact]
    public async Task A_new_notification_is_pushed_once_through_the_hosted_worker()
    {
        Guid notificationId;
        await using (var work = await BeginFactoryUnitOfWorkAsync(TestTenants.AlphaContext))
        {
            var saved = await work.Resolve<NixDispatcher>().SendAsync<AddPushSubscription, PushSubscriptionDto>(
                new("https://fcm.googleapis.com/fcm/send/notify-e2e", RealP256dh(), ValidAuth(), "notify-e2e-agent"), Cancellation);
            Assert.True(saved.IsSuccess);
            var created = await work.Resolve<INotificationWriter>().CreateAsync(
                TestTenants.AlphaContext.PrincipalId, NotificationKind.Reminder, "Task due", "Finish the report",
                itemId: null, Nix.Domain.Tenancy.WorkspaceId.From(TestTenants.AlphaWorkspace), "notify-e2e:once", Cancellation);
            Assert.True(created.Created);
            notificationId = created.Notification.Id;
            await work.CommitAsync(Cancellation);
        }

        var status = await WaitForJobAsync(notificationId, TimeSpan.FromSeconds(20));

        Assert.Equal("completed", status);
        var request = Assert.Single(_pushService.Requests);
        Assert.Equal("https://fcm.googleapis.com/fcm/send/notify-e2e", request.Url);
        Assert.Equal("aes128gcm", request.Headers["Content-Encoding"]);
        Assert.Equal("application/octet-stream", request.Headers["Content-Type"]);
        Assert.Equal("86400", request.Headers["TTL"]);
        Assert.Equal("normal", request.Headers["Urgency"]);
        Assert.StartsWith("vapid t=", request.Headers["Authorization"], StringComparison.Ordinal);
        Assert.True(request.BodyLength > 16 + 4 + 1 + 65 + 16);

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var attempted = await RawSql.TextListAsync(connection, $"SELECT (push_attempted_at IS NOT NULL)::text FROM notification WHERE id = '{notificationId}'");
            Assert.Equal("true", Assert.Single(attempted));
            var failures = await RawSql.TextListAsync(connection, "SELECT failures::text FROM push_subscription");
            Assert.Equal("0", Assert.Single(failures));
        }
    }

    private async Task<string> WaitForJobAsync(Guid notificationId, TimeSpan budget)
    {
        var deadline = DateTimeOffset.UtcNow + budget;
        while (DateTimeOffset.UtcNow < deadline)
        {
            var connection = await _fixture.OpenMigratorConnectionAsync();
            await using (connection.ConfigureAwait(false))
            {
                var status = await RawSql.TextListAsync(connection, $"SELECT status FROM worker_job WHERE kind = 'notify.push' AND idempotency_key = 'notify:{notificationId:D}'");
                if (status.Count == 1 && status[0] is "completed" or "failed")
                {
                    return status[0];
                }
            }
            await Task.Delay(250, Cancellation);
        }
        return "timeout";
    }

    private Task<NixUnitOfWork> BeginFactoryUnitOfWorkAsync(NixSessionContext context) =>
        NixUnitOfWork.StartAsync(_factory.Services.CreateAsyncScope(), context, System.Data.IsolationLevel.ReadCommitted, Cancellation);

    // Encryption needs a real point on the curve: the RFC 8291 Appendix A user-agent key.
    private static string RealP256dh() => "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";

    private static string ValidAuth() => "BTBZMqHH6r4Tts7J_aSIgg";

    private sealed class FakePushService : HttpMessageHandler
    {
        public List<(string Url, Dictionary<string, string> Headers, long BodyLength)> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var (name, values) in request.Headers)
            {
                headers[name] = string.Join(",", values);
            }
            foreach (var (name, values) in request.Content!.Headers)
            {
                headers[name] = string.Join(",", values);
            }
            var body = await request.Content.ReadAsByteArrayAsync(cancellationToken);
            lock (Requests)
            {
                Requests.Add((request.RequestUri!.ToString(), headers, body.LongLength));
            }
            return new HttpResponseMessage(HttpStatusCode.Created);
        }
    }
}
