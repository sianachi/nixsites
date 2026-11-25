using System.Text.Json;
using System.Text.RegularExpressions;
using Nix.Abstractions.PetRuns;
using Nix.Abstractions.Templates;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Templates;

namespace Nix.Features.PetRuns;

internal sealed partial class PetPlanDispatchService
{
    private const string TemplateBegin = "/internal/templates/applications/begin";

    internal static bool IsConsumedCollabAuthorization(HttpRequest request) => HttpMethods.IsGet(request.Method)
        && Regex.IsMatch(request.Path.Value ?? "", @"^/internal/authz/items/[0-9a-fA-F-]{36}$",
            RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));

    internal static bool IsTemplateContinuation(HttpRequest request)
    {
        var path = request.Path.Value ?? "";
        return HttpMethods.IsPost(request.Method) && path == TemplateBegin
            || HttpMethods.IsGet(request.Method) && Regex.IsMatch(path,
                @"^/internal/template-operations/[0-9a-fA-F-]{36}/items/[0-9a-fA-F-]{36}/authorization$",
                RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100))
            || HttpMethods.IsPost(request.Method) && Regex.IsMatch(path,
                @"^/internal/templates/applications/[0-9a-fA-F-]{36}/finalize$",
                RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100))
            || HttpMethods.IsDelete(request.Method) && Regex.IsMatch(path,
                @"^/internal/templates/applications/[0-9a-fA-F-]{36}$",
                RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
    }

    internal async Task<bool> AuthorizeTemplateContinuationAsync(HttpContext http, ValidatedPetTurnToken token,
        CancellationToken cancellationToken)
    {
        var parent = await TemplateParentAsync(token, cancellationToken).ConfigureAwait(false);
        if (parent is null || http.Request.QueryString.HasValue || !IsTemplateContinuation(http.Request))
        {
            return false;
        }
        var (run, state, step, child) = parent.Value;
        if (!await permissions.CanWriteWorkspaceAsync(run.WorkspaceId, cancellationToken).ConfigureAwait(false)
            || (await identities.FindPrincipalByIdAsync(run.TenantId, run.ActorId, cancellationToken).ConfigureAwait(false))?.Status != PrincipalStatus.Active
            || (await workspaceLocks.GetStateAsync(run.WorkspaceId, cancellationToken).ConfigureAwait(false)).PasswordProtected)
        {
            return false;
        }
        var path = http.Request.Path.Value!;
        if (path == TemplateBegin)
        {
            if (child.TemplateProgress is not null || child.Body is null)
            {
                return false;
            }
            if (child.Revisions.Length > 0)
            {
                var previous = http.Request.Headers[PetActionRequestBinding.RevisionsHeader];
                http.Request.Headers[PetActionRequestBinding.RevisionsHeader] = child.Revisions;
                var unchanged = await PetActionRequestBinding.RevisionsMatchAsync(http, cancellationToken).ConfigureAwait(false);
                http.Request.Headers[PetActionRequestBinding.RevisionsHeader] = previous;
                if (!unchanged)
                {
                    return false;
                }
            }
            var body = await ReadContinuationBodyAsync(http.Request, cancellationToken).ConfigureAwait(false);
            try
            {
                using var expected = JsonDocument.Parse(child.Body, new JsonDocumentOptions { MaxDepth = 24, AllowDuplicateProperties = false });
                using var actual = JsonDocument.Parse(body, new JsonDocumentOptions { MaxDepth = 24, AllowDuplicateProperties = false });
                if (!JsonElement.DeepEquals(expected.RootElement, actual.RootElement))
                {
                    return false;
                }
                using var freshness = JsonDocument.Parse(step.Effect.Parameters.GetProperty("freshnessFingerprint").GetString()!,
                    new JsonDocumentOptions { MaxDepth = 24, AllowDuplicateProperties = false });
                var preflight = freshness.RootElement.GetProperty("context").GetProperty("preflight");
                var savedRevision = preflight.TryGetProperty("expectedRevision", out var guard) && guard.ValueKind != JsonValueKind.Null
                    ? guard : preflight.GetProperty("templateRevision");
                if (!savedRevision.TryGetInt32(out var revision) || revision < 0
                    || !actual.RootElement.TryGetProperty("expectedRevision", out var submitted)
                    || !submitted.TryGetInt32(out var requestedRevision) || requestedRevision != revision)
                {
                    return false;
                }
                var template = await templates.DetailAsync(TemplateId.From(expected.RootElement.GetProperty("templateId").GetGuid()),
                    cancellationToken).ConfigureAwait(false);
                if (template.IsFailure || template.Value.Template.WorkspaceId != run.WorkspaceId)
                {
                    return false;
                }
            }
            catch (Exception error) when (error is JsonException or InvalidOperationException or KeyNotFoundException or FormatException)
            {
                return false;
            }
            return await SaveTemplateProgressAsync(run, state, step, child, new(), cancellationToken).ConfigureAwait(false);
        }
        if (child.TemplateProgress is not { OperationId: { } operationId, Finished: false } progress)
        {
            return false;
        }
        var parts = path.Split('/');
        if (HttpMethods.IsGet(http.Request.Method))
        {
            if (!Guid.TryParseExact(parts[3], "D", out var requestedOperation) || requestedOperation != operationId
                || !Guid.TryParseExact(parts[5], "D", out var itemId)
                || !(progress.SourceItemIds ?? []).Concat(progress.TargetItemIds ?? []).Contains(itemId))
            {
                return false;
            }
            var stage = await http.RequestServices.GetRequiredService<ITemplateAuthorizationStore>()
                .AuthorizeOperationItemAsync(operationId, ItemId.From(itemId), cancellationToken).ConfigureAwait(false);
            return stage.IsSuccess && stage.Value.TenantId == run.TenantId && stage.Value.PrincipalId == run.ActorId
                && stage.Value.WorkspaceId == run.WorkspaceId;
        }
        if (!Guid.TryParseExact(parts[4], "D", out var finalOperation) || finalOperation != operationId)
        {
            return false;
        }
        if (HttpMethods.IsPost(http.Request.Method))
        {
            try
            {
                var body = await ReadContinuationBodyAsync(http.Request, cancellationToken).ConfigureAwait(false);
                using var actual = JsonDocument.Parse(body, new JsonDocumentOptions { MaxDepth = 24, AllowDuplicateProperties = false });
                if (actual.RootElement.ValueKind != JsonValueKind.Object || actual.RootElement.EnumerateObject().Count() != 1
                    || !actual.RootElement.TryGetProperty("writtenTargetItemIds", out var written) || written.ValueKind != JsonValueKind.Array
                    || written.GetArrayLength() > 4096)
                {
                    return false;
                }
                var targets = new HashSet<Guid>();
                foreach (var raw in written.EnumerateArray())
                {
                    if (raw.ValueKind != JsonValueKind.String || !raw.TryGetGuid(out var target) || !targets.Add(target)
                        || progress.TargetItemIds?.Contains(target) != true)
                    {
                        return false;
                    }
                }
            }
            catch (JsonException)
            {
                return false;
            }
        }
        else if ((await ReadContinuationBodyAsync(http.Request, cancellationToken).ConfigureAwait(false)).Length != 0)
        {
            return false;
        }
        return await SaveTemplateProgressAsync(run, state, step, child, progress with { Finished = true }, cancellationToken).ConfigureAwait(false);
    }

    internal async Task CompleteTemplateContinuationAsync(HttpContext http, ValidatedPetTurnToken token,
        CancellationToken cancellationToken)
    {
        if (http.Request.Path != TemplateBegin)
        {
            return;
        }
        var parent = await TemplateParentAsync(token, cancellationToken).ConfigureAwait(false);
        if (parent is null || !http.Response.Body.CanSeek || http.Response.Body.Length > 128_000)
        {
            throw new InvalidOperationException("The template stage could not be bound to its plan request.");
        }
        var position = http.Response.Body.Position;
        http.Response.Body.Position = 0;
        using var document = await JsonDocument.ParseAsync(http.Response.Body, cancellationToken: cancellationToken).ConfigureAwait(false);
        http.Response.Body.Position = position;
        var response = document.RootElement;
        if (!response.TryGetProperty("applicationId", out var rawOperation) || !rawOperation.TryGetGuid(out var operationId)
            || operationId == Guid.Empty || !response.TryGetProperty("bodyCopies", out var copies)
            || copies.ValueKind != JsonValueKind.Array || copies.GetArrayLength() > 4096)
        {
            throw new InvalidOperationException("The template stage response is invalid.");
        }
        var sourceIds = new HashSet<Guid>();
        var targetIds = new HashSet<Guid>();
        foreach (var copy in copies.EnumerateArray())
        {
            sourceIds.Add(copy.GetProperty("sourceItemId").GetGuid());
            targetIds.Add(copy.GetProperty("targetItemId").GetGuid());
        }
        var (run, state, step, child) = parent.Value;
        var progress = new PetPlanTemplateProgress(operationId, [.. sourceIds], [.. targetIds],
            response.TryGetProperty("alreadyApplied", out var applied) && applied.ValueKind == JsonValueKind.True
                || response.TryGetProperty("fileTransferPending", out var pending) && pending.ValueKind == JsonValueKind.True);
        if (!await SaveTemplateProgressAsync(run, state, step, child, progress, cancellationToken).ConfigureAwait(false))
        {
            throw new InvalidOperationException("The template stage could not be saved with its exact plan request.");
        }
    }

    private async Task<(PetRunRecord Run, PetRunCheckpoint State, PetPlanPreparedStep Step, PetPlanChildPermit Child)?> TemplateParentAsync(
        ValidatedPetTurnToken token, CancellationToken cancellationToken)
    {
        if (token.PlanRequest is not { } context || !PetActionRequestBinding.TryReadPlanRequest(context, out var runId, out var requestId))
        {
            return null;
        }
        var run = await runs.GetAsync(runId, cancellationToken).ConfigureAwait(false);
        var state = run is null ? null : State(run);
        var step = state?.Plan?.Steps.SingleOrDefault(value => value.Execution?.Children?.Any(child => child.RequestId == requestId) == true);
        var child = step?.Execution?.Children?.Single(value => value.RequestId == requestId);
        return run is not null && step is { Capability: "workspace.apply_template", Executor: "server" }
            && child is { Destination: "collab", Status: "dispatched", Method: "POST", Target: "/templates/applications" }
            && child.Binding == token.ActionBinding && run.TenantId == token.TenantId && run.ActorId == token.PrincipalId
                ? (run, state!, step, child) : null;
    }

    private Task<bool> SaveTemplateProgressAsync(PetRunRecord run, PetRunCheckpoint state, PetPlanPreparedStep step,
        PetPlanChildPermit child, PetPlanTemplateProgress progress, CancellationToken cancellationToken) =>
        SaveAsync(run, Replace(state, step with
        {
            Execution = step.Execution! with
            {
                Children = [.. step.Execution.Children!.Select(value =>
            value.RequestId == child.RequestId ? value with { TemplateProgress = progress } : value)]
            }
        }), cancellationToken);

    private static async Task<string> ReadContinuationBodyAsync(HttpRequest request, CancellationToken cancellationToken)
    {
        if (request.ContentLength > PetActionRequestBinding.MaximumBodyBytes)
        {
            return " ";
        }
        request.EnableBuffering(bufferThreshold: PetActionRequestBinding.MaximumBodyBytes, bufferLimit: PetActionRequestBinding.MaximumBodyBytes);
        var position = request.Body.Position;
        try
        {
            using var reader = new StreamReader(request.Body, leaveOpen: true);
            return await reader.ReadToEndAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (IOException)
        {
            return " ";
        }
        finally
        {
            request.Body.Position = position;
        }
    }
}
