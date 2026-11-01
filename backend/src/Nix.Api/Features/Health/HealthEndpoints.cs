using System.Collections.Frozen;
using System.Reflection;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Errors;

namespace Nix.Features.Health;

/// <summary>
/// Route registration for the health feature, and the template every later
/// feature copies: one <c>Map&lt;Feature&gt;Endpoints</c> extension per feature,
/// a <c>MapGroup</c> carrying the shared prefix, tag, filters, and auth policy,
/// and delegates thin enough to read in one glance — bind, call, map the result.
/// Business logic never lives in an endpoint lambda.
/// </summary>
internal static class HealthEndpoints
{
    /// <summary>Logical service name reported by the status endpoint.</summary>
    private const string ServiceName = "nix-api";

    private const string HealthyStatus = "healthy";

    /// <summary>
    /// Stable code for "the named health check does not exist". Codes are
    /// namespaced by feature so two features can never collide, and the frontend
    /// switches on the literal.
    /// </summary>
    internal const string CheckNotFoundCode = "health.check_not_found";

    /// <summary>
    /// Checks this build knows how to run. A frozen set: the membership test is on
    /// a request path and must not allocate or rehash per call.
    /// </summary>
    private static readonly FrozenSet<string> KnownChecks =
        new[] { "self" }.ToFrozenSet(StringComparer.Ordinal);

    /// <summary>Informational version of the running build, resolved once at startup.</summary>
    private static readonly string ServiceVersion = ResolveServiceVersion();

    /// <summary>
    /// Registers the health feature's routes on <paramref name="endpoints"/>.
    /// </summary>
    internal static IEndpointRouteBuilder MapHealthEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        // Liveness sits at the root, outside the versioned group, on purpose:
        // orchestrator probes are configured once and must not move when the API
        // version does.
        endpoints.MapGet("/healthz", GetLiveness)
            .WithName("GetLiveness")
            .WithTags("Health")
            .WithSummary("Liveness probe")
            .WithDescription("Answers 200 whenever the process can serve HTTP. Touches no dependency.")
            .Produces<LivenessResponse>(StatusCodes.Status200OK);

        var health = endpoints.MapGroup("/api/v1/health")
            .WithTags("Health");

        health.MapGet("/status", GetStatus)
            .WithName("GetServiceStatus")
            .WithSummary("Service identity and clock")
            .WithDescription("Reports the service name, the running build's version, and the server clock in UTC.")
            .Produces<ServiceStatusResponse>(StatusCodes.Status200OK);

        health.MapGet("/checks/{name}", GetCheck)
            .WithName("GetHealthCheck")
            .WithSummary("Result of one named health check")
            .WithDescription("Returns the named check's result, or an RFC 9457 problem with code 'health.check_not_found'.")
            .ProducesProblem(StatusCodes.Status404NotFound);

        return endpoints;
    }

    /// <summary>
    /// Registers the signed-in route that lists the release each service runs, for Settings &gt; About.
    /// Kept apart from the health group, which answers anonymous probes.
    /// </summary>
    internal static IEndpointRouteBuilder MapSystemVersionsEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        endpoints.MapGet("/api/v1/system/versions", static (ServiceVersions versions) => TypedResults.Ok(versions.Snapshot()))
            .WithTags("Health")
            .WithName("GetSystemVersions")
            .WithSummary("The release each service runs")
            .WithDescription(
                "Lists the version and image tag of Core and of every service that has called Core's "
                + "internal routes since Core started: collab, the workers and the sites worker.")
            .Produces<SystemVersionsResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status401Unauthorized);

        return endpoints;
    }

    private static Ok<LivenessResponse> GetLiveness() =>
        TypedResults.Ok(new LivenessResponse(HealthyStatus));

    private static Ok<ServiceStatusResponse> GetStatus(TimeProvider timeProvider, ServiceVersions versions)
    {
        // The deployment's release when it names one; the assembly's version otherwise.
        var release = versions.Core.Version;
        return TypedResults.Ok(new ServiceStatusResponse(
            ServiceName,
            release.Length > 0 ? release : ServiceVersion,
            timeProvider.GetUtcNow()));
    }

    /// <summary>
    /// The reference shape for a typed failure: no exception, no stringly-typed
    /// signalling — an unknown check is an expected outcome, so it is modelled in
    /// the return type and surfaces as problem details with a stable code.
    /// </summary>
    private static Results<Ok<HealthCheckResponse>, ProblemHttpResult> GetCheck(
        string name,
        HttpContext httpContext) =>
        KnownChecks.Contains(name)
            ? TypedResults.Ok(new HealthCheckResponse(name, HealthyStatus))
            : TypedResults.Problem(ApiProblem.Create(
                httpContext,
                StatusCodes.Status404NotFound,
                CheckNotFoundCode,
                "Health check not found",
                $"No health check is registered under the name '{name}'."));

    /// <summary>
    /// Reads the informational version stamped by the build and drops the source
    /// revision suffix, so the value stays a plain version the frontend can compare.
    /// </summary>
    private static string ResolveServiceVersion()
    {
        var informational = typeof(HealthEndpoints).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;

        if (string.IsNullOrWhiteSpace(informational))
        {
            return "0.0.0";
        }

        var suffix = informational.IndexOf('+', StringComparison.Ordinal);
        return suffix < 0 ? informational : informational[..suffix];
    }
}
