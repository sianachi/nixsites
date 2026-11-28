using System.Text;
using System.Text.Json;
using Nix.Abstractions;
using Nix.Abstractions.PetRuns;
using Nix.Abstractions.Workers;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Items;
using Nix.Features.Pets;
using Nix.Workers;

namespace Nix.Features.PetRuns;

internal sealed partial class PetRunService
{
    // Reserve room below the database limit to record the terminal receipt of spent approvals.
    private const int MaxCheckpointBytes = 960_000;
    private const int MaxReceiptBytes = 64_000;

    private sealed record Work(NixSessionContext Context, WorkerExecution Job, WorkerExecutionAuthorization Authorization, Guid RunId);
    private sealed record Step(PetRunRecord Run, PetRunCheckpoint State);
    private sealed record PreparedTurn(PreparedPetTaskStep? Request, List<PetRunProposal> Observed, string? PreviousDraft, string SharingAttestation, NixError? Refusal = null);
    private sealed record ExternalStep(Step Step, PetRunProposal Proposal, bool Undo);

    internal async Task<string?> AdvanceAsync(WorkerExecution execution, CancellationToken cancellationToken)
    {
        var payload = JsonSerializer.Deserialize(execution.Job.Payload, PetRunJsonContext.Default.PetRunJobPayload);
        if (payload is null || payload.RunId == Guid.Empty)
        {
            throw WorkerJobException.Fail("pet_runs.invalid_job", "The pet job has no run identifier.");
        }

        var authorization = await dispatch.AuthorizeExecutionAsync(execution.Job.Id, execution.ExecutionId, cancellationToken).ConfigureAwait(false);
        if (authorization?.Kind is not (AdvanceKind or PlanAdvanceKind) || authorization.WorkspaceId is not { } workspaceId)
        {
            return null;
        }

        var work = new Work(new NixSessionContext(TenantId.From(authorization.TenantId), WorkspaceId.From(workspaceId),
            PrincipalId.From(authorization.ActorId)), execution, authorization, payload.RunId);
        var step = await InWorkerScopeAsync(work, static (handler, job, token) => handler.BeginAsync(job, token), cancellationToken)
            .ConfigureAwait(false);
        if (step is null)
        {
            return null;
        }
        if (step.State.PlanRequest is not null)
        {
            if (authorization.Kind == PlanAdvanceKind)
            {
                await AdvancePlanAsync(work, step, cancellationToken).ConfigureAwait(false);
            }
            return null;
        }
        if (authorization.Kind != AdvanceKind)
        {
            return null;
        }

        var pending = step.State.Proposals.FirstOrDefault(proposal => proposal.Status is "approved" or "undo_pending");
        if (pending is not null)
        {
            await ExecuteActionAsync(work, step, pending, cancellationToken).ConfigureAwait(false);
        }
        else
        {
            await ExecuteTurnAsync(work, step, cancellationToken).ConfigureAwait(false);
        }
        return null;
    }

    private Task<T> InWorkerScopeAsync<T>(
        Work work, Func<PetRunService, Work, CancellationToken, Task<IsolatedOutcome<T>>> action, CancellationToken cancellationToken) =>
        isolated.RunAsync(work.Context, (scope, ct) => action(scope.GetRequiredService<PetRunService>(), work, ct), cancellationToken);

    private async ValueTask<bool> HoldAsync(Work work, CancellationToken cancellationToken) =>
        await services.GetRequiredService<IWorkerExecutionFence>().HoldAsync(work.Job.Job.Id, work.Job.ExecutionId,
            work.Authorization, cancellationToken).ConfigureAwait(false);

    private async Task<Step?> CurrentAsync(Work work, CancellationToken cancellationToken)
    {
        var run = await runs.GetAsync(work.RunId, cancellationToken).ConfigureAwait(false);
        if (run is null || run.Status is not ("queued" or "running"))
        {
            return null;
        }
        var state = Checkpoint(run);
        return state.ActiveJobId == work.Job.Job.Id ? new Step(run, state) : null;
    }

    private async Task<bool> AvailableAsync(Step step, CancellationToken cancellationToken) =>
        await FindAvailablePetAsync(step, cancellationToken).ConfigureAwait(false) is not null;

    private async Task<PetProfile?> FindAvailablePetAsync(Step step, CancellationToken cancellationToken)
    {
        if (!IsEnabled(step.Run.WorkspaceId)
            || !await RunScopeAvailableAsync(step.Run, cancellationToken).ConfigureAwait(false)
            || await FindPetAsync(cancellationToken).ConfigureAwait(false) is not { } pet)
        {
            return null;
        }
        return pet.Id == step.State.PetId && pet.Provider == step.State.Provider ? pet : null;
    }

