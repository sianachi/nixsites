using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Abstractions.Importing;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Importing;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Features.Templates;
using Nix.Http;
using Nix.Messaging;
using Nix.Persistence.ObjectStorage;

namespace Nix.Features.TemplateImports;

/// <summary>The worker side of a template import: lease-bound capabilities, staging and completion for the job that owns it.</summary>
internal static class TemplateImportWorkerEndpoints
{
    internal static void MapWorkerExecutions(IEndpointRouteBuilder group)
    {
        var imports = group.MapGroup("/template-imports/{importId:guid}");
        imports.MapGet("/preview", GetPreviewExecution);
        imports.MapPost("/preview/complete", CompletePreviewExecution);
        imports.MapGet("/commit", GetCommitExecution);
        imports.MapPost("/stage", StageExecution).WithRequestBodyLimit(16L * 1024 * 1024);
        imports.MapGet("/files/authorization", AuthorizeFileVersionsExecution);
        imports.MapPost("/files/complete", CompleteFileVersionsExecution);
        imports.MapGet("/bodies/authorization", AuthorizeBodiesExecution);
        imports.MapPost("/complete", CompleteExecution);
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
        var execution = await OwnedExecution(importId, context, imports, jobs, session, "template.preview").ConfigureAwait(false);
        if (execution is null
            || !signer.IsConfigured
            || execution.Import.Status is not (DocumentImportStatuses.PreviewQueued or DocumentImportStatuses.PreviewReady))
        {
            return TypedResults.Problem(TemplateImportProblems.NotFound(context));
        }
        var source = signer.Get(execution.SourceObjectKey);
        var sourceDelete = signer.Delete(execution.SourceObjectKey);
        var planUpload = signer.Put(execution.Import.PlanObjectKey);
        var planDelete = signer.Delete(execution.Import.PlanObjectKey);
        return TypedResults.Ok(new WorkerTemplateImportPreviewResponse(
            execution.Import.Id,
            execution.Import.WorkspaceId,
            TemplateImportMapping.Origin(execution.Import.Purpose),
            execution.Import.ManagedSource,
            execution.Import.IdempotencyKey,
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
        CompleteTemplateImportPreviewRequest request,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IWorkerDispatchStore dispatch)
    {
        if (!TemplateImportRules.ValidPreview(request)
            || await OwnedExecution(importId, context, imports, jobs, session, "template.preview").ConfigureAwait(false) is null)
        {
            return TypedResults.Problem(TemplateImportProblems.NotFound(context));
        }
        var preview = new TemplateImportPreviewResponse(
            request.Profile,
            request.SourceSha256,
            request.RootItemType,
            request.ItemCount,
            request.BodyCount,
            request.ViewCount);
        var result = await imports.CompletePreviewAsync(
            new CompleteDocumentImportPreview(
                DocumentImportId.From(importId),
                request.PlanSha256,
                request.PlanByteLength,
                request.SourceSha256,
                request.ItemCount,
                request.BodyCount,
                "[]",
                "[]",
                JsonSerializer.Serialize(preview, TemplateImportsJsonContext.Default.TemplateImportPreviewResponse)),
            context.RequestAborted).ConfigureAwait(false);
        if (result is null)
        {
            return TypedResults.Problem(TemplateImportProblems.NotFound(context));
        }
        return await WorkerExecutionMiddleware.ExecutionStillLive(context, dispatch).ConfigureAwait(false)
            ? TypedResults.Ok(TemplateImportMapping.ToResponse(result))
            : TypedResults.Problem(TemplateImportProblems.ExecutionLost(context));
    }

    private static async Task<IResult> GetCommitExecution(
        Guid importId,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] S3CapabilitySigner signer)
    {
        var execution = await OwnedExecution(importId, context, imports, jobs, session, "template.commit").ConfigureAwait(false);
        if (execution is null
            || execution.Import.Status is not (DocumentImportStatuses.CommitQueued
                or DocumentImportStatuses.Staging
                or DocumentImportStatuses.Staged
                or DocumentImportStatuses.Completed)
            || execution.Import.PlanSha256 is null
            || execution.Import.PlanByteLength is null
            || execution.Import.SourceSha256 is null)
        {
            return TypedResults.Problem(TemplateImportProblems.NotFound(context));
        }
        if (execution.Import.Status is DocumentImportStatuses.Staged or DocumentImportStatuses.Completed)
        {
            var completed = TemplateImportMapping.WorkerResult(execution.Import);
            return completed is null
                ? TypedResults.Problem(TemplateImportProblems.NotFound(context))
                : TypedResults.Ok(new WorkerTemplateImportCommitResponse(
                    execution.Import.Id,
                    execution.Import.WorkspaceId,
                    TemplateImportMapping.Origin(execution.Import.Purpose),
                    execution.Import.ManagedSource,
                    execution.Import.IdempotencyKey,
                    execution.SourceFileName,
                    execution.SourceMediaType,
                    execution.SourceByteLength,
                    execution.Import.PlanSha256,
                    execution.Import.PlanByteLength.Value,
                    execution.Import.SourceSha256,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    completed));
        }
        if (!signer.IsConfigured)
        {
            return TypedResults.Problem(TemplateImportProblems.NotFound(context));
        }
        var source = signer.Get(execution.SourceObjectKey);
        var sourceDelete = signer.Delete(execution.SourceObjectKey);
        var plan = signer.Get(execution.Import.PlanObjectKey);
        var planUpload = signer.Put(execution.Import.PlanObjectKey);
        var planDelete = signer.Delete(execution.Import.PlanObjectKey);
        return TypedResults.Ok(new WorkerTemplateImportCommitResponse(
            execution.Import.Id,
            execution.Import.WorkspaceId,
            TemplateImportMapping.Origin(execution.Import.Purpose),
            execution.Import.ManagedSource,
            execution.Import.IdempotencyKey,
            execution.SourceFileName,
            execution.SourceMediaType,
            execution.SourceByteLength,
            execution.Import.PlanSha256,
            execution.Import.PlanByteLength.Value,
            execution.Import.SourceSha256,
            source.Url,
            sourceDelete.Url,
            plan.Url,
            planUpload.Url,
            planDelete.Url,
            MinimumExpiry(source, sourceDelete, plan, planUpload, planDelete),
            null));
    }

    private static async Task<IResult> StageExecution(
        Guid importId,
        StageTemplateImportRequest request,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IWorkerDispatchStore dispatch,
        [FromServices] NixDispatcher dispatcher)
    {
        var execution = await OwnedExecution(importId, context, imports, jobs, session, "template.commit").ConfigureAwait(false);
        if (execution is null
            || !TemplateImportRules.TryBuildTemplateImport(execution.Import, request, out var descriptor, out var items))
        {
            return TypedResults.Problem(TemplateImportProblems.NotFound(context));
        }
        var staged = await dispatcher.SendAsync<BeginTemplateImport, TemplateImportPlan>(
            new BeginTemplateImport(
                WorkspaceId.From(execution.Import.WorkspaceId),
                execution.Import.IdempotencyKey,
                descriptor,
                items),
            context.RequestAborted).ConfigureAwait(false);
        if (staged.IsFailure)
        {
            return TemplateImportProblems.TemplateProblem(context, staged.Error);
        }
        var plan = staged.Value;
        var attached = await imports.AttachTemplateStageAsync(
            new AttachTemplateImportStage(
                DocumentImportId.From(importId),
                plan.OperationId,
                plan.TemplateId,
                descriptor.StableKey,
                descriptor.Digest,
                plan.Unchanged),
            context.RequestAborted).ConfigureAwait(false);
        if (attached is null)
        {
            return TypedResults.Problem(TemplateImportProblems.ExecutionLost(context));
        }
        var fileTransfers = await imports.StageTemplateFileVersionsAsync(
            DocumentImportId.From(importId),
            plan.Unchanged ? [] : (request.Files ?? []).Select(file => new ImportFileVersionPlan(
                file.SourceItemId, file.Version, file.FileName, file.MediaType, file.ByteLength,
                file.Sha256, file.Previewable, file.PixelWidth, file.PixelHeight)).ToArray(),
            plan.ItemMappings.Where(mapping => mapping.ItemType == "file")
                .Select(mapping => (mapping.SourceId.ToString("D"), mapping.ItemId)).ToArray(),
            context.RequestAborted).ConfigureAwait(false);
        if (fileTransfers is null)
        {
            return TypedResults.Problem(TemplateImportProblems.ExecutionLost(context));
        }
        if (!await WorkerExecutionMiddleware.ExecutionStillLive(context, dispatch).ConfigureAwait(false))
        {
            return TypedResults.Problem(TemplateImportProblems.ExecutionLost(context));
        }
        return TypedResults.Ok(new TemplateImportStageResponse(
            importId,
            plan.OperationId?.Value,
            plan.TemplateId.Value,
            descriptor.StableKey,
            descriptor.Digest,
            plan.Unchanged,
            plan.ItemMappings.Select(TemplateImportMapping.Map).ToArray(),
            plan.BodyWrites.Select(TemplateImportMapping.Map).ToArray(),
            fileTransfers.Select(value => new TemplateImportFileTransferMappingResponse(
                value.TransferId, value.SourceItemId, value.TargetItemId, value.TargetVersion)).ToArray()));
    }

    private static async Task<IResult> AuthorizeBodiesExecution(
        Guid importId,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] NixDispatcher dispatcher)
    {
        var execution = await OwnedExecution(importId, context, imports, jobs, session, "template.commit").ConfigureAwait(false);
        var scoped = session.Current;
        if (execution is null
            || scoped is null
            || scoped.Value.WorkspaceId is null
            || execution.Import.Status is not (DocumentImportStatuses.Staging
                or DocumentImportStatuses.Staged
                or DocumentImportStatuses.Completed))
        {
            return TypedResults.Problem(TemplateImportProblems.NotFound(context));
        }
        if (execution.Import.TemplateOperationId is null)
        {
            if (execution.Import.TemplateUnchanged != true)
            {
                return TypedResults.Problem(TemplateImportProblems.NotFound(context));
            }
            return TypedResults.Ok(new TemplateImportBodyAuthorizationResponse(
                scoped.Value.TenantId.Value,
                scoped.Value.PrincipalId.Value,
                scoped.Value.WorkspaceId.Value.Value,
                importId,
                null,
                [],
                CanWrite: true));
        }
        var authorization = await dispatcher.QueryAsync<AuthorizeTemplateOperationWrites, Result<TemplateOperationWriteAuthorization>>(
            new AuthorizeTemplateOperationWrites(TemplateOperationId.From(execution.Import.TemplateOperationId.Value)),
            context.RequestAborted).ConfigureAwait(false);
        if (authorization.IsFailure)
        {
            return TemplateImportProblems.TemplateProblem(context, authorization.Error);
        }
        var value = authorization.Value;
        if (value.WorkspaceId.Value != execution.Import.WorkspaceId || !value.CanWrite)
        {
            return TypedResults.Problem(TemplateImportProblems.NotFound(context));
        }
        return TypedResults.Ok(new TemplateImportBodyAuthorizationResponse(
            value.TenantId.Value,
            value.PrincipalId.Value,
            value.WorkspaceId.Value,
            importId,
            value.OperationId.Value,
            value.BodyWrites.Select(write => new TemplateImportBodyAuthorizationItemResponse(
                write.SourceId,
                write.TargetItemId.Value,
                write.ItemType,
                write.BodyRequired)).ToArray(),
            CanWrite: true));
    }

