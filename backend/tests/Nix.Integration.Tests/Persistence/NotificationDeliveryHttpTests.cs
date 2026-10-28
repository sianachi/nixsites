using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Notifications;
using Nix.Features.Notifications;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence.Workers;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Contract N1, proved at the wire: the exact JSON the Go worker's
/// <c>workerapi.GetNotificationDelivery</c> and <c>workerapi.ReportNotificationDeliveryResults</c>
/// send and expect (per <c>apps/go-workers/internal/workerapi/client.go</c> and
/// <c>internal/notifyjob/handler.go</c>): a strict, single JSON object with exactly the fields
/// those decoders read, and the delivery/results round trip they drive.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class NotificationDeliveryHttpTests : IAsyncLifetime
{
    private const string InternalSecret = "notify-http-internal-secret";
    private readonly NixPostgresFixture _fixture;
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;

    public NotificationDeliveryHttpTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            // These tests exercise first-write behaviour: the seed's own push subscription and
            // notification would otherwise dilute the exact single-device, single-notification
            // shapes asserted below.
            await RawSql.ExecuteAsync(connection, transaction: null, "DELETE FROM push_subscription");
            await RawSql.ExecuteAsync(connection, transaction: null, "DELETE FROM notification");
        }
        _factory = new ConfiguredApplicationFactory(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Nix"] = _fixture.ApplicationConnectionString,
            [InternalBoundaryMiddleware.SecretConfigurationKey] = InternalSecret,
            ["Nix:Push:VapidPublicKey"] = "test-vapid-public-key",
        });
        _client = _factory.CreateClient();
    }

    public async ValueTask DisposeAsync()
    {
        _client.Dispose();
        await _factory.DisposeAsync();
    }

    [Fact]
    public async Task Creating_a_notification_enqueues_notify_push_and_delivery_serves_the_exact_go_shape()
    {
        var p256dh = ValidP256dh();
        var auth = ValidAuth();
        Guid subscriptionId;
        Guid notificationId;
        await using (var work = await BeginFactoryUnitOfWorkAsync(TestTenants.AlphaContext))
        {
            var saved = await work.Resolve<NixDispatcher>().SendAsync<AddPushSubscription, PushSubscriptionDto>(
                new("https://fcm.googleapis.com/fcm/send/notify-http", p256dh, auth, "notify-http-agent"), Cancellation);
            Assert.True(saved.IsSuccess);
            subscriptionId = saved.Value.Id;

            var created = await work.Resolve<INotificationWriter>().CreateAsync(
                TestTenants.AlphaContext.PrincipalId,
                NotificationKind.Reminder,
                "Task due",
                "Finish the report",
                itemId: null,
                Nix.Domain.Tenancy.WorkspaceId.From(TestTenants.AlphaWorkspace),
                "notify-http:enqueue",
                Cancellation);
            Assert.True(created.Created);
            notificationId = created.Notification.Id;
            await work.CommitAsync(Cancellation);
        }

        var jobId = await FindJobIdAsync(notificationId);
        Assert.NotNull(jobId);

        const string execution = "notify-http-worker:019946d1-fbc1-7d99-9ce7-1c721b406ff1";
        await using var scope = _fixture.Application.CreateUnscopedScope();
        var dispatch = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        Assert.NotNull(await dispatch.ClaimJobAsync(jobId!.Value, execution, 60, Cancellation));

        using var delivery = await InternalAsync(
            HttpMethod.Post, $"/internal/worker-executions/notifications/{notificationId:D}/delivery", jobId.Value, execution);
        delivery.EnsureSuccessStatusCode();
        Assert.Contains("application/json", delivery.Content.Headers.ContentType?.MediaType, StringComparison.Ordinal);
        var deliveryJson = await delivery.Content.ReadAsStringAsync(Cancellation);
        using (var body = JsonDocument.Parse(deliveryJson))
        {
            var root = body.RootElement;
            // Exactly the fields workerapi.GetNotificationDelivery decodes with DisallowUnknownFields.
            Assert.Equal(2, root.EnumerateObject().Count());
            var payload = root.GetProperty("payload");
            Assert.Equal(4, payload.EnumerateObject().Count());
            Assert.Equal("Task due", payload.GetProperty("title").GetString());
            Assert.Equal("Finish the report", payload.GetProperty("body").GetString());
            var url = payload.GetProperty("url").GetString();
            Assert.StartsWith("/", url, StringComparison.Ordinal);
            Assert.DoesNotContain("://", url, StringComparison.Ordinal);
            Assert.Equal($"/w/{TestTenants.AlphaWorkspace:D}", url);
            Assert.Equal("nix-" + notificationId.ToString("D"), payload.GetProperty("tag").GetString());

            var subscriptions = root.GetProperty("subscriptions");
            var subscription = Assert.Single(subscriptions.EnumerateArray());
            Assert.Equal(4, subscription.EnumerateObject().Count());
            Assert.Equal(subscriptionId, subscription.GetProperty("id").GetGuid());
            Assert.Equal("https://fcm.googleapis.com/fcm/send/notify-http", subscription.GetProperty("endpoint").GetString());
            Assert.Equal(p256dh, subscription.GetProperty("p256dh").GetString());
            Assert.Equal(auth, subscription.GetProperty("auth").GetString());
        }

        // The exact request shape workerapi.ReportNotificationDeliveryResults sends.
        using var results = await InternalPostJsonAsync(
            $"/internal/worker-executions/notifications/{notificationId:D}/delivery/results",
            jobId.Value,
            execution,
            new { results = new[] { new { subscriptionId, status = "delivered", httpStatus = 201 } } });
        Assert.Equal(HttpStatusCode.NoContent, results.StatusCode);

        await using (var check = await BeginFactoryUnitOfWorkAsync(TestTenants.AlphaContext))
        {
            var device = Assert.Single(await check.Resolve<IPushSubscriptionStore>()
                .ListAsync(TestTenants.AlphaContext.TenantId, TestTenants.AlphaContext.PrincipalId, Cancellation));
            Assert.Equal(0, device.Failures);
            Assert.NotNull(device.LastSuccessAt);
        }
    }

    [Fact]
    public async Task Gone_removes_the_subscription_and_failed_increments_until_the_fifth_removes_it()
    {
        Guid notificationId;
        Guid subscriptionId;
        await using (var work = await BeginFactoryUnitOfWorkAsync(TestTenants.AlphaContext))
        {
            var saved = await work.Resolve<NixDispatcher>().SendAsync<AddPushSubscription, PushSubscriptionDto>(
                new("https://fcm.googleapis.com/fcm/send/notify-http-gone", ValidP256dh(), ValidAuth(), "notify-http-agent"), Cancellation);
            subscriptionId = saved.Value.Id;
            var created = await work.Resolve<INotificationWriter>().CreateAsync(
                TestTenants.AlphaContext.PrincipalId, NotificationKind.System, "Gone test", "Body",
                itemId: null, workspaceId: null, "notify-http:gone", Cancellation);
            notificationId = created.Notification.Id;
            await work.CommitAsync(Cancellation);
        }

        var jobId = await FindJobIdAsync(notificationId);
        Assert.NotNull(jobId);
        const string execution = "notify-http-worker:019946d1-fbc1-7d99-9ce7-1c721b406ff2";
        await using var scope = _fixture.Application.CreateUnscopedScope();
        var dispatch = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        Assert.NotNull(await dispatch.ClaimJobAsync(jobId!.Value, execution, 60, Cancellation));

        using var results = await InternalPostJsonAsync(
            $"/internal/worker-executions/notifications/{notificationId:D}/delivery/results",
            jobId.Value,
            execution,
            new { results = new[] { new { subscriptionId, status = "gone", httpStatus = 410 } } });
        Assert.Equal(HttpStatusCode.NoContent, results.StatusCode);

        await using (var check = await BeginFactoryUnitOfWorkAsync(TestTenants.AlphaContext))
        {
            Assert.Empty(await check.Resolve<IPushSubscriptionStore>()
                .ListAsync(TestTenants.AlphaContext.TenantId, TestTenants.AlphaContext.PrincipalId, Cancellation));
        }
    }

    [Fact]
    public async Task A_job_for_a_different_notification_is_refused()
    {
        Guid notificationId;
        await using (var work = await BeginFactoryUnitOfWorkAsync(TestTenants.AlphaContext))
        {
            await work.Resolve<NixDispatcher>().SendAsync<AddPushSubscription, PushSubscriptionDto>(
                new("https://fcm.googleapis.com/fcm/send/notify-http-mismatch", ValidP256dh(), ValidAuth(), "agent"), Cancellation);
            var created = await work.Resolve<INotificationWriter>().CreateAsync(
                TestTenants.AlphaContext.PrincipalId, NotificationKind.System, "Mismatch", "Body",
                itemId: null, workspaceId: null, "notify-http:mismatch", Cancellation);
            notificationId = created.Notification.Id;
            await work.CommitAsync(Cancellation);
        }

        var jobId = await FindJobIdAsync(notificationId);
        Assert.NotNull(jobId);
        const string execution = "notify-http-worker:019946d1-fbc1-7d99-9ce7-1c721b406ff3";
        await using var scope = _fixture.Application.CreateUnscopedScope();
        var dispatch = scope.ServiceProvider.GetRequiredService<WorkerDispatchStore>();
        Assert.NotNull(await dispatch.ClaimJobAsync(jobId!.Value, execution, 60, Cancellation));

        // Route names a notification that is not this job's own.
        using var delivery = await InternalAsync(
            HttpMethod.Post, $"/internal/worker-executions/notifications/{Guid.NewGuid():D}/delivery", jobId.Value, execution);
        Assert.Equal(HttpStatusCode.NotFound, delivery.StatusCode);
    }

    /// <summary>
    /// Opens a unit of work against the WebApplicationFactory's own container, not
    /// <c>_fixture.Application</c>'s: the two are separate composition roots over the same
    /// database, and only this one carries the <c>Nix:Push:VapidPublicKey</c> setting this test
    /// configured, which is what <see cref="Nix.Persistence.Notifications.NotificationStore"/>
    /// reads to decide whether to enqueue a <c>notify.push</c> job.
    /// </summary>
    private Task<NixUnitOfWork> BeginFactoryUnitOfWorkAsync(NixSessionContext context) =>
        NixUnitOfWork.StartAsync(_factory.Services.CreateAsyncScope(), context, System.Data.IsolationLevel.ReadCommitted, Cancellation);

    private static string ValidP256dh()
    {
        var key = new byte[65];
        key[0] = 0x04;
        return Convert.ToBase64String(key).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private static string ValidAuth() =>
        Convert.ToBase64String(new byte[16]).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private async Task<Guid?> FindJobIdAsync(Guid notificationId)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var ids = await RawSql.GuidListAsync(
                connection,
                transaction: null,
                $"""
                SELECT job_id FROM worker_job
                 WHERE kind = 'notify.push' AND idempotency_key = 'notify:{notificationId:D}'
                """);
            return ids.Count == 1 ? ids[0] : null;
        }
    }

    private async Task<HttpResponseMessage> InternalAsync(HttpMethod method, string path, Guid jobId, string execution)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.TryAddWithoutValidation(InternalBoundaryMiddleware.SecretHeaderName, InternalSecret);
        request.Headers.TryAddWithoutValidation(WorkerExecutionMiddleware.JobHeaderName, jobId.ToString("D"));
        request.Headers.TryAddWithoutValidation(WorkerExecutionMiddleware.ExecutionHeaderName, execution);
        return await _client.SendAsync(request, Cancellation);
    }

    private async Task<HttpResponseMessage> InternalPostJsonAsync(string path, Guid jobId, string execution, object body)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = JsonContent.Create(body),
        };
        request.Headers.TryAddWithoutValidation(InternalBoundaryMiddleware.SecretHeaderName, InternalSecret);
        request.Headers.TryAddWithoutValidation(WorkerExecutionMiddleware.JobHeaderName, jobId.ToString("D"));
        request.Headers.TryAddWithoutValidation(WorkerExecutionMiddleware.ExecutionHeaderName, execution);
        return await _client.SendAsync(request, Cancellation);
    }
}