    private async Task<IsolatedOutcome<Step?>> BeginAsync(Work work, CancellationToken cancellationToken)
    {
        if (!await HoldAsync(work, cancellationToken).ConfigureAwait(false)
            || await CurrentAsync(work, cancellationToken).ConfigureAwait(false) is not { } step)
        {
            return new IsolatedOutcome<Step?>(null, false);
        }

        // A prior execution may have sent an external request before its lease was lost.
        var interrupted = step.State.Proposals.FirstOrDefault(proposal => proposal.Status is "applying" or "undo_applying");
        if (step.State.Plan is { } plan && plan.Steps.Any(effect => effect.Status is "applying" or "undo_applying"))
        {
            var uncertainPlan = plan with
            {
                Status = "review_required",
                Steps = [.. plan.Steps.Select(effect =>
                effect.Status is "applying" or "undo_applying" ? effect with { Status = "unknown" } : effect)]
            };
            var saved = await StopAsync(step.Run, step.State with { Plan = uncertainPlan }, "review_required", cancellationToken).ConfigureAwait(false);
            return new IsolatedOutcome<Step?>(null, saved);
        }
        if (interrupted is not null)
        {
            var uncertain = Replace(step.State, interrupted with { Status = "unknown" });
            var saved = await StopAsync(step.Run, uncertain, "review_required", cancellationToken).ConfigureAwait(false);
            return new IsolatedOutcome<Step?>(null, saved);
        }
        if (!await AvailableAsync(step, cancellationToken).ConfigureAwait(false))
        {
            var saved = await StopAsync(step.Run, step.State, "failed", cancellationToken).ConfigureAwait(false);
            return new IsolatedOutcome<Step?>(null, saved);
        }
        if (step.Run.Status == "running")
        {
            return new IsolatedOutcome<Step?>(step, false);
        }

        var next = Next(step.Run, step.State, "running");
        return await runs.UpdateAsync(next, step.Run.Revision, cancellationToken).ConfigureAwait(false)
            ? new IsolatedOutcome<Step?>(new Step(next, step.State), true)
            : new IsolatedOutcome<Step?>(null, false);
    }

    private async Task ExecuteTurnAsync(Work work, Step step, CancellationToken cancellationToken)
    {
        var prepared = await InWorkerScopeAsync(work, (handler, job, ct) => handler.PrepareTurnAsync(job, step, ct),
            cancellationToken).ConfigureAwait(false);
        Result<PetTaskStep> decision;
        if (prepared?.Refusal is { } refusal)
        {
            decision = Result.Failure<PetTaskStep>(refusal);
        }
        else if (prepared is null
            || !await InWorkerScopeAsync(work, (handler, job, ct) => handler.CanSendTurnAsync(job, step, prepared, ct), cancellationToken)
                .ConfigureAwait(false))
        {
            decision = Result.Failure<PetTaskStep>(new NixError("pet_runs.plan_unavailable", "The pet could not continue this job."));
        }
        else if (await dispatch.AuthorizeExecutionAsync(work.Job.Job.Id, work.Job.ExecutionId, cancellationToken).ConfigureAwait(false) is not null)
        {
            decision = await services.GetRequiredService<PetWorkerClient>().PlanTaskStepAsync(prepared.Request!, cancellationToken)
                .ConfigureAwait(false);
        }
        else
        {
            return;
        }

        PetRunEffect? preview = null;
        PetPlanPrepared? plan = null;
        var failure = decision.IsFailure ? RunFailure("planning", decision.Error) : null;
        if (step.State.PlanRequest is not null && decision.IsSuccess && decision.Value.Kind is "plan" or "action")
        {
            IReadOnlyList<PetTaskPlanStep> proposed = decision.Value.Steps
                ?? (decision.Value is { Capability: { } planCapability, Arguments: { } planArguments } ? [new(planCapability, planArguments)] : []);
            var preparedPlan = await InWorkerScopeAsync(work, async (handler, job, ct) =>
            {
                var current = await handler.CurrentAsync(job, ct).ConfigureAwait(false);
                if (current is null || current.Run.Revision != step.Run.Revision)
                {
                    return new IsolatedOutcome<Result<PetPlanPrepared>?>(null, false);
                }
                var result = await handler.PreparePlanAsync(current.Run, current.State, decision.Value.Text ?? "Review the prepared changes", proposed, ct).ConfigureAwait(false);
                return new IsolatedOutcome<Result<PetPlanPrepared>?>(result, false);
            }, cancellationToken).ConfigureAwait(false);
            if (preparedPlan is { IsSuccess: true })
            {
                plan = preparedPlan.Value.Value;
            }
            else
            {
                failure = RunFailure("preview", preparedPlan is { IsFailure: true } invalid ? invalid.Error
                    : new NixError("pet_plans.preview_unavailable", "The plan could not be prepared."));
            }
        }
        if (step.State.PlanRequest is null && decision.IsSuccess && decision.Value is { Kind: "action", Capability: { } name, Arguments: { } args }
            && RunAbilities(step.Run, step.State).Contains(name, StringComparer.Ordinal) && _capabilities.ContainsKey(name))
        {
            var result = await InWorkerScopeAsync(work, (handler, job, ct) => handler.PreviewAsync(job, step, name, args, ct),
                cancellationToken).ConfigureAwait(false);
            if (result is { IsSuccess: true })
            {
                preview = result.Value.Value;
            }
            else if (name == PetTaskCommentCapability.Id && result is { IsFailure: true } refused
                && refused.Error.Code == PetTaskCommentCapability.CommentsDisabled.Code)
            {
                decision = Result.Success(new PetTaskStep("question", PetTaskCommentCapability.CommentsDisabled.Message, null, null));
            }
            else if (name == "nix.action" && result is { IsFailure: true } needsText
                && needsText.Error.Code == NixActionPetCapability.TargetTextRequiredCode
                && step.State.IncludeTargetText == false && step.State.Turns + 1 < MaxTurns)
            {
                decision = Result.Success(new PetTaskStep("scope", "Share the current note as a source so I can read its text before preparing the change.",
                    null, null, "source"));
            }
            else
            {
                failure = RunFailure("preview", result is { IsFailure: true } invalid ? invalid.Error
                    : new NixError("pet_runs.preview_unavailable", "The draft could not be prepared."));
            }
        }

        await InWorkerScopeAsync(work, (handler, job, ct) => handler.RecordTurnAsync(job, step, decision, preview, failure, ct, plan),
            cancellationToken).ConfigureAwait(false);
    }