    private static async Task<IResult> AuthorizeFileVersionsExecution(
        Guid importId,
        Guid? afterTransferId,
        int? limit,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] S3CapabilitySigner signer)
    {
        var pageSize = limit ?? 100;
        var executionId = context.Request.Headers[WorkerExecutionMiddleware.ExecutionHeaderName].ToString();
        if (pageSize is < 1 or > 100 || !signer.IsConfigured
            || await OwnedExecution(importId, context, imports, jobs, session, "template.commit").ConfigureAwait(false) is null)
        {
            return TypedResults.Problem(TemplateImportProblems.NotFound(context));
        }
        var page = await imports.AuthorizeFileVersionsAsync(DocumentImportId.From(importId), executionId,
            afterTransferId, pageSize, context.RequestAborted).ConfigureAwait(false);
        if (page is null)
        {
            return TypedResults.Problem(TemplateImportProblems.NotFound(context));
        }

        var files = page.Files.Select(file => new TemplateImportFileVersionCapabilityResponse(
            file.TransferId, file.SourceItemId, file.TargetItemId, file.TargetVersion,
            file.FileName, file.MediaType, file.ByteLength, file.Sha256,
            file.ObjectReady ? null : signer.PutImmutableVerified(file.ObjectKey, file.ByteLength, file.Sha256).Url,
            file.ObjectReady ? null : signer.Get(file.ObjectKey).Url, file.ObjectReady)).ToArray();
        return TypedResults.Ok(new TemplateImportFileVersionsAuthorizationResponse(
            importId, files, page.NextAfterTransferId, page.Complete));
    }

    private static async Task<IResult> CompleteFileVersionsExecution(
        Guid importId,
        CompleteTemplateImportFileVersionsRequest request,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IWorkerDispatchStore dispatch)
    {
        var executionId = context.Request.Headers[WorkerExecutionMiddleware.ExecutionHeaderName].ToString();
        if (request.TransferIds.Count is < 1 or > 100
            || request.TransferIds.Distinct().Count() != request.TransferIds.Count
            || await OwnedExecution(importId, context, imports, jobs, session, "template.commit").ConfigureAwait(false) is null
            || !await imports.CompleteFileVersionsAsync(DocumentImportId.From(importId), executionId,
                request.TransferIds, context.RequestAborted).ConfigureAwait(false))
        {
            return TypedResults.Problem(TemplateImportProblems.NotFound(context));
        }
        return await WorkerExecutionMiddleware.ExecutionStillLive(context, dispatch).ConfigureAwait(false)
            ? TypedResults.Ok(new CompleteTemplateImportFileVersionsResponse(importId, request.TransferIds))
            : TypedResults.Problem(TemplateImportProblems.ExecutionLost(context));
    }

    private static async Task<IResult> CompleteExecution(
        Guid importId,
        CompleteTemplateImportRequest request,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IWorkerDispatchStore dispatch,
        [FromServices] NixDispatcher dispatcher,
        [FromServices] S3CapabilitySigner signer)
    {
        if (request.WrittenTargetItemIds is null
            || request.WrittenTargetItemIds.Count > TemplateImportRules.MaximumItems
            || request.WrittenTargetItemIds.Distinct().Count() != request.WrittenTargetItemIds.Count)
        {
            return TypedResults.Problem(TemplateImportProblems.NotFound(context));
        }
        var execution = await OwnedExecution(importId, context, imports, jobs, session, "template.commit").ConfigureAwait(false);
        if (execution is null
            || execution.Import.Status is not (DocumentImportStatuses.Staging
                or DocumentImportStatuses.Staged
                or DocumentImportStatuses.Completed))
        {
            return TypedResults.Problem(TemplateImportProblems.NotFound(context));
        }
        var managed = execution.Import.Purpose == DocumentImportPurposes.TemplateManaged;
        if (execution.Import.Status == DocumentImportStatuses.Staging && !managed)
        {
            if (execution.Import.TemplateOperationId is { } operationId)
            {
                var finalized = await dispatcher.SendAsync<FinalizeTemplateOperation, TemplateId>(
                    new FinalizeTemplateOperation(
                        TemplateOperationId.From(operationId),
                        request.WrittenTargetItemIds.Select(ItemId.From).ToArray()),
                    context.RequestAborted).ConfigureAwait(false);
                if (finalized.IsFailure)
                {
                    return TemplateImportProblems.TemplateProblem(context, finalized.Error);
                }
            }
            else if (request.WrittenTargetItemIds.Count != 0 || execution.Import.TemplateUnchanged != true)
            {
                return TypedResults.Problem(TemplateImportProblems.NotFound(context));
            }
        }
        var result = await imports.CompleteTemplateAsync(
            new CompleteTemplateImport(
                DocumentImportId.From(importId),
                request.WrittenTargetItemIds.Select(ItemId.From).ToArray(),
                managed),
            context.RequestAborted).ConfigureAwait(false);
        if (result is null)
        {
            return TypedResults.Problem(TemplateImportProblems.NotFound(context));
        }
        if (execution.Import.Status is not (DocumentImportStatuses.Staged or DocumentImportStatuses.Completed))
        {
            var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
            await ObjectCleanupJobs.QueueAsync(
                jobs,
                scoped.TenantId,
                scoped.PrincipalId,
                WorkspaceId.From(result.WorkspaceId),
                "template-import",
                importId,
                signer.GetCleanupNotBefore(),
                [execution.SourceObjectKey, execution.Import.PlanObjectKey],
                context.RequestAborted).ConfigureAwait(false);
        }
        return await WorkerExecutionMiddleware.ExecutionStillLive(context, dispatch).ConfigureAwait(false)
            ? TypedResults.Ok(TemplateImportMapping.WorkerResult(result)
                ?? throw new InvalidOperationException("A completed template import must retain its durable result."))
            : TypedResults.Problem(TemplateImportProblems.ExecutionLost(context));
    }

    private static async Task<IResult> RejectExecution(
        Guid importId,
        RejectTemplateImportRequest request,
        HttpContext context,
        [FromServices] IDocumentImportStore imports,
        [FromServices] IWorkerJobStore jobs,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] IWorkerDispatchStore dispatch,
        [FromServices] NixDispatcher dispatcher,
        [FromServices] S3CapabilitySigner signer)
    {
        var execution = await OwnedExecution(
            importId,
            context,
            imports,
            jobs,
            session,
            expectedKind: null).ConfigureAwait(false);
        if (execution is null || !TemplateImportRules.ValidFailureCode(request.Code))
        {
            return TypedResults.Problem(TemplateImportProblems.NotFound(context));
        }
        if (execution.Import.TemplateOperationId is { } operationId)
        {
            var aborted = await dispatcher.SendAsync<AbortTemplateOperation, bool>(
                new AbortTemplateOperation(TemplateOperationId.From(operationId)),
                context.RequestAborted).ConfigureAwait(false);
            if (aborted.IsFailure)
            {
                return TemplateImportProblems.TemplateProblem(context, aborted.Error);
            }
        }
        var cleanup = await imports.FailAsync(
            DocumentImportId.From(importId),
            request.Code,
            context.RequestAborted).ConfigureAwait(false);
        if (cleanup is null)
        {
            return TypedResults.Problem(TemplateImportProblems.NotFound(context));
        }
        var scoped = session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        await TemplateImportCleanup.QueueAsync(cleanup, importId, context, jobs, scoped, signer.GetCleanupNotBefore()).ConfigureAwait(false);
        return await WorkerExecutionMiddleware.ExecutionStillLive(context, dispatch).ConfigureAwait(false)
            ? TypedResults.NoContent()
            : TypedResults.Problem(TemplateImportProblems.ExecutionLost(context));
    }

    private static async Task<DocumentImportExecutionRecord?> OwnedExecution(
        Guid importId,
        HttpContext context,
        IDocumentImportStore imports,
        IWorkerJobStore jobs,
        INixSessionContextAccessor session,
        string? expectedKind)
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
        if (job is null
            || job.Status != "running"
            || (expectedKind is null
                ? job.Kind is not ("template.preview" or "template.commit")
                : job.Kind != expectedKind))
        {
            return null;
        }
        TemplateImportJobPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize(
                job.Payload,
                TemplateImportsJsonContext.Default.TemplateImportJobPayload);
        }
        catch (JsonException)
        {
            return null;
        }
        var execution = payload?.ImportId == importId
            ? await imports.GetExecutionAsync(DocumentImportId.From(importId), context.RequestAborted).ConfigureAwait(false)
            : null;
        if (execution is null
            || !DocumentImportPurposes.IsTemplate(execution.Import.Purpose)
            || (job.Kind == "template.commit"
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
