#pragma warning disable CA2000 // Justification: the request body handed to the loopback client is owned and disposed by the request it is attached to.
using System.Text.Json;
using Nix.Features.Internal;
using Nix.Workers.Transfer;

namespace Nix.Workers;

/// <summary>
/// The <c>template.files.copy</c> job: copies every pending source object of a template stage to
/// its immutable target, verifies the target by reading it back, and acknowledges each transfer
/// on its own so a later failure never repeats earlier copies. A port of the Go
/// <c>templatefilecopy</c> handler.
/// </summary>
public sealed class TemplateFileCopyHandler(WorkerLoopbackClient core, ObjectTransfer objects) : IWorkerJobHandler
{
    public const string Kind = "template.files.copy";
    private const int PlanResponseLimit = 1 << 20;
    private const int CompleteResponseLimit = 64 << 10;

    public IReadOnlyList<string> Kinds { get; } = [Kind];

    public async Task<string?> HandleAsync(WorkerExecution job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        TemplateFileTransferJobPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize(job.Job.Payload, TemplateFileTransfersJsonContext.Default.TemplateFileTransferJobPayload);
        }
        catch (JsonException)
        {
            payload = null;
        }
        if (payload is null || payload.OwnerKind is not ("operation" or "application") || payload.OwnerId == Guid.Empty)
        {
            throw WorkerJobException.Fail("template_file_copy_payload_invalid", "template file copy owner is invalid");
        }
        if (job.Job.Kind != Kind)
        {
            throw WorkerJobException.Fail("template_file_copy_kind_mismatch", "job kind is not template.files.copy");
        }
        var jobId = job.Job.Id.ToString("D");
        var basePath = $"/internal/worker-executions/template-file-transfers/{jobId}";
        Guid? after = null;
        var verified = 0;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            WorkerTemplateFileTransferPlanResponse plan;
            var planPath = basePath + "/plan?limit=" + ImportSupport.PlanPageLimit + (after is { } cursor ? "&afterTransferId=" + cursor.ToString("D") : string.Empty);
            try
            {
                plan = await core.GetJsonAsync(job, planPath, TemplateFileTransfersJsonContext.Default.WorkerTemplateFileTransferPlanResponse, PlanResponseLimit, cancellationToken).ConfigureAwait(false)
                    ?? throw new WorkerLoopbackException(200, planPath, "empty plan");
            }
            catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException)
            {
                throw ImportSupport.ApiFailure("template_file_copy_plan_unavailable", exception, retryTooManyRequests: true);
            }
            if (!ValidPlan(plan, job.Job.Id, after))
            {
                throw WorkerJobException.Retry("template_file_copy_plan_unavailable", "worker API template file transfer plan is invalid");
            }
            if (plan.OwnerKind != payload.OwnerKind || plan.OwnerId != payload.OwnerId)
            {
                throw WorkerJobException.Fail("template_file_copy_plan_invalid", "Core returned a transfer plan for a different stage");
            }
            foreach (var transfer in plan.Transfers)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!transfer.Ready)
                {
                    try
                    {
                        await CopyAsync(transfer, cancellationToken).ConfigureAwait(false);
                    }
                    catch (ObjectTransferException exception)
                    {
                        // A mismatching immutable object is a durable conflict; transport and
                        // capability failures recover with a fresh capability on the next attempt.
                        throw exception.Conflict
                            ? WorkerJobException.Fail("template_file_copy_failed", exception.Message)
                            : WorkerJobException.Retry("template_file_copy_failed", exception.Message);
                    }
                    try
                    {
                        var completion = await core.PostJsonAsync(job, basePath + "/complete",
                            WorkerLoopbackClient.Json(new CompleteTemplateFileTransferRequest([transfer.TransferId]), TemplateFileTransfersJsonContext.Default.CompleteTemplateFileTransferRequest),
                            TemplateFileTransfersJsonContext.Default.WorkerTemplateFileTransferCompleteResponse, CompleteResponseLimit, cancellationToken).ConfigureAwait(false);
                        if (completion is null || completion.JobId != job.Job.Id || !completion.Completed)
                        {
                            throw new WorkerLoopbackException(200, basePath + "/complete", "worker API rejected template file transfer completion");
                        }
                    }
                    catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException)
                    {
                        throw ImportSupport.ApiFailure("template_file_copy_acknowledgement_failed", exception, retryTooManyRequests: true);
                    }
                }
                verified++;
            }
            if (plan.Complete)
            {
                return JsonSerializer.Serialize(new TemplateFileCopyResult(job.Job.Id, payload.OwnerKind, payload.OwnerId, verified), WorkersJsonContext.Default.TemplateFileCopyResult);
            }
            after = plan.NextAfterTransferId;
        }
    }

    private async Task CopyAsync(WorkerTemplateFileTransferResponse transfer, CancellationToken cancellationToken)
    {
        if (transfer.DownloadUrl is null || transfer.UploadUrl is null || transfer.VerifyUrl is null)
        {
            throw new ObjectTransferException("transfer capabilities are missing");
        }
        // A prior execution may have completed the immutable PUT and lost its acknowledgement:
        // verify the target first so a deleted source cannot strand a valid copy.
        try
        {
            await ImportSupport.VerifyObjectAsync(objects, transfer.VerifyUrl, transfer.ByteLength, transfer.Sha256, cancellationToken).ConfigureAwait(false);
            return;
        }
        catch (ObjectTransferException exception) when (exception.NotFound)
        {
        }
        var source = await objects.DownloadAsync(transfer.DownloadUrl, Math.Max(transfer.ByteLength, 1), cancellationToken).ConfigureAwait(false);
        await using (source.ConfigureAwait(false))
        {
            try
            {
                await objects.UploadCreateOnlyAsync(transfer.UploadUrl, transfer.MediaType, source.Body, transfer.ByteLength, transfer.Sha256, cancellationToken).ConfigureAwait(false);
                if (!string.Equals(source.DigestHex(), transfer.Sha256, StringComparison.OrdinalIgnoreCase))
                {
                    throw new ObjectTransferException("source digest does not match the declared file") { Conflict = true };
                }
            }
            catch (ObjectTransferException exception) when (exception.AlreadyExists)
            {
            }
        }
        await ImportSupport.VerifyObjectAsync(objects, transfer.VerifyUrl, transfer.ByteLength, transfer.Sha256, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>The Go client's plan validation: canonical ids, bounded fields, an ascending cursor, capabilities only on pending transfers.</summary>
    private static bool ValidPlan(WorkerTemplateFileTransferPlanResponse plan, Guid jobId, Guid? after)
    {
        if (plan.JobId != jobId || plan.OwnerKind is not ("operation" or "application") || plan.OwnerId == Guid.Empty || plan.ObservedAt == default
            || plan.Transfers.Count > ImportSupport.PlanPageLimit || plan.Complete != (plan.NextAfterTransferId is null))
        {
            return false;
        }
        var previous = after?.ToString("D") ?? string.Empty;
        foreach (var transfer in plan.Transfers)
        {
            var id = transfer.TransferId.ToString("D");
            if (transfer.TransferId == Guid.Empty || transfer.SourceItemId == Guid.Empty || transfer.TargetItemId == Guid.Empty
                || transfer.TargetVersion is < 1 or > 100 || transfer.ByteLength is < 0 or > (100L << 20) || !ImportSupport.IsSha256Hex(transfer.Sha256)
                || string.IsNullOrWhiteSpace(transfer.FileName) || transfer.FileName.Length > 255 || string.IsNullOrWhiteSpace(transfer.MediaType) || transfer.MediaType.Length > 160
                || string.CompareOrdinal(id, previous) <= 0)
            {
                return false;
            }
            if (transfer.Ready ? transfer.DownloadUrl is not null || transfer.UploadUrl is not null || transfer.VerifyUrl is not null
                               : transfer.DownloadUrl is null || transfer.UploadUrl is null || transfer.VerifyUrl is null)
            {
                return false;
            }
            previous = id;
        }
        return plan.Complete || (plan.Transfers.Count > 0 && plan.NextAfterTransferId == plan.Transfers[^1].TransferId);
    }
}

/// <summary>What a finished copy reports.</summary>
public sealed record TemplateFileCopyResult(Guid JobId, string OwnerKind, Guid OwnerId, int TransfersVerified);
