using System.Text.Json;
using Nix.Abstractions;
using Nix.Abstractions.Importing;
using Nix.Abstractions.Workers;
using Nix.Domain.Identity;
using Nix.Domain.Importing;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Features.DocumentImports;
using Nix.Features.TemplateImports;
using Nix.Features.Templates;
using Nix.Messaging;
using Nix.Persistence.ObjectStorage;

namespace Nix.Workers;

/// <summary>
/// What the startup sweep does for an <c>import.commit</c> or <c>template.commit</c> it found
/// interrupted: the same work the worker's <c>/reject</c> route does, run in the job's own tenant
/// scope because the job's lease is gone. The staged tree is hard-deleted, a template operation is
/// aborted, and the staged objects are queued for cleanup after the safety delay. Imports are
/// all-or-nothing: nothing of an interrupted commit remains, and a retry creates one tree.
/// </summary>
public sealed class InterruptedImportCleanup(IIsolatedUnitOfWork isolated) : IInterruptedJobCleanup
{
    public IReadOnlyList<string> Kinds { get; } = ["import.commit", "template.commit"];

    public async Task CleanUpAsync(DispatchedWorkerJob job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        if (job.ActorId is not { } actor || job.WorkspaceId is not { } workspace)
        {
            return;
        }
        Guid importId;
        try
        {
            importId = job.Kind == "template.commit"
                ? JsonSerializer.Deserialize(job.Payload, TemplateImportsJsonContext.Default.TemplateImportJobPayload)?.ImportId ?? Guid.Empty
                : JsonSerializer.Deserialize(job.Payload, DocumentImportsJsonContext.Default.DocumentImportJobPayload)?.ImportId ?? Guid.Empty;
        }
        catch (JsonException)
        {
            return;
        }
        if (importId == Guid.Empty)
        {
            return;
        }
        var ownerKind = job.Kind == "template.commit" ? "template-import" : "document-import";
        var session = new NixSessionContext(new TenantId(job.TenantId), new WorkspaceId(workspace), new PrincipalId(actor));
        await isolated.RunAsync(session, async (services, token) =>
        {
            var imports = services.GetRequiredService<IDocumentImportStore>();
            var cleanup = await imports.FailAsync(DocumentImportId.From(importId), InterruptedJobSweep.ErrorCode, token).ConfigureAwait(false);
            if (cleanup is null)
            {
                return new IsolatedOutcome<bool>(false, Commit: true);
            }
            if (cleanup.TemplateOperationId is { } operationId)
            {
                await services.GetRequiredService<NixDispatcher>().SendAsync<AbortTemplateOperation, bool>(new AbortTemplateOperation(TemplateOperationId.From(operationId)), token).ConfigureAwait(false);
            }
            await ObjectCleanupJobs.QueueBatchedAsync(
                services.GetRequiredService<IWorkerJobStore>(),
                session.TenantId,
                session.PrincipalId,
                WorkspaceId.From(cleanup.WorkspaceId),
                ownerKind,
                importId,
                services.GetRequiredService<S3CapabilitySigner>().GetCleanupNotBefore(),
                cleanup.ObjectKeys,
                token).ConfigureAwait(false);
            return new IsolatedOutcome<bool>(true, Commit: true);
        }, cancellationToken).ConfigureAwait(false);
    }
}
