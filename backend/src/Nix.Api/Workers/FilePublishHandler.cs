#pragma warning disable CA2000 // Justification: the request body handed to the loopback client is owned and disposed by the request it is attached to.
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Nix.Abstractions.Files;
using Nix.Abstractions.Workers;
using Nix.Features.Files;
using Nix.Workers.Files;
using Nix.Workers.Transfer;

namespace Nix.Workers;

/// <summary>
/// The <c>file.publish</c> job: streams an upload to a spool file while sniffing its header, checks
/// the declared size, copies it create-only to its immutable destination, attaches a best-effort
/// thumbnail and publishes the inspection. Bytes are never decoded, executed or unpacked beyond
/// the bounded header and the thumbnail extractor. A port of the Go <c>fileinspect</c> handler.
/// </summary>
public sealed class FilePublishHandler(WorkerLoopbackClient core, ObjectTransfer objects, IOptions<WorkerOptions> options, TimeProvider clock, ILogger<FilePublishHandler>? logger = null) : IWorkerJobHandler, IDisposable
{
    private const int SmallResponseLimit = 64 << 10;
    private readonly SemaphoreSlim _thumbnails = new(Thumbnails.MaxConcurrentThumbnails, Thumbnails.MaxConcurrentThumbnails);
    private readonly ILogger<FilePublishHandler> _logger = logger ?? NullLogger<FilePublishHandler>.Instance;

    public IReadOnlyList<string> Kinds { get; } = ["file.publish"];

