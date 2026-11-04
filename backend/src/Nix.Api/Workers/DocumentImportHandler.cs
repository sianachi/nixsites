#pragma warning disable CA2000 // Justification: the request body handed to the loopback client is owned and disposed by the request it is attached to.
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Nix.Abstractions.Importing;
using Nix.Features.DocumentImports;
using Nix.Workers.Archive;
using Nix.Workers.Import;
using Nix.Workers.Transfer;

namespace Nix.Workers;

/// <summary>
/// The <c>import.preview.*</c> and <c>import.commit</c> jobs. Preview parses the uploaded source
/// into a deterministic plan and stores it; commit re-downloads both, re-parses the source and
/// requires the same plan digest, then stages the tree in one Core transaction, publishes files
/// create-only, writes bodies through Collab and finalises. Every failure after staging rejects
/// the import, which hard-deletes the staged tree: an import is all or nothing. A port of the Go
/// <c>documentimport</c> handler.
/// </summary>
public sealed class DocumentImportHandler(WorkerLoopbackClient core, ObjectTransfer objects, CollabImportClient collab, IOptions<WorkerOptions> options) : IWorkerJobHandler
{
    private const int SmallResponseLimit = 64 << 10;
    private const int StageResponseLimit = 16 << 20;
    private const int PlanResponseLimit = 1 << 20;

    public IReadOnlyList<string> Kinds { get; } =
        ["import.preview.nix", "import.preview.markdown", "import.preview.txt", "import.preview.docx", "import.preview.pdf", "import.commit"];

    /// <summary>The bounds the Go worker ran with, scaled by the configured source size.</summary>
    public static ImportPlanLimits Limits(WorkerOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        return new ImportPlanLimits(options.MaxInputBytes, 16L << 20, 8L << 20, 8L << 20, Math.Min(options.MaxRecords, 10_000), 32, 30);
    }

