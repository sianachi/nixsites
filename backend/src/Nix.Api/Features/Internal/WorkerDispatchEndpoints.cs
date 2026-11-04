using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions.Workers;

namespace Nix.Features.Internal;

/// <summary>Service-authenticated, cross-tenant dispatch over narrow database functions.</summary>
internal static class WorkerDispatchEndpoints
{
    internal static void Map(IEndpointRouteBuilder group)
    {
        group.MapPost("/worker-dispatch/jobs/lease", LeaseJobs);
        group.MapPost("/worker-dispatch/jobs/{jobId:guid}/claim", ClaimJob);
        group.MapPost("/worker-dispatch/jobs/{jobId:guid}/renew", RenewJob);
        group.MapGet("/worker-dispatch/jobs/{jobId:guid}/state", GetJobState);
        group.MapPost("/worker-dispatch/jobs/{jobId:guid}/complete", CompleteJob);
    }

    private static async Task<Ok<IReadOnlyList<DispatchedWorkerJob>>> LeaseJobs(
        DispatchLeaseRequest request,
        [FromServices] IWorkerDispatchStore store,
        CancellationToken cancellationToken) => TypedResults.Ok(
            await store.LeaseJobsAsync(
                request.Kind,
                request.Owner,
                Math.Clamp(request.Limit, 1, 100),
                Math.Clamp(request.LeaseSeconds, 5, 300),
                cancellationToken).ConfigureAwait(false));

    private static async Task<Results<Ok<DispatchedWorkerJob>, Conflict>> ClaimJob(
        Guid jobId,
        DispatchExecutionRequest request,
        [FromServices] IWorkerDispatchStore store,
        CancellationToken cancellationToken)
    {
        var claimed = await store.ClaimJobAsync(
            jobId,
            request.Owner,
            Math.Clamp(request.LeaseSeconds, 5, 300),
            cancellationToken).ConfigureAwait(false);
        return claimed is null ? TypedResults.Conflict() : TypedResults.Ok(claimed);
    }

    private static async Task<Results<NoContent, Conflict>> RenewJob(
        Guid jobId,
        DispatchExecutionRequest request,
        [FromServices] IWorkerDispatchStore store,
        CancellationToken cancellationToken) =>
        await store.RenewJobAsync(
            jobId,
            request.Owner,
            Math.Clamp(request.LeaseSeconds, 5, 300),
            cancellationToken).ConfigureAwait(false)
            ? TypedResults.NoContent()
            : TypedResults.Conflict();

    private static async Task<Results<Ok<WorkerExecutionState>, NotFound>> GetJobState(
        Guid jobId,
        string owner,
        [FromServices] IWorkerDispatchStore store,
        CancellationToken cancellationToken)
    {
        var state = await store.GetJobStateAsync(jobId, owner, cancellationToken).ConfigureAwait(false);
        return state is null ? TypedResults.NotFound() : TypedResults.Ok(state);
    }

    private static async Task<Results<NoContent, Conflict>> CompleteJob(
        Guid jobId,
        DispatchJobCompletion request,
        [FromServices] IWorkerDispatchStore store,
        CancellationToken cancellationToken) =>
        await store.FinishJobAsync(
            jobId,
            request.Owner,
            request.Succeeded,
            request.Retryable,
            request.Result?.ToJsonString(),
            request.ErrorCode,
            request.ErrorDetail,
            cancellationToken).ConfigureAwait(false)
            ? TypedResults.NoContent()
            : TypedResults.Conflict();

}

public sealed record DispatchLeaseRequest(string Owner, string? Kind = null, int Limit = 10, int LeaseSeconds = 60);
public sealed record DispatchExecutionRequest(string Owner, int LeaseSeconds = 60);
public sealed record DispatchJobCompletion(string Owner, bool Succeeded, bool Retryable = false, JsonNode? Result = null, string? ErrorCode = null, string? ErrorDetail = null);
