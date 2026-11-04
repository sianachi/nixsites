using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Primitives;
using Nix.Errors;
using Nix.Features.DocumentImports;
using Nix.Features.Exports;
using Nix.Features.Files;
using Nix.Features.Sites;
using Nix.Features.TemplateImports;
using Nix.Http;

namespace Nix.Features.Internal;

/// <summary>
/// Route registration for the service-to-service surface.
/// </summary>
/// <remarks>
/// <para>
/// These routes exist for trusted Nix services, including Collaboration and the Go workers. They
/// sit behind <see cref="Nix.Authentication.InternalBoundaryMiddleware"/>: a shared secret proves
/// the caller is a trusted service, and routes acting directly for a user also require the user's
/// forwarded token. Lease-bound worker routes establish their tenant and principal only from the
/// durable job execution authorized by <see cref="Nix.Authentication.WorkerExecutionMiddleware"/>.
/// </para>
/// <para>
/// Deliberately absent from the OpenAPI document: <c>backend/openapi/nix-api.json</c> is the
/// public contract the frontend client generates from, and a service-to-service seam published
/// there would invite exactly the callers it must refuse.
/// </para>
/// </remarks>
internal static class InternalEndpoints
{
    /// <summary>
    /// Registers the internal routes on <paramref name="endpoints"/>.
    /// </summary>
    internal static IEndpointRouteBuilder MapInternalEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var group = endpoints.MapGroup("/internal").ExcludeFromDescription();

        group.MapGet("/authz/items/{itemId:guid}", GetItemAuthorizationEndpoint.Handle);
        group.MapPost("/items/{itemId:guid}/touched", TouchItemEndpoint.Handle);
        WorkerJobEndpoints.Map(group);
        WorkerOutboxEndpoints.Map(group);
        WorkerDispatchEndpoints.Map(group);
        FileEndpoints.MapWorkerExecutions(group.MapGroup("/worker-executions"));
        DocumentImportWorkerEndpoints.MapWorkerExecutions(group.MapGroup("/worker-executions"));
        TemplateImportWorkerEndpoints.MapWorkerExecutions(group.MapGroup("/worker-executions"));
        TemplateFileTransferEndpoints.MapWorkerExecutions(group.MapGroup("/worker-executions"));
        ExportEndpoints.MapWorkerExecutions(group.MapGroup("/worker-executions"));
        ObjectCleanupEndpoints.Map(group.MapGroup("/worker-executions"));
        WorkspacePurgeEndpoints.Map(group.MapGroup("/worker-executions"));
        NotificationDeliveryEndpoints.MapWorkerExecutions(group.MapGroup("/worker-executions"));
        CalendarSyncWorkerEndpoints.MapWorkerExecutions(group.MapGroup("/worker-executions"));
        SiteWorkerEndpoints.MapWorkerExecutions(group.MapGroup("/worker-executions"));

        return endpoints;
    }

    /// <summary>Builds the problem details for a refused internal request.</summary>
    /// <param name="httpContext">The current request.</param>
    /// <param name="error">Why the request was refused.</param>
    /// <returns>Problem details describing the failure.</returns>
    /// <remarks>
    /// Every refusal is 404 with the feature's own code: an internal caller that may not act on an
    /// item learns nothing beyond "not visible", the same non-answer the public surface gives.
    /// </remarks>
    internal static ProblemDetails Problem(HttpContext httpContext, NixError error) =>
        ApiProblem.Create(
            httpContext,
            error.Code == InternalErrors.BodyLockedCode
                ? StatusCodes.Status403Forbidden
                : StatusCodes.Status404NotFound,
            error.Code,
            "Request refused",
            error.Message);
}
