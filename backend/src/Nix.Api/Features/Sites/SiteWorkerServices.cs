using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Nix.Abstractions;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Sites;
using Nix.Errors;
using Nix.Features.Exports;
using Nix.Persistence.ObjectStorage;

namespace Nix.Features.Sites;

/// <summary>What a route learned about its job before doing anything.</summary>
public sealed record WorkerScope(
    IResult? Refusal,
    string? Execution,
    NixSessionContext Context,
    WorkerJobRecord? Job,
    SiteBuild? Build,
    Site? Site);

/// <summary>The services every route needs, bundled so the routes stay short.</summary>
public sealed class SiteWorkerServices(
    ISiteStore sites,
    IWorkerJobStore jobs,
    IWorkerDispatchStore dispatch,
    INixSessionContextAccessor session,
    IPermissionResolver permissions,
    IWorkspaceMembershipIgnoringLock membership,
    SelfIssuedTokenService tokens,
    IConfiguration configuration,
    SiteCapabilitySigner signer,
    S3CapabilitySigner storage,
    SiteOptions options,
    TimeProvider clock)
{
    internal const string RefusedCode = "sites.execution_refused";

    internal ISiteStore Sites => sites;

    internal IWorkerJobStore Jobs => jobs;

    internal IPermissionResolver Permissions => permissions;

    internal IWorkspaceMembershipIgnoringLock Membership => membership;

    internal SelfIssuedTokenService Tokens => tokens;

    internal IConfiguration Configuration => configuration;

    internal SiteCapabilitySigner Signer => signer;

    internal S3CapabilitySigner Storage => storage;

    internal SiteOptions Options => options;

    internal TimeProvider Clock => clock;

    /// <summary>Resolves a <c>site.build</c> job whose build is in one of <paramref name="statuses"/>.</summary>
    internal async ValueTask<WorkerScope> BuildAsync(Guid jobId, HttpContext context, params string[] statuses)
    {
        var scope = await JobAsync(jobId, context, SiteJobKinds.Build).ConfigureAwait(false);
        if (scope.Refusal is not null)
        {
            return scope;
        }

        var payload = TryReadBuildPayload(scope.Job!);
        if (payload is null)
        {
            return Refuse(context, 409, RefusedCode, "The job does not build a site.");
        }

        // The site's row lock first, then the build: a seal or activation never interleaves with a
        // rollback, an unpublish or a delete, and the build is read as the last holder left it.
        await sites.LockSiteAsync(payload.SiteId, context.RequestAborted).ConfigureAwait(false);
        var build = await sites.FindBuildByJobAsync(jobId, context.RequestAborted).ConfigureAwait(false);
        if (build is null || payload.BuildId != build.Id || payload.SiteId != build.SiteId)
        {
            return Refuse(context, 409, RefusedCode, "The job does not build a site.");
        }

        // A build retired by an unpublish carries a purge; its objects are being deleted.
        if (!statuses.Contains(build.Status) || build.PurgeId is not null)
        {
            return Refuse(context, 409, "sites.build_closed", "The build is no longer in a state that accepts this request.");
        }

        var site = await sites.FindForUpdateAsync(build.SiteId, context.RequestAborted).ConfigureAwait(false);
        return site is null
            ? Refuse(context, 409, RefusedCode, "The site no longer exists.")
            : scope with { Build = build, Site = site };
    }

    /// <summary>Resolves a running job of <paramref name="kind"/> that the exact execution owns.</summary>
    internal async ValueTask<WorkerScope> JobAsync(Guid jobId, HttpContext context, string kind)
    {
        var execution = await ExportEndpoints.ExactExecution(jobId, context, dispatch).ConfigureAwait(false);
        var current = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        if (execution is null)
        {
            return Refuse(context, 409, RefusedCode, "The execution does not own this job.");
        }

        var job = await jobs.GetAsync(current.TenantId, current.PrincipalId, jobId, context.RequestAborted).ConfigureAwait(false);
        return job is null || job.Kind != kind || job.Status != "running"
            ? Refuse(context, 409, RefusedCode, "The job is not a running job of this kind.")
            : new WorkerScope(null, execution, current, job, null, null);
    }

    private static SiteBuildJobPayload? TryReadBuildPayload(WorkerJobRecord job)
    {
        try
        {
            return JsonSerializer.Deserialize(job.Payload, SitesJsonContext.Default.SiteBuildJobPayload);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>The site a <c>site.activate</c> job names, or null when the payload is malformed.</summary>
    internal static Guid? TryReadActivationSite(WorkerJobRecord job)
    {
        try
        {
            return JsonSerializer.Deserialize(job.Payload, SitesJsonContext.Default.SiteActivateJobPayload)?.SiteId;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    internal static Microsoft.AspNetCore.Http.HttpResults.ProblemHttpResult Problem(HttpContext context, int status, string code, string detail) =>
        TypedResults.Problem(ApiProblem.Create(context, status, code, "Site build request refused", detail));

    private static WorkerScope Refuse(HttpContext context, int status, string code, string detail) =>
        new(Problem(context, status, code, detail), null, default, null, null, null);
}