    private async Task<IsolatedOutcome<PreparedTurn?>> PrepareTurnAsync(
        Work work, Step step, CancellationToken cancellationToken)
    {
        if (step.State.Turns >= MaxTurns
            || await CurrentAsync(work, cancellationToken).ConfigureAwait(false) is not { } current
            || current.Run.Revision != step.Run.Revision
            || await FindAvailablePetAsync(current, cancellationToken).ConfigureAwait(false) is not { } pet)
        {
            return new IsolatedOutcome<PreparedTurn?>(null, false);
        }
        var scope = DisclosureScope(step.Run, step.State);
        var sharing = services.GetRequiredService<PetPlanSharingService>();
        var pin = await sharing.PinAsync(step.Run.WorkspaceId.Value, step.State.PetId, scope, work.Job.Job.Id, cancellationToken).ConfigureAwait(false);
        if (pin.IsFailure)
        {
            var paused = step.State with { ActiveJobId = null, Failure = new("sharing", pin.Error.Code, pin.Error.Message) };
            var saved = await StopAsync(step.Run, paused, "review_required", cancellationToken).ConfigureAwait(false);
            return new IsolatedOutcome<PreparedTurn?>(null, saved);
        }

        var observations = RevisionInstructions(step.State);
        if (step.State.PlanRequest?.ChatSource is not null && step.State.Plan is { Status: "superseded" } previousPlan)
        {
            foreach (var previous in previousPlan.Steps)
            {
                observations.Add($"Untrusted previous prepared effect {previous.Capability}: {Cut(PetPlanExecution.Canonical(previous.Arguments), 2000)}");
            }
        }
        var preferences = await services.GetRequiredService<IPrincipalPreferencesStore>()
            .FindAsync(work.Context.TenantId, work.Context.PrincipalId, cancellationToken).ConfigureAwait(false);
        observations.Add(PetRunClock.Describe(clock.GetUtcNow(), preferences?.TimeZone));
        var observed = new List<PetRunProposal>();
        var selectedNotes = new List<ItemId>();
        var effective = EffectiveRun(step.Run, step.State);
        var previousDraft = await PreviousDraftAsync(effective, step.State, cancellationToken).ConfigureAwait(false);
        if (previousDraft is not null)
        {
            observations.Add($"Untrusted previous draft: {previousDraft}");
        }
        var sourceIds = step.Run.ItemId is { } anchor ? ReadSources(step.Run, step.State).Prepend(anchor.Value) : ReadSources(step.Run, step.State);
        foreach (var id in sourceIds.Distinct())
        {
            var item = await items.FindAsync(ItemId.From(id), cancellationToken).ConfigureAwait(false);
            if (item is null || item.WorkspaceId != step.Run.WorkspaceId || !CanUseSource(item))
            {
                return new IsolatedOutcome<PreparedTurn?>(null, false);
            }
            observations.Add($"Selected Nix item {id:D} ({item.Type}): {Cut(ItemProperties.ReadTitle(item.Properties), 160)}");
            if (item.Id == step.Run.ItemId && item.Type == "note" && step.State.IncludeTargetText is { } sharedText)
            {
                observations.Add(sharedText
                    ? "Target note text is shared for this job."
                    : "Target note text is not shared. AppendItemBody preserves existing blocks without reading them. To read this note, request the current note as a source.");
            }
            if (item.Type == "note" && (item.Id != step.Run.ItemId || step.State.IncludeTargetText != false))
            {
                selectedNotes.Add(item.Id);
            }
        }
        foreach (var proposal in step.State.Proposals.TakeLast(12))
        {
            observations.Add($"Nix recorded {proposal.Capability} action {proposal.Id:D} as {proposal.Status}.");
            if (proposal is { Status: "applied", Receipt: { } receipt }
                && !proposal.ObservationBlocked && await ObservationAvailableAsync(step.Run, proposal, cancellationToken).ConfigureAwait(false)
                && _capabilities.TryGetValue(proposal.Capability, out var capability))
            {
                var effect = new PetRunEffect(proposal.Description, proposal.Preview);
                if (capability.ModelObservation(effect, receipt) is { } observation
                    && await capability.CanObserveAsync(effective, effect, receipt, cancellationToken).ConfigureAwait(false))
                {
                    observations.Add($"Untrusted result for {proposal.Id:D}: {Cut(observation, 700)}");
                    observed.Add(proposal);
                }
            }
        }
        foreach (var answer in step.State.Answers
            .Where(static answer => !answer.StartsWith("Untrusted registered runner result for ", StringComparison.Ordinal))
            .TakeLast(6))
        {
            observations.Add(Cut(answer, 450));
        }

        if (selectedNotes.Count > 0)
        {
            var excerpts = selectedNotes.Select(item => ReadExcerptAsync(step.Run, item, cancellationToken));
            observations.AddRange(await Task.WhenAll(excerpts).ConfigureAwait(false));
        }
        if (step.State.PlanRequest is not null)
        {
            var catalog = await PetWorkspaceToolCapability.PrepareCatalogAsync(_capabilities.Values, cancellationToken).ConfigureAwait(false);
            if (catalog.IsFailure)
            {
                return new IsolatedOutcome<PreparedTurn?>(null, false);
            }
        }
        PetTaskCapability[] offered = [.. effective.Abilities
            .Where(_capabilities.ContainsKey)
            .Where(name => step.State.PlanRequest?.SourceReadOnly != true || PetWorkspaceToolCapability.ReadOnlyOperation(name))
            .Select(name => new PetTaskCapability(name, _capabilities[name].Description, _capabilities[name].InputSchema))];
        var scopeAbilities = step.State.IncludeTargetText is not null
            ? _capabilities.Keys.Except(effective.Abilities, StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray()
            : null;
        var input = new PetTaskStepInput(step.Run.Id, work.Job.Job.Id, step.Run.WorkspaceId.Value, step.Run.ItemId?.Value,
            step.Run.Brief, BoundContext(observations), offered, scopeAbilities, step.State.PlanRequest is not null, pin.Value, step.State.Routine is not null);
        var prepared = await services.GetRequiredService<PetWorkerClient>().PrepareTaskStepAsync(pet, input, cancellationToken)
            .ConfigureAwait(false);
        // Only the budget refusal is carried through; any other preparation failure stays the generic "could not continue".
        return new IsolatedOutcome<PreparedTurn?>(prepared.IsSuccess ? new PreparedTurn(prepared.Value, observed, previousDraft, pin.Value)
            : prepared.Error.Code == PetUsageService.BudgetExhausted ? new PreparedTurn(null, [], null, pin.Value, prepared.Error) : null, false);
    }

    private async Task<IsolatedOutcome<bool>> CanSendTurnAsync(
        Work work, Step step, PreparedTurn prepared, CancellationToken cancellationToken)
    {
        var current = await CurrentAsync(work, cancellationToken).ConfigureAwait(false);
        if (current is null || current.Run.Revision != step.Run.Revision
            || !await services.GetRequiredService<PetPlanSharingService>().ValidateAsync(prepared.SharingAttestation, cancellationToken).ConfigureAwait(false)
            || !await AvailableAsync(current, cancellationToken).ConfigureAwait(false))
        {
            return new IsolatedOutcome<bool>(false, false);
        }
        var effective = EffectiveRun(current.Run, current.State);
        if (prepared.PreviousDraft is not null
            && prepared.PreviousDraft != await PreviousDraftAsync(effective, current.State, cancellationToken).ConfigureAwait(false))
        {
            return new IsolatedOutcome<bool>(false, false);
        }
        foreach (var proposal in prepared.Observed)
        {
            var effect = new PetRunEffect(proposal.Description, proposal.Preview);
            if (!await ObservationAvailableAsync(current.Run, proposal, cancellationToken).ConfigureAwait(false)
                || !await _capabilities[proposal.Capability].CanObserveAsync(effective, effect, proposal.Receipt!, cancellationToken)
                .ConfigureAwait(false))
            {
                return new IsolatedOutcome<bool>(false, false);
            }
        }
        return new IsolatedOutcome<bool>(true, false);
    }

    private async Task<string?> PreviousDraftAsync(PetRunRecord run, PetRunCheckpoint state, CancellationToken cancellationToken)
    {
        if (state.RevisionFeedback is not { ProposalId: var id }
            || state.Proposals.FirstOrDefault(proposal => proposal.Id == id && proposal.Status == "superseded") is not { } prior
            || !_capabilities.TryGetValue(prior.Capability, out var capability))
        {
            return null;
        }
        var draft = await capability.RevisionObservationAsync(run, new PetRunEffect(prior.Description, prior.Preview), cancellationToken)
            .ConfigureAwait(false);
        return draft is null ? null : Cut(draft, 2_000);
    }

    private async Task<string> ReadExcerptAsync(PetRunRecord run, ItemId itemId, CancellationToken cancellationToken)
    {
        var tokens = services.GetRequiredService<SelfIssuedTokenService>();
        var unavailable = $"No excerpt is available from selected Nix item {itemId.Value:D}.";
        if (!tokens.IsConfigured)
        {
            return unavailable;
        }

        var binding = PetActionRequestBinding.Create("GET", $"/internal/authz/items/{itemId.Value:D}", null);
        var bearer = tokens.MintPetAction(run.ActorId, run.TenantId, Guid.NewGuid(), PetTurnMode.Read, binding);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(8));
        try
        {
            var read = await services.GetRequiredService<ItemBodyClient>().ReadAsync(itemId.Value, bearer, deadline.Token)
                .ConfigureAwait(false);
            return read.IsSuccess
                ? PetRunExcerpt.Describe(itemId.Value, read.Value.Markdown)
                : unavailable;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return unavailable;
        }
    }

