using System.Diagnostics.CodeAnalysis;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Nix.Abstractions;
using Nix.Abstractions.PetRuns;
using Nix.Abstractions.Templates;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Features.Pets;
using Nix.Messaging;

namespace Nix.Features.PetRuns;

internal sealed record PetPlanIssueRequest(Guid TenantId, Guid PrincipalId, Guid WorkspaceId,
    PetPlanExecutionBinding Binding, int ChildId, string Destination, string Method, string Target,
    string? Body, IReadOnlyDictionary<string, string> Headers, string Executor);
internal sealed record PetPlanIssuedRequest(string Kind, Guid RequestId,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Token,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyDictionary<string, string>? Headers = null);
internal sealed record PetPlanPollRequest(Guid TenantId, Guid PrincipalId, Guid WorkspaceId, PetPlanExecutionBinding Binding);
internal sealed record PetPlanClientIoIntent(Guid RequestId, int ChildId, string Destination, string Method,
    string Target, string? Body, IReadOnlyDictionary<string, string> Headers, string DispatchPermit);
internal sealed record PetPlanClientIoResult(Guid RequestId, int Status, IReadOnlyDictionary<string, string> Headers, string Body);
internal sealed record PetPlanIoResult(bool Ready,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? Status = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyDictionary<string, string>? Headers = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Body = null);
internal sealed record PetPlanAllowedResponse(bool Allowed);
internal sealed record PetPlanRecordedResponse(bool Recorded);
internal sealed record PetPlanConsumeRequest(string Token, Guid RequestId, string Method, string Target,
    string? Body, IReadOnlyDictionary<string, string> Headers, string? DispatchPermit = null);
internal sealed record PetPlanRuntimeResult(Guid TenantId, Guid PrincipalId, Guid WorkspaceId,
    PetPlanExecutionBinding Binding, bool Success, string Receipt, bool LockedContent, bool Unknown, string? Status = null);
internal sealed record PetPlanSettleRequest(string Token, Guid RequestId, int Status, IReadOnlyDictionary<string, string> Headers, string Body,
    string? DispatchPermit = null);

