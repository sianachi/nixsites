using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Abstractions.Notifications;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Notifications;
using Nix.Errors;

namespace Nix.Features.Internal;

/// <summary>
/// N1: the worker-execution endpoints a <c>notify.push</c> job uses to fetch its rendered push
/// payload and subscriptions, then report per-subscription delivery outcomes (ADR-0051 section 5
/// and 7). Guarded by <see cref="Nix.Authentication.WorkerExecutionMiddleware"/>: tenant, workspace
/// and actor (the notification's recipient) come only from the leased job, never from the request.
/// </summary>
internal static class NotificationDeliveryEndpoints
{
    private const string JobKind = "notify.push";
    private const int MaxSubscriptions = 20;

    internal static void MapWorkerExecutions(IEndpointRouteBuilder group)
    {
        var notifications = group.MapGroup("/notifications/{notificationId:guid}");
        notifications.MapPost("/delivery", GetDelivery);
        notifications.MapPost("/delivery/results", ReportResults);
    }

    private static async Task<IResult> GetDelivery(
        Guid notificationId,
        HttpContext context,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INotificationStore notifications,
        [FromServices] IPushSubscriptionStore pushSubscriptions,
        [FromServices] INixSessionContextAccessor session)
    {
        var job = await ResolveJobAsync(notificationId, context, jobs, session).ConfigureAwait(false);
        if (job is null)
        {
            return Refused(context);
        }

        var scoped = session.Current!.Value;
        var notification = await notifications.GetAsync(scoped.TenantId, scoped.PrincipalId, notificationId, context.RequestAborted)
            .ConfigureAwait(false);
        if (notification is null)
        {
            return Refused(context);
        }

        // Handed out once. A worker re-running this job after a crash gets no devices and sends
        // nothing: one lost push beats a duplicate on every device.
        var devices = await notifications.ClaimPushAsync(scoped.TenantId, scoped.PrincipalId, notificationId, context.RequestAborted).ConfigureAwait(false)
            ? await pushSubscriptions.ListAsync(scoped.TenantId, scoped.PrincipalId, context.RequestAborted).ConfigureAwait(false)
            : [];
        var response = new NotificationDeliveryResponse(
            new NotificationDeliveryPayloadDto(
                notification.Title,
                notification.Body,
                BuildUrl(notification.WorkspaceId?.Value, notification.ItemId?.Value),
                "nix-" + notification.Id.ToString("D", System.Globalization.CultureInfo.InvariantCulture)),
            [.. devices.Take(MaxSubscriptions).Select(device =>
                new NotificationDeliverySubscriptionDto(device.Id, device.Endpoint, device.P256dh, device.Auth))]);
        return TypedResults.Ok(response);
    }