    private static List<string> RevisionInstructions(PetRunCheckpoint state)
    {
        // Keep the most recent complete instructions ahead of the untrusted observations.
        const int maxRevisionBytes = 12_500;
        var context = new List<string>();
        var bytes = 0;
        foreach (var feedback in OwnerRevisions(state).Reverse())
        {
            var instruction = $"Owner's revision request: {feedback}";
            bytes += JsonEncodedText.Encode(instruction).EncodedUtf8Bytes.Length + 3;
            if (bytes > maxRevisionBytes)
            {
                break;
            }
            context.Add(instruction);
        }
        context.Reverse();
        if (state.RevisionFeedback is { Feedback: null })
        {
            context.Add("Owner requested a fresh draft for the current item.");
        }
        return context;
    }

    private static List<string> BoundContext(IReadOnlyList<string> observations)
    {
        var context = new List<string>();
        var bytes = 0;
        foreach (var observation in observations)
        {
            bytes += JsonEncodedText.Encode(observation).EncodedUtf8Bytes.Length + 3;
            if (context.Count >= 63 || bytes > 30_000)
            {
                context.Add("Additional selected context did not fit this turn.");
                break;
            }
            context.Add(observation);
        }
        return context;
    }

    private async Task<IsolatedOutcome<Result<PetRunEffect>?>> PreviewAsync(
        Work work, Step step, string name, JsonElement args, CancellationToken cancellationToken)
    {
        if (await CurrentAsync(work, cancellationToken).ConfigureAwait(false) is not { } current
            || current.Run.Revision != step.Run.Revision || !await AvailableAsync(current, cancellationToken).ConfigureAwait(false))
        {
            return new IsolatedOutcome<Result<PetRunEffect>?>(null, false);
        }
        var preview = await _capabilities[name].PreviewAsync(EffectiveRun(current.Run, current.State), args, cancellationToken)
            .ConfigureAwait(false);
        return new IsolatedOutcome<Result<PetRunEffect>?>(preview, false);
    }

