using System.Text.Json;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Abstractions.Importing;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Importing;
using Nix.Domain.Tenancy;
using Nix.Http;
using Nix.Persistence.ObjectStorage;

namespace Nix.Features.DocumentImports;

/// <summary>The worker side of a document import: lease-bound capabilities, staging and finalization for the job that owns it.</summary>
internal static class DocumentImportWorkerEndpoints
{
    internal static void MapWorkerExecutions(IEndpointRouteBuilder group)
    {
        var imports = group.MapGroup("/imports/{importId:guid}");
        imports.MapGet("/preview", GetPreviewExecution);
        imports.MapPost("/preview/complete", CompletePreviewExecution);
        imports.MapGet("/commit", GetCommitExecution);
        imports.MapPost("/stage", StageExecution).WithRequestBodyLimit(40L * 1024 * 1024);
        imports.MapGet("/objects/capability", AuthorizeObjectExecution);
        imports.MapPost("/objects/complete", CompleteObjectExecution);
        imports.MapGet("/file-versions/authorization", AuthorizeFileVersionsExecution);
        imports.MapPost("/file-versions/complete", CompleteFileVersionsExecution);
        imports.MapGet("/bodies/authorization", AuthorizeBodiesExecution);
        imports.MapPost("/finalize", FinalizeExecution);
        imports.MapPost("/reject", RejectExecution);
    }

