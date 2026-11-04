#pragma warning disable CA2000 // Justification: the request body handed to the loopback client is owned and disposed by the request it is attached to.
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Nix.Features.TemplateImports;
using Nix.Workers.Import;
using Nix.Workers.Transfer;

namespace Nix.Workers;

/// <summary>
/// The <c>template.preview</c> and <c>template.commit</c> jobs: a template archive becomes a
/// deterministic plan; commit re-validates source and plan, stages the template in Core, writes
/// bodies through Collab, streams archived file versions create-only and completes. A durable
/// completed result replays without touching any capability; a Core 409 with
/// <c>worker.execution_refused</c> is a lost lease. A port of the Go <c>templateimport</c> handler.
/// </summary>
public sealed class TemplateImportHandler(WorkerLoopbackClient core, ObjectTransfer objects, CollabImportClient collab, IOptions<WorkerOptions> options) : IWorkerJobHandler
{
    private const int SmallResponseLimit = 64 << 10;
    private const int StageResponseLimit = 16 << 20;
    private const int PlanResponseLimit = 1 << 20;
    private const string LeaseLostCode = "worker.execution_refused";

    public IReadOnlyList<string> Kinds { get; } = ["template.preview", "template.commit"];

    public async Task<string?> HandleAsync(WorkerExecution job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        TemplateImportJobPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize(job.Job.Payload, TemplateImportsJsonContext.Default.TemplateImportJobPayload);
        }
        catch (JsonException)
        {
            payload = null;
        }
        if (payload is null || payload.ImportId == Guid.Empty)
        {
            throw WorkerJobException.Fail("template_payload_invalid", "importId must be a UUID");
        }
        cancellationToken.ThrowIfCancellationRequested();
        return job.Job.Kind switch
        {
            "template.preview" => await PreviewAsync(job, payload.ImportId, cancellationToken).ConfigureAwait(false),
            "template.commit" => await CommitAsync(job, payload.ImportId, cancellationToken).ConfigureAwait(false),
            _ => throw WorkerJobException.Fail("template_kind_mismatch", "job kind is not a template import operation"),
        };
    }

    private async Task<string> PreviewAsync(WorkerExecution job, Guid importId, CancellationToken cancellationToken)
    {
        var limits = DocumentImportHandler.Limits(options.Value);
        var basePath = $"/internal/worker-executions/template-imports/{importId:D}";
        WorkerTemplateImportPreviewResponse preview;
        try
        {
            preview = await core.GetJsonAsync(job, basePath + "/preview", TemplateImportsJsonContext.Default.WorkerTemplateImportPreviewResponse, SmallResponseLimit, cancellationToken).ConfigureAwait(false)
                ?? throw new WorkerLoopbackException(200, basePath, "empty preview");
        }
        catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException)
        {
            throw await ApiErrorAsync(job, basePath, "template_preview_unavailable", exception, cancellationToken).ConfigureAwait(false);
        }
        if (preview.ImportId != importId || !ValidMetadata(preview.WorkspaceId, preview.Origin, preview.ManagedSource, preview.IdempotencyKey, preview.FileName, preview.DeclaredMediaType, preview.DeclaredByteLength, preview.SourceUrl, preview.SourceDeleteUrl, preview.PlanUploadUrl, preview.PlanDeleteUrl, preview.CapabilityExpiresAt))
        {
            throw await RejectAsync(job, basePath, "template_preview_invalid", "Core returned incomplete or invalid template import metadata", cancellationToken).ConfigureAwait(false);
        }
        using var source = await DownloadAsync(job, basePath, preview.SourceUrl, limits.MaxSourceBytes, "template_source_too_large", "template_source_unavailable", cancellationToken).ConfigureAwait(false);
        if (source.Size != preview.DeclaredByteLength)
        {
            throw await RejectAsync(job, basePath, "template_size_mismatch", "uploaded template size does not match its declaration", cancellationToken).ConfigureAwait(false);
        }
        TemplatePlan plan;
        try
        {
            plan = await TemplatePlanner.ParseAsync(TemplateSource(source, preview.FileName, preview.DeclaredMediaType), limits, cancellationToken).ConfigureAwait(false);
        }
        catch (ImportPlanException exception)
        {
            throw await RejectAsync(job, basePath, "template_archive_invalid", exception.Message, cancellationToken).ConfigureAwait(false);
        }
        byte[] planBytes;
        string planDigest;
        try
        {
            (planBytes, planDigest) = TemplatePlanner.Encode(plan, limits.MaxPlanBytes);
        }
        catch (ImportPlanException exception)
        {
            throw await RejectAsync(job, basePath, "template_plan_invalid", exception.Message, cancellationToken).ConfigureAwait(false);
        }
        try
        {
            using var body = new MemoryStream(planBytes, writable: false);
            await objects.UploadAsync(preview.PlanUploadUrl, "application/json", body, planBytes.Length, planDigest, createOnly: false, storageChecksum: false, cancellationToken).ConfigureAwait(false);
        }
        catch (ObjectTransferException exception)
        {
            cancellationToken.ThrowIfCancellationRequested();
            throw WorkerJobException.Retry("template_plan_upload_failed", exception.Message);
        }
        var completion = new CompleteTemplateImportPreviewRequest(planDigest, planBytes.Length, source.Sha256, Profile(plan.Profile), plan.RootItemType, plan.ItemCount, plan.BodyCount, plan.ViewCount);
        try
        {
            await core.PostJsonAsync<object>(job, basePath + "/preview/complete", WorkerLoopbackClient.Json(completion, TemplateImportsJsonContext.Default.CompleteTemplateImportPreviewRequest), null, 0, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException)
        {
            throw await ApiErrorAsync(job, basePath, "template_preview_completion_failed", exception, cancellationToken).ConfigureAwait(false);
        }
        return JsonSerializer.Serialize(new TemplateImportPreviewResult(importId, plan.Profile.Key, plan.RootItemType, plan.ItemCount, plan.BodyCount, plan.ViewCount, source.Sha256, planDigest), WorkersJsonContext.Default.TemplateImportPreviewResult);
    }

    private async Task<string> CommitAsync(WorkerExecution job, Guid importId, CancellationToken cancellationToken)
    {
        var limits = DocumentImportHandler.Limits(options.Value);
        var basePath = $"/internal/worker-executions/template-imports/{importId:D}";
        WorkerTemplateImportCommitResponse commit;
        try
        {
            commit = await core.GetJsonAsync(job, basePath + "/commit", TemplateImportsJsonContext.Default.WorkerTemplateImportCommitResponse, SmallResponseLimit, cancellationToken).ConfigureAwait(false)
                ?? throw new WorkerLoopbackException(200, basePath, "empty commit");
        }
        catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException)
        {
            throw await ApiErrorAsync(job, basePath, "template_commit_unavailable", exception, cancellationToken).ConfigureAwait(false);
        }
        if (commit.CompletedResult is { } durable)
        {
            if (!ValidTerminalResult(importId, durable))
            {
                throw WorkerJobException.Fail("template_completion_invalid", "Core returned an invalid durable template result");
            }
            return CommitResult(durable);
        }
        if (commit.ImportId != importId
            || !ValidMetadata(commit.WorkspaceId, commit.Origin, commit.ManagedSource, commit.IdempotencyKey, commit.FileName, commit.DeclaredMediaType, commit.DeclaredByteLength, commit.SourceUrl, commit.SourceDeleteUrl, commit.PlanUploadUrl, commit.PlanDeleteUrl, commit.CapabilityExpiresAt)
            || commit.PlanByteLength <= 0 || commit.PlanByteLength > limits.MaxPlanBytes || !ImportSupport.IsSha256Hex(commit.PlanSha256) || !ImportSupport.IsSha256Hex(commit.SourceSha256) || commit.PlanUrl is null)
        {
            throw await RejectAsync(job, basePath, "template_commit_invalid", "Core returned invalid template plan metadata", cancellationToken).ConfigureAwait(false);
        }
        using var source = await DownloadAsync(job, basePath, commit.SourceUrl!, limits.MaxSourceBytes, "template_source_too_large", "template_source_unavailable", cancellationToken).ConfigureAwait(false);
        if (source.Size != commit.DeclaredByteLength || !string.Equals(source.Sha256, commit.SourceSha256, StringComparison.OrdinalIgnoreCase))
        {
            throw await RejectAsync(job, basePath, "template.file_changed", "the template source changed after preview", cancellationToken).ConfigureAwait(false);
        }
        using var planned = await DownloadAsync(job, basePath, commit.PlanUrl, limits.MaxPlanBytes, "template_plan_invalid", "template_plan_unavailable", cancellationToken).ConfigureAwait(false);
        if (planned.Size != commit.PlanByteLength || !string.Equals(planned.Sha256, commit.PlanSha256, StringComparison.OrdinalIgnoreCase))
        {
            throw await RejectAsync(job, basePath, "template_plan_changed", "the template plan changed after preview", cancellationToken).ConfigureAwait(false);
        }
        TemplatePlan plan;
        try
        {
            plan = TemplatePlanner.Decode(await File.ReadAllBytesAsync(planned.Path, cancellationToken).ConfigureAwait(false), commit.PlanSha256, limits);
        }
        catch (ImportPlanException exception)
        {
            throw await RejectAsync(job, basePath, "template_plan_invalid", exception.Message, cancellationToken).ConfigureAwait(false);
        }
        if (!string.Equals(plan.SourceSha256, commit.SourceSha256, StringComparison.OrdinalIgnoreCase))
        {
            throw await RejectAsync(job, basePath, "template_plan_mismatch", "the template plan does not describe this source", cancellationToken).ConfigureAwait(false);
        }
        var stageRequest = new StageTemplateImportRequest(
            Profile(plan.Profile),
            plan.Items.Select(item => new StageTemplateImportItemRequest(Guid.Parse(item.SourceId), item.ParentSourceId is { } parent ? Guid.Parse(parent) : null, item.Seq, item.Title, item.ItemType, item.Properties, item.Schema, item.Views, !JsonNull(item.Body), item.Recurrence)).ToArray(),
            (plan.Files ?? []).Select(file => new StageTemplateImportFileRequest(file.ItemId, file.Version, file.FileName, file.MediaType, file.ByteLength, file.Sha256, file.Previewable, file.PixelWidth, file.PixelHeight)).ToArray());
        TemplateImportStageResponse stage;
        try
        {
            stage = await core.PostJsonAsync(job, basePath + "/stage", WorkerLoopbackClient.Json(stageRequest, TemplateImportsJsonContext.Default.StageTemplateImportRequest), TemplateImportsJsonContext.Default.TemplateImportStageResponse, StageResponseLimit, cancellationToken).ConfigureAwait(false)
                ?? throw new WorkerLoopbackException(200, basePath, "empty stage");
        }
        catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException)
        {
            throw await ApiErrorAsync(job, basePath, "template_stage_failed", exception, cancellationToken).ConfigureAwait(false);
        }
        if (!ValidStage(importId, stage, plan))
        {
            throw await RejectAsync(job, basePath, "template_stage_invalid", "Core returned an inconsistent template stage", cancellationToken).ConfigureAwait(false);
        }
        var writtenIds = new List<Guid>();
        if (!stage.Unchanged)
        {
            var bySource = stage.BodyWrites.ToDictionary(mapping => mapping.SourceId);
            var writes = new List<TemplateBodyWrite>();
            var expectedIds = new List<Guid>();
            foreach (var item in plan.Items.Where(item => !JsonNull(item.Body)))
            {
                if (!bySource.TryGetValue(Guid.Parse(item.SourceId), out var mapping) || mapping.ItemType != item.ItemType)
                {
                    throw await RejectAsync(job, basePath, "template_stage_invalid", "template body mapping does not match the deterministic plan", cancellationToken).ConfigureAwait(false);
                }
                writes.Add(new TemplateBodyWrite(item.SourceId, item.Body!.Value));
                expectedIds.Add(mapping.TargetItemId);
            }
            if (writes.Count > 0)
            {
                TemplateBodyWriteResponse? written;
                try
                {
                    written = await collab.WriteTemplateBodiesAsync(job, importId, new TemplateBodyWrites(writes), WorkersJsonContext.Default.TemplateBodyWrites, WorkersJsonContext.Default.TemplateBodyWriteResponse, cancellationToken).ConfigureAwait(false);
                }
                catch (WorkerLoopbackException exception) when (exception.Status == 409 && exception.Code == LeaseLostCode)
                {
                    throw WorkerJobException.Retry("template_body_write_failed", exception.Message);
                }
                catch (WorkerLoopbackException exception) when (exception.Status < 500)
                {
                    throw await RejectAsync(job, basePath, "template_body_invalid", exception.Message, cancellationToken).ConfigureAwait(false);
                }
                catch (Exception exception) when (exception is WorkerLoopbackException or HttpRequestException or OperationCanceledException or JsonException && !cancellationToken.IsCancellationRequested)
                {
                    throw WorkerJobException.Retry("template_body_write_failed", exception.Message);
                }
                writtenIds.AddRange(written?.WrittenTargetItemIds ?? []);
                if (!SameSet(writtenIds, expectedIds))
                {
                    throw await RejectAsync(job, basePath, "template_body_write_invalid", "Collaboration did not confirm every staged template body", cancellationToken).ConfigureAwait(false);
                }
            }
            if (plan.Files is { Count: > 0 })
            {
                await TransferTemplateFilesAsync(job, basePath, source.Path, plan, stage, limits, cancellationToken).ConfigureAwait(false);
            }
        }
        WorkerCompleteTemplateImportResponse result;
        try
        {
            result = await core.PostJsonAsync(job, basePath + "/complete", WorkerLoopbackClient.Json(new CompleteTemplateImportRequest(writtenIds), TemplateImportsJsonContext.Default.CompleteTemplateImportRequest), TemplateImportsJsonContext.Default.WorkerCompleteTemplateImportResponse, PlanResponseLimit, cancellationToken).ConfigureAwait(false)
                ?? throw new WorkerLoopbackException(200, basePath, "empty completion");
        }
        catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException)
        {
            throw await ApiErrorAsync(job, basePath, "template_completion_failed", exception, cancellationToken).ConfigureAwait(false);
        }
        if (result.ImportId != importId || result.TemplateId != stage.TemplateId || result.StableKey != plan.Profile.Key || !string.Equals(result.Digest, plan.SourceSha256, StringComparison.OrdinalIgnoreCase)
            || result.Unchanged != stage.Unchanged || result.ItemCount != plan.ItemCount || result.BodyCount != plan.BodyCount || result.OperationId != stage.OperationId || !SameSet(result.WrittenTargetItemIds, writtenIds))
        {
            throw WorkerJobException.Fail("template_completion_invalid", "Core did not confirm the completed template import");
        }
        return CommitResult(result);
    }

    private async Task TransferTemplateFilesAsync(WorkerExecution job, string basePath, string archivePath, TemplatePlan plan, TemplateImportStageResponse stage, ImportPlanLimits limits, CancellationToken cancellationToken)
    {
        NixArchiveFiles archives;
        try
        {
            archives = NixArchiveFiles.Open(archivePath, limits);
        }
        catch (Exception exception) when (exception is ImportPlanException or InvalidDataException or IOException)
        {
            throw WorkerJobException.Fail("template_file_archive_invalid", exception.Message);
        }
        using (archives)
        {
            var expected = plan.Files!.ToDictionary(file => Key(file.ItemId, file.Version), StringComparer.Ordinal);
            var transfers = (stage.FileTransfers ?? []).ToDictionary(mapping => Key(mapping.SourceItemId, mapping.TargetVersion), StringComparer.Ordinal);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            Guid? after = null;
            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var planPath = $"{basePath}/files/authorization?limit={ImportSupport.PlanPageLimit}" + (after is { } cursor ? "&afterTransferId=" + cursor.ToString("D") : string.Empty);
                TemplateImportFileVersionsAuthorizationResponse page;
                try
                {
                    page = await core.GetJsonAsync(job, planPath, TemplateImportsJsonContext.Default.TemplateImportFileVersionsAuthorizationResponse, PlanResponseLimit, cancellationToken).ConfigureAwait(false)
                        ?? throw new WorkerLoopbackException(200, planPath, "empty file plan");
                }
                catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException)
                {
                    throw await ApiErrorAsync(job, basePath, "template_file_capability_unavailable", exception, cancellationToken).ConfigureAwait(false);
                }
                if (page.ImportId != stage.ImportId || page.Files.Count > ImportSupport.PlanPageLimit || page.Complete != (page.NextAfterTransferId is null))
                {
                    throw WorkerJobException.Retry("template_file_capability_unavailable", "worker API template import file plan is invalid");
                }
                foreach (var file in page.Files)
                {
                    var key = Key(file.SourceItemId, file.TargetVersion);
                    if (!expected.TryGetValue(key, out var descriptor) || !transfers.TryGetValue(key, out var mapping) || mapping.TransferId != file.TransferId || mapping.TargetItemId != file.TargetItemId
                        || file.FileName != descriptor.FileName || file.MediaType != descriptor.MediaType || file.ByteLength != descriptor.ByteLength || !string.Equals(file.Sha256, descriptor.Sha256, StringComparison.OrdinalIgnoreCase))
                    {
                        throw WorkerJobException.Fail("template_file_capability_invalid", "Core returned a file capability that does not match the validated archive");
                    }
                    if (!seen.Add(key))
                    {
                        throw WorkerJobException.Fail("template_file_capability_invalid", "Core returned a duplicate template file transfer");
                    }
                    if (file.Ready)
                    {
                        continue;
                    }
                    try
                    {
                        await CopyTemplateFileAsync(archives, file, cancellationToken).ConfigureAwait(false);
                    }
                    catch (Exception exception) when (exception is ObjectTransferException or ImportPlanException or InvalidDataException or IOException)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        throw WorkerJobException.Retry("template_file_transfer_failed", exception.Message);
                    }
                    try
                    {
                        var completion = await core.PostJsonAsync(job, basePath + "/files/complete", WorkerLoopbackClient.Json(new CompleteTemplateImportFileVersionsRequest([file.TransferId]), TemplateImportsJsonContext.Default.CompleteTemplateImportFileVersionsRequest), TemplateImportsJsonContext.Default.CompleteTemplateImportFileVersionsResponse, SmallResponseLimit, cancellationToken).ConfigureAwait(false);
                        if (completion is null || completion.ImportId != stage.ImportId || !completion.CompletedTransferIds.SequenceEqual([file.TransferId]))
                        {
                            throw new WorkerLoopbackException(200, basePath, "worker API rejected template import file completion");
                        }
                    }
                    catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException)
                    {
                        throw await ApiErrorAsync(job, basePath, "template_file_transfer_completion_failed", exception, cancellationToken).ConfigureAwait(false);
                    }
                }
                if (page.Complete)
                {
                    if (seen.Count != expected.Count)
                    {
                        throw WorkerJobException.Fail("template_file_capability_invalid", "Core omitted one or more staged archive file versions");
                    }
                    return;
                }
                after = page.NextAfterTransferId;
            }
        }
    }

    private async Task CopyTemplateFileAsync(NixArchiveFiles archive, TemplateImportFileVersionCapabilityResponse file, CancellationToken cancellationToken)
    {
        if (file.UploadUrl is null || file.VerifyUrl is null)
        {
            throw new ObjectTransferException("Core omitted a staged template file capability");
        }
        try
        {
            await ImportSupport.VerifyObjectAsync(objects, file.VerifyUrl, file.ByteLength, file.Sha256, cancellationToken).ConfigureAwait(false);
            return;
        }
        catch (ObjectTransferException exception) when (exception.NotFound)
        {
        }
        var content = archive.OpenVersion(file.SourceItemId, file.TargetVersion, file.ByteLength);
        await using (content.ConfigureAwait(false))
        {
            using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            using var hashing = new HashingReadStream(content, digest);
            try
            {
                await objects.UploadCreateOnlyAsync(file.UploadUrl, file.MediaType, hashing, file.ByteLength, file.Sha256, cancellationToken).ConfigureAwait(false);
            }
            catch (ObjectTransferException exception) when (exception.AlreadyExists)
            {
                await ImportSupport.VerifyObjectAsync(objects, file.VerifyUrl, file.ByteLength, file.Sha256, cancellationToken).ConfigureAwait(false);
                return;
            }
            if (!string.Equals(Convert.ToHexStringLower(digest.GetCurrentHash()), file.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                throw new ObjectTransferException("archive file digest does not match its declaration") { Conflict = true };
            }
        }
        await ImportSupport.VerifyObjectAsync(objects, file.VerifyUrl, file.ByteLength, file.Sha256, cancellationToken).ConfigureAwait(false);
    }

    private static bool ValidMetadata(Guid workspaceId, string origin, string? managedSource, string idempotencyKey, string fileName, string mediaType, long byteLength, Uri? sourceUrl, Uri? sourceDeleteUrl, Uri? planUploadUrl, Uri? planDeleteUrl, DateTimeOffset? capabilityExpires)
    {
        if (workspaceId == Guid.Empty || byteLength < 0 || string.IsNullOrWhiteSpace(fileName) || fileName.Length > 500 || string.IsNullOrWhiteSpace(mediaType) || mediaType.Length > 200
            || string.IsNullOrWhiteSpace(idempotencyKey) || idempotencyKey.Length > 500 || sourceUrl is null || sourceDeleteUrl is null || planUploadUrl is null || planDeleteUrl is null || capabilityExpires is null or { Ticks: 0 })
        {
            return false;
        }
        return origin switch
        {
            "user" => managedSource is null,
            "managed" => !string.IsNullOrWhiteSpace(managedSource) && managedSource.Length <= 500,
            _ => false,
        };
    }

    private static bool ValidStage(Guid importId, TemplateImportStageResponse stage, TemplatePlan plan)
    {
        if (stage.ImportId != importId || stage.TemplateId == Guid.Empty || stage.StableKey != plan.Profile.Key || !string.Equals(stage.Digest, plan.SourceSha256, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }
        var itemTypes = plan.Items.ToDictionary(item => Guid.Parse(item.SourceId), item => item.ItemType);
        if (stage.ItemMappings.Count != itemTypes.Count || !ValidMappings(stage.ItemMappings, itemTypes))
        {
            return false;
        }
        var itemTargets = stage.ItemMappings.ToDictionary(mapping => mapping.SourceId, mapping => mapping.TargetItemId);
        if (stage.Unchanged)
        {
            return stage.OperationId is null && stage.BodyWrites.Count == 0 && (stage.FileTransfers ?? []).Count == 0;
        }
        if (stage.OperationId is null || stage.OperationId == Guid.Empty)
        {
            return false;
        }
        var expected = plan.Items.Where(item => !JsonNull(item.Body)).ToDictionary(item => Guid.Parse(item.SourceId), item => item.ItemType);
        if (stage.BodyWrites.Count != expected.Count || !ValidMappings(stage.BodyWrites, expected) || stage.BodyWrites.Any(mapping => itemTargets[mapping.SourceId] != mapping.TargetItemId))
        {
            return false;
        }
        var expectedFiles = (plan.Files ?? []).Select(file => Key(file.ItemId, file.Version)).ToHashSet(StringComparer.Ordinal);
        var transfers = stage.FileTransfers ?? [];
        if (transfers.Count != expectedFiles.Count)
        {
            return false;
        }
        var seenTransfers = new HashSet<Guid>();
        foreach (var mapping in transfers)
        {
            if (!expectedFiles.Contains(Key(mapping.SourceItemId, mapping.TargetVersion)) || mapping.TransferId == Guid.Empty
                || !Guid.TryParse(mapping.SourceItemId, out var sourceId) || !itemTargets.TryGetValue(sourceId, out var target) || target != mapping.TargetItemId || !seenTransfers.Add(mapping.TransferId))
            {
                return false;
            }
        }
        return true;
    }

    private static bool ValidMappings(IReadOnlyList<TemplateImportItemMappingResponse> mappings, Dictionary<Guid, string> expected)
    {
        var seenSources = new HashSet<Guid>();
        var seenTargets = new HashSet<Guid>();
        foreach (var mapping in mappings)
        {
            if (!expected.TryGetValue(mapping.SourceId, out var itemType) || itemType != mapping.ItemType || mapping.TargetItemId == Guid.Empty || !seenSources.Add(mapping.SourceId) || !seenTargets.Add(mapping.TargetItemId))
            {
                return false;
            }
        }
        return seenSources.Count == expected.Count;
    }

    private static bool ValidTerminalResult(Guid importId, WorkerCompleteTemplateImportResponse result)
    {
        if (result.ImportId != importId || result.TemplateId == Guid.Empty || string.IsNullOrWhiteSpace(result.StableKey) || result.StableKey.Length > 160 || !ImportSupport.IsSha256Hex(result.Digest)
            || result.ItemCount is < 1 or > 10_000 || result.BodyCount < 0 || result.BodyCount > result.ItemCount || result.OperationId == Guid.Empty)
        {
            return false;
        }
        if (result.Unchanged)
        {
            return result.OperationId is null && result.WrittenTargetItemIds.Count == 0;
        }
        var seen = new HashSet<Guid>();
        return result.WrittenTargetItemIds.All(target => target != Guid.Empty && seen.Add(target)) && seen.Count == result.BodyCount;
    }

    private async Task<WorkerJobException> ApiErrorAsync(WorkerExecution job, string basePath, string code, Exception exception, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (exception is WorkerLoopbackException { Status: var status } loopback)
        {
            if (status == 409 && loopback.Code == LeaseLostCode)
            {
                return WorkerJobException.Retry(code, exception.Message);
            }
            if (status < 500)
            {
                return await RejectAsync(job, basePath, code, exception.Message, cancellationToken).ConfigureAwait(false);
            }
        }
        return WorkerJobException.Retry(code, exception.Message);
    }

    private async Task<WorkerJobException> RejectAsync(WorkerExecution job, string basePath, string code, string detail, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        try
        {
            await core.PostJsonAsync<object>(job, basePath + "/reject", WorkerLoopbackClient.Json(new RejectTemplateImportRequest(code), TemplateImportsJsonContext.Default.RejectTemplateImportRequest), null, 0, cleanup.Token).ConfigureAwait(false);
        }
        catch (WorkerLoopbackException exception) when (exception.Status == 409)
        {
            return WorkerJobException.Retry(code, exception.Message);
        }
        catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException or OperationCanceledException)
        {
            // A rejection that could not be recorded still fails the job; retention reaps the staged rows.
        }
        return WorkerJobException.Fail(code, detail);
    }

    private async Task<ImportSupport.LocalObject> DownloadAsync(WorkerExecution job, string basePath, Uri url, long maximum, string tooLargeCode, string retryCode, CancellationToken cancellationToken)
    {
        try
        {
            return await ImportSupport.DownloadAsync(objects, url, maximum, options.Value.SpoolDirectory, "nix-template-import-", cancellationToken).ConfigureAwait(false);
        }
        catch (ObjectTransferException exception) when (exception.TooLarge)
        {
            cancellationToken.ThrowIfCancellationRequested();
            throw await RejectAsync(job, basePath, tooLargeCode, exception.Message, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is ObjectTransferException or IOException)
        {
            cancellationToken.ThrowIfCancellationRequested();
            throw WorkerJobException.Retry(retryCode, exception.Message);
        }
    }

    private static ImportSource TemplateSource(ImportSupport.LocalObject source, string fileName, string mediaType) =>
        new(source.Path, "nix", fileName, fileName, mediaType, source.Size, source.Sha256);

    private static TemplateImportProfileResponse Profile(TemplateProfile profile) => new(
        profile.Kind, profile.Version, profile.Key, profile.Name, profile.Description, profile.IncludeBody, profile.IncludeChildren,
        profile.Initialization is { } initialization ? JsonSerializer.SerializeToElement(initialization, TemplateInitializationJsonContext.Default.TemplateInitialization) : null);

    private static string CommitResult(WorkerCompleteTemplateImportResponse result) =>
        JsonSerializer.Serialize(new TemplateImportCommitResult(result.ImportId, result.OperationId, result.TemplateId, result.StableKey, result.Digest, result.Unchanged, result.ItemCount, result.BodyCount, [.. result.WrittenTargetItemIds]), WorkersJsonContext.Default.TemplateImportCommitResult);

    private static bool JsonNull(JsonElement? value) => value is null || value.Value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined;

    private static bool SameSet(IEnumerable<Guid> left, IEnumerable<Guid> right) => left.Order().SequenceEqual(right.Order());

    private static string Key(string itemId, int version) => itemId + "/" + version.ToString(System.Globalization.CultureInfo.InvariantCulture);
}

/// <summary>What a finished template preview reports.</summary>
public sealed record TemplateImportPreviewResult(Guid ImportId, string StableKey, string RootItemType, int ItemCount, int BodyCount, int ViewCount, string SourceSha256, string PlanSha256);

/// <summary>What a finished template commit reports.</summary>
public sealed record TemplateImportCommitResult(Guid ImportId, Guid? OperationId, Guid TemplateId, string StableKey, string Digest, bool Unchanged, int ItemCount, int BodyCount, IReadOnlyList<Guid> WrittenTargetItemIds);

/// <summary>The Collab body-write request for a template import.</summary>
public sealed record TemplateBodyWrites(IReadOnlyList<TemplateBodyWrite> Writes);

public sealed record TemplateBodyWrite(string SourceId, JsonElement Body);

public sealed record TemplateBodyWriteResponse(IReadOnlyList<Guid> WrittenTargetItemIds);

/// <summary>Serialises a template initialization the way the Go worker's json.Marshal did (optional fields omitted when null).</summary>
[System.Text.Json.Serialization.JsonSourceGenerationOptions(PropertyNamingPolicy = System.Text.Json.Serialization.JsonKnownNamingPolicy.CamelCase, DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
[System.Text.Json.Serialization.JsonSerializable(typeof(TemplateInitialization))]
internal sealed partial class TemplateInitializationJsonContext : System.Text.Json.Serialization.JsonSerializerContext;