    private async Task<IsolatedOutcome<bool>> RecordTurnAsync(
        Work work, Step step, Result<PetTaskStep> decision, PetRunEffect? effect, PetRunFailure? failure, CancellationToken cancellationToken,
        PetPlanPrepared? plan = null)
    {
        if (!await HoldAsync(work, cancellationToken).ConfigureAwait(false)
            || await CurrentAsync(work, cancellationToken).ConfigureAwait(false) is not { } current
            || current.Run.Revision != step.Run.Revision)
        {
            return new IsolatedOutcome<bool>(false, false);
        }

        var state = current.State with { Turns = current.State.Turns + 1, ActiveJobId = null, Failure = failure };
        var status = "failed";
        if (decision.IsSuccess && await AvailableAsync(current, cancellationToken).ConfigureAwait(false))
        {
            switch (decision.Value)
            {
                case { Kind: "plan" or "action" } when current.State.PlanRequest is not null && plan is not null:
                    state = state with { PlanRequest = state.PlanRequest! with { ProtectedRead = state.PlanRequest.ProtectedRead || plan.ProtectedRead } };
                    if (current.State.PlanRequest.ChatSource is not null)
                    {
                        state = state with
                        {
                            PlanRequest = state.PlanRequest with
                            {
                                ReadPhase = plan.Steps.Any(effect =>
                            effect.IncludedInReview && !_capabilities[effect.Capability].RequiresApproval(effect.Effect))
                            }
                        };
                        var queued = await QueuePlanAsync(current.Run, state with { Plan = plan with { Status = "adopting" } }, cancellationToken).ConfigureAwait(false);
                        return new IsolatedOutcome<bool>(queued.IsSuccess, queued.IsSuccess);
                    }
                    var first = plan.Steps[0];
                    if (!_capabilities[first.Capability].RequiresApproval(first.Effect))
                    {
                        var queuedRead = await QueuePlanAsync(current.Run, state with
                        { Discovery = new(Guid.NewGuid(), first.Capability, first.Effect) }, cancellationToken).ConfigureAwait(false);
                        return new IsolatedOutcome<bool>(queuedRead.IsSuccess, queuedRead.IsSuccess);
                    }
                    status = "waiting_for_approval";
                    state = state with { Plan = plan, Question = null };
                    break;
                case { Kind: "complete", Text: { } text }:
                    status = "completed";
                    state = state with { Results = [.. state.Results, new PetRunResult(Guid.NewGuid(), Cut(text, 1600), false)] };
                    break;
                case { Kind: "question", Text: { } question }:
                    status = "waiting_for_input";
                    state = state with { Question = new PetRunQuestion(Guid.NewGuid(), Cut(question, 1600)) };
                    break;
                case { Kind: "scope", Scope: "source" or "ability", Text: { } reason } access
                    when state.IncludeTargetText is not null && state.Turns < MaxTurns:
                    status = "waiting_for_input";
                    state = state with { Question = new PetRunQuestion(Guid.NewGuid(), Cut(reason, 1600), access.Scope, access.Capability) };
                    break;
                case { Kind: "action", Capability: { } name } when effect is not null
                    && _capabilities.TryGetValue(name, out var capability):
                    var automatic = await AllowsRoutineAsync(current.Run, state, capability, effect, cancellationToken).ConfigureAwait(false);
                    var review = capability.RequiresApproval(effect) && !automatic;
                    var proposal = new PetRunProposal(Guid.NewGuid(), name, Cut(effect.Description, 500), effect.Parameters,
                        review ? "pending" : "approved", Automatic: automatic);
                    var offered = FinishRevisionTurn(state with { Proposals = [.. state.Proposals, proposal] });
                    if (Fits(offered))
                    {
                        if (!review)
                        {
                            var queued = await QueueAsync(current.Run, offered, cancellationToken).ConfigureAwait(false);
                            return new IsolatedOutcome<bool>(queued.IsSuccess, queued.IsSuccess);
                        }
                        status = "waiting_for_approval";
                        state = offered;
                    }
                    break;
            }
        }

        if (status == "failed" && state.Failure is null)
        {
            state = state with { Failure = RunFailure("planning", new NixError("pet_runs.plan_unavailable", "The pet could not continue this job.")) };
        }
        var saved = await StopAsync(current.Run, status == "failed" ? state : FinishRevisionTurn(state with { Failure = null }), status, cancellationToken)
            .ConfigureAwait(false);
        return new IsolatedOutcome<bool>(saved, saved);
    }