    public async Task<string?> HandleAsync(WorkerExecution job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        DocumentImportJobPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize(job.Job.Payload, DocumentImportsJsonContext.Default.DocumentImportJobPayload);
        }
        catch (JsonException)
        {
            payload = null;
        }
        if (payload is null || payload.ImportId == Guid.Empty)
        {
            throw WorkerJobException.Fail("import_payload_invalid", "importId is required");
        }
        if (job.Job.Kind == "import.commit")
        {
            return await CommitAsync(job, payload.ImportId, cancellationToken).ConfigureAwait(false);
        }
        if (job.Job.Kind.StartsWith("import.preview.", StringComparison.Ordinal))
        {
            return await PreviewAsync(job, payload.ImportId, job.Job.Kind["import.preview.".Length..], cancellationToken).ConfigureAwait(false);
        }
        throw WorkerJobException.Fail("import_kind_mismatch", "job kind is not a document import operation");
    }

    private async Task<string> PreviewAsync(WorkerExecution job, Guid importId, string kindFormat, CancellationToken cancellationToken)
    {
        var limits = Limits(options.Value);
        var basePath = $"/internal/worker-executions/imports/{importId:D}";
        WorkerDocumentImportPreviewResponse preview;
        try
        {
            preview = await core.GetJsonAsync(job, basePath + "/preview", DocumentImportsJsonContext.Default.WorkerDocumentImportPreviewResponse, SmallResponseLimit, cancellationToken).ConfigureAwait(false)
                ?? throw new WorkerLoopbackException(200, basePath, "empty preview");
        }
        catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException)
        {
            throw ImportSupport.ApiFailure("import_preview_unavailable", exception);
        }
        if (preview.ImportId != importId || preview.Format != kindFormat || preview.DeclaredByteLength < 0 || preview.DeclaredByteLength > limits.MaxSourceBytes)
        {
            throw await RejectAsync(job, basePath, "import_preview_invalid", "Core returned inconsistent import metadata", cancellationToken).ConfigureAwait(false);
        }
        using var source = await DownloadAsync(preview.SourceUrl, limits.MaxSourceBytes, "import_source_unavailable", cancellationToken).ConfigureAwait(false);
        if (source.Size != preview.DeclaredByteLength)
        {
            throw await RejectAsync(job, basePath, "import_size_mismatch", "uploaded source size does not match its declaration", cancellationToken).ConfigureAwait(false);
        }
        ImportPlan plan;
        byte[] planBytes;
        string planDigest;
        try
        {
            plan = await ImportPlanner.ParseAsync(new ImportSource(source.Path, preview.Format, preview.Title, preview.FileName, preview.DeclaredMediaType, source.Size, source.Sha256), limits, cancellationToken).ConfigureAwait(false);
        }
        catch (ImportPlanException exception)
        {
            throw await RejectAsync(job, basePath, exception.Code, exception.Message, cancellationToken).ConfigureAwait(false);
        }
        try
        {
            (planBytes, planDigest) = ImportPlanner.Encode(plan, limits.MaxPlanBytes);
        }
        catch (ImportPlanException exception)
        {
            throw await RejectAsync(job, basePath, "import_plan_invalid", exception.Message, cancellationToken).ConfigureAwait(false);
        }
        try
        {
            using var body = new MemoryStream(planBytes, writable: false);
            await objects.UploadAsync(preview.PlanUploadUrl, "application/json", body, planBytes.Length, planDigest, createOnly: false, storageChecksum: false, cancellationToken).ConfigureAwait(false);
        }
        catch (ObjectTransferException exception)
        {
            throw WorkerJobException.Retry("import_plan_upload_failed", exception.Message);
        }
        var assets = plan.Items.Count(item => item.File is { SourceKind: "asset" });
        var completion = new CompleteDocumentImportPreviewRequest(planDigest, planBytes.Length, source.Sha256, plan.Items.Count, assets, [.. plan.Loss], [.. plan.Omissions]);
        try
        {
            await core.PostJsonAsync<object>(job, basePath + "/preview/complete", WorkerLoopbackClient.Json(completion, DocumentImportsJsonContext.Default.CompleteDocumentImportPreviewRequest), null, 0, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException)
        {
            throw ImportSupport.ApiFailure("import_preview_completion_failed", exception);
        }
        return JsonSerializer.Serialize(new DocumentImportPreviewResult(importId, plan.Items.Count, assets, [.. plan.Loss], [.. plan.Omissions]), WorkersJsonContext.Default.DocumentImportPreviewResult);
    }

    private async Task<string> CommitAsync(WorkerExecution job, Guid importId, CancellationToken cancellationToken)
    {
        var limits = Limits(options.Value);
        var basePath = $"/internal/worker-executions/imports/{importId:D}";
        WorkerDocumentImportCommitResponse commit;
        try
        {
            commit = await core.GetJsonAsync(job, basePath + "/commit", DocumentImportsJsonContext.Default.WorkerDocumentImportCommitResponse, SmallResponseLimit, cancellationToken).ConfigureAwait(false)
                ?? throw new WorkerLoopbackException(200, basePath, "empty commit");
        }
        catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException)
        {
            throw ImportSupport.ApiFailure("import_commit_unavailable", exception);
        }
        if (commit.ImportId != importId || commit.DeclaredByteLength < 0 || commit.DeclaredByteLength > limits.MaxSourceBytes || commit.PlanByteLength <= 0 || commit.PlanByteLength > limits.MaxPlanBytes)
        {
            throw await RejectAsync(job, basePath, "import_commit_invalid", "Core returned inconsistent commit metadata", cancellationToken).ConfigureAwait(false);
        }
        using var source = await DownloadAsync(commit.SourceUrl, limits.MaxSourceBytes, "import_source_unavailable", cancellationToken).ConfigureAwait(false);
        if (source.Size != commit.DeclaredByteLength || !string.Equals(source.Sha256, commit.SourceSha256, StringComparison.OrdinalIgnoreCase))
        {
            throw await RejectAsync(job, basePath, "import_source_changed", "the source changed after preview", cancellationToken).ConfigureAwait(false);
        }
        using var planned = await DownloadAsync(commit.PlanUrl, limits.MaxPlanBytes, "import_plan_unavailable", cancellationToken).ConfigureAwait(false);
        if (planned.Size != commit.PlanByteLength || !string.Equals(planned.Sha256, commit.PlanSha256, StringComparison.OrdinalIgnoreCase))
        {
            throw await RejectAsync(job, basePath, "import_plan_changed", "the import plan changed after preview", cancellationToken).ConfigureAwait(false);
        }
        ImportPlan plan;
        try
        {
            plan = ImportPlanner.Decode(await File.ReadAllBytesAsync(planned.Path, cancellationToken).ConfigureAwait(false), commit.PlanSha256, limits);
        }
        catch (ImportPlanException exception)
        {
            throw await RejectAsync(job, basePath, "import_plan_invalid", exception.Message, cancellationToken).ConfigureAwait(false);
        }
        if (plan.Format != commit.Format || plan.Title != commit.Title || !string.Equals(plan.SourceSha256, commit.SourceSha256, StringComparison.OrdinalIgnoreCase))
        {
            throw await RejectAsync(job, basePath, "import_plan_mismatch", "the plan does not describe this import", cancellationToken).ConfigureAwait(false);
        }
        var importSource = new ImportSource(source.Path, commit.Format, commit.Title, commit.FileName, commit.DeclaredMediaType, source.Size, source.Sha256);
        try
        {
            var reparsed = await ImportPlanner.ParseAsync(importSource, limits, cancellationToken).ConfigureAwait(false);
            var (_, reparsedDigest) = ImportPlanner.Encode(reparsed, limits.MaxPlanBytes);
            if (!string.Equals(reparsedDigest, commit.PlanSha256, StringComparison.OrdinalIgnoreCase))
            {
                throw await RejectAsync(job, basePath, "import_plan_mismatch", "the deterministic preview no longer matches the source", cancellationToken).ConfigureAwait(false);
            }
        }
        catch (ImportPlanException exception)
        {
            throw await RejectAsync(job, basePath, exception.Code == ImportPlanException.PlanInvalid ? "import_plan_mismatch" : exception.Code, exception.Message, cancellationToken).ConfigureAwait(false);
        }

        var stageRequest = new StageDocumentImportRequest(
            commit.PlanSha256,
            commit.SourceSha256,
            plan.Items.Select(StageItem).ToArray(),
            plan.FileVersions is { Count: > 0 } versions
                ? versions.Select(file => new StageDocumentImportFileVersionRequest(file.ItemId, file.Version, file.FileName, file.MediaType, file.ByteLength, file.Sha256, file.Previewable, file.PixelWidth, file.PixelHeight)).ToArray()
                : null);
        DocumentImportStageResponse stage;
        try
        {
            stage = await core.PostJsonAsync(job, basePath + "/stage", WorkerLoopbackClient.Json(stageRequest, DocumentImportsJsonContext.Default.StageDocumentImportRequest), DocumentImportsJsonContext.Default.DocumentImportStageResponse, StageResponseLimit, cancellationToken).ConfigureAwait(false)
                ?? throw new WorkerLoopbackException(200, basePath, "empty stage");
        }
        catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException)
        {
            var classified = ImportSupport.ApiFailure("import_stage_failed", exception);
            if (ImportSupport.RetryableOrLeaseLost(exception) || classified.Retryable)
            {
                throw classified;
            }
            throw await RejectAsync(job, basePath, "import_stage_failed", exception.Message, cancellationToken).ConfigureAwait(false);
        }
        if (stage.ImportId != importId || stage.Items.Count != plan.Items.Count)
        {
            throw await RejectAsync(job, basePath, "import_stage_invalid", "Core returned an incomplete staging map", cancellationToken).ConfigureAwait(false);
        }
        if (plan.FileVersions is { Count: > 0 })
        {
            try
            {
                await TransferArchiveFileVersionsAsync(job, basePath, source.Path, plan.FileVersions, stage, limits, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception) when (exception is ImportPlanException or ObjectTransferException or WorkerJobException or WorkerLoopbackException or HttpRequestException or InvalidDataException)
            {
                if (ImportSupport.RetryableOrLeaseLost(exception))
                {
                    throw;
                }
                throw await RejectAsync(job, basePath, exception is WorkerJobException typed ? typed.Code : "import_file_invalid", exception.Message, cancellationToken).ConfigureAwait(false);
            }
        }

        var mapped = new Dictionary<string, DocumentImportStageItemResponse>(StringComparer.Ordinal);
        foreach (var item in stage.Items)
        {
            if (!mapped.TryAdd(item.SourceId, item))
            {
                throw await RejectAsync(job, basePath, "import_stage_invalid", "Core returned duplicate staging mappings", cancellationToken).ConfigureAwait(false);
            }
        }
        foreach (var item in plan.Items)
        {
            if (!mapped.TryGetValue(item.SourceId, out var mapping) || mapping.ItemType != item.ItemType || mapping.BodyRequired != (item.Body is not null))
            {
                throw await RejectAsync(job, basePath, "import_stage_invalid", "Core staging mappings disagree with the plan", cancellationToken).ConfigureAwait(false);
            }
            if (item.File is null || mapping.ObjectReady)
            {
                continue;
            }
            try
            {
                await UploadFileAsync(job, basePath, importSource, item, limits, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception) when (exception is ImportPlanException or ObjectTransferException or WorkerJobException or WorkerLoopbackException or HttpRequestException or InvalidDataException)
            {
                if (ImportSupport.RetryableOrLeaseLost(exception))
                {
                    throw;
                }
                throw await RejectAsync(job, basePath, "import_file_invalid", exception.Message, cancellationToken).ConfigureAwait(false);
            }
        }
        try
        {
            var writes = plan.Items.Where(item => item.Body is not null).Select(item => new ImportBodyWrite(item.SourceId, item.Body!)).ToArray();
            await collab.WriteDocumentBodiesAsync(job, importId, new ImportBodyWrites(writes), WorkersJsonContext.Default.ImportBodyWrites, cancellationToken).ConfigureAwait(false);
        }
        catch (WorkerLoopbackException exception) when (exception.Status is 409 or >= 500)
        {
            throw WorkerJobException.Retry("import_body_write_failed", exception.Message);
        }
        catch (Exception exception) when (exception is HttpRequestException or OperationCanceledException && !cancellationToken.IsCancellationRequested)
        {
            throw WorkerJobException.Retry("import_body_write_failed", exception.Message);
        }
        catch (WorkerLoopbackException exception)
        {
            throw await RejectAsync(job, basePath, "import_body_invalid", exception.Message, cancellationToken).ConfigureAwait(false);
        }
        DocumentImportResponse result;
        try
        {
            result = await core.PostJsonAsync(job, basePath + "/finalize", null, DocumentImportsJsonContext.Default.DocumentImportResponse, SmallResponseLimit, cancellationToken).ConfigureAwait(false)
                ?? throw new WorkerLoopbackException(200, basePath, "empty finalize");
        }
        catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException)
        {
            var classified = ImportSupport.ApiFailure("import_finalize_failed", exception);
            if (ImportSupport.RetryableOrLeaseLost(exception) || classified.Retryable)
            {
                throw classified;
            }
            throw await RejectAsync(job, basePath, "import_finalize_failed", exception.Message, cancellationToken).ConfigureAwait(false);
        }
        if (result.Status != "completed" || result.RootItemId != stage.RootItemId)
        {
            throw WorkerJobException.Fail("import_finalize_invalid", "Core did not confirm the published root");
        }
        var assets = plan.Items.Count(item => item.File is { SourceKind: "asset" });
        return JsonSerializer.Serialize(new DocumentImportCommitResult(importId, stage.RootItemId, plan.Items.Count, assets), WorkersJsonContext.Default.DocumentImportCommitResult);
    }

    private async Task UploadFileAsync(WorkerExecution job, string basePath, ImportSource source, ImportItem item, ImportPlanLimits limits, CancellationToken cancellationToken)
    {
        var file = item.File ?? throw new ImportPlanException("file plan is missing");
        Stream body;
        IDisposable owner;
        switch (file.SourceKind)
        {
            case "source":
                body = File.OpenRead(source.Path);
                owner = body;
                break;
            case "asset":
                var asset = AssetReader.Open(source, file.AssetPath ?? throw new ImportPlanException("asset path is missing"), limits);
                if (asset.Size != file.ByteLength)
                {
                    asset.Dispose();
                    throw new ImportPlanException("asset size changed after preview");
                }
                body = asset.Body;
                owner = asset;
                break;
            default:
                throw new ImportPlanException("file source kind is unsupported");
        }
        using (owner)
        {
            DocumentImportObjectCapabilityResponse capability;
            try
            {
                capability = await core.GetJsonAsync(job, $"{basePath}/objects/capability?sourceId={Uri.EscapeDataString(item.SourceId)}", DocumentImportsJsonContext.Default.DocumentImportObjectCapabilityResponse, SmallResponseLimit, cancellationToken).ConfigureAwait(false)
                    ?? throw new WorkerLoopbackException(200, basePath, "empty capability");
            }
            catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException)
            {
                throw ImportSupport.ApiFailure("import_file_capability_failed", exception);
            }
            if (capability.SourceId != item.SourceId)
            {
                throw new ImportPlanException("Core returned a capability for the wrong file");
            }
            using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            using var limited = new LimitedReadStream(body, file.ByteLength);
            using var hashing = new HashingReadStream(limited, digest);
            try
            {
                await objects.UploadCreateOnlyAsync(capability.UploadUrl, file.MediaType, hashing, file.ByteLength, file.Sha256, cancellationToken).ConfigureAwait(false);
                if (!string.Equals(Convert.ToHexStringLower(digest.GetCurrentHash()), file.Sha256, StringComparison.OrdinalIgnoreCase))
                {
                    try
                    {
                        await objects.DeleteAsync(capability.DeleteUrl, CancellationToken.None).ConfigureAwait(false);
                    }
                    catch (ObjectTransferException)
                    {
                    }
                    throw new ImportPlanException("file checksum changed after preview");
                }
            }
            catch (ObjectTransferException exception) when (exception.AlreadyExists)
            {
                await VerifyPublishedFileAsync(capability.Url, file.ByteLength, file.Sha256, cancellationToken).ConfigureAwait(false);
            }
            catch (ObjectTransferException exception)
            {
                throw WorkerJobException.Retry("import_file_upload_failed", exception.Message);
            }
        }
        try
        {
            await core.PostJsonAsync<object>(job, basePath + "/objects/complete", WorkerLoopbackClient.Json(new CompleteDocumentImportObjectRequest(item.SourceId, file.ByteLength, file.Sha256), DocumentImportsJsonContext.Default.CompleteDocumentImportObjectRequest), null, 0, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException)
        {
            throw ImportSupport.ApiFailure("import_file_completion_failed", exception);
        }
    }

    private async Task TransferArchiveFileVersionsAsync(WorkerExecution job, string basePath, string archivePath, IList<FileVersionEntry> descriptors, DocumentImportStageResponse stage, ImportPlanLimits limits, CancellationToken cancellationToken)
    {
        NixArchiveFiles archives;
        try
        {
            archives = NixArchiveFiles.Open(archivePath, limits);
        }
        catch (Exception exception) when (exception is ImportPlanException or InvalidDataException or IOException)
        {
            throw WorkerJobException.Fail("import_file_archive_invalid", exception.Message);
        }
        using (archives)
        {
            var expected = descriptors.ToDictionary(descriptor => Key(descriptor.ItemId, descriptor.Version), StringComparer.Ordinal);
            var mappings = (stage.FileTransfers ?? []).ToDictionary(mapping => Key(mapping.SourceItemId, mapping.TargetVersion), StringComparer.Ordinal);
            if (mappings.Count != expected.Count)
            {
                throw new ImportPlanException("Core returned incomplete archive file-version mappings");
            }
            var seen = new HashSet<string>(StringComparer.Ordinal);
            Guid? after = null;
            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var planPath = $"{basePath}/file-versions/authorization?limit={ImportSupport.PlanPageLimit}" + (after is { } cursor ? "&afterTransferId=" + cursor.ToString("D") : string.Empty);
                DocumentImportFileVersionsAuthorizationResponse page;
                try
                {
                    page = await core.GetJsonAsync(job, planPath, DocumentImportsJsonContext.Default.DocumentImportFileVersionsAuthorizationResponse, PlanResponseLimit, cancellationToken).ConfigureAwait(false)
                        ?? throw new WorkerLoopbackException(200, planPath, "empty file plan");
                }
                catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException)
                {
                    throw ImportSupport.ApiFailure("import_file_capability_failed", exception);
                }
                if (page.ImportId != stage.ImportId || page.Files.Count > ImportSupport.PlanPageLimit || page.Complete != (page.NextAfterTransferId is null))
                {
                    throw WorkerJobException.Retry("import_file_capability_failed", "worker API document import file-version plan is invalid");
                }
                foreach (var file in page.Files)
                {
                    var key = Key(file.SourceItemId, file.TargetVersion);
                    if (!expected.TryGetValue(key, out var descriptor) || !mappings.TryGetValue(key, out var mapping) || mapping.TransferId != file.TransferId || mapping.TargetItemId != file.TargetItemId
                        || file.FileName != descriptor.FileName || file.MediaType != descriptor.MediaType || file.ByteLength != descriptor.ByteLength || !string.Equals(file.Sha256, descriptor.Sha256, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new ImportPlanException("Core returned file capabilities that differ from the validated archive");
                    }
                    if (!seen.Add(key))
                    {
                        throw new ImportPlanException("Core returned a duplicate archive file-version transfer");
                    }
                    if (file.Ready)
                    {
                        continue;
                    }
                    if (file.UploadUrl is null || file.VerifyUrl is null)
                    {
                        throw new ImportPlanException("Core omitted archive file-version capabilities");
                    }
                    try
                    {
                        await CopyArchiveFileVersionAsync(archives, file, cancellationToken).ConfigureAwait(false);
                    }
                    catch (ObjectTransferException exception) when (!exception.Conflict)
                    {
                        throw WorkerJobException.Retry("import_file_transfer_failed", exception.Message);
                    }
                    try
                    {
                        var completion = await core.PostJsonAsync(job, basePath + "/file-versions/complete", WorkerLoopbackClient.Json(new CompleteDocumentImportFileVersionsRequest([file.TransferId]), DocumentImportsJsonContext.Default.CompleteDocumentImportFileVersionsRequest), DocumentImportsJsonContext.Default.CompleteDocumentImportFileVersionsResponse, SmallResponseLimit, cancellationToken).ConfigureAwait(false);
                        if (completion is null || completion.ImportId != stage.ImportId || !completion.CompletedTransferIds.SequenceEqual([file.TransferId]))
                        {
                            throw new WorkerLoopbackException(200, basePath, "worker API rejected document import file completion");
                        }
                    }
                    catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException)
                    {
                        throw ImportSupport.ApiFailure("import_file_completion_failed", exception);
                    }
                }
                if (page.Complete)
                {
                    if (seen.Count != expected.Count)
                    {
                        throw new ImportPlanException("Core omitted one or more archive file versions");
                    }
                    return;
                }
                after = page.NextAfterTransferId;
            }
        }
    }

    private async Task CopyArchiveFileVersionAsync(NixArchiveFiles archive, DocumentImportFileVersionCapabilityResponse file, CancellationToken cancellationToken)
    {
        try
        {
            await VerifyPublishedFileAsync(file.VerifyUrl!, file.ByteLength, file.Sha256, cancellationToken).ConfigureAwait(false);
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
                await objects.UploadCreateOnlyAsync(file.UploadUrl!, file.MediaType, hashing, file.ByteLength, file.Sha256, cancellationToken).ConfigureAwait(false);
            }
            catch (ObjectTransferException exception) when (exception.AlreadyExists)
            {
                await VerifyPublishedFileAsync(file.VerifyUrl!, file.ByteLength, file.Sha256, cancellationToken).ConfigureAwait(false);
                return;
            }
            if (!string.Equals(Convert.ToHexStringLower(digest.GetCurrentHash()), file.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                throw new ObjectTransferException("source checksum does not match") { Conflict = true };
            }
        }
        await VerifyPublishedFileAsync(file.VerifyUrl!, file.ByteLength, file.Sha256, cancellationToken).ConfigureAwait(false);
    }

    private async Task VerifyPublishedFileAsync(Uri url, long size, string expectedDigest, CancellationToken cancellationToken)
    {
        try
        {
            await ImportSupport.VerifyObjectAsync(objects, url, size, expectedDigest, cancellationToken).ConfigureAwait(false);
        }
        catch (ObjectTransferException exception) when (exception.Conflict)
        {
            throw WorkerJobException.Fail("import_file_publication_conflict", "the immutable destination contains different bytes");
        }
        catch (ObjectTransferException exception) when (!exception.NotFound)
        {
            throw WorkerJobException.Retry("import_file_verification_failed", exception.Message);
        }
    }

    private async Task<ImportSupport.LocalObject> DownloadAsync(Uri url, long maximum, string retryCode, CancellationToken cancellationToken)
    {
        try
        {
            return await ImportSupport.DownloadAsync(objects, url, maximum, options.Value.SpoolDirectory, "nix-document-import-", cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is ObjectTransferException or IOException)
        {
            throw WorkerJobException.Retry(retryCode, exception.Message);
        }
    }

    private async Task<WorkerJobException> RejectAsync(WorkerExecution job, string basePath, string code, string detail, CancellationToken cancellationToken)
    {
        using var cleanup = CancellationTokenSource.CreateLinkedTokenSource(CancellationToken.None);
        cleanup.CancelAfter(TimeSpan.FromSeconds(20));
        try
        {
            await core.PostJsonAsync<object>(job, basePath + "/reject", WorkerLoopbackClient.Json(new RejectDocumentImportRequest(code), DocumentImportsJsonContext.Default.RejectDocumentImportRequest), null, 0, cleanup.Token).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException or OperationCanceledException)
        {
            return ImportSupport.ApiFailure("import_rejection_failed", exception);
        }
        _ = cancellationToken;
        return WorkerJobException.Fail(code, detail);
    }

    private static StageDocumentImportItemRequest StageItem(ImportItem item) => new(
        item.SourceId,
        item.ParentSourceId,
        item.Order,
        item.Title,
        item.ItemType,
        item.Properties,
        item.Schema,
        item.Views,
        item.FinalLifecycleState,
        item.Body is not null,
        item.File is { } file ? new StageDocumentImportFileRequest(file.SourceKind, file.AssetPath, file.FileName, file.MediaType, file.ByteLength, file.Sha256, file.Previewable, file.PixelWidth, file.PixelHeight) : null,
        item.Comments is { ValueKind: JsonValueKind.Array } comments ? comments.Deserialize(DocumentImportsJsonContext.Default.IReadOnlyListImportCommentThread) : null);

    private static string Key(string itemId, int version) => itemId + "/" + version.ToString(System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>Reads at most a declared number of bytes from a longer stream.</summary>
    private sealed class LimitedReadStream(Stream inner, long limit) : Stream
    {
        private long remaining = limit;

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

        public override void Flush()
        {
        }

        public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (remaining <= 0)
            {
                return 0;
            }
            var read = await inner.ReadAsync(buffer[..(int)Math.Min(buffer.Length, remaining)], cancellationToken).ConfigureAwait(false);
            remaining -= read;
            return read;
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}

/// <summary>Hashes everything read through it.</summary>
internal sealed class HashingReadStream(Stream inner, IncrementalHash digest) : Stream
{
    public override bool CanRead => true;

    public override bool CanSeek => false;

    public override bool CanWrite => false;

    public override long Length => throw new NotSupportedException();

    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

    public override void Flush()
    {
    }

    public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        var read = await inner.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
        digest.AppendData(buffer.Span[..read]);
        return read;
    }

    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

    public override void SetLength(long value) => throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}

/// <summary>What a finished preview reports.</summary>
public sealed record DocumentImportPreviewResult(Guid ImportId, int Items, int Assets, IReadOnlyList<string> Loss, IReadOnlyList<string> Omissions);

/// <summary>What a finished commit reports.</summary>
public sealed record DocumentImportCommitResult(Guid ImportId, Guid RootItemId, int Items, int Assets);

/// <summary>The Collab body-write request for a document import.</summary>
public sealed record ImportBodyWrites(IReadOnlyList<ImportBodyWrite> Writes);

public sealed record ImportBodyWrite(string SourceId, ImportBody Body);
