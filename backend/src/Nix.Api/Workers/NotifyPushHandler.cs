using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Nix.Abstractions.Notifications;
using Nix.Features.Internal;
using Nix.Serialization;
using Nix.Workers.Push;

namespace Nix.Workers;

/// <summary>
/// The <c>notify.push</c> job (ADR-0051 contract N1): fetch the notification's rendered payload
/// and devices from the delivery endpoint, encrypt and sign one Web Push message per device,
/// deliver, and report the outcomes. A port of the Go <c>notifyjob</c> handler.
/// </summary>
/// <remarks>
/// The delivery endpoint hands a notification out once (<c>push_attempted_at</c>): a job re-leased
/// after a crash gets no devices back and completes without sending, so no device ever receives
/// the same push twice.
/// </remarks>
public sealed class NotifyPushHandler(
    WorkerLoopbackClient core,
    PushTransport transport,
    IOptions<PushOptions> push,
    TimeProvider clock,
    ILogger<NotifyPushHandler>? logger = null) : IWorkerJobHandler, IDisposable
{
    /// <summary>The "TTL" header: how long a push service may hold an undelivered message.</summary>
    public const int PushTtlSeconds = 86400;

    private const int MaxConcurrentPushes = 8;
    private const int DeliveryResponseLimit = 64 * 1024;
    private readonly ILogger<NotifyPushHandler> logger = logger ?? NullLogger<NotifyPushHandler>.Instance;
    private readonly Lazy<ECDsa?> privateKey = new(() =>
        string.IsNullOrWhiteSpace(push.Value.VapidPrivateKey) ? null : WebPush.ParseVapidPrivateKey(push.Value.VapidPrivateKey));

    /// <inheritdoc />
    public IReadOnlyList<string> Kinds { get; } = ["notify.push"];

    /// <inheritdoc />
    public async Task<string?> HandleAsync(WorkerExecution job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        NotifyPushJobPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize(job.Job.Payload, NotifyPushJobJsonContext.Default.NotifyPushJobPayload);
        }
        catch (JsonException)
        {
            payload = null;
        }
        if (payload is null || payload.NotificationId == Guid.Empty)
        {
            throw WorkerJobException.Fail("notify_payload_invalid", "the durable notify request is invalid");
        }
        if (privateKey.Value is not { } key || string.IsNullOrWhiteSpace(push.Value.VapidSubject))
        {
            throw WorkerJobException.Fail("notify_configuration_invalid", "the notify worker is not configured");
        }

        NotificationDeliveryResponse? delivery;
        try
        {
            delivery = await core.PostJsonAsync(
                job,
                $"/internal/worker-executions/notifications/{payload.NotificationId:D}/delivery",
                content: null,
                InternalJsonContext.Default.NotificationDeliveryResponse,
                DeliveryResponseLimit,
                cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException or TaskCanceledException && !cancellationToken.IsCancellationRequested)
        {
            throw WorkerJobException.Retry("notify_delivery_unavailable", exception.Message);
        }
        if (delivery is null || delivery.Payload is null || delivery.Subscriptions is null)
        {
            throw WorkerJobException.Fail("notify_delivery_invalid", "the notification delivery payload is invalid");
        }

        var plaintext = JsonSerializer.SerializeToUtf8Bytes(delivery.Payload, InternalJsonContext.Default.NotificationDeliveryPayloadDto);
        var results = new NotificationDeliveryResultDto[delivery.Subscriptions.Count];
        // Subscriptions are independent push services, so a slow one must not delay the rest;
        // results keep the subscription order.
        using var slots = new SemaphoreSlim(MaxConcurrentPushes, MaxConcurrentPushes);
        await Task.WhenAll(delivery.Subscriptions.Select(async (subscription, index) =>
        {
            await slots.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                var (status, httpStatus) = await DeliverAsync(key, subscription, plaintext, cancellationToken).ConfigureAwait(false);
                results[index] = new NotificationDeliveryResultDto(subscription.Id, status, httpStatus);
            }
            finally
            {
                slots.Release();
            }
        })).ConfigureAwait(false);

        var delivered = results.Count(result => result.Status == "delivered");
        var gone = results.Count(result => result.Status == "gone");
        if (results.Length > 0)
        {
            await ReportAsync(job, payload.NotificationId, results, cancellationToken).ConfigureAwait(false);
        }
        return JsonSerializer.Serialize(
            new NotifyPushResult(payload.NotificationId, delivered, gone, results.Length - delivered - gone),
            WorkersJsonContext.Default.NotifyPushResult);
    }

    // Retries the report itself before failing the job: a failed job is retried from the top, and
    // the retry would push to every device again.
    private async Task ReportAsync(WorkerExecution job, Guid notificationId, NotificationDeliveryResultDto[] results, CancellationToken cancellationToken)
    {
        Exception? last = null;
        for (var attempt = 0; attempt < 3; attempt++)
        {
            if (attempt > 0)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(500 * attempt), clock, cancellationToken).ConfigureAwait(false);
            }
            try
            {
                await core.PostJsonAsync<object>(
                    job,
                    $"/internal/worker-executions/notifications/{notificationId:D}/delivery/results",
                    WorkerLoopbackClient.Json(new NotificationDeliveryResultsRequest(results), InternalJsonContext.Default.NotificationDeliveryResultsRequest),
                    responseInfo: null,
                    0,
                    cancellationToken).ConfigureAwait(false);
                return;
            }
            catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException or TaskCanceledException && !cancellationToken.IsCancellationRequested)
            {
                last = exception;
            }
        }
        throw WorkerJobException.Retry("notify_results_unavailable", last?.Message ?? "the results report failed");
    }

    // Failures here are per-subscription outcomes, not job failures: a malformed or unreachable
    // subscription must not block delivery to the notification's other subscriptions.
    private async Task<(string Status, int HttpStatus)> DeliverAsync(ECDsa key, NotificationDeliverySubscriptionDto subscription, byte[] plaintext, CancellationToken cancellationToken)
    {
        try
        {
            var body = WebPush.Encrypt(plaintext, WebPush.Base64UrlDecode(subscription.P256dh), WebPush.Base64UrlDecode(subscription.Auth));
            var authorization = WebPush.VapidAuthorization(key, subscription.Endpoint, push.Value.VapidSubject!, clock.GetUtcNow());
            var headers = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["Content-Type"] = "application/octet-stream",
                ["Content-Encoding"] = "aes128gcm",
                ["TTL"] = PushTtlSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ["Urgency"] = "normal",
                ["Authorization"] = authorization,
            };
            var status = await transport.SendAsync(subscription.Endpoint, headers, body, cancellationToken).ConfigureAwait(false);
            return status switch
            {
                404 or 410 => ("gone", status),
                >= 200 and < 300 => ("delivered", status),
                _ => ("failed", status),
            };
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
#pragma warning disable CA1031 // Justification: every per-device failure is an outcome to report, never a job failure.
        catch (Exception exception)
        {
            NotifyPushHandlerLog.DeviceFailed(logger, subscription.Id, exception.GetType().Name);
            return ("failed", 0);
        }
#pragma warning restore CA1031
    }

    public void Dispose()
    {
        if (privateKey.IsValueCreated)
        {
            privateKey.Value?.Dispose();
        }
    }
}

/// <summary>The counts a finished push job stores as its result.</summary>
public sealed record NotifyPushResult(Guid NotificationId, int Delivered, int Gone, int Failed);

internal static partial class NotifyPushHandlerLog
{
    [LoggerMessage(5410, LogLevel.Information, "Push to subscription {SubscriptionId} failed: {Error}")]
    internal static partial void DeviceFailed(ILogger logger, Guid subscriptionId, string error);
}