    private static PetPlanSourceScope DisclosureScope(PetRunRecord run, PetRunCheckpoint state) => state.PlanRequest?.SourceScope
        ?? (run.WorkspaceScope ? new("workspace") : new("selected",
            [.. (run.ItemId is { } anchor ? ReadSources(run, state).Prepend(anchor.Value) : ReadSources(run, state)).Distinct().Order()]));

    private async Task ExecuteActionAsync(Work work, Step step, PetRunProposal proposal, CancellationToken cancellationToken)
    {
        var staged = await InWorkerScopeAsync(work, (handler, job, ct) => handler.StageActionAsync(job, step, proposal, ct),
            cancellationToken).ConfigureAwait(false);
        if (staged is null)
        {
            return;
        }

        // The spend is already committed. No lease retry can dispatch this external effect again.
        var result = await InWorkerScopeAsync(work, (handler, job, ct) => handler.ApplyExternalAsync(job, staged, ct),
            cancellationToken).ConfigureAwait(false);
        await InWorkerScopeAsync(work, (handler, job, ct) => handler.RecordExternalAsync(job, staged, result, ct),
            cancellationToken).ConfigureAwait(false);
    }

    private async Task<IsolatedOutcome<ExternalStep?>> StageActionAsync(
        Work work, Step step, PetRunProposal proposal, CancellationToken cancellationToken)
    {
        if (!await HoldAsync(work, cancellationToken).ConfigureAwait(false)
            || await CurrentAsync(work, cancellationToken).ConfigureAwait(false) is not { } current
            || current.Run.Revision != step.Run.Revision)
        {
            return new IsolatedOutcome<ExternalStep?>(null, false);
        }
        var undo = proposal.Status == "undo_pending";
        if (!await AvailableAsync(current, cancellationToken).ConfigureAwait(false)
            || !_capabilities.TryGetValue(proposal.Capability, out var capability)
            || proposal.Automatic && !undo && !await AllowsRoutineAsync(current.Run, current.State, capability,
                new PetRunEffect(proposal.Description, proposal.Preview), cancellationToken).ConfigureAwait(false))
        {
            var stopped = await StopAsync(current.Run, Replace(current.State, proposal with { Status = "refused" }),
                "failed", cancellationToken).ConfigureAwait(false);
            return new IsolatedOutcome<ExternalStep?>(null, stopped);
        }

        if (capability.Atomic)
        {
            var result = await ApplyAsync(capability, EffectiveRun(current.Run, current.State), proposal, undo, cancellationToken)
                .ConfigureAwait(false);
            var saved = await FinishActionAsync(current, proposal, result, undo, false, cancellationToken).ConfigureAwait(false);
            return new IsolatedOutcome<ExternalStep?>(null, saved);
        }

        var applying = proposal with { Status = undo ? "undo_applying" : "applying" };
        var nextState = Replace(current.State, applying);
        var next = Next(current.Run, nextState, "running");
        return await runs.UpdateAsync(next, current.Run.Revision, cancellationToken).ConfigureAwait(false)
            ? new IsolatedOutcome<ExternalStep?>(new ExternalStep(new Step(next, nextState), applying, undo), true)
            : new IsolatedOutcome<ExternalStep?>(null, false);
    }

