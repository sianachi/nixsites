#pragma warning disable CA2000 // Justification: the request body handed to the loopback client is owned and disposed by the request it is attached to.
using System.Text.Json;
using Nix.Abstractions.Workers;
using Nix.Features.Internal;
using Nix.Serialization;
using Nix.Workers.Transfer;

namespace Nix.Workers;

/// <summary>
/// The <c>object.cleanup</c> job: deletes, page by page, exactly the objects Core signs delete
/// capabilities for, and finalises a workspace purge once its objects are gone. A port of the Go
/// <c>objectcleanup</c> handler; the safety delay is also enforced by the lease query, so a job
/// is normally never leased early.
/// </summary>
public sealed class ObjectCleanupHandler(WorkerLoopbackClient core, ObjectTransfer objects, TimeProvider clock) : IWorkerJobHandler
{
    private const int CapabilityResponseLimit = 1 << 20;

    public IReadOnlyList<string> Kinds { get; } = [ObjectCleanupJobs.Kind];

    public async Task<string?> HandleAsync(WorkerExecution job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        if (job.Job.Kind != ObjectCleanupJobs.Kind)
        {
            throw WorkerJobException.Fail("cleanup_kind_mismatch", "job kind is not object.cleanup");
        }
        ObjectCleanupJobPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize(job.Job.Payload, ObjectCleanupJsonContext.Default.ObjectCleanupJobPayload);
        }
        catch (JsonException)
        {
            payload = null;
        }
        if (payload is null || string.IsNullOrEmpty(payload.OwnerKind) || payload.OwnerKind.Length > 80 || payload.OwnerId == Guid.Empty
            || payload.NotBefore == default || payload.ObjectKeys is null || payload.ObjectKeys.Count > 10_002)
        {
            throw WorkerJobException.Fail("cleanup_payload_invalid", "cleanup payload is incomplete");
        }
        if (clock.GetUtcNow() < payload.NotBefore)
        {
            throw WorkerJobException.Retry("cleanup_not_ready", "the cleanup safety delay has not elapsed");
        }

        var offset = 0;
        var deleted = 0;
        while (true)
        {
            ObjectCleanupCapabilityResponse capability;
            try
            {
                capability = await core.GetJsonAsync(job, $"/internal/worker-executions/object-cleanup?offset={offset}", InternalJsonContext.Default.ObjectCleanupCapabilityResponse, CapabilityResponseLimit, cancellationToken).ConfigureAwait(false)
                    ?? throw new WorkerLoopbackException(200, "/internal/worker-executions/object-cleanup", "empty capability");
            }
            catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException)
            {
                throw ImportSupport.ApiFailure("cleanup_capability_unavailable", exception);
            }
            if (capability.OwnerKind != payload.OwnerKind || capability.OwnerId != payload.OwnerId || capability.NotBefore != payload.NotBefore)
            {
                throw WorkerJobException.Fail("cleanup_capability_invalid", "Core returned cleanup capabilities for a different owner");
            }
            foreach (var target in capability.DeleteUrls)
            {
                try
                {
                    await objects.DeleteAsync(target, cancellationToken).ConfigureAwait(false);
                }
                catch (ObjectTransferException exception)
                {
                    throw WorkerJobException.Retry("cleanup_object_unavailable", exception.Message);
                }
                deleted++;
            }
            if (capability.NextOffset is not { } next)
            {
                break;
            }
            if (next <= offset || next > payload.ObjectKeys.Count)
            {
                throw WorkerJobException.Fail("cleanup_capability_invalid", "Core returned an invalid cleanup cursor");
            }
            offset = next;
        }
        if (deleted != payload.ObjectKeys.Count)
        {
            throw WorkerJobException.Fail("cleanup_capability_invalid", "Core returned an incomplete cleanup target set");
        }
        if (payload.OwnerKind == "workspace-purge")
        {
            try
            {
                await core.PostJsonAsync<object>(job, "/internal/worker-executions/workspace-purge/finalize", null, null, 0, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException)
            {
                throw ImportSupport.ApiFailure("workspace_purge_finalize_unavailable", exception);
            }
        }
        return JsonSerializer.Serialize(new ObjectCleanupResult(payload.OwnerKind, payload.OwnerId, deleted), WorkersJsonContext.Default.ObjectCleanupResult);
    }
}

/// <summary>What a finished cleanup reports.</summary>
public sealed record ObjectCleanupResult(string OwnerKind, Guid OwnerId, int Deleted);
