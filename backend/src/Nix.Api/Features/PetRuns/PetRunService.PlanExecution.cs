using System.Text;
using System.Text.Json;
using Nix.Abstractions;
using Nix.Abstractions.PetRuns;
using Nix.Domain.Primitives;

namespace Nix.Features.PetRuns;

internal sealed partial class PetRunService
{
    private async Task AdvancePlanAsync(Work work, Step step, CancellationToken cancellationToken)
    {
        if (step.State.Discovery is not null)
        {
            await ExecutePlanDiscoveryAsync(work, step, cancellationToken).ConfigureAwait(false);
            return;
        }
        if (step.State.PlanRequest?.PendingFinalStatus is not null)
        {
            await ResolveSourceReceiptsAsync(work, step, cancellationToken).ConfigureAwait(false);
            return;
        }
        if (step.State.PlanRequest?.ReadPhase == true && step.State.Plan?.Status is "discovery" or "approved")
        {
            await ExecuteAdoptedReadsAsync(work, step, cancellationToken).ConfigureAwait(false);
            return;
        }
        if (step.State.Plan is { Status: "adopting" })
        {
            await AdoptStoredPlanAsync(work, step.Run.Id, cancellationToken).ConfigureAwait(false);
            return;
        }
        if (step.State.Plan is not { Status: "approved" or "cancelled" } plan)
        {
            if (step.State.PlanRequest is { ChatSource: not null, SourceBindings: null })
            {
                await PrepareChatPlanAsync(work, step, cancellationToken).ConfigureAwait(false);
                return;
            }
            await ExecuteTurnAsync(work, step, cancellationToken).ConfigureAwait(false);
            return;
        }
        var next = plan.Steps.FirstOrDefault(candidate => candidate.Status is "pending" or "claimed" or "applying" or "undo_pending" or "undo_claimed");
        if (next is null)
        {
            await InWorkerScopeAsync(work, async (handler, job, ct) =>
            {
                var current = await handler.CurrentAsync(job, ct).ConfigureAwait(false);
                if (current is null || !await handler.HoldAsync(job, ct).ConfigureAwait(false))
                {
                    return new IsolatedOutcome<bool>(false, false);
                }
                var completed = current.State with { Plan = current.State.Plan! with { Status = plan.Status == "cancelled" ? "cancelled" : "completed" } };
                var saved = await handler.StopAsync(current.Run, completed, completed.Plan.Status, ct).ConfigureAwait(false);
                return new IsolatedOutcome<bool>(saved, saved);
            }, cancellationToken).ConfigureAwait(false);
            return;
        }
        if (plan.Status == "cancelled" && next.Status != "applying")
        {
            return;
        }
        if (next.Executor == "client" && next.Execution is null)
        {
            await InWorkerScopeAsync(work, async (handler, job, ct) =>
            {
                var current = await handler.CurrentAsync(job, ct).ConfigureAwait(false);
                var saved = current is not null && await handler.HoldAsync(job, ct).ConfigureAwait(false)
                    && await handler.StopAsync(current.Run, current.State, "waiting_for_handoff", ct).ConfigureAwait(false);
                return new IsolatedOutcome<bool>(saved, saved);
            }, cancellationToken).ConfigureAwait(false);
            return;
        }
        var claimed = await InWorkerScopeAsync(work, (handler, job, ct) => handler.ClaimWorkerPlanStepAsync(job, plan, next, ct), cancellationToken)
            .ConfigureAwait(false);
        if (claimed is null)
        {
            return;
        }
        var frozen = claimed.State.Plan!.Steps.Single(candidate => candidate.Id == next.Id);
        var capability = _capabilities[frozen.Capability];
        if (capability.Atomic)
        {
            await InWorkerScopeAsync(work, (handler, job, ct) => handler.ApplyAtomicPlanStepAsync(job, frozen, ct), cancellationToken).ConfigureAwait(false);
            return;
        }
        var staged = await InWorkerScopeAsync(work, (handler, job, ct) => handler.StagePlanStepAsync(job, frozen, ct), cancellationToken)
            .ConfigureAwait(false);
        if (staged is null)
        {
            return;
        }
        var effect = staged.State.Plan!.Steps.Single(candidate => candidate.Id == next.Id);
        PetPlanExecutionOutcome outcome;
        try
        {
            outcome = await InWorkerScopeAsync(work, async (handler, job, ct) =>
            {
                var current = await handler.CurrentAsync(job, ct).ConfigureAwait(false);
                if (current is null || !SameExecution(current.State, effect) || !await handler.AvailableAsync(current, ct).ConfigureAwait(false))
                {
                    return new IsolatedOutcome<PetPlanExecutionOutcome>(new("unknown", null,
                        new NixError("pet_plans.outcome_unknown", "The result could not be confirmed.")), false);
                }
                var effective = EffectiveRun(current.Run, current.State) with { PlanExecution = handler.ExecutionBinding(current.Run, current.State.Plan!, effect) };
                if (effect.Status is not ("undo_claimed" or "undo_applying") && handler._capabilities[effect.Capability] is IPetPlanOutcomeCapability prepared)
                {
                    var observed = await prepared.ApplyPlanAsync(effective, effect.Execution!.ExecutionId, effect.Effect, ct).ConfigureAwait(false);
                    return new IsolatedOutcome<PetPlanExecutionOutcome>(observed, observed.Status == "applied");
                }
                var applied = effect.Status is "undo_claimed" or "undo_applying"
                    ? await handler._capabilities[effect.Capability].UndoAsync(effective, effect.UndoId!.Value, effect.Effect, effect.Receipt!, ct).ConfigureAwait(false)
                    : await handler._capabilities[effect.Capability].ApplyAsync(effective, effect.Execution!.ExecutionId, effect.Effect, ct).ConfigureAwait(false);
                return new IsolatedOutcome<PetPlanExecutionOutcome>(new(applied.IsSuccess ? "applied" :
                    applied.Error.Code == "pet_plans.waiting_client" ? "waiting_for_handoff" : "failed",
                    applied.IsSuccess ? applied.Value : null, applied.IsFailure ? applied.Error : null), applied.IsSuccess);
            }, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is HttpRequestException or IOException or OperationCanceledException)
        {
            outcome = new("unknown", null, new NixError("pet_plans.outcome_unknown", "The result could not be confirmed. Review the target before continuing."));
        }
        await InWorkerScopeAsync(work, (handler, job, ct) => handler.RecordWorkerPlanStepAsync(job, effect, outcome, ct), cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task<IsolatedOutcome<Step?>> ClaimWorkerPlanStepAsync(Work work, PetPlanPrepared expected,
        PetPlanPreparedStep step, CancellationToken cancellationToken)
    {
        var current = await CurrentAsync(work, cancellationToken).ConfigureAwait(false);
        if (current is null || current.State.Plan is not { } plan || !PetPlanExecution.Matches(plan, expected.Id, expected.Version, expected.ReviewDigest)
            || !await HoldAsync(work, cancellationToken).ConfigureAwait(false) || !await AvailableAsync(current, cancellationToken).ConfigureAwait(false))
        {
            return new IsolatedOutcome<Step?>(null, false);
        }
        var active = plan.Steps.SingleOrDefault(candidate => candidate.Id == step.Id);
        if (active is null)
        {
            return new IsolatedOutcome<Step?>(null, false);
        }
        if (active.Execution is not null && active.Status is "claimed" or "applying" or "undo_claimed")
        {
            if (active.Executor == "client" || active.Execution.JobId == work.Job.Job.Id && active.Execution.WorkerExecutionId == work.Job.ExecutionId)
            {
                return new IsolatedOutcome<Step?>(current, false);
            }
            if (active.Status is not ("claimed" or "undo_claimed") || active.Execution.Children?.Any(child => child.Status is "dispatched" or "completed") == true)
            {
                return new IsolatedOutcome<Step?>(null, false);
            }
        }
        if (plan.Status != "approved" || active.Status is not ("pending" or "claimed" or "undo_pending" or "undo_claimed"))
        {
            return new IsolatedOutcome<Step?>(null, false);
        }
        var execution = new PetPlanStepExecution(Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.Empty,
            work.Job.Job.Id, clock.GetUtcNow(), WorkerExecutionId: work.Job.ExecutionId);
        var state = ReplacePlanStep(current.State, active with { Status = active.Status is "undo_pending" or "undo_claimed" ? "undo_claimed" : "claimed", Execution = execution });
        var next = Next(current.Run, state, "running");
        return await runs.UpdateAsync(next, current.Run.Revision, cancellationToken).ConfigureAwait(false)
            ? new IsolatedOutcome<Step?>(new(next, state), true) : new IsolatedOutcome<Step?>(null, false);
    }

    private async Task<IsolatedOutcome<Step?>> StagePlanStepAsync(Work work, PetPlanPreparedStep step, CancellationToken cancellationToken)
    {
        var current = await CurrentAsync(work, cancellationToken).ConfigureAwait(false);
        if (current is null || !SameExecution(current.State, step) || !await HoldAsync(work, cancellationToken).ConfigureAwait(false))
        {
            return new IsolatedOutcome<Step?>(null, false);
        }
        var active = current.State.Plan!.Steps.Single(candidate => candidate.Id == step.Id);
        if (!await AvailableAsync(current, cancellationToken).ConfigureAwait(false)
            || !await services.GetRequiredService<PetPlanDispatchService>().SourcesAvailableAsync(current.Run, current.State, cancellationToken).ConfigureAwait(false))
        {
            var held = ReplacePlanStep(current.State, active with { Status = "stale" });
            held = held with
            {
                Plan = held.Plan! with { Status = "review_required" },
                Failure = new("scope", "pet_plans.source_changed", "The plan's sources are no longer available. Review current sources before continuing.")
            };
            var saved = await StopAsync(current.Run, held, "review_required", cancellationToken).ConfigureAwait(false);
            return new IsolatedOutcome<Step?>(null, saved);
        }
        if (current.State.PlanRequest?.SourceReadOnly == true && _capabilities[active.Capability].RequiresApproval(active.Effect))
        {
            return new IsolatedOutcome<Step?>(null, false);
        }
        if (active.Status is "applying" or "undo_applying" && active.Executor == "client")
        {
            return new IsolatedOutcome<Step?>(current, false);
        }
        if (current.State.Plan.Status != "approved" || active.Status is not ("claimed" or "undo_claimed"))
        {
            return new IsolatedOutcome<Step?>(null, false);
        }
        if (active.Status != "undo_claimed")
        {
            var source = await services.GetRequiredService<PetPlanSourceGuard>().CheckAsync(current.Run, current.State, cancellationToken).ConfigureAwait(false);
            if (!source.Available || source.ProtectedRead && !current.State.Plan.ProtectedRead)
            {
                var held = ReplacePlanStep(current.State, active with { Status = "stale" });
                held = held with
                {
                    Plan = held.Plan! with { Status = "review_required" },
                    PlanRequest = held.PlanRequest! with { ProtectedRead = held.PlanRequest.ProtectedRead || source.ProtectedRead },
                    Failure = new("scope", "pet_plans.source_changed", "The source conversation or its protected scope changed. Review a fresh plan.")
                };
                var saved = await StopAsync(current.Run, held, "review_required", cancellationToken).ConfigureAwait(false);
                return new IsolatedOutcome<Step?>(null, saved);
            }
        }
        if (_capabilities[active.Capability].PlanRequestDispatch)
        {
            return new IsolatedOutcome<Step?>(current, false);
        }
        var state = ReplacePlanStep(current.State, active with
        {
            Status = active.Status == "undo_claimed" ? "undo_applying" : "applying",
            Execution = active.Execution! with { DispatchedAt = clock.GetUtcNow() }
        });
        var next = Next(current.Run, state, "running");
        return await runs.UpdateAsync(next, current.Run.Revision, cancellationToken).ConfigureAwait(false)
            ? new IsolatedOutcome<Step?>(new(next, state), true) : new IsolatedOutcome<Step?>(null, false);
    }

    private async Task<IsolatedOutcome<bool>> ApplyAtomicPlanStepAsync(Work work, PetPlanPreparedStep step, CancellationToken cancellationToken)
    {
        var staged = await StagePlanStepAsync(work, step, cancellationToken).ConfigureAwait(false);
        if (staged.Value is not { } current)
        {
            return new(false, false);
        }
        var active = current.State.Plan!.Steps.Single(candidate => candidate.Id == step.Id);
        var effective = EffectiveRun(current.Run, current.State) with { PlanExecution = ExecutionBinding(current.Run, current.State.Plan, active) };
        var capability = _capabilities[active.Capability];
        var result = active.Status == "undo_applying"
            ? await capability.UndoAsync(effective, active.UndoId!.Value, active.Effect, active.Receipt!, cancellationToken).ConfigureAwait(false)
            : await capability.ApplyAsync(effective, active.Execution!.ExecutionId, active.Effect, cancellationToken).ConfigureAwait(false);
        var saved = await FinishPlanStepAsync(current, active, result, false, cancellationToken).ConfigureAwait(false);
        return new(saved, saved);
    }

    private async Task<IsolatedOutcome<bool>> RecordWorkerPlanStepAsync(Work work, PetPlanPreparedStep step,
        PetPlanExecutionOutcome outcome, CancellationToken cancellationToken)
    {
        var current = await CurrentAsync(work, cancellationToken).ConfigureAwait(false);
        if (current is null || !SameExecution(current.State, step) || !await HoldAsync(work, cancellationToken).ConfigureAwait(false))
        {
            return new(false, false);
        }
        if (outcome.LockedContent && current.State.PlanRequest is { } request)
        {
            var changed = !request.ProtectedRead;
            var state = current.State with { PlanRequest = request with { ProtectedRead = true } };
            if (changed && state.Plan?.Steps.Any(effect => effect.Id != step.Id && effect.Status is "pending" or "claimed") == true)
            {
                state = state with
                {
                    Plan = state.Plan with { Status = "review_required" },
                    Failure = new("scope", "pet_plans.protected_scope_changed", "Protected source content changed the scope. Review a fresh plan before further changes.")
                };
            }
            current = current with { State = state };
        }
        if (outcome.Status == "waiting_for_handoff" && step.Executor == "client")
        {
            var waiting = await StopAsync(current.Run, current.State, "waiting_for_handoff", cancellationToken).ConfigureAwait(false);
            return new(waiting, waiting);
        }
        var result = outcome.Status == "applied" && outcome.Receipt is not null ? Result.Success(outcome.Receipt)
            : Result.Failure<string>(outcome.Failure ?? new NixError("pet_plans.outcome_unknown", "This step did not confirm its complete effect."));
        var saved = await FinishPlanStepAsync(current, step, result, true, cancellationToken, outcome.Receipt,
            outcome.Status == "failed" ? null : outcome.Status).ConfigureAwait(false);
        return new(saved, saved);
    }

    private async Task<bool> FinishPlanStepAsync(Step current, PetPlanPreparedStep step, Result<string> result,
        bool external, CancellationToken cancellationToken, string? observedReceipt = null, string? observedStatus = null)
    {
        step = current.State.Plan!.Steps.Single(candidate => candidate.Id == step.Id);
        var undo = step.Status == "undo_applying";
        var status = result.IsSuccess ? undo ? "undone" : "applied"
            : result.Error.Code is "pet_runs.stale_review" or "pet_runs.canvas_stale" or "items.body_conflict" ? "stale"
            : external && result.Error.Code is not ("pet_runs.action_refused" or "pet_runs.canvas_refused" or "pet_runs.sheet_refused" or "pet_plans.refused")
                ? "unknown" : "refused";
        if (observedStatus is "partial" or "unknown" or "refused" or "stale")
        {
            status = observedStatus;
        }
        var observed = result.IsSuccess ? result.Value : observedReceipt;
        var receipt = observed is not null && Encoding.UTF8.GetByteCount(observed) <= MaxReceiptBytes ? observed : null;
        if (result.IsSuccess && receipt is null)
        {
            if (!external)
            {
                throw new InvalidOperationException("The plan receipt exceeds its durable limit.");
            }
            status = "unknown";
        }
        var state = ReplacePlanStep(current.State, step with { Status = status, Receipt = undo ? step.Receipt : receipt });
        state = state with
        {
            Results = receipt is null ? state.Results :
            [.. state.Results.Where(value => value.Id != step.Id), new PetRunResult(step.Id, undo ? "Undid " + step.Effect.Description : step.Effect.Description,
                status == "applied" && !undo && _capabilities[step.Capability].Reversible)]
        };
        if (!Fits(state))
        {
            if (!external)
            {
                throw new InvalidOperationException("The plan receipt cannot be saved.");
            }
            state = ReplacePlanStep(current.State, step with { Status = "unknown", Receipt = null });
            status = "unknown";
        }
        if (status is "unknown" or "stale" or "refused" or "partial")
        {
            state = state with
            {
                Plan = state.Plan! with { Status = "review_required" },
                Failure = new("apply",
                result.IsFailure ? result.Error.Code : "pet_plans.outcome_unknown",
                result.IsFailure ? result.Error.Message : "The result could not be confirmed.")
            };
            state = state with
            {
                Plan = state.Plan! with
                {
                    Steps = [.. state.Plan.Steps.Select(effect => effect.Status is "pending" or "claimed"
                ? effect with { Status = "cancelled" } : effect)]
                }
            };
            return await FinishOrResolveSourcesAsync(current.Run, state, "review_required", cancellationToken).ConfigureAwait(false);
        }
        if (undo)
        {
            var resume = state.UndoResumeStatus ?? "completed";
            state = state with { UndoResumeStatus = null, Plan = state.Plan! with { Status = resume } };
            return await StopAsync(current.Run, state, resume, cancellationToken).ConfigureAwait(false);
        }
        if (state.Plan!.Status == "cancelled")
        {
            return await FinishOrResolveSourcesAsync(current.Run, state, state.Plan.Status == "cancelled" ? "cancelled" : "completed", cancellationToken).ConfigureAwait(false);
        }
        if (state.Plan.Status == "review_required")
        {
            return await StopAsync(current.Run, state, "review_required", cancellationToken).ConfigureAwait(false);
        }
        if (state.Plan.Steps.All(value => value.Status is "applied" or "undone"))
        {
            return await FinishOrResolveSourcesAsync(current.Run, state with { Plan = state.Plan with { Status = "completed" } }, "completed", cancellationToken).ConfigureAwait(false);
        }
        return (await QueuePlanAsync(current.Run, state, cancellationToken).ConfigureAwait(false)).IsSuccess;
    }

    private static bool SameExecution(PetRunCheckpoint state, PetPlanPreparedStep step) => state.Plan?.Steps.Any(active =>
        active.Id == step.Id && active.Execution is { } execution && execution.ExecutionId == step.Execution?.ExecutionId
        && execution.ClaimId == step.Execution?.ClaimId && active.Status is "claimed" or "applying" or "undo_claimed" or "undo_applying") == true;

    private PetPlanExecutionBinding ExecutionBinding(PetRunRecord run, PetPlanPrepared plan, PetPlanPreparedStep step)
    {
        var execution = step.Execution!;
        var hash = _capabilities[step.Capability] is IPetPlanCapability adapter
            ? adapter.FrozenArgumentsHash(step.Effect, step.Arguments) : PetPlanExecution.Hash(step.Arguments);
        return new(run.Id, plan.Id, plan.Version, plan.ReviewDigest, step.Id, execution.ClaimId, execution.ExecutionId,
            hash, execution.JobId, execution.WorkerExecutionId);
    }

    private static PetRunCheckpoint ReplacePlanStep(PetRunCheckpoint state, PetPlanPreparedStep replacement) =>
        state with { Plan = state.Plan! with { Steps = [.. state.Plan.Steps.Select(step => step.Id == replacement.Id ? replacement : step)] } };

    internal async Task<Result<bool>> RecordRuntimePlanResultAsync(PetPlanRuntimeResult request, CancellationToken cancellationToken)
    {
        var run = await runs.GetAsync(request.Binding.RunId, cancellationToken).ConfigureAwait(false);
        if (run is null || run.ActorId != Caller.PrincipalId || run.TenantId != Caller.TenantId
            || request.TenantId != run.TenantId.Value || request.PrincipalId != run.ActorId.Value
            || request.WorkspaceId != run.WorkspaceId.Value || Encoding.UTF8.GetByteCount(request.Receipt) > MaxReceiptBytes)
        {
            return Result.Failure<bool>(Missing());
        }
        var state = Checkpoint(run);
        var step = state.Plan?.Steps.SingleOrDefault(candidate => candidate.Id == request.Binding.StepId);
        if (state.Plan is not { } plan || !PetPlanExecution.Matches(plan, request.Binding.PlanId, request.Binding.PlanVersion, request.Binding.ReviewDigest)
            || step is not { Executor: "client", Execution: { } execution } || execution.ExecutionId != request.Binding.ExecutionId
            || execution.ClaimId != request.Binding.ClaimId || ExecutionBinding(run, plan, step).FrozenArgumentsHash != request.Binding.FrozenArgumentsHash)
        {
            return Result.Failure<bool>(new NixError("pet_plans.conflict", "The runtime result does not match this plan."));
        }
        if (step.Status is "applied" or "unknown" or "refused" or "partial" or "stale")
        {
            return Result.Success(step.Receipt == request.Receipt);
        }
        if (step.Status is not ("applying" or "claimed"))
        {
            return Result.Failure<bool>(new NixError("pet_plans.conflict", "This execution is not awaiting a result."));
        }
        state = state with { PlanRequest = state.PlanRequest! with { ProtectedRead = state.PlanRequest.ProtectedRead || request.LockedContent } };
        var result = request.Success ? Result.Success(request.Receipt) : Result.Failure<string>(new NixError(
            request.Unknown ? "pet_plans.outcome_unknown" : "pet_plans.refused",
            request.Unknown ? "This step could not confirm its complete effect." : "This step stopped before completing the reviewed effect."));
        return Result.Success(await FinishPlanStepAsync(new(run, state), step, result, true, cancellationToken,
            request.Receipt, request.Status ?? (request.Unknown ? "unknown" : request.Success ? "applied" : "refused")).ConfigureAwait(false));
    }

    public async ValueTask<Result<PetPlanStepClaimResponse>> HandleAsync(ClaimPetPlanStep command, CancellationToken cancellationToken)
    {
        var found = await FindPlanAsync(command.WorkspaceId, command.RunId, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<PetPlanStepClaimResponse>(found.Error);
        }
        var run = found.Value;
        var state = Checkpoint(run);
        var request = command.Request;
        var step = state.Plan?.Steps.FirstOrDefault(candidate => candidate.Status is "pending" or "claimed" or "applying");
        if (state.Plan is not { Status: "approved" } plan || !PetPlanExecution.Matches(plan, command.PlanId, request.PlanVersion, request.ReviewDigest)
            || step is not { Executor: "client" } || step.Id != command.StepId
            || request.RunnerContextId == Guid.Empty || request.RequestId == Guid.Empty)
        {
            return Result.Failure<PetPlanStepClaimResponse>(new NixError("pet_plans.conflict", "The client step changed."));
        }
        if (step.Execution is { } existing)
        {
            return existing.RequestId == request.RequestId && existing.RunnerContextId == request.RunnerContextId
                ? Result.Success(ClaimResponse(run, state, step))
                : Result.Failure<PetPlanStepClaimResponse>(new NixError("pet_plans.conflict", "Another client holds this step."));
        }
        if (request.ExpectedRunRevision != run.Revision || step.Status != "pending")
        {
            return Result.Failure<PetPlanStepClaimResponse>(new NixError("pet_plans.conflict", "Refresh this plan before claiming its step."));
        }
        step = step with
        {
            Status = "claimed",
            Execution = new(Guid.NewGuid(), Guid.NewGuid(), request.RequestId,
            request.RunnerContextId, null, clock.GetUtcNow())
        };
        state = ReplacePlanStep(state, step);
        var queued = await QueuePlanAsync(run, state, cancellationToken).ConfigureAwait(false);
        return queued.IsSuccess ? Result.Success(ClaimResponse(run with { Revision = run.Revision + 1, Status = "queued" }, state, step))
            : Result.Failure<PetPlanStepClaimResponse>(queued.Error);
    }

    private PetPlanStepClaimResponse ClaimResponse(PetRunRecord run, PetRunCheckpoint state, PetPlanPreparedStep step) => new(
        RespondPlan(run, state), step.Execution!.ClaimId, step.Execution.ExecutionId, step.Id, step.Capability,
        step.Arguments, PublicEffect(step).Parameters, step.Executor, JsonSerializer.Serialize(ExecutionBinding(run, state.Plan!, step)));

    public async ValueTask<Result<PetPlanResponse>> HandleAsync(RecordPetPlanStep command, CancellationToken cancellationToken)
    {
        var found = await FindPlanAsync(command.WorkspaceId, command.RunId, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<PetPlanResponse>(found.Error);
        }
        var run = found.Value;
        var state = Checkpoint(run);
        var request = command.Request;
        var step = state.Plan?.Steps.SingleOrDefault(candidate => candidate.Id == command.StepId);
        if (state.Plan is not { } plan || !PetPlanExecution.Matches(plan, command.PlanId, request.PlanVersion, request.ReviewDigest)
            || step is not { Executor: "client", Execution: { } execution } || execution.ClaimId != request.ClaimId
            || execution.ExecutionId != request.ExecutionId || request.Status is not ("applied" or "refused" or "unknown")
            || request.Receipt is not null && Encoding.UTF8.GetByteCount(request.Receipt) > MaxReceiptBytes)
        {
            return PlanConflict();
        }
        // The browser may report transport failure, but success comes from the trusted executor's observed receipt.
        if (request.Status == "applied")
        {
            return PlanInvalid("Submit the exact I/O result so Nix can verify this receipt.");
        }
        if (step.Status is "unknown" or "refused")
        {
            return Result.Success(RespondPlan(run, state));
        }
        var saved = await FinishPlanStepAsync(new(run, state), step,
            Result.Failure<string>(new NixError(request.Status == "unknown" ? "pet_plans.outcome_unknown" : "pet_plans.refused",
                request.Status == "unknown" ? "The client could not confirm this result." : "The client declined this effect.")), true, cancellationToken).ConfigureAwait(false);
        if (!saved)
        {
            return PlanConflict();
        }
        var current = await runs.GetAsync(run.Id, cancellationToken).ConfigureAwait(false);
        return current is null ? PlanConflict() : Result.Success(RespondPlan(current, Checkpoint(current)));
    }

    public async ValueTask<Result<PetPlanResponse>> HandleAsync(UndoPetPlanStep command, CancellationToken cancellationToken)
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
        var step = state.Plan?.Steps.SingleOrDefault(candidate => candidate.Id == command.StepId);
        if (run.Revision != command.Request.ExpectedRunRevision || command.Request.RequestId == Guid.Empty
            || state.Plan?.Id != command.PlanId || step is not { Status: "applied", Receipt: not null }
            || !_capabilities[step.Capability].Reversible || run.Status is "queued" or "running")
        {
            return PlanConflict();
        }
        state = ReplacePlanStep(Handled(state, command.Request.RequestId), step with { Status = "undo_pending", Execution = null, UndoId = Guid.NewGuid() });
        return await QueuePlanAsync(run, state with { Plan = state.Plan! with { Status = "approved" }, UndoResumeStatus = run.Status }, cancellationToken).ConfigureAwait(false);
    }
}
