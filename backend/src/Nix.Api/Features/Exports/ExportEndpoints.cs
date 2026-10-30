using System.Globalization;
using System.Text.Json;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Abstractions.Files;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Features.Files;
using Nix.Http;
using Nix.Persistence.ObjectStorage;

namespace Nix.Features.Exports;

internal static class ExportEndpoints
{
    internal const string CollaborationBaseUrlConfigurationKey = "Nix:Collaboration:BaseUrl";

    private const long MaximumExportBytes = 256L * 1024 * 1024;
    private static readonly TimeSpan ResultRetention = TimeSpan.FromHours(24);
    private static readonly TimeSpan AttemptCleanupDelay = TimeSpan.FromHours(48);

    internal static IEndpointRouteBuilder MapExportEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var exports = endpoints.MapGroup("/api/v1/exports").WithTags("Exports");
        exports.MapGet("/formats", Formats)
            .WithName("ListExportFormats")
            .Produces<ExportFormatCatalogResponse>();
        exports.MapPost("", Begin)
            .WithName("BeginExport")
            .Produces<ExportResponse>(StatusCodes.Status202Accepted)
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(503)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        exports.MapGet("/{exportId:guid}", Get)
            .WithName("GetExport")
            .Produces<ExportResponse>()
            .ProducesProblem(404)
            .ProducesProblem(500);
        exports.MapPost("/{exportId:guid}/cancel", Cancel)
            .WithName("CancelExport")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        exports.MapGet("/{exportId:guid}/download", Download)
            .WithName("AuthorizeExportDownload")
            .Produces<ExportDownloadCapabilityResponse>()
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(410)
            .ProducesProblem(503);
        return endpoints;
    }

    internal static void MapWorkerExecutions(IEndpointRouteBuilder group)
    {
        var exports = group.MapGroup("/exports/{jobId:guid}");
        exports.MapGet("", GetWorkerSource);
        exports.MapGet("/destination", GetWorkerDestination);
        exports.MapGet("/images/{itemId:guid}", GetWorkerImage);
        ExportFileEndpoints.MapWorkerExecutions(exports);
    }

    private static ExportFormatCatalogResponse Formats(
        [FromServices] IWorkerCapabilityRegistry registry,
        [FromServices] TimeProvider clock)
    {
        var now = clock.GetUtcNow();
        return new ExportFormatCatalogResponse(
            registry.ExportFormats(now).Select(ToResponse).ToArray(),
            now);
    }

    private static async Task<IResult> Begin(
        BeginExportRequest request,
        HttpContext context,
        [FromServices] IWorkerCapabilityRegistry registry,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] IItemTree tree,
        [FromServices] IPermissionResolver permissions,
        [FromServices] IItemLocks locks,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] S3CapabilitySigner signer,
        [FromServices] SelfIssuedTokenService tokens,
        [FromServices] IConfiguration configuration,
        [FromServices] TimeProvider clock)
    {
        var format = NormalizeFormat(request.Format);
        var scope = NormalizeScope(request.Scope);
        if (format.Length == 0
            || scope.Length == 0
            || string.IsNullOrWhiteSpace(request.IdempotencyKey)
            || request.IdempotencyKey.Length > 160
            || request.ItemId == Guid.Empty)
        {
            return Problem(context, 400, "exports.request_invalid", "Export request invalid", "The item, format, scope, and idempotency key must be valid.");
        }
        if (!signer.IsConfigured
            || !tokens.IsConfigured
            || !TryCollaborationBaseUri(configuration, out _))
        {
            return Problem(context, 503, "exports.not_configured", "Export unavailable", "This deployment cannot prepare durable exports.");
        }

        var advertised = registry.ExportFormats(clock.GetUtcNow());
        var descriptor = advertised.SingleOrDefault(candidate =>
            string.Equals(candidate.Format, format, StringComparison.Ordinal));
        if (descriptor is null)
        {
            return Problem(context, 503, "exports.format_unavailable", "Export format unavailable", "No active worker currently advertises this export format.");
        }
        if (!ValidDescriptor(descriptor))
        {
            return Problem(context, 503, "exports.format_unavailable", "Export format unavailable", "The active worker advertised an invalid export format contract.");
        }

        var item = await tree.FindAsync(ItemId.From(request.ItemId), context.RequestAborted).ConfigureAwait(false);
        if (item is null
            || !await permissions.CanReadWorkspaceAsync(item.WorkspaceId, context.RequestAborted).ConfigureAwait(false))
        {
            return Problem(context, 404, "exports.item_not_found", "Export source not found", "No such item is visible.");
        }

        // An export copies bodies out of Nix, which is exactly what a lock withholds, and it runs
        // in a worker under a delegation that cannot hold an unlock. Refused up front rather than
        // exported with holes: an archive missing a locked file's bytes is one the importer rejects,
        // and a document export that silently drops a note is worse than one that says why it
        // cannot run. The collaboration service also leaves locked bodies out of what it streams,
        // so an item locked after this check still does not leave.
        var locked = scope == "subtree"
            ? await locks.AnyInSubtreeAsync(item.Id, context.RequestAborted).ConfigureAwait(false)
            : (await locks.GetStateAsync(item.Id, context.RequestAborted).ConfigureAwait(false)).Locked;
        if (locked)
        {
            return Problem(
                context,
                409,
                "exports.item_locked",
                "Export includes a locked item",
                scope == "subtree"
                    ? "This item or something under it is locked. Remove the lock, or export a part of the tree without it."
                    : "A locked item cannot be exported. Remove its lock first.");
        }

        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var payload = new ExportJobPayload(
            request.ItemId,
            item.WorkspaceId.Value,
            descriptor.Format,
            scope,
            ItemProperties.ReadTitle(item.Properties),
            descriptor.Extension,
            descriptor.MediaType,
            descriptor.DeclaredLoss.ToArray(),
            request.IncludeComments);
        WorkerJobRecord job;
        try
        {
            job = await jobs.CreateAsync(
                scoped.TenantId,
                scoped.PrincipalId,
                item.WorkspaceId,
                "export." + descriptor.Format,
                request.IdempotencyKey.Trim(),
                JsonSerializer.Serialize(payload, ExportsJsonContext.Default.ExportJobPayload),
                context.RequestAborted).ConfigureAwait(false);
        }
        catch (WorkerJobIdempotencyConflictException)
        {
            return Problem(context, 409, "exports.idempotency_conflict", "Export conflicts", "The idempotency key already belongs to a different export.");
        }

        if (!TryReadState(job, out var storedPayload, out var storedResult))
        {
            return Problem(context, 500, "exports.state_invalid", "Export state invalid", "The durable export state could not be read safely.");
        }

        return TypedResults.Accepted(
            $"/api/v1/exports/{job.Id:D}",
            ToResponse(job, storedPayload, storedResult, scoped.TenantId, clock.GetUtcNow()));
    }

    private static async Task<IResult> Get(
        Guid exportId,
        HttpContext context,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IPermissionResolver permissions,
        [FromServices] TimeProvider clock)
    {
        var state = await FindState(exportId, jobs, session, permissions, context.RequestAborted).ConfigureAwait(false);
        if (state is null)
        {
            return Problem(context, 404, "exports.not_found", "Export not found", "No such export is visible.");
        }
        if (!TryReadState(state.Value.Job, out var payload, out var result))
        {
            return Problem(context, 500, "exports.state_invalid", "Export state invalid", "The durable export state could not be read safely.");
        }
        if (state.Value.Job.Status == "completed"
            && (result is null
                || !ValidResult(
                    result,
                    payload,
                    state.Value.Context.TenantId,
                    exportId)))
        {
            return Problem(context, 500, "exports.state_invalid", "Export state invalid", "The completed export result did not match its durable request.");
        }
        return TypedResults.Ok(ToResponse(
            state.Value.Job,
            payload,
            result,
            state.Value.Context.TenantId,
            clock.GetUtcNow()));
    }

    private static async Task<IResult> Cancel(
        Guid exportId,
        HttpContext context,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IPermissionResolver permissions)
    {
        var state = await FindState(exportId, jobs, session, permissions, context.RequestAborted).ConfigureAwait(false);
        if (state is null || !TryReadState(state.Value.Job, out _, out _))
        {
            return Problem(context, 404, "exports.not_found", "Export not found", "No such export is visible.");
        }
        if (state.Value.Job.Status == "completed")
        {
            return Problem(context, 409, "exports.already_completed", "Export already completed", "A completed export cannot be cancelled.");
        }
        if (!await jobs.CancelAsync(
            state.Value.Context.TenantId,
            state.Value.Context.PrincipalId,
            exportId,
            context.RequestAborted).ConfigureAwait(false))
        {
            return Problem(context, 404, "exports.not_found", "Export not found", "No such export is visible.");
        }
        return TypedResults.NoContent();
    }

    private static async Task<IResult> Download(
        Guid exportId,
        HttpContext context,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IPermissionResolver permissions,
        [FromServices] S3CapabilitySigner signer,
        [FromServices] TimeProvider clock)
    {
        if (!signer.IsConfigured)
        {
            return Problem(context, 503, "exports.storage_unavailable", "Export storage unavailable", "Private object storage is not configured.");
        }
        var state = await FindState(exportId, jobs, session, permissions, context.RequestAborted).ConfigureAwait(false);
        if (state is null || !TryReadState(state.Value.Job, out var payload, out var result))
        {
            return Problem(context, 404, "exports.not_found", "Export not found", "No such export is visible.");
        }
        if (state.Value.Job.Status != "completed" || state.Value.Job.CompletedAt is null || result is null)
        {
            return Problem(context, 409, "exports.not_ready", "Export not ready", "The export has not completed successfully.");
        }
        var expiresAt = state.Value.Job.CompletedAt.Value.Add(ResultRetention);
        if (expiresAt <= clock.GetUtcNow())
        {
            return Problem(context, 410, "exports.expired", "Export expired", "This export result has expired.");
        }
        if (!ValidResult(
            result,
            payload,
            state.Value.Context.TenantId,
            exportId))
        {
            return Problem(context, 409, "exports.result_invalid", "Export result unavailable", "The completed worker result did not match the requested export.");
        }
        var fileName = FileName(payload.Title, payload.Extension);
        var capability = signer.GetForBrowser(result.ObjectKey, fileName, payload.MediaType, inline: false);
        return TypedResults.Ok(new ExportDownloadCapabilityResponse(
            capability.Url,
            capability.ExpiresAt,
            fileName,
            payload.MediaType,
            result.ByteLength,
            result.Sha256));
    }

    private static async Task<IResult> GetWorkerSource(
        Guid jobId,
        HttpContext context,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IWorkerDispatchStore dispatch,
        [FromServices] SelfIssuedTokenService tokens,
        [FromServices] IConfiguration configuration,
        [FromServices] TimeProvider clock)
    {
        var execution = await ExactExecution(jobId, context, dispatch).ConfigureAwait(false);
        if (execution is null || !tokens.IsConfigured || !TryCollaborationBaseUri(configuration, out var collaboration))
        {
            return Problem(context, 409, "exports.execution_refused", "Export execution refused", "The export execution is no longer usable.");
        }
        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var job = await jobs.GetAsync(scoped.TenantId, scoped.PrincipalId, jobId, context.RequestAborted).ConfigureAwait(false);
        if (job is null || !TryReadState(job, out var payload, out _) || job.Status != "running")
        {
            return Problem(context, 409, "exports.execution_refused", "Export execution refused", "The durable export is not running under this execution.");
        }
        var source = new Uri(
            collaboration,
            $"documents/{payload.ItemId:D}/bundles?scope={Uri.EscapeDataString(payload.Scope)}"
            + $"&exportedAt={Uri.EscapeDataString(job.CreatedAt.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture))}"
            + (payload.Format is "pdf" or "docx" ? "&expandEmbeds=true" : string.Empty)
            + (payload.Format is "pdf" or "docx" or "markdown" ? "&shape=render" : string.Empty)
            + (payload.IncludeComments ? "&includeComments=true" : string.Empty));
        var bearer = tokens.MintWorkerExecution(
            scoped.PrincipalId,
            scoped.TenantId,
            jobId,
            payload.ItemId,
            payload.WorkspaceId,
            payload.Scope,
            execution);
        return TypedResults.Ok(new WorkerExportSourceResponse(
            jobId,
            payload.Format,
            source,
            bearer,
            clock.GetUtcNow().Add(SelfIssuedTokenService.WorkerExecutionLifetime)));
    }

    private static async Task<IResult> GetWorkerImage(
        Guid jobId,
        Guid itemId,
        HttpContext context,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IWorkerDispatchStore dispatch,
        [FromServices] IFileStore files,
        [FromServices] IItemTree tree,
        [FromServices] S3CapabilitySigner signer)
    {
        var execution = await ExactExecution(jobId, context, dispatch).ConfigureAwait(false);
        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var job = await jobs.GetAsync(scoped.TenantId, scoped.PrincipalId, jobId, context.RequestAborted).ConfigureAwait(false);
        if (execution is null || !signer.IsConfigured || job is null
            || !TryReadState(job, out var payload, out _) || job.Status != "running"
            || payload.Format is not ("pdf" or "docx" or "markdown"))
        {
            return Problem(context, 409, "exports.execution_refused", "Export execution refused", "The image request no longer owns a running export.");
        }
        // Both queries run under the execution actor's RLS context. References may point to
        // sibling files, but cannot grant access outside the export workspace or actor's rights.
        var file = await tree.FindAsync(ItemId.From(itemId), context.RequestAborted).ConfigureAwait(false);
        if (file is null || file.WorkspaceId.Value != payload.WorkspaceId)
        {
            return Problem(context, 404, "exports.image_unavailable", "Image unavailable", "The image is not available to this export.");
        }
        // A captured Mermaid diagram is an SVG the worker rasterises itself; it is never previewable.
        var image = await files.AuthorizeDownloadAsync(ItemId.From(itemId), null, context.RequestAborted).ConfigureAwait(false);
        if (image is null || image.ByteLength is <= 0 or > 10 * 1024 * 1024
            || !(image.Previewable && image.MediaType is "image/png" or "image/jpeg" or "image/webp"
                || image.MediaType is "image/svg+xml"))
        {
            return Problem(context, 404, "exports.image_unavailable", "Image unavailable", "The image is not a supported preview.");
        }
        var capability = signer.Get(image.ObjectKey);
        return TypedResults.Ok(new FileDownloadCapabilityResponse(
            capability.Url, capability.ExpiresAt, image.FileName, image.MediaType,
            image.ByteLength, image.Sha256, Inline: true, Unscanned: true, NoSniff: true));
    }

    private static async Task<IResult> GetWorkerDestination(
        Guid jobId,
        long byteLength,
        string sha256,
        HttpContext context,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IWorkerDispatchStore dispatch,
        [FromServices] S3CapabilitySigner signer,
        [FromServices] TimeProvider clock)
    {
        var execution = await ExactExecution(jobId, context, dispatch).ConfigureAwait(false);
        if (execution is null
            || !signer.IsConfigured
            || byteLength is <= 0 or > MaximumExportBytes
            || !ValidSha256(sha256))
        {
            return Problem(context, 409, "exports.execution_refused", "Export execution refused", "The destination request is invalid or no longer owns the job lease.");
        }
        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var job = await jobs.GetAsync(scoped.TenantId, scoped.PrincipalId, jobId, context.RequestAborted).ConfigureAwait(false);
        if (job is null || !TryReadState(job, out var payload, out _) || job.Status != "running")
        {
            return Problem(context, 409, "exports.execution_refused", "Export execution refused", "The durable export is not running under this execution.");
        }
        var attemptId = ObjectStorageKeys.ExportAttempt(jobId, execution);
        var key = ObjectStorageKeys.ExportResult(
            scoped.TenantId,
            jobId,
            attemptId,
            payload.Extension);
        await ObjectCleanupJobs.QueueAsync(
            jobs,
            scoped.TenantId,
            scoped.PrincipalId,
            WorkspaceId.From(payload.WorkspaceId),
            "export-attempt",
            attemptId,
            clock.GetUtcNow().Add(AttemptCleanupDelay),
            [key],
            context.RequestAborted).ConfigureAwait(false);
        var upload = signer.PutImmutableVerified(key, byteLength, sha256);
        var read = signer.Get(key);
        var delete = signer.Delete(key);
        var expiresAt = new[] { upload.ExpiresAt, read.ExpiresAt, delete.ExpiresAt }.Min();
        return TypedResults.Ok(new WorkerExportDestinationResponse(
            jobId,
            attemptId,
            payload.Format,
            key,
            upload.Url,
            read.Url,
            delete.Url,
            expiresAt));
    }

    internal static async ValueTask<string?> ExactExecution(
        Guid routeJobId,
        HttpContext context,
        IWorkerDispatchStore dispatch)
    {
        var execution = context.Request.Headers[WorkerExecutionMiddleware.ExecutionHeaderName].ToString();
        if (!Guid.TryParse(
                context.Request.Headers[WorkerExecutionMiddleware.JobHeaderName].ToString(),
                out var headerJobId)
            || routeJobId != headerJobId
            || string.IsNullOrWhiteSpace(execution)
            || execution.Length > 128)
        {
            return null;
        }
        return await dispatch.AuthorizeExecutionAsync(routeJobId, execution, context.RequestAborted)
            .ConfigureAwait(false) is null
                ? null
                : execution;
    }

    private static async ValueTask<(WorkerJobRecord Job, NixSessionContext Context)?> FindState(
        Guid exportId,
        IWorkerJobStore jobs,
        INixSessionContextAccessor session,
        IPermissionResolver permissions,
        CancellationToken cancellationToken)
    {
        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var job = await jobs.GetAsync(
            scoped.TenantId,
            scoped.PrincipalId,
            exportId,
            cancellationToken).ConfigureAwait(false);
        if (job is null || !job.Kind.StartsWith("export.", StringComparison.Ordinal))
        {
            return null;
        }
        if (TryReadState(job, out var payload, out _)
            && !await permissions.CanReadWorkspaceAsync(
                WorkspaceId.From(payload.WorkspaceId),
                cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        return (job, scoped);
    }

    internal static bool TryReadState(
        WorkerJobRecord job,
        out ExportJobPayload payload,
        out WorkerExportResult? result)
    {
        payload = default!;
        result = null;
        try
        {
            payload = JsonSerializer.Deserialize(job.Payload, ExportsJsonContext.Default.ExportJobPayload)!;
            if (payload is null
                || payload.ItemId == Guid.Empty
                || payload.WorkspaceId == Guid.Empty
                || job.Kind != "export." + payload.Format
                || !ValidPayload(payload))
            {
                return false;
            }
            if (!string.IsNullOrWhiteSpace(job.Result))
            {
                result = JsonSerializer.Deserialize(job.Result, ExportsJsonContext.Default.WorkerExportResult);
                if (result is null || !ValidResultShape(result))
                {
                    return false;
                }
            }
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static ExportResponse ToResponse(
        WorkerJobRecord job,
        ExportJobPayload payload,
        WorkerExportResult? result,
        TenantId tenantId,
        DateTimeOffset now)
    {
        DateTimeOffset? expiresAt = job.Status == "completed" && job.CompletedAt is { } completed
            ? completed.Add(ResultRetention)
            : null;
        var validResult = result is not null && ValidResult(result, payload, tenantId, job.Id);
        var loss = payload.DeclaredLoss
            .Concat(validResult ? result!.Loss : [])
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        return new ExportResponse(
            job.Id,
            payload.ItemId,
            payload.WorkspaceId,
            payload.Format,
            payload.Scope,
            FileName(payload.Title, payload.Extension),
            payload.MediaType,
            job.Status,
            validResult ? result!.ItemCount : null,
            validResult ? result!.OmittedCount : null,
            validResult ? result!.ByteLength : null,
            validResult ? result!.Sha256 : null,
            loss,
            validResult ? result!.Omissions : [],
            job.ErrorCode,
            job.ErrorDetail,
            job.CancellationRequested,
            validResult && expiresAt > now,
            job.CreatedAt,
            job.CompletedAt,
            expiresAt);
    }

    private static bool ValidResult(
        WorkerExportResult result,
        ExportJobPayload payload,
        TenantId tenantId,
        Guid exportId) =>
        result.AttemptId != Guid.Empty
        && result.Format == payload.Format
        && result.ObjectKey == ObjectStorageKeys.ExportResult(
            tenantId,
            exportId,
            result.AttemptId,
            payload.Extension)
        && result.ItemCount is > 0 and <= 100_000
        && result.OmittedCount is >= 0 and <= 100_000
        && result.ByteLength is > 0 and <= MaximumExportBytes
        && ValidSha256(result.Sha256)
        && result.Loss.Count <= 128
        && result.Omissions.Count <= 100_000
        && result.Loss.All(ValidReportEntry)
        && result.Omissions.All(ValidReportEntry);

    private static bool ValidResultShape(WorkerExportResult result) =>
        result.AttemptId != Guid.Empty
        && !string.IsNullOrWhiteSpace(result.Format)
        && !string.IsNullOrWhiteSpace(result.ObjectKey)
        && result.Loss is not null
        && result.Omissions is not null
        && result.ByteLength is > 0 and <= MaximumExportBytes
        && ValidSha256(result.Sha256);

    private static bool ValidPayload(ExportJobPayload payload) =>
        !string.IsNullOrWhiteSpace(payload.Format)
        && payload.Format.Length <= 32
        && payload.Scope is "item" or "subtree"
        && payload.Title is not null
        && payload.Title.Length <= 500
        && !string.IsNullOrWhiteSpace(payload.Extension)
        && payload.Extension.Length <= 16
        && payload.Extension.All(character => char.IsAsciiDigit(character)
            || character is >= 'a' and <= 'z')
        && !string.IsNullOrWhiteSpace(payload.MediaType)
        && payload.MediaType.Length is > 2 and <= 128
        && payload.MediaType.Contains('/', StringComparison.Ordinal)
        && payload.DeclaredLoss is not null
        && payload.DeclaredLoss.Count <= 32
        && payload.DeclaredLoss.All(ValidReportEntry);

    private static bool ValidDescriptor(ExportFormatCapability descriptor) =>
        descriptor.Format.Length is > 0 and <= 32
        && descriptor.Format.All(character => char.IsAsciiDigit(character)
            || character is >= 'a' and <= 'z'
            || character == '-')
        && descriptor.Extension.Length is > 0 and <= 16
        && descriptor.Extension.All(character => char.IsAsciiDigit(character)
            || character is >= 'a' and <= 'z')
        && descriptor.MediaType.Length is > 2 and <= 128
        && descriptor.MediaType.Contains('/', StringComparison.Ordinal)
        && descriptor.DeclaredLoss.Count <= 32
        && descriptor.DeclaredLoss.All(ValidReportEntry);

    private static bool ValidReportEntry(string? value) =>
        !string.IsNullOrWhiteSpace(value)
        && value.Length <= 500
        && !value.Any(char.IsControl);

    private static bool ValidSha256(string? value) =>
        value is { Length: 64 } && value.All(char.IsAsciiHexDigit);

    private static string NormalizeFormat(string? value)
    {
        var trimmed = value?.Trim();
        var normalized = trimmed is null
            ? null
            : string.Create(trimmed.Length, trimmed, static (destination, source) =>
            {
                for (var index = 0; index < source.Length; index++)
                {
                    var character = source[index];
                    destination[index] = character is >= 'A' and <= 'Z'
                        ? (char)(character + ('a' - 'A'))
                        : character;
                }
            });
        if (string.Equals(normalized, "md", StringComparison.OrdinalIgnoreCase)
            || string.Equals(normalized, "markdown", StringComparison.OrdinalIgnoreCase))
        {
            return "markdown";
        }
        return normalized is { Length: > 0 and <= 32 }
            && normalized.All(character => char.IsAsciiDigit(character)
                || character is >= 'a' and <= 'z'
                || character == '-')
                ? normalized
                : string.Empty;
    }

    private static string NormalizeScope(string? value)
    {
        var normalized = value?.Trim();
        if (string.Equals(normalized, "item", StringComparison.OrdinalIgnoreCase))
        {
            return "item";
        }
        return string.Equals(normalized, "subtree", StringComparison.OrdinalIgnoreCase)
            ? "subtree"
            : string.Empty;
    }

    private static ExportFormatResponse ToResponse(ExportFormatCapability format) => new(
        format.Format,
        format.Label,
        format.Extension,
        format.MediaType,
        format.Lossless,
        format.DeclaredLoss);

    private static string FileName(string title, string extension)
    {
        var stem = new string(title.Trim().Select(character =>
            char.IsAsciiLetterOrDigit(character) || character is '-' or '_' or ' '
                ? character
                : '_').ToArray()).Trim();
        if (string.IsNullOrWhiteSpace(stem))
        {
            stem = "Nix export";
        }
        if (stem.Length > 120)
        {
            stem = stem[..120].TrimEnd();
        }
        return $"{stem}.{extension}";
    }

    internal static bool TryCollaborationBaseUri(IConfiguration configuration, out Uri baseUri)
    {
        var value = configuration[CollaborationBaseUrlConfigurationKey];
        if (!Uri.TryCreate(value, UriKind.Absolute, out var parsed)
            || parsed.UserInfo.Length != 0
            || parsed.Query.Length != 0
            || parsed.Fragment.Length != 0
            || parsed.Scheme is not ("http" or "https")
            || (parsed.Scheme == Uri.UriSchemeHttp
                && !parsed.IsLocal()
                && parsed.Host.Contains('.', StringComparison.Ordinal)))
        {
            baseUri = default!;
            return false;
        }
        baseUri = new Uri(parsed.AbsoluteUri.TrimEnd('/') + "/", UriKind.Absolute);
        return true;
    }

    private static ProblemHttpResult Problem(
        HttpContext context,
        int status,
        string code,
        string title,
        string detail) => TypedResults.Problem(ApiProblem.Create(context, status, code, title, detail));
}