    private async Task<IsolatedOutcome<Result<string>?>> ApplyExternalAsync(
        Work work, ExternalStep staged, CancellationToken cancellationToken)
    {
        if (await CurrentAsync(work, cancellationToken).ConfigureAwait(false) is not { } current
            || current.Run.Revision != staged.Step.Run.Revision
            || !await AvailableAsync(current, cancellationToken).ConfigureAwait(false))
        {
            return new IsolatedOutcome<Result<string>?>(null, false);
        }
        var capability = _capabilities[staged.Proposal.Capability];
        if (staged.Proposal.Automatic && !staged.Undo && !await AllowsRoutineAsync(current.Run, current.State, capability,
            new PetRunEffect(staged.Proposal.Description, staged.Proposal.Preview), cancellationToken).ConfigureAwait(false))
        {
            return new IsolatedOutcome<Result<string>?>(null, false);
        }
        if (await dispatch.AuthorizeExecutionAsync(work.Job.Job.Id, work.Job.ExecutionId, cancellationToken).ConfigureAwait(false) is null)
        {
            return new IsolatedOutcome<Result<string>?>(null, false);
        }
        var result = await ApplyAsync(capability, EffectiveRun(current.Run, current.State), staged.Proposal, staged.Undo, cancellationToken)
            .ConfigureAwait(false);
        return new IsolatedOutcome<Result<string>?>(result, result.IsSuccess);
    }

    private async Task<IsolatedOutcome<bool>> RecordExternalAsync(
        Work work, ExternalStep staged, Result<string>? result, CancellationToken cancellationToken)
    {
        if (!await HoldAsync(work, cancellationToken).ConfigureAwait(false)
            || await CurrentAsync(work, cancellationToken).ConfigureAwait(false) is not { } current
            || current.Run.Revision != staged.Step.Run.Revision)
        {
            return new IsolatedOutcome<bool>(false, false);
        }
        var saved = await FinishActionAsync(current, staged.Proposal, result, staged.Undo, true, cancellationToken)
            .ConfigureAwait(false);
        return new IsolatedOutcome<bool>(saved, saved);
    }

    private async Task<bool> FinishActionAsync(
        Step current, PetRunProposal proposal, Result<string>? result, bool undo, bool external, CancellationToken cancellationToken)
    {
        if (!undo && result is { IsFailure: true } stale && stale.Error.Code is "pet_runs.canvas_stale" or "pet_runs.stale_review" or "items.body_conflict")
        {
            return await StopAsync(current.Run, Replace(current.State, proposal with { Status = "stale" }),
                "waiting_for_approval", cancellationToken).ConfigureAwait(false);
        }
        var receipt = result is { IsSuccess: true } ? result.Value.Value : null;
        var unknown = external && result is { IsFailure: true } failure
            && failure.Error.Code is not ("browser.form_changed" or "browser.attachments_changed" or "browser.connection_changed"
                or "browser.invalid" or "connector.changed" or "connector.not_found" or "connector.invalid"
                or "pet_runs.canvas_refused" or "pet_runs.canvas_stale" or "pet_runs.sheet_refused"
                or "pet_runs.stale_review" or "items.body_conflict");
        if (receipt is not null && (Encoding.UTF8.GetByteCount(receipt) > MaxReceiptBytes
            || !await AvailableAsync(current, cancellationToken).ConfigureAwait(false)))
        {
            if (!external)
            {
                throw WorkerJobException.Fail("pet_runs.receipt_unavailable", "The pet action could not be recorded.");
            }
            unknown = true;
            receipt = null;
        }

        var state = Replace(current.State, proposal with
        {
            Status = receipt is null ? (unknown ? "unknown" : undo ? "undo_refused" : "refused") : (undo ? "undone" : "applied"),
            Receipt = undo ? proposal.Receipt : receipt,
        });
        if (receipt is not null)
        {
            var text = undo ? $"Undid {proposal.Description}" : proposal.Description;
            var reversible = !undo && _capabilities[proposal.Capability].Reversible;
            state = state with
            {
                Results = [.. state.Results.Where(item => item.Id != proposal.Id),
                new PetRunResult(proposal.Id, text, reversible)]
            };
        }
        else if (undo)
        {
            state = state with
            {
                Results = [.. state.Results.Select(item => item.Id == proposal.Id
                ? item with { Reversible = false } : item)]
            };
        }
        if (!Fits(state))
        {
            if (!external)
            {
                throw WorkerJobException.Fail("pet_runs.receipt_unavailable", "The pet job reached its receipt size limit.");
            }
            unknown = true;
            receipt = null;
            state = Replace(current.State, proposal with { Status = "unknown" });
        }

        if (unknown || receipt is null || undo)
        {
            if (receipt is null)
            {
                state = state with
                {
                    Failure = RunFailure("apply", result is { IsFailure: true } refusal ? refusal.Error
                        : new NixError("pet_runs.outcome_unknown", "The result could not be confirmed.")),
                };
            }
            var status = unknown ? "review_required" : undo ? current.State.UndoResumeStatus ?? "completed" : "failed";
            return await StopAsync(current.Run, state with { UndoResumeStatus = null }, status,
                cancellationToken).ConfigureAwait(false);
        }
        if (proposal.Capability == "peer.delegate")
        {
            return await StopAsync(current.Run, state, "waiting_for_handoff", cancellationToken).ConfigureAwait(false);
        }
        var queued = await QueueAsync(current.Run, state, cancellationToken).ConfigureAwait(false);
        return queued.IsSuccess;
    }