[SuppressMessage("Performance", "CA1812", Justification = "Created by scoped dependency injection.")]
internal sealed partial class PetPlanDispatchService(IPetRunStore runs, IIsolatedUnitOfWork isolated,
    INixSessionContextAccessor session, SelfIssuedTokenService tokens, IWorkerDispatchStore dispatch,
    IWorkerExecutionFence fence, IPermissionResolver permissions, IWorkspaceLocks workspaceLocks,
    IItemLocks itemLocks, IItemTree items, IEnumerable<IPetRunCapability> capabilities, IIdentityDirectory identities,
    ITemplateCatalogStore templates, NixDispatcher dispatcher, PetPlanSourceGuard sourceGuard, TimeProvider clock)
{
    private NixSessionContext Caller => session.Current ?? throw new InvalidOperationException("A plan dispatch requires an actor scope.");

    internal Task<Result<PetPlanIssuedRequest>> IssueDetachedAsync(PetPlanIssueRequest request, CancellationToken cancellationToken) =>
        isolated.RunAsync(new(TenantId.From(request.TenantId), WorkspaceId.From(request.WorkspaceId), PrincipalId.From(request.PrincipalId)),
            async (services, ct) =>
            {
                var result = await services.GetRequiredService<PetPlanDispatchService>().IssueAsync(request, ct).ConfigureAwait(false);
                return new IsolatedOutcome<Result<PetPlanIssuedRequest>>(result, result.IsSuccess
                    || result.IsFailure && result.Error.Code == "pet_plans.source_changed");
            }, cancellationToken);

    internal async Task<Result<PetPlanIssuedRequest>> IssueAsync(PetPlanIssueRequest request, CancellationToken cancellationToken)
    {
        if (request.Binding is null || request.Headers is null || request.ChildId is < 1 or > 80 || request.Destination is not ("core" or "collab")
            || request.Executor is not ("server" or "client") || request.Method is not ("GET" or "POST" or "PUT" or "PATCH" or "DELETE")
            || !ValidTarget(request.Target) || Encoding.UTF8.GetByteCount(request.Body ?? "") > PetActionRequestBinding.MaximumBodyBytes
            || request.Headers.Count > 12 || request.Headers.Any(header => !AllowedHeader(header.Key) || header.Value is null || header.Value.Length > 4096))
        {
            return Refused<PetPlanIssuedRequest>();
        }
        var current = await FindAsync(request.Binding, cancellationToken).ConfigureAwait(false);
        if (current is null || current.Value.Plan.Status != "approved" || current.Value.Step.Executor != request.Executor
            || current.Value.Step.Status is not ("claimed" or "applying" or "undo_claimed" or "undo_applying")
            || request.TenantId != Caller.TenantId.Value || request.PrincipalId != Caller.PrincipalId.Value
            || request.WorkspaceId != current.Value.Run.WorkspaceId.Value
            || !await AvailableAsync(current.Value.Run, current.Value.Step, cancellationToken).ConfigureAwait(false))
        {
            return Refused<PetPlanIssuedRequest>();
        }
        var (run, state, plan, step) = current.Value;
        if (state.PlanRequest?.SourceReadOnly == true
            && capabilities.Single(value => value.Name == step.Capability).RequiresApproval(step.Effect))
        {
            return Refused<PetPlanIssuedRequest>();
        }
        if (step.Status is not ("undo_claimed" or "undo_applying"))
        {
            var source = await sourceGuard.CheckAsync(run, state, cancellationToken).ConfigureAwait(false);
            if (!source.Available || source.ProtectedRead && !plan.ProtectedRead)
            {
                var held = Replace(state, step with { Status = "stale" });
                held = held with
                {
                    ActiveJobId = null,
                    Plan = held.Plan! with { Status = "review_required" },
                    PlanRequest = held.PlanRequest! with { ProtectedRead = held.PlanRequest.ProtectedRead || source.ProtectedRead },
                    Failure = new("scope", "pet_plans.source_changed", "The source conversation or its protected scope changed. Review a fresh plan.")
                };
                await SaveAsync(run with { Status = "review_required" }, held, cancellationToken).ConfigureAwait(false);
                return Result.Failure<PetPlanIssuedRequest>(new NixError("pet_plans.source_changed", "Review a fresh plan for the current protected source scope."));
            }
        }
        var children = step.Execution!.Children ?? [];
        var revisions = step.Execution.ExpectedRevisions ?? ExpectedRevisions(step);
        var binding = PetActionRequestBinding.Create(request.Method, request.Target, request.Body, revisions);
        var existing = children.SingleOrDefault(child => child.ChildId == request.ChildId);
        if (existing is not null)
        {
            return existing.Binding == binding && existing.Destination == request.Destination && existing.Status == "issued"
                ? Result.Success(Issued(run, step, existing)) : Refused<PetPlanIssuedRequest>();
        }
        if (request.ChildId != children.Count + 1 || children.Any(child => child.Status == "issued"))
        {
            return Refused<PetPlanIssuedRequest>();
        }
        var headers = new Dictionary<string, string>(request.Headers, StringComparer.OrdinalIgnoreCase);
        if (revisions.Length > 0)
        {
            headers[PetActionRequestBinding.RevisionsHeader] = revisions;
        }
        var probe = new DefaultHttpContext().Request;
        probe.Method = request.Method;
        probe.Path = request.Target.Split('?')[0];
        if (request.Destination == "core" && (PetTurnPolicy.IsHumanOnly(probe)
            || AccessTokenScopePolicy.Classify(probe.Method, probe.Path) is AccessTokenScopePolicy.Requirement.InteractiveOnly))
        {
            if (!await AllowsMemoryAsync(state, step, request.Executor, request.Method, request.Target, request.Body, cancellationToken).ConfigureAwait(false))
            {
                return Refused<PetPlanIssuedRequest>();
            }
        }
        var permit = new PetPlanChildPermit(request.ChildId, Guid.NewGuid(), request.Destination, request.Method,
            request.Target, request.Body, revisions, binding, "issued", Headers: headers);
        var updated = step with { Execution = step.Execution with { Children = [.. children, permit], ExpectedRevisions = revisions } };
        if (!await SaveAsync(run, Replace(state, updated), cancellationToken).ConfigureAwait(false))
        {
            return Refused<PetPlanIssuedRequest>();
        }
        return Result.Success(Issued(run, updated, permit));
    }

    internal async Task<bool> ConsumeAsync(HttpContext http, ValidatedPetTurnToken? token, CancellationToken cancellationToken)
    {
        var text = token?.PlanRequest ?? http.Request.Headers["X-Nix-Pet-Plan-Request"].ToString();
        if (!PetActionRequestBinding.TryReadPlanRequest(text, out var runId, out var requestId))
        {
            return false;
        }
        var run = await runs.GetAsync(runId, cancellationToken).ConfigureAwait(false);
        if (run is null || run.TenantId != Caller.TenantId || run.ActorId != Caller.PrincipalId)
        {
            return false;
        }
        var state = State(run);
        var step = state.Plan?.Steps.SingleOrDefault(candidate => candidate.Execution?.Children?.Any(child => child.RequestId == requestId) == true);
        var permit = step?.Execution?.Children?.SingleOrDefault(child => child.RequestId == requestId);
        if (state.Plan is not { Status: "approved" } || step is null || permit is not { Status: "issued" }
            || token is not null && (token.RequestId != requestId || token.ActionBinding != permit.Binding)
            || token is null && step.Executor != "client"
            || !await AvailableAsync(run, step, cancellationToken).ConfigureAwait(false)
            || !await PetActionRequestBinding.MatchesAsync(http.Request, permit.Binding, cancellationToken).ConfigureAwait(false)
            || permit.Headers?.Any(header => !string.Equals(http.Request.Headers[header.Key].ToString(), header.Value, StringComparison.Ordinal)) == true
            || !await PetActionRequestBinding.RevisionsMatchAsync(http, cancellationToken).ConfigureAwait(false))
        {
            return false;
        }
        if (permit.Target == "/api/v1/me/pets/settings" && !await AllowsMemoryAsync(state, step, step.Executor,
            permit.Method, permit.Target, permit.Body, cancellationToken).ConfigureAwait(false))
        {
            return false;
        }
        if (step.Status is not ("undo_claimed" or "undo_applying"))
        {
            var source = await sourceGuard.CheckAsync(run, state, cancellationToken).ConfigureAwait(false);
            if (!source.Available || source.ProtectedRead && !state.Plan.ProtectedRead)
            {
                return false;
            }
        }
        var spent = permit with { Status = "dispatched" };
        var execution = step.Execution! with
        {
            DispatchedAt = step.Execution.DispatchedAt ?? clock.GetUtcNow(),
            Children = [.. step.Execution.Children!.Select(child => child.RequestId == requestId ? spent : child)]
        };
        return await SaveAsync(run, Replace(state, step with { Status = step.Status is "undo_claimed" or "undo_applying" ? "undo_applying" : "applying", Execution = execution }), cancellationToken)
            .ConfigureAwait(false);
    }

    internal async Task CompleteCoreAsync(HttpContext http, ValidatedPetTurnToken? token, CancellationToken cancellationToken)
    {
        var text = token?.PlanRequest ?? http.Request.Headers["X-Nix-Pet-Plan-Request"].ToString();
        if (!PetActionRequestBinding.TryReadPlanRequest(text, out var runId, out var requestId))
        {
            return;
        }
        var run = await runs.GetAsync(runId, cancellationToken).ConfigureAwait(false);
        if (run is null)
        {
            return;
        }
        var state = State(run);
        var step = state.Plan?.Steps.SingleOrDefault(candidate => candidate.Execution?.Children?.Any(child => child.RequestId == requestId) == true);
        if (step?.Execution is not { } execution)
        {
            return;
        }
        var permit = execution.Children!.Single(child => child.RequestId == requestId);
        var revisions = await AdvanceRevisionsAsync(permit.Revisions, cancellationToken).ConfigureAwait(false);
        if (!http.Response.Body.CanSeek || http.Response.Body.Length > 64_000)
        {
            throw new InvalidOperationException("The plan I/O response exceeds its durable limit.");
        }
        var position = http.Response.Body.Position;
        http.Response.Body.Position = 0;
        using var reader = new StreamReader(http.Response.Body, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, leaveOpen: true);
        var responseBody = await reader.ReadToEndAsync(cancellationToken).ConfigureAwait(false);
        http.Response.Body.Position = position;
        var responseHeaders = http.Response.Headers.Where(header => header.Key.Equals("Content-Type", StringComparison.OrdinalIgnoreCase)
            || header.Key.Equals("ETag", StringComparison.OrdinalIgnoreCase)).ToDictionary(header => header.Key, header => header.Value.ToString(), StringComparer.OrdinalIgnoreCase);
        var next = execution with
        {
            ExpectedRevisions = revisions,
            Children = [.. execution.Children!.Select(child =>
            child.RequestId == requestId ? child with { Status = "completed", ResponseStatus = http.Response.StatusCode,
                ResponseBody = responseBody, ResponseHeaders = responseHeaders } : child)]
        };
        if (!await SaveAsync(run, Replace(state, step with { Execution = next }), cancellationToken).ConfigureAwait(false))
        {
            throw new InvalidOperationException("The exact plan request result could not be recorded.");
        }
    }

    internal async Task<Result<PetPlanClientIoIntent?>> NextClientIntentAsync(Guid runId, CancellationToken cancellationToken)
    {
        var run = await runs.GetAsync(runId, cancellationToken).ConfigureAwait(false);
        if (run is null || run.ActorId != Caller.PrincipalId || run.TenantId != Caller.TenantId)
        {
            return Refused<PetPlanClientIoIntent?>();
        }
        var state = State(run);
        if (state.Plan is not { Status: "approved" })
        {
            return Result.Success<PetPlanClientIoIntent?>(null);
        }
        var step = state.Plan.Steps.SingleOrDefault(candidate => candidate.Executor == "client" && candidate.Status is "claimed" or "applying");
        var child = step?.Execution?.Children?.FirstOrDefault(candidate => candidate.Status == "issued");
        return child is null ? Result.Success<PetPlanClientIoIntent?>(null) : Result.Success<PetPlanClientIoIntent?>(new(child.RequestId,
            child.ChildId, child.Destination, child.Method, child.Target, child.Body,
            child.Headers ?? new Dictionary<string, string>(), Permit(run.Id, child.RequestId)));
    }

    internal async Task<Result<bool>> RecordClientResultAsync(Guid runId, PetPlanClientIoResult result, CancellationToken cancellationToken)
    {
        var run = await runs.GetAsync(runId, cancellationToken).ConfigureAwait(false);
        if (run is null || result.Status is < 100 or > 599 || Encoding.UTF8.GetByteCount(result.Body) > 64_000
            || result.Headers.Count > 12 || result.Headers.Any(header => header.Key.Length > 100 || header.Value.Length > 4096))
        {
            return Refused<bool>();
        }
        var state = State(run);
        var step = state.Plan?.Steps.SingleOrDefault(candidate => candidate.Executor == "client"
            && candidate.Execution?.Children?.Any(child => child.RequestId == result.RequestId) == true);
        var child = step?.Execution?.Children?.SingleOrDefault(candidate => candidate.RequestId == result.RequestId);
        if (step is null || child is null || child.Status is not ("dispatched" or "completed"))
        {
            return Refused<bool>();
        }
        if (child.ResponseBody is not null)
        {
            return child.ResponseStatus == result.Status && child.ResponseBody == result.Body ? Result.Success(true) : Refused<bool>();
        }
        return Refused<bool>();
    }

    internal async Task<Result<PetPlanIoResult>> PollResultAsync(Guid requestId, PetPlanPollRequest request, CancellationToken cancellationToken)
    {
        var found = await FindAsync(request.Binding, cancellationToken).ConfigureAwait(false);
        if (found is null || request.TenantId != Caller.TenantId.Value || request.PrincipalId != Caller.PrincipalId.Value
            || request.WorkspaceId != found.Value.Run.WorkspaceId.Value)
        {
            return Refused<PetPlanIoResult>();
        }
        var child = found.Value.Step.Execution?.Children?.SingleOrDefault(candidate => candidate.RequestId == requestId);
        return child is { ResponseStatus: { } status, ResponseBody: { } body }
            ? Result.Success(new PetPlanIoResult(true, status, child.ResponseHeaders ?? new Dictionary<string, string>(), body))
            : found.Value.Plan.Status == "approved" ? Result.Success(new PetPlanIoResult(false)) : Refused<PetPlanIoResult>();
    }

    internal async Task<bool> AuthorizeReadAsync(HttpContext http, string runText, CancellationToken cancellationToken)
    {
        if (!Guid.TryParseExact(runText, "N", out var runId)
            || AccessTokenScopePolicy.Classify(http.Request.Method, http.Request.Path) != AccessTokenScopePolicy.Requirement.Read
                && !PetTurnPolicy.IsPlanReadPreflight(http.Request))
        {
            return false;
        }
        var run = await runs.GetAsync(runId, cancellationToken).ConfigureAwait(false);
        if (run is null || !await permissions.CanReadWorkspaceAsync(run.WorkspaceId, cancellationToken).ConfigureAwait(false)
            || (await workspaceLocks.GetStateAsync(run.WorkspaceId, cancellationToken).ConfigureAwait(false)).PasswordProtected)
        {
            return false;
        }
        var path = http.Request.Path.Value ?? "";
        var readState = State(run);
        var workspaceScope = readState.PlanRequest is null ? run.WorkspaceScope
            : readState.PlanRequest.SourceScope.Kind == "workspace" && readState.PlanRequest.ChatSource?.RootItemId is null;
        var sourceIds = readState.PlanRequest?.SourceScope.ItemIds ?? run.SourceItemIds;
        var readOnlyWorkspaces = readState.PlanRequest?.SourceScope.ReadOnlyWorkspaceIds ?? [];
        if (http.Request.RouteValues.GetValueOrDefault("templateId")?.ToString() is { } rawTemplate && Guid.TryParse(rawTemplate, out var templateId))
        {
            var template = await templates.DetailAsync(TemplateId.From(templateId), cancellationToken).ConfigureAwait(false);
            return template.IsSuccess && (workspaceScope && template.Value.Template.WorkspaceId == run.WorkspaceId
                || readOnlyWorkspaces.Contains(template.Value.Template.WorkspaceId.Value));
        }
        var raw = http.Request.RouteValues.GetValueOrDefault("itemId")?.ToString();
        if (raw is null && path.StartsWith("/internal/authz/items/", StringComparison.Ordinal))
        {
            raw = path["/internal/authz/items/".Length..].Split('/')[0];
        }
        if (raw is not null && Guid.TryParse(raw, out var id))
        {
            var item = await items.FindAsync(ItemId.From(id), cancellationToken).ConfigureAwait(false);
            var state = State(run);
            var root = state.PlanRequest?.ChatSource?.RootItemId ?? (state.PlanRequest?.SourceScope.Kind == "subtree" ? run.ItemId?.Value : null);
            var inSubtree = root is { } rootId && await items.IsVisibleSubtreeMemberAsync(run.WorkspaceId, ItemId.From(rootId), ItemId.From(id), cancellationToken).ConfigureAwait(false);
            return item is not null && !ItemSettings.Read(item.Settings).WithholdFromPets
                && (item.WorkspaceId == run.WorkspaceId && (workspaceScope || run.ItemId?.Value == id || sourceIds.Contains(id) || inSubtree)
                    || readOnlyWorkspaces.Contains(item.WorkspaceId.Value))
                && await permissions.CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false)
                && !(await workspaceLocks.GetStateAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false)).PasswordProtected
                && !(await itemLocks.GetStateAsync(item.Id, cancellationToken).ConfigureAwait(false)).Locked;
        }
        if (http.Request.RouteValues.GetValueOrDefault("workspaceId")?.ToString() is { } rawWorkspace && Guid.TryParse(rawWorkspace, out var workspace))
        {
            var targetWorkspace = WorkspaceId.From(workspace);
            return (workspaceScope && targetWorkspace == run.WorkspaceId || readOnlyWorkspaces.Contains(workspace))
                && await permissions.CanReadWorkspaceAsync(targetWorkspace, cancellationToken).ConfigureAwait(false)
                && !(await workspaceLocks.GetStateAsync(targetWorkspace, cancellationToken).ConfigureAwait(false)).PasswordProtected;
        }
        return workspaceScope && path == "/api/v1/actions";
    }

    internal async Task<bool> AuthorizeConsumedCollabAsync(HttpContext http, ValidatedPetTurnToken token, CancellationToken cancellationToken)
    {
        if (token.PlanRequest is not { } context || !PetActionRequestBinding.TryReadPlanRequest(context, out var runId, out var requestId)
            || !http.Request.Path.StartsWithSegments("/internal/authz/items", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }
        var rawId = (http.Request.Path.Value ?? "")["/internal/authz/items/".Length..].Split('/')[0];
        if (!Guid.TryParse(rawId, out var itemId))
        {
            return false;
        }
        var run = await runs.GetAsync(runId, cancellationToken).ConfigureAwait(false);
        var child = run is null ? null : State(run).Plan?.Steps.SelectMany(step => step.Execution?.Children ?? [])
            .SingleOrDefault(candidate => candidate.RequestId == requestId);
        var item = await items.FindAsync(ItemId.From(itemId), cancellationToken).ConfigureAwait(false);
        return child is { Destination: "collab", Status: "dispatched" or "completed" }
            && child.Target.Split('?', 2)[0].Split('/').Contains(itemId.ToString("D"), StringComparer.OrdinalIgnoreCase)
            && item is not null && item.WorkspaceId == run!.WorkspaceId && !ItemSettings.Read(item.Settings).WithholdFromPets
            && await permissions.CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false)
            && !(await itemLocks.GetStateAsync(item.Id, cancellationToken).ConfigureAwait(false)).Locked;
    }

    private async Task<(PetRunRecord Run, PetRunCheckpoint State, PetPlanPrepared Plan, PetPlanPreparedStep Step)?> FindAsync(
        PetPlanExecutionBinding binding, CancellationToken cancellationToken)
    {
        var run = await runs.GetAsync(binding.RunId, cancellationToken).ConfigureAwait(false);
        if (run is null || run.ActorId != Caller.PrincipalId || run.TenantId != Caller.TenantId)
        {
            return null;
        }
        var state = State(run);
        var step = state.Plan?.Steps.SingleOrDefault(candidate => candidate.Id == binding.StepId);
        var capability = step is null ? null : capabilities.SingleOrDefault(candidate => candidate.Name == step.Capability);
        var hash = step is null ? "" : capability is IPetPlanCapability adapter
            ? adapter.FrozenArgumentsHash(step.Effect, step.Arguments) : PetPlanExecution.Hash(step.Arguments);
        return state.Plan is { } plan && PetPlanExecution.Matches(plan, binding.PlanId, binding.PlanVersion, binding.ReviewDigest)
            && step?.Execution is { } execution && execution.ClaimId == binding.ClaimId && execution.ExecutionId == binding.ExecutionId
            && execution.JobId == binding.JobId && execution.WorkerExecutionId == binding.WorkerExecutionId
            && hash.Equals(binding.FrozenArgumentsHash, StringComparison.OrdinalIgnoreCase) ? (run, state, plan, step) : null;
    }

    private async Task<bool> AvailableAsync(PetRunRecord run, PetPlanPreparedStep step, CancellationToken cancellationToken)
    {
        if ((await identities.FindPrincipalByIdAsync(run.TenantId, run.ActorId, cancellationToken).ConfigureAwait(false))?.Status != PrincipalStatus.Active
            || !await permissions.CanReadWorkspaceAsync(run.WorkspaceId, cancellationToken).ConfigureAwait(false)
            || (await workspaceLocks.GetStateAsync(run.WorkspaceId, cancellationToken).ConfigureAwait(false)).PasswordProtected)
        {
            return false;
        }
        if (step.Execution is { JobId: { } job, WorkerExecutionId: { } lease })
        {
            var authority = await dispatch.AuthorizeExecutionAsync(job, lease, cancellationToken).ConfigureAwait(false);
            if (authority is null || !await fence.HoldAsync(job, lease, authority, cancellationToken).ConfigureAwait(false))
            {
                return false;
            }
        }
        return await SourcesAvailableAsync(run, State(run), cancellationToken).ConfigureAwait(false);
    }

    internal async Task<bool> SourcesAvailableAsync(PetRunRecord run, PetRunCheckpoint state, CancellationToken cancellationToken)
    {
        var scope = state.PlanRequest?.SourceScope;
        var sourceIds = (scope?.ItemIds ?? run.SourceItemIds).Concat(state.PlanRequest?.DisclosureSourceItemIds ?? [])
            .Concat(state.Proposals.SelectMany(proposal => proposal.SourceItemIds ?? []))
            .Concat(run.ItemId is { } anchor ? [anchor.Value] : Array.Empty<Guid>()).Distinct().Take(129).ToArray();
        if (sourceIds.Length > 128)
        {
            return false;
        }
        foreach (var id in sourceIds)
        {
            var item = await items.FindAsync(ItemId.From(id), cancellationToken).ConfigureAwait(false);
            if (item is null || item.WorkspaceId != run.WorkspaceId && scope?.ReadOnlyWorkspaceIds?.Contains(item.WorkspaceId.Value) != true
                || ItemSettings.Read(item.Settings).WithholdFromPets
                || !await permissions.CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false)
                || (await workspaceLocks.GetStateAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false)).PasswordProtected
                || (await itemLocks.GetStateAsync(item.Id, cancellationToken).ConfigureAwait(false)).Locked)
            {
                return false;
            }
            if (item.WorkspaceId == run.WorkspaceId && scope is not null
                && (scope.Kind == "selected" && scope.ItemIds?.Contains(id) != true
                    || scope.Kind == "subtree" && !await items.IsVisibleSubtreeMemberAsync(item.WorkspaceId,
                        ItemId.From(scope.ItemIds![0]), item.Id, cancellationToken).ConfigureAwait(false)))
            {
                return false;
            }
        }
        if (state.PlanRequest?.UnboundedDisclosure == true || state.Proposals.Any(proposal => proposal.UnboundedSourceProvenance))
        {
            if (scope?.Kind != "workspace")
            {
                return false;
            }
            foreach (var raw in new[] { run.WorkspaceId.Value }.Concat(scope.ReadOnlyWorkspaceIds ?? []).Distinct())
            {
                var workspace = WorkspaceId.From(raw);
                if (!await permissions.CanReadWorkspaceAsync(workspace, cancellationToken).ConfigureAwait(false)
                    || (await workspaceLocks.GetStateAsync(workspace, cancellationToken).ConfigureAwait(false)).PasswordProtected
                    || await items.AnyItemsWithheldFromPetsAsync(workspace, cancellationToken).ConfigureAwait(false)
                    || await itemLocks.AnyInWorkspaceAsync(workspace, cancellationToken).ConfigureAwait(false))
                {
                    return false;
                }
            }
        }
        return true;
    }

    internal async Task<bool> SettleAsync(ValidatedPetTurnToken? token, PetPlanSettleRequest result, CancellationToken cancellationToken)
    {
        var context = token?.PlanRequest ?? result.DispatchPermit;
        if (context is null || !PetActionRequestBinding.TryReadPlanRequest(context, out var runId, out var requestId)
            || requestId != result.RequestId || result.Status is < 100 or > 599 || Encoding.UTF8.GetByteCount(result.Body) > 64_000
            || result.Headers.Count > 12 || result.Headers.Any(header => header.Key.Length > 100 || header.Value.Length > 4096))
        {
            return false;
        }
        var run = await runs.GetAsync(runId, cancellationToken).ConfigureAwait(false);
        if (run is null)
        {
            return false;
        }
        var state = State(run);
        var step = state.Plan?.Steps.SingleOrDefault(candidate => candidate.Execution?.Children?.Any(child => child.RequestId == requestId) == true);
        var permit = step?.Execution?.Children?.SingleOrDefault(child => child.RequestId == requestId);
        if (step is null || permit is not { Destination: "collab", Status: "dispatched" or "completed" }
            || token is not null && permit.Binding != token.ActionBinding || token is null && step.Executor != "client")
        {
            return false;
        }
        if (permit.ResponseBody is not null)
        {
            return permit.ResponseBody == result.Body && permit.ResponseStatus == result.Status;
        }
        var response = permit with { Status = "completed", ResponseStatus = result.Status, ResponseHeaders = result.Headers, ResponseBody = result.Body };
        return await SaveAsync(run, Replace(state, step with
        {
            Execution = step.Execution! with
            {
                Children = [.. step.Execution.Children!
            .Select(child => child.RequestId == requestId ? response : child)]
            }
        }), cancellationToken).ConfigureAwait(false);
    }

    private async Task<bool> AllowsMemoryAsync(PetRunCheckpoint state, PetPlanPreparedStep step, string executor,
        string method, string target, string? body, CancellationToken cancellationToken)
    {
        if (executor != "client" || step.Capability != "workspace.remember" || target != "/api/v1/me/pets/settings"
            || method is not ("GET" or "PUT") || state.PlanRequest?.ProtectedRead != false)
        {
            return false;
        }
        var stored = await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), cancellationToken).ConfigureAwait(false);
        if (stored.Settings.MemoryMode == PetMemoryModes.Off)
        {
            return false;
        }
        if (method == "GET")
        {
            return body is null;
        }
        try
        {
            var submitted = body is null ? null : JsonSerializer.Deserialize(body, PetJsonContext.Default.SavePetSettingsRequest);
            if (submitted is null || submitted.ExpectedRevision != stored.Revision || !PetSettingsValidation.IsValid(submitted.Settings)
                || !step.Arguments.TryGetProperty("markdown", out var markdown) || markdown.GetString() is not { } fact)
            {
                return false;
            }
            fact = Regex.Replace(fact.Trim(), @"\s+", " ", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
            var existing = stored.Settings.Memories ?? [];
            var proposed = submitted.Settings.Memories ?? [];
            if (proposed.Count != existing.Count + 1 || !proposed.Take(existing.Count).SequenceEqual(existing)
                || proposed[^1].Text != fact || existing.Any(memory => memory.Text.Equals(fact, StringComparison.OrdinalIgnoreCase)))
            {
                return false;
            }
            var expected = stored.Settings with { Memories = proposed };
            return JsonElement.DeepEquals(JsonSerializer.SerializeToElement(expected, PetJsonContext.Default.PetSettings),
                JsonSerializer.SerializeToElement(submitted.Settings, PetJsonContext.Default.PetSettings));
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private async Task<string> AdvanceRevisionsAsync(string revisions, CancellationToken cancellationToken)
    {
        if (revisions.Length == 0)
        {
            return "";
        }
        var split = revisions.IndexOf('|', StringComparison.Ordinal);
        var workspace = WorkspaceId.From(Guid.Parse(revisions[..split]));
        var current = new List<string>();
        foreach (var revision in revisions[(split + 1)..].Split(','))
        {
            var separator = revision.IndexOf(':', StringComparison.Ordinal);
            var item = Guid.Parse(revision[..separator]);
            if (await items.ReadPetRevisionAsync(workspace, ItemId.From(item), pin: true, cancellationToken).ConfigureAwait(false) is { } sequence)
            {
                current.Add(FormattableString.Invariant($"{item:D}:{sequence}"));
            }
            else
            {
                current.Add(revision);
            }
        }
        return workspace.Value.ToString("D") + "|" + string.Join(',', current);
    }

    private string ExpectedRevisions(PetPlanPreparedStep step) => capabilities.SingleOrDefault(capability => capability.Name == step.Capability) is IPetPlanCapability adapter
        ? adapter.ExpectedRevisions(step.Effect) : step.Effect.Parameters.TryGetProperty("revisions", out var revisions) ? revisions.GetString() ?? "" : "";

    private PetPlanIssuedRequest Issued(PetRunRecord run, PetPlanPreparedStep step, PetPlanChildPermit child) => step.Executor == "client"
        ? new("client", child.RequestId, null)
        : new("server", child.RequestId, tokens.MintPetAction(run.ActorId, run.TenantId, child.RequestId,
            child.Method == "GET" ? PetTurnMode.Read : PetTurnMode.Write, child.Binding, Permit(run.Id, child.RequestId)), child.Headers);

    private async Task<bool> SaveAsync(PetRunRecord run, PetRunCheckpoint state, CancellationToken cancellationToken)
    {
        var json = JsonSerializer.SerializeToElement(state, PetRunJsonContext.Default.PetRunCheckpoint);
        return Encoding.UTF8.GetByteCount(json.GetRawText()) <= 960_000
            && await runs.UpdateAsync(run with { State = json, Revision = run.Revision + 1, UpdatedAt = clock.GetUtcNow() }, run.Revision, cancellationToken).ConfigureAwait(false);
    }
    private static PetRunCheckpoint State(PetRunRecord run) => run.State.Deserialize(PetRunJsonContext.Default.PetRunCheckpoint)!;
    private static PetRunCheckpoint Replace(PetRunCheckpoint state, PetPlanPreparedStep step) =>
        state with { Plan = state.Plan! with { Steps = [.. state.Plan.Steps.Select(candidate => candidate.Id == step.Id ? step : candidate)] } };
    private static string Permit(Guid runId, Guid requestId) => $"{runId:N}.{requestId:N}";
    private static bool ValidTarget(string target) => target.Length is > 1 and <= 8192 && target[0] == '/' && !target.StartsWith("//", StringComparison.Ordinal)
        && !target.Contains('#', StringComparison.Ordinal) && !target.Contains('\\', StringComparison.Ordinal) && !target.Any(char.IsControl)
        && !target.Contains("..", StringComparison.Ordinal);
    private static bool AllowedHeader(string name) => name.Equals("Content-Type", StringComparison.OrdinalIgnoreCase)
        || name.Equals("If-Match", StringComparison.OrdinalIgnoreCase) || name.Equals("Idempotency-Key", StringComparison.OrdinalIgnoreCase)
        || name.Equals("X-Nix-Idempotency-Key", StringComparison.OrdinalIgnoreCase) || name.Equals(PetActionRequestBinding.RevisionsHeader, StringComparison.OrdinalIgnoreCase);
    private static Result<T> Refused<T>() => Result.Failure<T>(new NixError("pet_plans.dispatch_refused", "The exact reviewed request is unavailable or has already been dispatched."));
}

[JsonSourceGenerationOptions(JsonSerializerDefaults.Web)]
[JsonSerializable(typeof(PetPlanIssueRequest))]
[JsonSerializable(typeof(PetPlanPollRequest))]
[JsonSerializable(typeof(PetPlanConsumeRequest))]
[JsonSerializable(typeof(PetPlanClientIoResult))]
[JsonSerializable(typeof(PetPlanClientIoIntent))]
[JsonSerializable(typeof(PetPlanExecutionBinding))]
[JsonSerializable(typeof(PetPlanRuntimeResult))]
[JsonSerializable(typeof(PetPlanIssuedRequest))]
[JsonSerializable(typeof(PetPlanIoResult))]
[JsonSerializable(typeof(PetPlanAllowedResponse))]
[JsonSerializable(typeof(PetPlanRecordedResponse))]
[JsonSerializable(typeof(PetPlanSettleRequest))]
internal sealed partial class PetPlanDispatchJsonContext : JsonSerializerContext;