    private static async Task<IResult> GetPreviewExecution(
        Guid importId,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] S3CapabilitySigner signer)
    {
        var execution = await OwnedExecution(
            importId,
            context,
            imports,
            jobs,
            session,
            static kind => kind.StartsWith("import.preview.", StringComparison.Ordinal)).ConfigureAwait(false);
        if (execution is null
            || !signer.IsConfigured
            || execution.Import.Status is not (DocumentImportStatuses.PreviewQueued or DocumentImportStatuses.PreviewReady))
        {
            return TypedResults.Problem(DocumentImportProblems.NotFound(context));
        }
        var source = signer.Get(execution.SourceObjectKey);
        var sourceDelete = signer.Delete(execution.SourceObjectKey);
        var planUpload = signer.Put(execution.Import.PlanObjectKey);
        var planDelete = signer.Delete(execution.Import.PlanObjectKey);
        return TypedResults.Ok(new WorkerDocumentImportPreviewResponse(
            execution.Import.Id,
            execution.Import.Format,
            execution.Import.Title,
            execution.SourceFileName,
            execution.SourceMediaType,
            execution.SourceByteLength,
            source.Url,
            sourceDelete.Url,
            planUpload.Url,
            planDelete.Url,
            MinimumExpiry(source, sourceDelete, planUpload, planDelete)));
    }

    private static async Task<IResult> CompletePreviewExecution(
        Guid importId,
        CompleteDocumentImportPreviewRequest request,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IWorkerDispatchStore dispatch)
    {
        if (!DocumentImportRules.ValidPreviewResult(request)
            || await OwnedExecution(
                importId,
                context,
                imports,
                jobs,
                session,
                static kind => kind.StartsWith("import.preview.", StringComparison.Ordinal)).ConfigureAwait(false) is null)
        {
            return TypedResults.Problem(DocumentImportProblems.NotFound(context));
        }
        var result = await imports.CompletePreviewAsync(
            new CompleteDocumentImportPreview(
                DocumentImportId.From(importId),
                request.PlanSha256,
                request.PlanByteLength,
                request.SourceSha256,
                request.ItemCount,
                request.AssetCount,
                JsonSerializer.Serialize(request.Loss, DocumentImportsJsonContext.Default.IReadOnlyListString),
                JsonSerializer.Serialize(request.Omissions, DocumentImportsJsonContext.Default.IReadOnlyListString)),
            context.RequestAborted).ConfigureAwait(false);
        if (result is null)
        {
            return TypedResults.Problem(DocumentImportProblems.NotFound(context));
        }
        return await WorkerExecutionMiddleware.ExecutionStillLive(context, dispatch).ConfigureAwait(false)
            ? TypedResults.Ok(DocumentImportMapping.ToResponse(result))
            : TypedResults.Problem(DocumentImportProblems.ExecutionLost(context));
    }

    private static async Task<IResult> GetCommitExecution(
        Guid importId,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] S3CapabilitySigner signer)
    {
        var execution = await OwnedExecution(
            importId,
            context,
            imports,
            jobs,
            session,
            static kind => kind == "import.commit").ConfigureAwait(false);
        if (execution is null
            || !signer.IsConfigured
            || execution.Import.Status is not (DocumentImportStatuses.CommitQueued or DocumentImportStatuses.Staging or DocumentImportStatuses.Completed)
            || execution.Import.PlanSha256 is null
            || execution.Import.PlanByteLength is null
            || execution.Import.SourceSha256 is null)
        {
            return TypedResults.Problem(DocumentImportProblems.NotFound(context));
        }
        var source = signer.Get(execution.SourceObjectKey);
        var sourceDelete = signer.Delete(execution.SourceObjectKey);
        var plan = signer.Get(execution.Import.PlanObjectKey);
        var planDelete = signer.Delete(execution.Import.PlanObjectKey);
        return TypedResults.Ok(new WorkerDocumentImportCommitResponse(
            execution.Import.Id,
            execution.Import.Format,
            execution.Import.Title,
            execution.SourceFileName,
            execution.SourceMediaType,
            execution.SourceByteLength,
            execution.Import.PlanSha256,
            execution.Import.PlanByteLength.Value,
            execution.Import.SourceSha256,
            source.Url,
            sourceDelete.Url,
            plan.Url,
            planDelete.Url,
            MinimumExpiry(source, sourceDelete, plan, planDelete)));
    }

    private static async Task<IResult> StageExecution(
        Guid importId,
        StageDocumentImportRequest request,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IWorkerDispatchStore dispatch)
    {
        if (request.Items.Count is < 1 or > 10_000
            || await OwnedExecution(
                importId,
                context,
                imports,
                jobs,
                session,
                static kind => kind == "import.commit").ConfigureAwait(false) is null)
        {
            return TypedResults.Problem(DocumentImportProblems.NotFound(context));
        }
        var result = await imports.StageAsync(
            new StageDocumentImport(
                DocumentImportId.From(importId),
                request.PlanSha256,
                request.SourceSha256,
                request.Items.Select(DocumentImportMapping.ToPlan).ToArray(),
                request.FileVersions?.Select(value => new ImportFileVersionPlan(
                    value.SourceItemId, value.Version, value.FileName, value.MediaType,
                    value.ByteLength, value.Sha256, value.Previewable, value.PixelWidth, value.PixelHeight)).ToArray()),
            context.RequestAborted).ConfigureAwait(false);
        if (result is null)
        {
            return TypedResults.Problem(DocumentImportProblems.NotFound(context));
        }
        if (!await WorkerExecutionMiddleware.ExecutionStillLive(context, dispatch).ConfigureAwait(false))
        {
            return TypedResults.Problem(DocumentImportProblems.ExecutionLost(context));
        }
        return TypedResults.Ok(new DocumentImportStageResponse(
            result.ImportId,
            result.RootItemId,
            result.Items.Select(value => new DocumentImportStageItemResponse(
                value.SourceId,
                value.TargetItemId,
                value.ItemType,
                value.BodyRequired,
                value.ObjectReady)).ToArray(),
            result.FileVersions?.Select(value => new DocumentImportStageFileVersionResponse(
                value.TransferId, value.SourceItemId, value.TargetItemId, value.TargetVersion)).ToArray()));
    }

    private static async Task<IResult> AuthorizeFileVersionsExecution(
        Guid importId, Guid? afterTransferId, int limit, HttpContext context,
        [FromServices] IDocumentImportStore imports, [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session, [FromServices] S3CapabilitySigner signer)
    {
        var executionId = context.Request.Headers[WorkerExecutionMiddleware.ExecutionHeaderName].ToString();
        if (!signer.IsConfigured || limit is < 1 or > 100
            || await OwnedExecution(importId, context, imports, jobs, session,
                static kind => kind == "import.commit").ConfigureAwait(false) is null)
        {
            return TypedResults.Problem(DocumentImportProblems.NotFound(context));
        }

        var rows = await imports.AuthorizeFileVersionsAsync(DocumentImportId.From(importId), executionId,
            afterTransferId, limit, context.RequestAborted).ConfigureAwait(false);
        if (rows is null)
        {
            return TypedResults.Problem(DocumentImportProblems.NotFound(context));
        }

        var files = rows.Files.Select(row => new DocumentImportFileVersionCapabilityResponse(
            row.TransferId, row.SourceItemId, row.TargetItemId, row.TargetVersion,
            row.FileName, row.MediaType, row.ByteLength, row.Sha256,
            row.ObjectReady ? null : signer.PutImmutableVerified(row.ObjectKey, row.ByteLength, row.Sha256).Url,
            row.ObjectReady ? null : signer.Get(row.ObjectKey).Url, row.ObjectReady)).ToArray();
        return TypedResults.Ok(new DocumentImportFileVersionsAuthorizationResponse(
            importId, files, rows.NextAfterTransferId, rows.Complete));
    }

    private static async Task<IResult> CompleteFileVersionsExecution(
        Guid importId, CompleteDocumentImportFileVersionsRequest request, HttpContext context,
        [FromServices] IDocumentImportStore imports, [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session, [FromServices] IWorkerDispatchStore dispatch)
    {
        var executionId = context.Request.Headers[WorkerExecutionMiddleware.ExecutionHeaderName].ToString();
        if (request.TransferIds.Count is < 1 or > 100
            || request.TransferIds.Distinct().Count() != request.TransferIds.Count
            || await OwnedExecution(importId, context, imports, jobs, session,
                static kind => kind == "import.commit").ConfigureAwait(false) is null
            || !await imports.CompleteFileVersionsAsync(DocumentImportId.From(importId), executionId,
                request.TransferIds, context.RequestAborted).ConfigureAwait(false))
        {
            return TypedResults.Problem(DocumentImportProblems.NotFound(context));
        }

        return await WorkerExecutionMiddleware.ExecutionStillLive(context, dispatch).ConfigureAwait(false)
            ? TypedResults.Ok(new CompleteDocumentImportFileVersionsResponse(importId, request.TransferIds))
            : TypedResults.Problem(DocumentImportProblems.ExecutionLost(context));
    }

    private static async Task<IResult> AuthorizeObjectExecution(
        Guid importId,
        string sourceId,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] S3CapabilitySigner signer)
    {
        if (!signer.IsConfigured
            || await OwnedExecution(
                importId,
                context,
                imports,
                jobs,
                session,
                static kind => kind == "import.commit").ConfigureAwait(false) is null)
        {
            return TypedResults.Problem(DocumentImportProblems.NotFound(context));
        }
        var mapping = await imports.AuthorizeObjectUploadAsync(
            DocumentImportId.From(importId),
            sourceId,
            context.RequestAborted).ConfigureAwait(false);
        if (mapping is null)
        {
            return TypedResults.Problem(DocumentImportProblems.NotFound(context));
        }
        var read = signer.Get(mapping.ObjectKey);
        var upload = signer.PutImmutableVerified(mapping.ObjectKey, mapping.ByteLength, mapping.Sha256);
        var delete = signer.Delete(mapping.ObjectKey);
        return TypedResults.Ok(new DocumentImportObjectCapabilityResponse(
            sourceId,
            read.Url,
            upload.Url,
            delete.Url,
            MinimumExpiry(read, upload, delete)));
    }

    private static async Task<IResult> CompleteObjectExecution(
        Guid importId,
        CompleteDocumentImportObjectRequest request,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IWorkerDispatchStore dispatch)
    {
        if (request.ByteLength is < 0 or > DocumentImportRules.MaximumBytes
            || !DocumentImportRules.ValidDigest(request.Sha256)
            || await OwnedExecution(
                importId,
                context,
                imports,
                jobs,
                session,
                static kind => kind == "import.commit").ConfigureAwait(false) is null
            || !await imports.MarkObjectReadyAsync(
                DocumentImportId.From(importId),
                request.SourceId,
                request.ByteLength,
                request.Sha256,
                context.RequestAborted).ConfigureAwait(false))
        {
            return TypedResults.Problem(DocumentImportProblems.NotFound(context));
        }
        return await WorkerExecutionMiddleware.ExecutionStillLive(context, dispatch).ConfigureAwait(false)
            ? TypedResults.NoContent()
            : TypedResults.Problem(DocumentImportProblems.ExecutionLost(context));
    }

    private static async Task<IResult> AuthorizeBodiesExecution(
        Guid importId,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session)
    {
        if (await OwnedExecution(
            importId,
            context,
            imports,
            jobs,
            session,
            static kind => kind == "import.commit").ConfigureAwait(false) is null)
        {
            return TypedResults.Problem(DocumentImportProblems.NotFound(context));
        }
        var stage = await imports.AuthorizeBodyWritesAsync(
            DocumentImportId.From(importId),
            context.RequestAborted).ConfigureAwait(false);
        var scoped = session.Current;
        if (stage is null || scoped is null || scoped.Value.WorkspaceId is null)
        {
            return TypedResults.Problem(DocumentImportProblems.NotFound(context));
        }
        var scope = scoped.Value;
        return TypedResults.Ok(new DocumentImportBodyAuthorizationResponse(
            scope.TenantId.Value,
            scope.PrincipalId.Value,
            scope.WorkspaceId!.Value.Value,
            importId,
            stage.Items.Select(item => new DocumentImportBodyAuthorizationItemResponse(
                item.SourceId,
                item.TargetItemId,
                item.ItemType,
                item.BodyRequired)).ToArray(),
            CanWrite: true));
    }

    private static async Task<IResult> FinalizeExecution(
        Guid importId,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IWorkerDispatchStore dispatch,
        [FromServices] IWorkerJobStore workerJobs,
        [FromServices] S3CapabilitySigner signer)
    {
        var execution = await OwnedExecution(
            importId,
            context,
            imports,
            jobs,
            session,
            static kind => kind == "import.commit").ConfigureAwait(false);
        if (execution is null)
        {
            return TypedResults.Problem(DocumentImportProblems.NotFound(context));
        }
        var result = await imports.FinalizeAsync(
            DocumentImportId.From(importId),
            context.RequestAborted).ConfigureAwait(false);
        if (result is null)
        {
            return TypedResults.Problem(DocumentImportProblems.NotFound(context));
        }
        if (execution.Import.Status != DocumentImportStatuses.Completed)
        {
            var scoped = session.Current
                ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
            await ObjectCleanupJobs.QueueAsync(
                workerJobs,
                scoped.TenantId,
                scoped.PrincipalId,
                WorkspaceId.From(result.WorkspaceId),
                "document-import",
                importId,
                signer.GetCleanupNotBefore(),
                [execution.SourceObjectKey, execution.Import.PlanObjectKey],
                context.RequestAborted).ConfigureAwait(false);
        }
        return await WorkerExecutionMiddleware.ExecutionStillLive(context, dispatch).ConfigureAwait(false)
            ? TypedResults.Ok(DocumentImportMapping.ToResponse(result))
            : TypedResults.Problem(DocumentImportProblems.ExecutionLost(context));
    }

    private static async Task<IResult> RejectExecution(
        Guid importId,
        RejectDocumentImportRequest request,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IWorkerDispatchStore dispatch,
        [FromServices] S3CapabilitySigner signer)
    {
        if (!DocumentImportRules.ValidFailureCode(request.Code)
            || await OwnedExecution(
                importId,
                context,
                imports,
                jobs,
                session,
                static kind => kind.StartsWith("import.", StringComparison.Ordinal)).ConfigureAwait(false) is null)
        {
            return TypedResults.Problem(DocumentImportProblems.NotFound(context));
        }
        var cleanup = await imports.FailAsync(
            DocumentImportId.From(importId),
            request.Code,
            context.RequestAborted).ConfigureAwait(false);
        if (cleanup is null)
        {
            return TypedResults.Problem(DocumentImportProblems.NotFound(context));
        }
        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        await ObjectCleanupJobs.QueueBatchedAsync(
            jobs,
            scoped.TenantId,
            scoped.PrincipalId,
            WorkspaceId.From(cleanup.WorkspaceId),
            "document-import",
            importId,
            signer.GetCleanupNotBefore(),
            cleanup.ObjectKeys,
            context.RequestAborted).ConfigureAwait(false);
        return await WorkerExecutionMiddleware.ExecutionStillLive(context, dispatch).ConfigureAwait(false)
            ? TypedResults.NoContent()
            : TypedResults.Problem(DocumentImportProblems.ExecutionLost(context));
    }

    private static async Task<DocumentImportExecutionRecord?> OwnedExecution(
        Guid importId,
        HttpContext context,
        IDocumentImportStore imports,
        IWorkerJobStore jobs,
        INixSessionContextAccessor session,
        Func<string, bool> kindAllowed)
    {
        if (!Guid.TryParse(context.Request.Headers[WorkerExecutionMiddleware.JobHeaderName], out var jobId))
        {
            return null;
        }
        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var job = await jobs.GetAsync(
            scoped.TenantId,
            scoped.PrincipalId,
            jobId,
            context.RequestAborted).ConfigureAwait(false);
        if (job is null || job.Status != "running" || !kindAllowed(job.Kind))
        {
            return null;
        }
        DocumentImportJobPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize(
                job.Payload,
                DocumentImportsJsonContext.Default.DocumentImportJobPayload);
        }
        catch (JsonException)
        {
            return null;
        }
        var execution = payload?.ImportId == importId
            ? await imports.GetExecutionAsync(
                DocumentImportId.From(importId),
                context.RequestAborted).ConfigureAwait(false)
            : null;
        if (execution is null
            || (job.Kind == "import.commit"
                ? execution.Import.CommitJobId != jobId
                : execution.Import.PreviewJobId != jobId))
        {
            return null;
        }
        return execution;
    }

    private static DateTimeOffset MinimumExpiry(params ObjectCapability[] capabilities) =>
        capabilities.Min(value => value.ExpiresAt);
}
