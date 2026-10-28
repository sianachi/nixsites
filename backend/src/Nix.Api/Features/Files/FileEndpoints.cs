using System.Text.Json;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Files;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Features.Operations;
using Nix.Http;
using Nix.Persistence.ObjectStorage;

namespace Nix.Features.Files;

internal static class FileEndpoints
{
    private const long MaximumFileBytes = 100L * 1024 * 1024;
    private const long MaximumPreviewBytes = 10L * 1024 * 1024;
    private const long MaximumPreviewPixels = 40_000_000;

    /// <summary>
    /// The longest side of a thumbnail in pixels. Must agree with <c>thumbnail.MaxSide</c> in the Go
    /// worker's <c>internal/thumbnail</c> package, and with <c>CK_file_version_thumbnail</c>.
    /// </summary>
    private const int MaximumThumbnailSide = 480;

    /// <summary>The largest thumbnail object Core will sign an upload for or record.</summary>
    private const int MaximumThumbnailBytes = 2 * 1024 * 1024;

    internal static IEndpointRouteBuilder MapFileEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var uploads = endpoints.MapGroup("/api/v1/files/uploads").WithTags("Files");
        uploads.MapPost("/", BeginPublic)
            .WithName("BeginFileUpload")
            .Produces<FileUploadCapabilityResponse>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(503)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        uploads.MapGet("/{uploadId:guid}", GetUploadPublic)
            .WithName("GetFileUpload")
            .Produces<FileUploadStatusResponse>()
            .ProducesProblem(404);
        uploads.MapPost("/{uploadId:guid}/complete", QueueInspection)
            .WithName("CompleteFileUpload")
            .Produces<OperationResponse>(StatusCodes.Status202Accepted)
            .ProducesProblem(404)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        uploads.MapDelete("/{uploadId:guid}", CancelPublic)
            .WithName("CancelFileUpload")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(404)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        var files = endpoints.MapGroup("/api/v1/items/{itemId:guid}/file").WithTags("Files");
        files.MapGet("/", Get).WithName("GetFile").Produces<FileRecord>().ProducesProblem(404);
        files.MapGet("/download", AuthorizePublicDownload)
            .WithName("AuthorizeFileDownload")
            .Produces<FileDownloadCapabilityResponse>()
            .ProducesProblem(404)
            .ProducesProblem(503);
        files.MapGet("/thumbnail", AuthorizeThumbnail)
            .WithName("AuthorizeFileThumbnail")
            .Produces<FileThumbnailCapabilityResponse>()
            .ProducesProblem(404)
            .ProducesProblem(503);
        return endpoints;
    }

    /// <summary>Lease-bound surface used by the Go file inspector.</summary>
    internal static void MapWorkerExecutions(IEndpointRouteBuilder group)
    {
        group.MapGet("/files/uploads/{uploadId:guid}", GetInspection);
        group.MapPost("/files/uploads/{uploadId:guid}/thumbnail-upload", AuthorizeThumbnailUpload);
        group.MapPost("/files/uploads/{uploadId:guid}/publish", PublishInspection);
        group.MapPost("/files/uploads/{uploadId:guid}/reject", RejectInspection);
    }

    private static async Task<IResult> BeginPublic(
        BeginFileUploadRequest request,
        HttpContext context,
        [FromServices] IFileStore files,
        [FromServices] IItemTree tree,
        [FromServices] IPermissionResolver permissions,
        [FromServices] IItemLocks locks,
        [FromServices] S3CapabilitySigner signer)
    {
        if (!signer.IsConfigured)
        {
            return StorageUnavailable(context);
        }
        var upload = await BeginValidated(request, context, files, tree, permissions, locks).ConfigureAwait(false);
        if (upload is null)
        {
            return TypedResults.Problem(Conflict(
                context,
                "files.idempotency_conflict",
                "The idempotency key already belongs to a different upload."));
        }
        if (upload.Value is null)
        {
            return TypedResults.Problem(upload.Error!);
        }
        var value = upload.Value;
        var capability = value.Status == "pending_upload"
            ? signer.PutSized(value.ObjectKey, request.ByteLength)
            : null;
        return TypedResults.Ok(new FileUploadCapabilityResponse(
            value.Id,
            value.Status,
            capability?.Url,
            capability?.ExpiresAt,
            value.ExpiresAt,
            value.ItemId,
            value.FailureCode));
    }

    private static async Task<UploadAttempt?> BeginValidated(
        BeginFileUploadRequest request,
        HttpContext context,
        IFileStore files,
        IItemTree tree,
        IPermissionResolver permissions,
        IItemLocks locks)
    {
        if (!ValidName(request.FileName)
            || string.IsNullOrWhiteSpace(request.IdempotencyKey)
            || request.IdempotencyKey.Length > 160
            || request.ByteLength < 0
            || request.ByteLength > MaximumFileBytes)
        {
            return new UploadAttempt(null, Invalid(
                context,
                "files.upload_invalid",
                "The upload metadata is invalid."));
        }
        var workspaceId = WorkspaceId.From(request.WorkspaceId);
        if (!await permissions.CanWriteWorkspaceAsync(workspaceId, context.RequestAborted).ConfigureAwait(false))
        {
            return new UploadAttempt(null, NotFound(context));
        }
        if (request.ParentId is { } parent)
        {
            var parentItem = await tree.FindAsync(ItemId.From(parent), context.RequestAborted).ConfigureAwait(false);
            if (parentItem is null || parentItem.WorkspaceId != workspaceId)
            {
                return new UploadAttempt(null, NotFound(context));
            }
        }
        if (request.TargetItemId is { } target)
        {
            var targetItem = await tree.FindAsync(ItemId.From(target), context.RequestAborted).ConfigureAwait(false);
            if (targetItem is not { Type: "file" } || targetItem.WorkspaceId != workspaceId)
            {
                return new UploadAttempt(null, NotFound(context));
            }

            // A replacement writes the file's body; a locked one needs this session's unlock, and
            // is refused like a file the caller cannot see rather than as a key conflict.
            if (!await locks.MayReadBodyAsync(targetItem.Id, context.RequestAborted).ConfigureAwait(false))
            {
                return new UploadAttempt(null, NotFound(context));
            }
        }
        // Browser MIME values are advisory. The temporary opaque publish path deliberately does
        // not trust them; invalid or missing values are stored as a safe download-only type.
        var declaredMediaType = ValidMediaType(request.MediaType)
            ? request.MediaType
            : "application/octet-stream";
        var created = await files.BeginAsync(
            new BeginFileUpload(
                workspaceId,
                request.ParentId is { } parentId ? ItemId.From(parentId) : null,
                request.TargetItemId is { } targetId ? ItemId.From(targetId) : null,
                request.FileName,
                declaredMediaType,
                request.ByteLength,
                request.IdempotencyKey),
            context.RequestAborted).ConfigureAwait(false);
        return created is null ? null : new UploadAttempt(created, null);
    }

    private static async Task<IResult> QueueInspection(
        Guid uploadId,
        HttpContext context,
        [FromServices] IFileStore files,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] IWorkerDispatchStore dispatch,
        [FromServices] INixSessionContextAccessor session)
    {
        var upload = await files.QueueInspectionAsync(
            FileUploadId.From(uploadId),
            context.RequestAborted).ConfigureAwait(false);
        if (upload is null)
        {
            return TypedResults.Problem(NotFound(context));
        }
        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var payload = JsonSerializer.Serialize(
            new FileInspectPayload(upload.Id),
            FilesJsonContext.Default.FileInspectPayload);
        var operation = await jobs.CreateAsync(
            scoped.TenantId,
            scoped.PrincipalId,
            WorkspaceId.From(upload.WorkspaceId),
            "file.publish",
            $"file.publish:{upload.Id:D}",
            payload,
            context.RequestAborted).ConfigureAwait(false);
        return TypedResults.Accepted(
            $"/api/v1/operations/{operation.Id:D}",
            OperationMapping.ToResponse(operation));
    }

    private static async Task<IResult> GetUploadPublic(
        Guid uploadId,
        HttpContext context,
        [FromServices] IFileStore files)
    {
        var upload = await files.GetUploadAsync(
            FileUploadId.From(uploadId),
            context.RequestAborted).ConfigureAwait(false);
        return upload is null
            ? TypedResults.Problem(NotFound(context))
            : TypedResults.Ok(new FileUploadStatusResponse(
                upload.Id,
                upload.Status,
                upload.ExpiresAt,
                upload.ItemId,
                upload.FailureCode));
    }

    private static async Task<Results<Ok<FileRecord>, ProblemHttpResult>> Get(
        Guid itemId,
        HttpContext context,
        [FromServices] IFileStore files)
    {
        var result = await files.GetAsync(ItemId.From(itemId), context.RequestAborted).ConfigureAwait(false);
        return result is null ? TypedResults.Problem(NotFound(context)) : TypedResults.Ok(result);
    }

    private static async Task<IResult> AuthorizePublicDownload(
        Guid itemId,
        Guid? versionId,
        bool preview,
        HttpContext context,
        [FromServices] IFileStore files,
        [FromServices] S3CapabilitySigner signer)
    {
        if (!signer.IsConfigured)
        {
            return StorageUnavailable(context);
        }
        var result = await files.AuthorizeDownloadAsync(
            ItemId.From(itemId),
            versionId is { } value ? FileVersionId.From(value) : null,
            context.RequestAborted).ConfigureAwait(false);
        if (result is null)
        {
            return TypedResults.Problem(NotFound(context));
        }
        var inline = preview && (result.Previewable || ServedAudio.IsServed(result.MediaType));
        var capability = signer.GetForBrowser(
            result.ObjectKey,
            result.FileName,
            result.MediaType,
            inline);
        context.Response.Headers.XContentTypeOptions = "nosniff";
        return TypedResults.Ok(new FileDownloadCapabilityResponse(
            capability.Url,
            capability.ExpiresAt,
            result.FileName,
            inline ? result.MediaType : "application/octet-stream",
            result.ByteLength,
            result.Sha256,
            inline,
            Unscanned: true,
            NoSniff: true));
    }

    private static async Task<IResult> AuthorizeThumbnail(
        Guid itemId,
        Guid? versionId,
        HttpContext context,
        [FromServices] IFileStore files,
        [FromServices] S3CapabilitySigner signer)
    {
        if (!signer.IsConfigured)
        {
            return StorageUnavailable(context);
        }

        // Authorization is the file download's, by construction: the store answers both from one
        // lookup, so an unreadable, hidden or locked file and a file without a thumbnail are the same
        // 404 here and a caller cannot tell them apart.
        var result = await files.AuthorizeThumbnailAsync(
            ItemId.From(itemId),
            versionId is { } value ? FileVersionId.From(value) : null,
            context.RequestAborted).ConfigureAwait(false);
        if (result is null)
        {
            return TypedResults.Problem(ApiProblem.Create(
                context,
                404,
                "files.thumbnail_not_found",
                "Thumbnail not found",
                "No such thumbnail is visible."));
        }
        var capability = signer.GetForBrowser(
            ObjectStorageKeys.FileThumbnail(result.VersionObjectKey),
            "thumbnail.jpg",
            "image/jpeg",
            inline: true);
        context.Response.Headers.XContentTypeOptions = "nosniff";
        return TypedResults.Ok(new FileThumbnailCapabilityResponse(
            capability.Url,
            capability.ExpiresAt,
            result.Width,
            result.Height,
            result.ByteLength));
    }

    /// <summary>
    /// Signs the upload of one upload's thumbnail, sized to the bytes the worker has produced.
    /// </summary>
    /// <remarks>
    /// Lease-bound like the rest of the worker surface: only the running <c>file.publish</c> job for
    /// this upload may ask, and the key is the one Core derives, so the worker cannot name an object.
    /// </remarks>
    private static async Task<IResult> AuthorizeThumbnailUpload(
        Guid uploadId,
        WorkerThumbnailUploadRequest request,
        HttpContext context,
        [FromServices] IFileStore files,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] S3CapabilitySigner signer)
    {
        if (!signer.IsConfigured
            || request.ByteLength is < 1 or > MaximumThumbnailBytes
            || !await ExecutionOwnsUpload(context, jobs, session, uploadId).ConfigureAwait(false))
        {
            return TypedResults.Problem(NotFound(context));
        }
        var upload = await files.GetInspectionAsync(
            FileUploadId.From(uploadId),
            context.RequestAborted).ConfigureAwait(false);
        if (upload is not { Purpose: FileUploadPurposes.File, Status: "pending_upload" })
        {
            return TypedResults.Problem(NotFound(context));
        }
        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var capability = signer.PutSized(
            ObjectStorageKeys.FileThumbnail(scoped.TenantId, FileUploadId.From(uploadId)),
            request.ByteLength);
        return TypedResults.Ok(new WorkerThumbnailUploadResponse(capability.Url, capability.ExpiresAt));
    }

    private static async Task<IResult> GetInspection(
        Guid uploadId,
        HttpContext context,
        [FromServices] IFileStore files,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] S3CapabilitySigner signer)
    {
        if (!signer.IsConfigured || !await ExecutionOwnsUpload(context, jobs, session, uploadId).ConfigureAwait(false))
        {
            return TypedResults.Problem(NotFound(context));
        }
        var upload = await files.GetInspectionAsync(
            FileUploadId.From(uploadId),
            context.RequestAborted).ConfigureAwait(false);
        if (upload is null)
        {
            return TypedResults.Problem(NotFound(context));
        }
        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var source = signer.Get(upload.ObjectKey);
        var sourceDelete = signer.Delete(upload.ObjectKey);
        var destinationKey = ObjectStorageKeys.FileVersion(
            scoped.TenantId,
            FileUploadId.From(upload.Id));
        var destination = signer.Get(destinationKey);
        var destinationUpload = signer.PutImmutable(destinationKey, upload.DeclaredByteLength);
        var destinationDelete = signer.Delete(destinationKey);
        return TypedResults.Ok(new WorkerFileInspectionResponse(
            upload.Id,
            upload.WorkspaceId,
            upload.Status,
            upload.FileName,
            upload.DeclaredMediaType,
            upload.DeclaredByteLength,
            upload.ExpiresAt,
            source.Url,
            sourceDelete.Url,
            destination.Url,
            destinationUpload.Url,
            destinationDelete.Url,
            new[]
            {
                source.ExpiresAt,
                sourceDelete.ExpiresAt,
                destination.ExpiresAt,
                destinationUpload.ExpiresAt,
                destinationDelete.ExpiresAt,
            }.Min(),
            upload.ItemId));
    }

    private static async Task<IResult> PublishInspection(
        Guid uploadId,
        CompleteFileUploadRequest request,
        HttpContext context,
        [FromServices] IFileStore files,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] IWorkerDispatchStore dispatch,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] S3CapabilitySigner signer)
    {
        if (!ValidCompletion(request)
            || !await ExecutionOwnsUpload(context, jobs, session, uploadId).ConfigureAwait(false))
        {
            return TypedResults.Problem(NotFound(context));
        }
        var result = await files.CompleteAsync(
            ToCompletion(uploadId, request),
            context.RequestAborted).ConfigureAwait(false);
        if (result is null)
        {
            return TypedResults.Problem(NotFound(context));
        }
        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        await ObjectCleanupJobs.QueueAsync(
            jobs,
            scoped.TenantId,
            scoped.PrincipalId,
            WorkspaceId.From(result.WorkspaceId),
            "file-upload",
            uploadId,
            signer.GetCleanupNotBefore(),
            [ObjectStorageKeys.FileUpload(scoped.TenantId, FileUploadId.From(uploadId))],
            context.RequestAborted).ConfigureAwait(false);
        return await WorkerExecutionMiddleware.ExecutionStillLive(context, dispatch).ConfigureAwait(false)
            ? TypedResults.Ok(result)
            : TypedResults.Problem(ExecutionLost(context));
    }

    private static async Task<IResult> RejectInspection(
        Guid uploadId,
        RejectFileUploadRequest request,
        HttpContext context,
        [FromServices] IFileStore files,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] IWorkerDispatchStore dispatch,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] S3CapabilitySigner signer)
    {
        if (!ValidFailureCode(request.Code)
            || !await ExecutionOwnsUpload(context, jobs, session, uploadId).ConfigureAwait(false))
        {
            return TypedResults.Problem(NotFound(context));
        }
        var upload = await files.GetInspectionAsync(
            FileUploadId.From(uploadId),
            context.RequestAborted).ConfigureAwait(false);
        if (upload is null)
        {
            return TypedResults.Problem(NotFound(context));
        }
        if (!await files.RejectAsync(
            FileUploadId.From(uploadId),
            request.Code,
            context.RequestAborted).ConfigureAwait(false))
        {
            return TypedResults.Problem(NotFound(context));
        }
        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        await ObjectCleanupJobs.QueueAsync(
            jobs,
            scoped.TenantId,
            scoped.PrincipalId,
            WorkspaceId.From(upload.WorkspaceId),
            "file-upload",
            uploadId,
            signer.GetCleanupNotBefore(),
            [
                ObjectStorageKeys.FileUpload(scoped.TenantId, FileUploadId.From(uploadId)),
                ObjectStorageKeys.FileVersion(scoped.TenantId, FileUploadId.From(uploadId)),
                ObjectStorageKeys.FileThumbnail(scoped.TenantId, FileUploadId.From(uploadId)),
            ],
            context.RequestAborted).ConfigureAwait(false);
        return await WorkerExecutionMiddleware.ExecutionStillLive(context, dispatch).ConfigureAwait(false)
            ? TypedResults.NoContent()
            : TypedResults.Problem(ExecutionLost(context));
    }

    private static async Task<bool> ExecutionOwnsUpload(
        HttpContext context,
        IWorkerJobStore jobs,
        INixSessionContextAccessor session,
        Guid uploadId)
    {
        if (!Guid.TryParse(context.Request.Headers[WorkerExecutionMiddleware.JobHeaderName], out var jobId))
        {
            return false;
        }
        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var job = await jobs.GetAsync(
            scoped.TenantId,
            scoped.PrincipalId,
            jobId,
            context.RequestAborted).ConfigureAwait(false);
        if (job is not { Kind: "file.publish", Status: "running" })
        {
            return false;
        }
        try
        {
            var payload = JsonSerializer.Deserialize(
                job.Payload,
                FilesJsonContext.Default.FileInspectPayload);
            return payload?.UploadId == uploadId;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static async Task<Results<NoContent, NotFound>> CancelPublic(
        Guid uploadId,
        HttpContext context,
        [FromServices] IFileStore files,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] S3CapabilitySigner signer)
    {
        var id = FileUploadId.From(uploadId);
        var upload = await files.GetUploadAsync(id, context.RequestAborted).ConfigureAwait(false);
        if (upload is null
            || upload.Purpose != FileUploadPurposes.File
            || !await files.CancelAsync(id, context.RequestAborted).ConfigureAwait(false))
        {
            return TypedResults.NotFound();
        }
        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        await ObjectCleanupJobs.QueueAsync(
            jobs,
            scoped.TenantId,
            scoped.PrincipalId,
            WorkspaceId.From(upload.WorkspaceId),
            "file-upload",
            uploadId,
            signer.GetCleanupNotBefore(),
            [
                ObjectStorageKeys.FileUpload(scoped.TenantId, id),
                ObjectStorageKeys.FileVersion(scoped.TenantId, id),
                ObjectStorageKeys.FileThumbnail(scoped.TenantId, id),
            ],
            context.RequestAborted).ConfigureAwait(false);
        return TypedResults.NoContent();
    }

    private static bool ValidName(string value) =>
        !string.IsNullOrWhiteSpace(value)
        && value.Length <= 255
        && value.IndexOfAny(['/', '\\', '\0']) < 0;

    private static bool ValidMediaType(string value)
    {
        var separator = value.IndexOf('/', StringComparison.Ordinal);
        return separator > 0
            && separator < value.Length - 1
            && value.Length <= 160
            && value.All(character =>
                character is >= (char)0x21 and <= (char)0x7e
                && character is not ';' and not '\\');
    }

    private static bool ValidCompletion(CompleteFileUploadRequest request) =>
        ValidMediaType(request.DetectedMediaType)
        && ValidSha256(request.Sha256)
        && request.ByteLength >= 0
        && request.ByteLength <= MaximumFileBytes
        && ValidImageMetadata(request)
        && ValidThumbnail(request);

    private static bool ValidThumbnail(CompleteFileUploadRequest request) =>
        request is { ThumbnailWidth: null, ThumbnailHeight: null, ThumbnailBytes: null }
        || request is
        {
            ThumbnailWidth: > 0 and <= MaximumThumbnailSide,
            ThumbnailHeight: > 0 and <= MaximumThumbnailSide,
            ThumbnailBytes: > 0 and <= MaximumThumbnailBytes,
        };

    private static bool ValidSha256(string value) =>
        value.Length == 64
        && value.All(static character =>
            character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static bool ValidImageMetadata(CompleteFileUploadRequest request)
    {
        var dimensionsValid = request is { PixelWidth: null, PixelHeight: null }
            || request is { PixelWidth: > 0 and <= 100_000, PixelHeight: > 0 and <= 100_000 }
                && (long)request.PixelWidth.Value * request.PixelHeight.Value <= 1_000_000_000;
        if (!dimensionsValid || !request.Previewable)
        {
            return dimensionsValid;
        }
        if (request.DetectedMediaType == "application/pdf")
        {
            return request.ByteLength <= MaximumPreviewBytes
                && request.PixelWidth is null
                && request.PixelHeight is null;
        }
        return request.ByteLength <= MaximumPreviewBytes
            && request.PixelWidth is > 0
            && request.PixelHeight is > 0
            && (long)request.PixelWidth.Value * request.PixelHeight.Value <= MaximumPreviewPixels
            && PreviewMediaTypes.Contains(request.DetectedMediaType);
    }

    private static readonly HashSet<string> PreviewMediaTypes =
        ["image/png", "image/jpeg", "image/webp", "image/avif"];

    private static bool ValidFailureCode(string code) =>
        !string.IsNullOrWhiteSpace(code)
        && code.Length <= 80
        && code.All(character => char.IsAsciiLetterOrDigit(character) || character is '.' or '_');

    private static CompleteFileUpload ToCompletion(Guid uploadId, CompleteFileUploadRequest request) =>
        new(
            FileUploadId.From(uploadId),
            request.DetectedMediaType,
            request.ByteLength,
            request.Sha256,
            request.Previewable,
            request.PixelWidth,
            request.PixelHeight,
            request.ThumbnailWidth,
            request.ThumbnailHeight,
            request.ThumbnailBytes);

    private static Microsoft.AspNetCore.Mvc.ProblemDetails NotFound(HttpContext context) =>
        ApiProblem.Create(context, 404, "files.not_found", "File not found", "No such file is visible.");

    private static Microsoft.AspNetCore.Mvc.ProblemDetails Invalid(
        HttpContext context,
        string code,
        string detail) => ApiProblem.Create(context, 400, code, "Upload refused", detail);

    private static Microsoft.AspNetCore.Mvc.ProblemDetails Conflict(
        HttpContext context,
        string code,
        string detail) => ApiProblem.Create(context, 409, code, "Upload conflict", detail);

    private static Microsoft.AspNetCore.Mvc.ProblemDetails ExecutionLost(HttpContext context) =>
        ApiProblem.Create(
            context,
            409,
            "worker.execution_refused",
            "Worker execution refused",
            "The worker no longer owns a live execution for this job.");

    private static ProblemHttpResult StorageUnavailable(HttpContext context) =>
        TypedResults.Problem(ApiProblem.Create(
            context,
            503,
            "files.storage_not_configured",
            "File storage unavailable",
            "Private object storage is not configured for this deployment."));

    private sealed record UploadAttempt(
        FileUploadRecord? Value,
        Microsoft.AspNetCore.Mvc.ProblemDetails? Error);
}
