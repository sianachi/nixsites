using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Abstractions.PetRuns;
using Nix.Authentication;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Pets;
using Nix.Messaging;

namespace Nix.Features.PetRuns;

internal sealed partial class PetRunService :
    IQueryHandler<ListPetPlans, Result<PetPlansResponse>>,
    IQueryHandler<ReadPetPlan, Result<PetPlanResponse>>,
    ICommandHandler<StartPetPlan, PetPlanResponse>,
    ICommandHandler<RevisePetPlan, PetPlanResponse>,
    ICommandHandler<DecidePetPlan, PetPlanResponse>,
    ICommandHandler<DecidePetPlanSharing, PetPlanResponse>,
    ICommandHandler<AnswerPetPlan, PetPlanResponse>,
    ICommandHandler<CancelPetPlan, PetPlanResponse>,
    ICommandHandler<ClaimPetPlanStep, PetPlanStepClaimResponse>,
    ICommandHandler<RecordPetPlanStep, PetPlanResponse>,
    ICommandHandler<UndoPetPlanStep, PetPlanResponse>
{
    private const string PlanAdvanceKind = "pet.plan.advance";

    public async ValueTask<Result<PetPlansResponse>> HandleAsync(ListPetPlans query, CancellationToken cancellationToken)
    {
        if (!await WorkspaceAvailableAsync(query.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<PetPlansResponse>(Missing());
        }
        var visible = new List<PetPlanResponse>();
        foreach (var run in await runs.ListAsync(query.WorkspaceId, null, cancellationToken).ConfigureAwait(false))
        {
            if (Checkpoint(run).PlanRequest is not null
                && await RunScopeAvailableAsync(run, cancellationToken).ConfigureAwait(false))
            {
                visible.Add(RespondPlan(run, Checkpoint(run)));
            }
        }
        var enabled = IsEnabled(query.WorkspaceId);
        return Result.Success(new PetPlansResponse(enabled,
            enabled ? [.. _capabilities.Values.Select(capability => new PetRunAbility(capability.Name, capability.Name, capability.Description))] : [],
            visible));
    }

    public async ValueTask<Result<PetPlanResponse>> HandleAsync(ReadPetPlan query, CancellationToken cancellationToken)
    {
        var found = await FindPlanAsync(query.WorkspaceId, query.RunId, cancellationToken).ConfigureAwait(false);
        return found.IsSuccess ? Result.Success(RespondPlan(found.Value, Checkpoint(found.Value))) : Result.Failure<PetPlanResponse>(found.Error);
    }

    public async ValueTask<Result<PetPlanResponse>> HandleAsync(StartPetPlan command, CancellationToken cancellationToken)
    {
        var request = command.Request;
        if (request.RequestId == Guid.Empty || request.PetId == Guid.Empty
            || request.AnchorItemId == Guid.Empty || !ValidText(request.Brief, 4_000, 8_000)
            || request.AfterMessageId is not null && !ValidText(request.AfterMessageId, 160, 500)
            || !PetPlanExecution.ValidScope(request.SourceScope, request.AnchorItemId)
            || !PetPlanExecution.ValidChatSource(request.ChatSource))
        {
            return PlanInvalid("Choose an available workspace scope and provide a brief of at most 4000 characters.");
        }
        if (await runs.GetByRequestAsync(command.WorkspaceId, request.RequestId, cancellationToken).ConfigureAwait(false) is { } prior)
        {
            return PetPlanExecution.SameStart(prior, Checkpoint(prior), request)
                ? Result.Success(RespondPlan(prior, Checkpoint(prior))) : PlanConflict();
        }
        var scopeIds = request.SourceScope.ItemIds?.Distinct().ToArray() ?? [];
        var anchor = request.AnchorItemId is { } rawAnchor ? ItemId.From(rawAnchor) : (ItemId?)null;
        if (!await WorkspaceSourcesAvailableAsync(command.WorkspaceId,
            anchor is { } item ? [item.Value, .. scopeIds] : scopeIds, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<PetPlanResponse>(Missing());
        }
        var pet = await FindPetAsync(cancellationToken).ConfigureAwait(false);
        if (!IsEnabled(command.WorkspaceId) || pet is null || pet.Id != request.PetId)
        {
            return Result.Failure<PetPlanResponse>(new NixError("pet_runs.disabled", "Enable this pet in the selected workspace before starting a plan."));
        }
        var sharing = await services.GetRequiredService<PetPlanSharingService>().PrepareAsync(
            command.WorkspaceId.Value, pet.Id, request.SourceScope, cancellationToken).ConfigureAwait(false);
        if (sharing.IsFailure)
        {
            return Result.Failure<PetPlanResponse>(sharing.Error);
        }
        var preferences = await services.GetRequiredService<Nix.Abstractions.IPrincipalPreferencesStore>()
            .FindAsync(Caller.TenantId, Caller.PrincipalId, cancellationToken).ConfigureAwait(false);
        var now = clock.GetUtcNow();
        var state = new PetRunCheckpoint(pet.Id, null, null, [], [], [], 0, Provider: pet.Provider,
            AfterMessageId: request.AfterMessageId, PlanRequest: new(request.RequestId, request.SourceScope, request.ChatSource,
                TimeZone: preferences?.TimeZone, StartFingerprint: PetPlanExecution.StartFingerprint(request)),
            SharingQuestion: sharing.Value);
        var run = new PetRunRecord(Guid.NewGuid(), anchor, command.WorkspaceId, Caller.TenantId, Caller.PrincipalId,
            request.Brief!.Trim(), scopeIds, request.SourceScope.Kind == "workspace",
            [.. _capabilities.Keys.Where(name => !name.StartsWith("peer.", StringComparison.Ordinal)).Order(StringComparer.Ordinal)],
            sharing.Value is null ? "queued" : "waiting_for_input", 1, Serialize(state), now, now, RequestId: request.RequestId);
        if (sharing.Value is null)
        {
            state = state with { ActiveJobId = await QueueJobAsync(run, 1, cancellationToken).ConfigureAwait(false) };
            run = run with { State = Serialize(state) };
        }
        if (await runs.CreateAsync(run, cancellationToken).ConfigureAwait(false))
        {
            return Result.Success(RespondPlan(run, state));
        }
        var duplicate = await runs.GetByRequestAsync(command.WorkspaceId, request.RequestId, cancellationToken).ConfigureAwait(false);
        return duplicate is not null && PetPlanExecution.SameStart(duplicate, Checkpoint(duplicate), request)
            ? Result.Success(RespondPlan(duplicate, Checkpoint(duplicate))) : PlanConflict();
    }

    public async ValueTask<Result<PetPlanResponse>> HandleAsync(DecidePetPlanSharing command, CancellationToken cancellationToken)
    {
        var found = await FindPlanAsync(command.WorkspaceId, command.RunId, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<PetPlanResponse>(found.Error);
        }
        var run = found.Value;
        var state = Checkpoint(run);
        if (WasHandled(state, command.Request.RequestId))
        {
            return Result.Success(RespondPlan(run, state));
        }
        if (command.Request.RequestId == Guid.Empty || run.Revision != command.Request.ExpectedRunRevision
            || state.SharingQuestion is null || run.Status != "waiting_for_input")
        {
            return PlanConflict();
        }
        var decided = await services.GetRequiredService<PetPlanSharingService>().DecideAsync(
            run.WorkspaceId.Value, state.PetId, state.PlanRequest!.SourceScope, command.Request, cancellationToken).ConfigureAwait(false);
        if (decided.IsFailure)
        {
            return Result.Failure<PetPlanResponse>(decided.Error);
        }
        state = Handled(state with { SharingQuestion = null }, command.Request.RequestId);
        if (command.Request.Approve)
        {
            return await QueuePlanAsync(run, state, cancellationToken).ConfigureAwait(false);
        }
        state = CancelUndispatched(state);
        return state.PlanRequest is { ChatSource: not null, SourceResolved: false } source
            ? await QueuePlanAsync(run, state with { PlanRequest = source with { PendingFinalStatus = "cancelled" } }, cancellationToken).ConfigureAwait(false)
            : await SavePlanAsync(run, state, "cancelled", cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask<Result<PetPlanResponse>> HandleAsync(DecidePetPlan command, CancellationToken cancellationToken)
    {
        var found = await FindPlanAsync(command.WorkspaceId, command.RunId, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<PetPlanResponse>(found.Error);
        }
        var run = found.Value;
        var state = Checkpoint(run);
        var request = command.Request;
        if (state.Plan is { } duplicate && duplicate.Id == command.PlanId && duplicate.Version == request.PlanVersion
            && duplicate.ReviewDigest == request.ReviewDigest && duplicate.Decision is { } decision
            && decision.RequestId == request.RequestId && decision.Approve == request.Approve)
        {
            return Result.Success(RespondPlan(run, state));
        }
        if (run.Status != "waiting_for_approval" || request.ExpectedRunRevision != run.Revision
            || state.Plan is not { Status: "awaiting_review" } plan
            || !PetPlanExecution.Matches(plan, command.PlanId, request.PlanVersion, request.ReviewDigest)
            || request.RequestId == Guid.Empty)
        {
            return PlanConflict();
        }
        var authority = await services.GetRequiredService<PetPlanDecisionAccess>().AuthorizeAsync(run.WorkspaceId.Value,
            run.Id, plan.Id, plan.Version, plan.ReviewDigest, request.Approve, request.RequestId,
            request.DecisionContext, cancellationToken).ConfigureAwait(false);
        if (authority.IsFailure)
        {
            return Result.Failure<PetPlanResponse>(authority.Error);
        }
        var approved = plan with { Decision = authority.Value, Status = request.Approve ? "approved" : "cancelled" };
        state = state with { Plan = approved };
        if (request.Approve)
        {
            return await QueuePlanAsync(run, state, cancellationToken).ConfigureAwait(false);
        }
        state = CancelUndispatched(state);
        return state.PlanRequest is { ChatSource: not null, SourceResolved: false } source
            ? await QueuePlanAsync(run, state with { PlanRequest = source with { PendingFinalStatus = "cancelled" } }, cancellationToken).ConfigureAwait(false)
            : await SavePlanAsync(run, state, "cancelled", cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask<Result<PetPlanResponse>> HandleAsync(AnswerPetPlan command, CancellationToken cancellationToken)
    {
        var found = await FindPlanAsync(command.WorkspaceId, command.RunId, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<PetPlanResponse>(found.Error);
        }
        var run = found.Value;
        var state = Checkpoint(run);
        if (WasHandled(state, command.Request.RequestId))
        {
            return Result.Success(RespondPlan(run, state));
        }
        if (run.Status != "waiting_for_input" || run.Revision != command.Request.ExpectedRunRevision
            || state.SharingQuestion is not null || state.Question is not { Scope: null } question
            || question.Id != command.Request.QuestionId || command.Request.RequestId == Guid.Empty
            || !ValidText(command.Request.Answer, 2_000, 8_000))
        {
            return PlanConflict();
        }
        state = Handled(state with
        {
            Question = null,
            Answers = [.. state.Answers, $"Owner's clarification: {command.Request.Answer!.Trim()}"]
        }, command.Request.RequestId);
        return await QueuePlanAsync(run, state, cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask<Result<PetPlanResponse>> HandleAsync(CancelPetPlan command, CancellationToken cancellationToken)
    {
        var found = await FindPlanAsync(command.WorkspaceId, command.RunId, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<PetPlanResponse>(found.Error);
        }
        var run = found.Value;
        var state = Checkpoint(run);
        if (WasHandled(state, command.Request.RequestId))
        {
            return Result.Success(RespondPlan(run, state));
        }
        if (run.Revision != command.Request.ExpectedRunRevision || command.Request.RequestId == Guid.Empty)
        {
            return PlanConflict();
        }
        var inFlight = state.Plan?.Steps.Any(step => step.Status is "applying" or "undo_applying") == true;
        state = Handled(CancelUndispatched(state), command.Request.RequestId);
        // A consumed external permit still needs its receipt. Cancelling the lease would discard that evidence.
        if (!inFlight && state.ActiveJobId is { } jobId)
        {
            await jobs.CancelAsync(run.TenantId, run.ActorId, jobId, cancellationToken).ConfigureAwait(false);
            state = state with { ActiveJobId = null };
        }
        if (!inFlight && state.PlanRequest is { ChatSource: not null, SourceResolved: false } source)
        {
            return await QueuePlanAsync(run, state with { PlanRequest = source with { PendingFinalStatus = "cancelled" } }, cancellationToken).ConfigureAwait(false);
        }
        return await SavePlanAsync(run, state, inFlight ? "running" : "cancelled", cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask<Result<PetPlanResponse>> HandleAsync(RevisePetPlan command, CancellationToken cancellationToken)
    {
        var found = await FindPlanAsync(command.WorkspaceId, command.RunId, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<PetPlanResponse>(found.Error);
        }
        var run = found.Value;
        var state = Checkpoint(run);
        var request = command.Request;
        if (WasHandled(state, request.RequestId))
        {
            return Result.Success(RespondPlan(run, state));
        }
        if (request.RequestId == Guid.Empty || request.ExpectedRunRevision != run.Revision
            || state.Plan is not { } plan || request.PlanVersion != plan.Version
            || run.Status is not ("waiting_for_approval" or "waiting_for_handoff" or "queued" or "running" or "review_required")
            || plan.Steps.Any(step => step.Status is "applying" or "applied" or "unknown" or "undo_applying")
            || request.Feedback is not null && !ValidText(request.Feedback, 2_000, 8_000)
            || request.FieldEdits?.Count > 100)
        {
            return PlanConflict();
        }
        state = Handled(state, request.RequestId);
        if (request.FieldEdits is { Count: > 0 } edits)
        {
            var changed = PetPlanExecution.Edit(plan, edits);
            if (changed.IsFailure)
            {
                return Result.Failure<PetPlanResponse>(changed.Error);
            }
            var prepared = await PreparePlanAsync(run, state, plan.Summary, changed.Value, cancellationToken).ConfigureAwait(false);
            if (prepared.IsFailure)
            {
                return Result.Failure<PetPlanResponse>(prepared.Error);
            }
            if (state.ActiveJobId is { } jobId)
            {
                await jobs.CancelAsync(run.TenantId, run.ActorId, jobId, cancellationToken).ConfigureAwait(false);
            }
            state = state with
            {
                PlanRequest = state.PlanRequest! with
                {
                    ProtectedRead = state.PlanRequest.ProtectedRead || prepared.Value.ProtectedRead,
                    ReadPhase = state.PlanRequest.ChatSource is not null && prepared.Value.Steps.Any(effect => effect.IncludedInReview
                        && !_capabilities[effect.Capability].RequiresApproval(effect.Effect))
                }
            };
            return state.PlanRequest?.ChatSource is not null
                ? await QueuePlanAsync(run, state with { Plan = prepared.Value with { Status = "adopting" } }, cancellationToken).ConfigureAwait(false)
                : await SavePlanAsync(run, state with { Plan = prepared.Value, ActiveJobId = null }, "waiting_for_approval", cancellationToken).ConfigureAwait(false);
        }
        state = state with
        {
            Plan = plan with { Status = "superseded" },
            OwnerRevisions = request.Feedback is null ? OwnerRevisions(state) : [.. OwnerRevisions(state), request.Feedback.Trim()]
        };
        return await QueuePlanAsync(run, state, cancellationToken).ConfigureAwait(false);
    }

    private async Task<Result<PetRunRecord>> FindPlanAsync(WorkspaceId workspaceId, Guid runId, CancellationToken cancellationToken)
    {
        var run = await runs.GetAsync(runId, cancellationToken).ConfigureAwait(false);
        return run is not null && run.WorkspaceId == workspaceId && run.TenantId == Caller.TenantId
            && run.ActorId == Caller.PrincipalId && Checkpoint(run).PlanRequest is not null
            && IsEnabled(workspaceId) && await RunScopeAvailableAsync(run, cancellationToken).ConfigureAwait(false)
                ? Result.Success(run) : Result.Failure<PetRunRecord>(Missing());
    }

    private async Task<bool> WorkspaceSourcesAvailableAsync(WorkspaceId workspaceId, IReadOnlyList<Guid> sources, CancellationToken cancellationToken)
    {
        if (!await WorkspaceAvailableAsync(workspaceId, cancellationToken).ConfigureAwait(false))
        {
            return false;
        }
        var ids = sources.Distinct().Select(ItemId.From).ToArray();
        if ((await itemLocks.LockedAmongAsync(ids, cancellationToken).ConfigureAwait(false)).Count > 0)
        {
            return false;
        }
        foreach (var id in ids)
        {
            var source = await items.FindAsync(id, cancellationToken).ConfigureAwait(false);
            if (source is null || source.WorkspaceId != workspaceId || !CanUseSource(source))
            {
                return false;
            }
        }
        return true;
    }

    private async Task<Result<PetPlanResponse>> QueuePlanAsync(PetRunRecord run, PetRunCheckpoint state, CancellationToken cancellationToken)
    {
        if (!Fits(state))
        {
            return PlanInvalid("This plan reached its checkpoint limit. Prepare a smaller plan.");
        }
        var job = await QueueJobAsync(run, run.Revision + 1, cancellationToken).ConfigureAwait(false);
        return await SavePlanAsync(run, state with { ActiveJobId = job, Failure = null }, "queued", cancellationToken).ConfigureAwait(false);
    }

    private async Task<Result<PetPlanResponse>> SavePlanAsync(PetRunRecord run, PetRunCheckpoint state, string status, CancellationToken cancellationToken)
    {
        if (!Fits(state))
        {
            return PlanInvalid("This plan reached its checkpoint limit. Prepare a smaller plan.");
        }
        var next = Next(run, state, status);
        return await runs.UpdateAsync(next, run.Revision, cancellationToken).ConfigureAwait(false)
            ? Result.Success(RespondPlan(next, state)) : PlanConflict();
    }

    private PetPlanResponse RespondPlan(PetRunRecord run, PetRunCheckpoint state) => new(
        run.Id, run.WorkspaceId.Value, run.ItemId?.Value, state.PetId, run.Brief, state.PlanRequest!.SourceScope,
        run.Status, run.Revision, state.SharingQuestion, state.Question,
        state.Plan is { } plan ? new PetPlanReview(plan.Id, plan.Version, plan.Summary, plan.ReviewDigest,
            plan.ScopeDigest, plan.RecipientRevision, plan.Status,
            [.. plan.Steps.Select(step => new PetPlanStepResponse(step.Id, step.Capability, PublicArguments(step), PublicEffect(step),
                step.Executor, step.Status, [.. step.Fields.Select(field => new PetPlanFieldResponse(field.Id, field.Label,
                    field.Kind, field.Value, field.Help, field.Required, field.Choices, field.CurrentValue))], step.Receipt, step.UndoId, ReceiptView(step)))], plan.Decision) : null,
        state.Results, run.CreatedAt, run.UpdatedAt, state.AfterMessageId, state.Failure,
        [.. state.Proposals.Where(proposal => proposal.Receipt is not null).Select(proposal => new PetPlanObservation(proposal.Id,
            proposal.Capability, proposal.Description, ReceiptView(new(proposal.Id, proposal.Capability, EmptyPreview,
                new(proposal.Description, proposal.Preview), "server", proposal.Status, [], Receipt: proposal.Receipt))))]);

    private PetRunEffect PublicEffect(PetPlanPreparedStep step)
    {
        if (_capabilities.GetValueOrDefault(step.Capability) is IPetPlanCapability adapter)
        {
            return adapter.PublicEffect(step.Effect);
        }
        var values = step.Effect.Parameters;
        if (step.Capability == "nix.action" && values.TryGetProperty("inputs", out var inputs))
        {
            var semantic = new JsonObject
            {
                ["kind"] = "nixAction",
                ["operation"] = values.GetProperty("operationId").GetString(),
                ["targets"] = values.TryGetProperty("targets", out var targets) ? JsonNode.Parse(targets.GetRawText()) : new JsonArray(),
                ["currentTitle"] = values.TryGetProperty("currentTitle", out var title) ? JsonNode.Parse(title.GetRawText()) : null,
                ["values"] = inputs.TryGetProperty("body", out var body) ? JsonNode.Parse(body.GetRawText()) : new JsonObject()
            };
            return new(step.Effect.Description, JsonSerializer.SerializeToElement(semantic, PetWorkspacePlanRpcJsonContext.Default.JsonObject));
        }
        if (step.Capability is "sheet.edit" or "canvas.edit")
        {
            var native = JsonNode.Parse(values.GetRawText())!.AsObject();
            native.Remove("revisions");
            return new(step.Effect.Description, JsonSerializer.SerializeToElement(native, PetWorkspacePlanRpcJsonContext.Default.JsonObject));
        }
        return step.Effect;
    }

    private JsonElement PublicArguments(PetPlanPreparedStep step)
    {
        var effect = PublicEffect(step);
        return effect.Parameters.TryGetProperty("values", out var values) ? values : step.Arguments;
    }

    private static PetPlanReceiptView? ReceiptView(PetPlanPreparedStep step)
    {
        if (step.Receipt is not { } receipt)
        {
            return null;
        }
        var summary = step.Status switch
        {
            "applied" => step.Effect.Description,
            "undone" => "Undid " + step.Effect.Description,
            "partial" => "Part of this change completed. Review the observed results.",
            "unknown" => step.UndoId is null ? "The complete result could not be confirmed. Review the observed results."
                : "The undo result could not be confirmed. The original applied receipt is retained.",
            _ => "This change stopped. Review the observed results.",
        };
        if (step.Capability.StartsWith("workspace.", StringComparison.Ordinal) || step.Capability is "sheet.edit" or "canvas.edit")
        {
            try
            {
                using var machine = JsonDocument.Parse(receipt, new JsonDocumentOptions { MaxDepth = 32, AllowDuplicateProperties = false });
                return new(summary, machine.RootElement.Clone());
            }
            catch (JsonException)
            {
                return new(summary, Text: receipt);
            }
        }
        if (step.Capability == "nix.action" && step.Effect.Parameters.TryGetProperty("operationId", out var operation)
            && operation.ValueKind == JsonValueKind.String && operation.GetString() is { } operationId
            && operationId != "GetItemBody" && PetCapabilities.Find(operationId)?.Mode == "read")
        {
            var prefix = $"Core completed {operationId} (";
            if (receipt.StartsWith(prefix, StringComparison.Ordinal) && receipt.Length > prefix.Length + 6
                && int.TryParse(receipt.AsSpan(prefix.Length, 3), System.Globalization.NumberStyles.None,
                    System.Globalization.CultureInfo.InvariantCulture, out var status) && status is >= 200 and < 300
                && receipt.AsSpan(prefix.Length + 3, 3).SequenceEqual(").\n"))
            {
                try
                {
                    using var machine = JsonDocument.Parse(receipt[(prefix.Length + 6)..],
                        new JsonDocumentOptions { MaxDepth = 32, AllowDuplicateProperties = false });
                    return new(summary, machine.RootElement.Clone());
                }
                catch (JsonException)
                {
                    return new(summary, Text: receipt);
                }
            }
        }
        return new(summary, Text: receipt);
    }

    private static bool WasHandled(PetRunCheckpoint state, Guid requestId) => requestId != Guid.Empty && state.HandledRequests?.Contains(requestId) == true;
    private static PetRunCheckpoint Handled(PetRunCheckpoint state, Guid requestId) =>
        state with { HandledRequests = [.. (state.HandledRequests ?? []).TakeLast(99), requestId] };
    private static PetRunCheckpoint CancelUndispatched(PetRunCheckpoint state) => state with
    {
        Question = null,
        SharingQuestion = null,
        Plan = state.Plan is { } plan ? plan with
        {
            Status = "cancelled",
            Steps = [.. plan.Steps.Select(step =>
            step.Status is "pending" or "claimed" ? step with { Status = "cancelled" } : step)]
        } : null,
    };
    private static Result<PetPlanResponse> PlanInvalid(string message) => Result.Failure<PetPlanResponse>(new NixError("pet_plans.invalid", message));
    private static Result<PetPlanResponse> PlanConflict() => Result.Failure<PetPlanResponse>(new NixError("pet_plans.conflict", "The plan changed. Refresh it before continuing."));
}