    private static async Task<IResult> ReportResults(
        Guid notificationId,
        NotificationDeliveryResultsRequest request,
        HttpContext context,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] IPushSubscriptionStore pushSubscriptions,
        [FromServices] INixSessionContextAccessor session)
    {
        if (request is null || request.Results is null || request.Results.Count == 0 || request.Results.Count > MaxSubscriptions)
        {
            return Refused(context);
        }

        var job = await ResolveJobAsync(notificationId, context, jobs, session).ConfigureAwait(false);
        if (job is null)
        {
            return Refused(context);
        }

        var scoped = session.Current!.Value;
        foreach (var result in request.Results)
        {
            switch (result.Status)
            {
                case "delivered":
                    await pushSubscriptions.RecordDeliveredAsync(scoped.TenantId, scoped.PrincipalId, result.SubscriptionId, context.RequestAborted)
                        .ConfigureAwait(false);
                    break;
                case "gone":
                    await pushSubscriptions.RemoveByIdAsync(scoped.TenantId, scoped.PrincipalId, result.SubscriptionId, context.RequestAborted)
                        .ConfigureAwait(false);
                    break;
                case "failed":
                    await pushSubscriptions.RecordFailedAsync(scoped.TenantId, scoped.PrincipalId, result.SubscriptionId, context.RequestAborted)
                        .ConfigureAwait(false);
                    break;
                default:
                    return Refused(context);
            }
        }

        return TypedResults.NoContent();
    }

    /// <summary>
    /// Resolves the leased job this request runs under, and refuses unless it is exactly this
    /// notification's own <c>notify.push</c> job: the payload's <c>notificationId</c> must match
    /// the route, the kind must match, and it must still be running.
    /// </summary>
    private static async Task<WorkerJobRecord?> ResolveJobAsync(
        Guid notificationId,
        HttpContext context,
        IWorkerJobStore jobs,
        INixSessionContextAccessor session)
    {
        if (!Guid.TryParse(context.Request.Headers[WorkerExecutionMiddleware.JobHeaderName].ToString(), out var jobId))
        {
            return null;
        }
        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var job = await jobs.GetAsync(scoped.TenantId, scoped.PrincipalId, jobId, context.RequestAborted).ConfigureAwait(false);
        if (job is not { Kind: JobKind, Status: "running" })
        {
            return null;
        }

        NotifyPushJobPayload? payload;
        try
        {
            payload = System.Text.Json.JsonSerializer.Deserialize(job.Payload, NotifyPushJobJsonContext.Default.NotifyPushJobPayload);
        }
        catch (System.Text.Json.JsonException)
        {
            return null;
        }
        return payload is not null && payload.NotificationId == notificationId ? job : null;
    }

    /// <summary>
    /// Builds a same-origin path from identifiers only, never from notification text: item and
    /// workspace ids are opaque uuids, so nothing user-authored can end up in the URL a service
    /// worker will navigate to.
    /// </summary>
    private static string BuildUrl(Guid? workspaceId, Guid? itemId)
    {
        if (workspaceId is not { } workspace)
        {
            return "/";
        }
        var path = $"/w/{workspace:D}";
        return itemId is { } item ? $"{path}?item={item:D}" : path;
    }

    private static Microsoft.AspNetCore.Http.HttpResults.ProblemHttpResult Refused(HttpContext context) => TypedResults.Problem(ApiProblem.Create(
        context,
        StatusCodes.Status404NotFound,
        "notify.delivery_unavailable",
        "Notification delivery unavailable",
        "The notification delivery is not available to this worker execution."));
}

/// <summary>The rendered push payload and the recipient's registered devices.</summary>
public sealed record NotificationDeliveryResponse(
    NotificationDeliveryPayloadDto Payload,
    IReadOnlyList<NotificationDeliverySubscriptionDto> Subscriptions);

/// <summary>Title, body and a same-origin url only - never full text of anything else.</summary>
/// <remarks>
/// <c>Url</c> is a relative path ("/w/{workspaceId}" or "/"), never an absolute
/// <see cref="Uri"/>: the Go worker client decodes it as a plain string and refuses one that is
/// not same-origin, so a <see cref="Uri"/> here would only make the type lie about what it holds.
/// </remarks>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1056:URI-like properties should not be strings", Justification = "Url is a same-origin relative path, never an absolute Uri.")]
[System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1054:URI-like parameters should not be strings", Justification = "Url is a same-origin relative path, never an absolute Uri.")]
public sealed record NotificationDeliveryPayloadDto(string Title, string Body, string Url, string Tag);

/// <summary>One device to push to. Carries the encryption material the worker needs, and nothing else.</summary>
public sealed record NotificationDeliverySubscriptionDto(Guid Id, string Endpoint, string P256dh, string Auth);

/// <summary>Per-subscription push outcomes the worker reports back.</summary>
public sealed record NotificationDeliveryResultsRequest(IReadOnlyList<NotificationDeliveryResultDto> Results);

/// <summary>One subscription's outcome: <c>delivered</c>, <c>gone</c>, or <c>failed</c>.</summary>
public sealed record NotificationDeliveryResultDto(Guid SubscriptionId, string Status, int HttpStatus);