    private static Task<Result<string>> ApplyAsync(
        IPetRunCapability capability, PetRunRecord run, PetRunProposal proposal, bool undo, CancellationToken cancellationToken)
    {
        var effect = new PetRunEffect(proposal.Description, proposal.Preview);
        if (!undo)
        {
            return capability.ApplyAsync(run, proposal.Id, effect, cancellationToken);
        }
        return capability.Reversible && proposal is { UndoId: { } id, Receipt: { } receipt }
            ? capability.UndoAsync(run, id, effect, receipt, cancellationToken)
            : Task.FromResult(Result.Failure<string>(new NixError("pet_runs.not_reversible", "This action cannot be undone.")));
    }

    private async Task<bool> StopAsync(PetRunRecord run, PetRunCheckpoint state, string status, CancellationToken cancellationToken)
    {
        var next = Next(run, state with { ActiveJobId = null }, status);
        if (!await runs.UpdateAsync(next, run.Revision, cancellationToken).ConfigureAwait(false))
        {
            return false;
        }
        if (status is "waiting_for_input" or "waiting_for_approval")
        {
            await PetRunDecisionNotices.CreateAsync(notifications, next, state, cancellationToken).ConfigureAwait(false);
        }
        return true;
    }

    private static PetRunFailure RunFailure(string stage, NixError error)
    {
        var code = error.Code.Length is > 0 and <= 80
            && error.Code.All(character => char.IsAsciiLetterLower(character) || char.IsAsciiDigit(character) || character is '.' or '_')
                ? error.Code : "pet_runs.step_unavailable";
        // These messages originate in Core's argument parser and scope checks, never in provider output.
        var message = code == "pet_runs.invalid_action" && stage == "preview"
            ? Cut(error.Message, 500)
            : code switch
            {
                "pets.task_step_invalid" => "The pet returned a planning step that Nix could not use. Retry the job.",
                "pets.task_context_invalid" => "The selected job context is invalid or too large. Use a smaller scope.",
                "pet_runs.preview_unavailable" => "The draft could not be prepared. Refresh the job and try again.",
                PetUsageService.BudgetExhausted => PetUsageService.BudgetExhaustedMessage,
                _ => stage switch
                {
                    "planning" => "The pet could not finish planning this step. Check the connection and retry.",
                    "preview" => "Nix could not prepare this action for review. Check the selected item and job access.",
                    _ => "Nix could not confirm this change. Check its target before deciding what to do next.",
                },
            };
        return new PetRunFailure(stage, code, message);
    }

    private static bool Fits(PetRunCheckpoint checkpoint) =>
        Encoding.UTF8.GetByteCount(Serialize(checkpoint).GetRawText()) <= MaxCheckpointBytes;

    private async Task<bool> AllowsRoutineAsync(PetRunRecord run, PetRunCheckpoint state, IPetRunCapability capability,
        PetRunEffect effect, CancellationToken cancellationToken) =>
        capability.Reversible && capability.RoutineEligible(effect) && state.Routine is { } routine
        && services.GetService<IPetRunRoutineAuthorization>() is { } policy
        && await policy.AllowsAsync(routine, run, capability.Name, effect, cancellationToken)
            .ConfigureAwait(false);

    private static string Cut(string text, int limit) => TextCut.Cut(text, limit);
}