    public async Task<string?> HandleAsync(WorkerExecution job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        if (job.Job.Kind != "file.publish")
        {
            throw WorkerJobException.Fail("files.kind_mismatch", "job kind is not file.publish");
        }
        FileInspectPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize(job.Job.Payload, FilesJsonContext.Default.FileInspectPayload);
        }
        catch (JsonException)
        {
            payload = null;
        }
        if (payload is null || payload.UploadId == Guid.Empty)
        {
            throw WorkerJobException.Fail("files.payload_invalid", "uploadId is required");
        }
        var basePath = $"/internal/worker-executions/files/uploads/{payload.UploadId:D}";
        WorkerFileInspectionResponse inspection;
        try
        {
            inspection = await core.GetJsonAsync(job, basePath, FilesJsonContext.Default.WorkerFileInspectionResponse, SmallResponseLimit, cancellationToken).ConfigureAwait(false)
                ?? throw new WorkerLoopbackException(200, basePath, "empty inspection");
        }
        catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException)
        {
            throw ImportSupport.ApiFailure("files.inspection_unavailable", exception);
        }
        if (inspection.ItemId is { } existing && inspection.Status == "completed")
        {
            return Result(new FilePublishResult(payload.UploadId, existing, inspection.WorkspaceId, string.Empty, 0, string.Empty, false, false));
        }
        if (inspection.Status == "cancelled")
        {
            throw WorkerJobException.Fail("files.cancelled", "the upload was cancelled");
        }
        if (inspection.Status == "failed")
        {
            throw WorkerJobException.Fail("files.upload_rejected", "the upload was already rejected");
        }
        if (clock.GetUtcNow() > inspection.ExpiresAt)
        {
            throw await RejectAsync(job, basePath, "files.upload_expired", "the upload capability expired", cancellationToken).ConfigureAwait(false);
        }

        var spool = WorkSpool.Create(options.Value.SpoolDirectory, "nix-file-inspection-");
        try
        {
            var header = new byte[FileInspector.HeaderLimit]; // byte[]: the bounded header the sniffer reads
            var headerLength = 0;
            long total;
            string sha256;
            ObjectDownload download;
            try
            {
                download = await objects.DownloadAsync(inspection.SourceUrl, options.Value.MaxInputBytes, cancellationToken).ConfigureAwait(false);
            }
            catch (ObjectTransferException exception) when (exception.TooLarge)
            {
                throw await RejectAsync(job, basePath, "files.too_large", exception.Message, cancellationToken).ConfigureAwait(false);
            }
            catch (ObjectTransferException exception)
            {
                throw WorkerJobException.Retry("files.object_unavailable", exception.Message);
            }
            await using (download.ConfigureAwait(false))
            {
                var file = new FileStream(spool, FileMode.Open, FileAccess.Write, FileShare.None, 64 * 1024, FileOptions.Asynchronous);
                await using (file.ConfigureAwait(false))
                {
                    var buffer = new byte[32 * 1024]; // byte[]: the copy buffer between the capability download and the spool
                    try
                    {
                        int read;
                        while ((read = await download.Body.ReadAsync(buffer, cancellationToken).ConfigureAwait(false)) > 0)
                        {
                            await file.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
                            if (headerLength < header.Length)
                            {
                                var copy = Math.Min(read, header.Length - headerLength);
                                buffer.AsSpan(0, copy).CopyTo(header.AsSpan(headerLength));
                                headerLength += copy;
                            }
                        }
                    }
                    catch (ObjectTransferException exception) when (exception.TooLarge)
                    {
                        throw await RejectAsync(job, basePath, "files.too_large", exception.Message, cancellationToken).ConfigureAwait(false);
                    }
                    catch (Exception exception) when (exception is ObjectTransferException or HttpRequestException or IOException)
                    {
                        throw WorkerJobException.Retry("files.object_unavailable", exception.Message);
                    }
                    total = file.Length;
                }
                sha256 = download.DigestHex();
            }
            if (total != inspection.DeclaredByteLength)
            {
                throw await RejectAsync(job, basePath, "files.size_mismatch", $"declared {inspection.DeclaredByteLength} bytes but received {total}", cancellationToken).ConfigureAwait(false);
            }
            var metadata = FileInspector.InspectHeader(header.AsSpan(0, headerLength), total);
            var inspected = new CompleteFileUploadRequest(metadata.MediaType, total, sha256, metadata.Previewable, metadata.Width, metadata.Height);
            await PublishObjectAsync(inspection, spool, inspected, cancellationToken).ConfigureAwait(false);
            inspected = await AttachThumbnailAsync(job, basePath, payload.UploadId, inspection.FileName, spool, inspected, cancellationToken).ConfigureAwait(false);

            FileRecord published;
            try
            {
                published = await core.PostJsonAsync(job, basePath + "/publish", WorkerLoopbackClient.Json(inspected, FilesJsonContext.Default.CompleteFileUploadRequest), FilesJsonContext.Default.FileRecord, SmallResponseLimit, cancellationToken).ConfigureAwait(false)
                    ?? throw new WorkerLoopbackException(200, basePath + "/publish", "empty publication");
            }
            catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException)
            {
                var classified = ImportSupport.ApiFailure("files.publish_refused", exception);
                if (classified.Retryable)
                {
                    throw classified;
                }
                throw await RejectAsync(job, basePath, "files.publish_refused", exception.Message, cancellationToken).ConfigureAwait(false);
            }
            return Result(new FilePublishResult(payload.UploadId, published.ItemId, published.WorkspaceId, metadata.MediaType, total, sha256, metadata.Previewable, ConsistentMediaType(inspection.DeclaredMediaType, metadata.MediaType)));
        }
        finally
        {
            File.Delete(spool);
        }
    }

    private async Task PublishObjectAsync(WorkerFileInspectionResponse inspection, string spool, CompleteFileUploadRequest inspected, CancellationToken cancellationToken)
    {
        var file = File.OpenRead(spool);
        await using (file.ConfigureAwait(false))
        {
            try
            {
                // The destination capability is signed for a plain create-only PUT, without the storage checksum header.
                await objects.UploadAsync(inspection.DestinationUploadUrl, inspected.DetectedMediaType, file, inspected.ByteLength, inspected.Sha256, createOnly: true, storageChecksum: false, cancellationToken).ConfigureAwait(false);
                return;
            }
            catch (ObjectTransferException exception) when (exception.AlreadyExists)
            {
            }
            catch (ObjectTransferException exception)
            {
                throw WorkerJobException.Retry("files.publication_unavailable", exception.Message);
            }
        }
        try
        {
            await ImportSupport.VerifyObjectAsync(objects, inspection.DestinationUrl, inspected.ByteLength, inspected.Sha256, cancellationToken).ConfigureAwait(false);
        }
        catch (ObjectTransferException exception) when (exception.Conflict)
        {
            throw WorkerJobException.Fail("files.publication_conflict", "the immutable destination contains different bytes");
        }
        catch (ObjectTransferException exception)
        {
            throw WorkerJobException.Retry("files.publication_unavailable", exception.Message);
        }
    }

    // Thumbnailing is best effort and never fails an inspection; the spool is read in place.
    private async Task<CompleteFileUploadRequest> AttachThumbnailAsync(WorkerExecution job, string basePath, Guid uploadId, string fileName, string spool, CompleteFileUploadRequest inspected, CancellationToken cancellationToken)
    {
        if (!Thumbnails.IsCandidate(fileName, inspected.DetectedMediaType))
        {
            return inspected;
        }
        if (!await _thumbnails.WaitAsync(TimeSpan.Zero, cancellationToken).ConfigureAwait(false))
        {
            await _thumbnails.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(Thumbnails.ThumbnailTimeout);
            var result = Thumbnails.FromStagedFile(spool, inspected.ByteLength, fileName, inspected.DetectedMediaType, timeout.Token);
            if (result is null || result.Bytes.Length == 0 || result.Bytes.Length > Thumbnails.MaxThumbnailBytes)
            {
                return inspected;
            }
            var size = result.Bytes.Length;
            var capability = await core.PostJsonAsync(job, basePath + "/thumbnail-upload", WorkerLoopbackClient.Json(new WorkerThumbnailUploadRequest(size), FilesJsonContext.Default.WorkerThumbnailUploadRequest), FilesJsonContext.Default.WorkerThumbnailUploadResponse, SmallResponseLimit, timeout.Token).ConfigureAwait(false);
            if (capability is null)
            {
                return inspected;
            }
            // The capability signs content-type octet-stream; reads set image/jpeg themselves.
            using var body = new MemoryStream(result.Bytes, writable: false);
            await objects.UploadAsync(capability.UploadUrl, "application/octet-stream", body, size, null, createOnly: false, storageChecksum: false, timeout.Token).ConfigureAwait(false);
            return inspected with { ThumbnailWidth = result.Width, ThumbnailHeight = result.Height, ThumbnailBytes = size };
        }
        catch (Exception exception) when (!cancellationToken.IsCancellationRequested && exception is ObjectTransferException or WorkerLoopbackException or HttpRequestException or OperationCanceledException or IOException or ThumbnailRefusedException)
        {
            // The reason names a parser or transport failure, never file content.
            FilePublishLog.ThumbnailSkipped(_logger, uploadId, exception.Message);
            return inspected;
        }
        finally
        {
            _thumbnails.Release();
        }
    }

    private async Task<WorkerJobException> RejectAsync(WorkerExecution job, string basePath, string code, string detail, CancellationToken cancellationToken)
    {
        try
        {
            await core.PostJsonAsync<object>(job, basePath + "/reject", WorkerLoopbackClient.Json(new RejectFileUploadRequest(code), FilesJsonContext.Default.RejectFileUploadRequest), null, 0, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is HttpRequestException or WorkerLoopbackException)
        {
            return ImportSupport.ApiFailure("files.rejection_unavailable", exception);
        }
        return WorkerJobException.Fail(code, detail);
    }

    private static bool ConsistentMediaType(string declared, string detected)
    {
        declared = declared.Trim().ToUpperInvariant();
        var upper = detected.ToUpperInvariant();
        return declared == upper || declared == "APPLICATION/OCTET-STREAM"
            || (upper == "APPLICATION/ZIP" && declared == "APPLICATION/VND.OPENXMLFORMATS-OFFICEDOCUMENT.WORDPROCESSINGML.DOCUMENT");
    }

    public void Dispose() => _thumbnails.Dispose();

    private static string Result(FilePublishResult result) => JsonSerializer.Serialize(result, WorkersJsonContext.Default.FilePublishResult);
}

/// <summary>What a finished publication reports.</summary>
public sealed record FilePublishResult(Guid UploadId, Guid ItemId, Guid WorkspaceId, string DetectedMediaType, long ByteLength, string Sha256, bool Previewable, bool DeclaredMediaTypeConsistent);

internal static partial class FilePublishLog
{
    [LoggerMessage(5430, LogLevel.Information, "Thumbnail skipped for upload {UploadId}: {Reason}")]
    internal static partial void ThumbnailSkipped(ILogger logger, Guid uploadId, string reason);
}
