using System.Text;
using Nix.Abstractions;
using Nix.Abstractions.PetRuns;
using Nix.Domain.Items;

namespace Nix.Features.PetRuns;

internal sealed partial class PetRunService
{
    private async Task ExecuteAdoptedReadsAsync(Work work, Step step, CancellationToken cancellationToken)
    {
        var plan = step.State.Plan!;
        var included = plan.Steps.Where(effect => effect.IncludedInReview).ToArray();
        if (included.Length == 0 || included.Any(effect => _capabilities[effect.Capability].RequiresApproval(effect.Effect)))
        {
            return;
        }
        var pending = included.FirstOrDefault(effect => effect.Status == "pending");
        if (pending is null)
        {
            return;
        }
        var ready = await InWorkerScopeAsync(work, async (handler, job, ct) =>
        {
            var current = await handler.CurrentAsync(job, ct).ConfigureAwait(false);
            if (current is null || !await handler.HoldAsync(job, ct).ConfigureAwait(false)
                || !await handler.AvailableAsync(current, ct).ConfigureAwait(false))
            {
                return new IsolatedOutcome<Step?>(null, false);
            }
            return new IsolatedOutcome<Step?>(current, false);
        }, cancellationToken).ConfigureAwait(false);
        if (ready is null)
        {
            return;
        }
        var capability = _capabilities[pending.Capability];
        PetPlanExecutionOutcome outcome;
        if (capability is IPetPlanDiscoveryCapability trusted)
        {
            outcome = await trusted.DiscoverAsync(EffectiveRun(ready.Run, ready.State), pending.Effect, cancellationToken).ConfigureAwait(false);
        }
        else
        {
            var read = await capability.ApplyAsync(EffectiveRun(ready.Run, ready.State), pending.Id, pending.Effect, cancellationToken).ConfigureAwait(false);
            outcome = new(read.IsSuccess ? "applied" : "refused", read.IsSuccess ? read.Value : null, read.IsFailure ? read.Error : null);
        }
        await InWorkerScopeAsync(work, async (handler, job, ct) =>
        {
            var current = await handler.CurrentAsync(job, ct).ConfigureAwait(false);
            if (current?.State.Plan is not { } active || active.Id != plan.Id || active.Version != plan.Version
                || !await handler.HoldAsync(job, ct).ConfigureAwait(false))
            {
                return new IsolatedOutcome<bool>(false, false);
            }
            var receipt = outcome.Receipt;
            var success = outcome.Status == "applied" && receipt is not null && Encoding.UTF8.GetByteCount(receipt) <= MaxReceiptBytes;
            var sources = outcome.SourceItemIds ?? [.. WriteTargets(pending.Effect.Parameters)];
            var observation = new PetRunProposal(pending.Id, pending.Capability, pending.Effect.Description, pending.Effect.Parameters,
                success ? "applied" : "refused", Receipt: receipt, SourceItemIds: sources,
                UnboundedSourceProvenance: outcome.UnboundedSourceProvenance);
            var visible = success && (outcome.UnboundedSourceProvenance
                ? await handler.BroadReadAvailableAsync(current.Run, current.State, ct).ConfigureAwait(false)
                : await handler.ObservationAvailableAsync(current.Run, observation, ct).ConfigureAwait(false));
            var effect = pending with
            {
                Status = success ? "applied" : outcome.Status is "unknown" or "partial" ? outcome.Status : "refused",
                Receipt = receipt is not null && Encoding.UTF8.GetByteCount(receipt) <= MaxReceiptBytes ? receipt : null,
                SourceItemIds = sources,
                UnboundedSourceProvenance = outcome.UnboundedSourceProvenance,
                ObservationBlocked = !visible
            };
            var state = ReplacePlanStep(current.State, effect);
            state = state with { PlanRequest = state.PlanRequest! with { ProtectedRead = state.PlanRequest.ProtectedRead || outcome.LockedContent } };
            if (!success)
            {
                state = state with
                {
                    Plan = state.Plan! with
                    {
                        Status = "review_required",
                        Steps = [.. state.Plan.Steps.Select(value =>
                    value.Status == "pending" ? value with { Status = "cancelled", Receipt = "Not dispatched because discovery stopped." } : value)]
                    }
                };
                var stopped = await handler.FinishOrResolveSourcesAsync(current.Run, state, "review_required", ct).ConfigureAwait(false);
                return new IsolatedOutcome<bool>(stopped, stopped);
            }
            if (state.Plan!.Steps.All(value => value.Status is "applied" or "cancelled"))
            {
                state = state with { Plan = state.Plan with { Status = "completed" } };
                var completed = await handler.FinishOrResolveSourcesAsync(current.Run, state, "completed", ct).ConfigureAwait(false);
                return new IsolatedOutcome<bool>(completed, completed);
            }
            var queued = await handler.QueuePlanAsync(current.Run, state, ct).ConfigureAwait(false);
            return new IsolatedOutcome<bool>(queued.IsSuccess, queued.IsSuccess);
        }, cancellationToken).ConfigureAwait(false);
    }

    private async Task ExecutePlanDiscoveryAsync(Work work, Step step, CancellationToken cancellationToken)
    {
        var discovery = step.State.Discovery!;
        if (!_capabilities.TryGetValue(discovery.Capability, out var capability) || capability.RequiresApproval(discovery.Effect))
        {
            return;
        }
        var ready = await InWorkerScopeAsync(work, async (handler, job, ct) =>
        {
            var current = await handler.CurrentAsync(job, ct).ConfigureAwait(false);
            if (current is null || current.State.Discovery?.Id != discovery.Id || !await handler.HoldAsync(job, ct).ConfigureAwait(false)
                || !await handler.AvailableAsync(current, ct).ConfigureAwait(false))
            {
                return new IsolatedOutcome<Step?>(null, false);
            }
            return new IsolatedOutcome<Step?>(current, false);
        }, cancellationToken).ConfigureAwait(false);
        if (ready is null)
        {
            return;
        }
        PetPlanExecutionOutcome outcome;
        if (capability is IPetPlanDiscoveryCapability trusted)
        {
            outcome = await trusted.DiscoverAsync(EffectiveRun(ready.Run, ready.State), discovery.Effect, cancellationToken).ConfigureAwait(false);
        }
        else
        {
            var result = await capability.ApplyAsync(EffectiveRun(ready.Run, ready.State), discovery.Id, discovery.Effect, cancellationToken).ConfigureAwait(false);
            outcome = new(result.IsSuccess ? "applied" : "refused", result.IsSuccess ? result.Value : null,
                result.IsFailure ? result.Error : null, SourceItemIds: [.. WriteTargets(discovery.Effect.Parameters)]);
        }
        await InWorkerScopeAsync(work, async (handler, job, ct) =>
        {
            var current = await handler.CurrentAsync(job, ct).ConfigureAwait(false);
            if (current is null || current.State.Discovery?.Id != discovery.Id || !await handler.HoldAsync(job, ct).ConfigureAwait(false))
            {
                return new IsolatedOutcome<bool>(false, false);
            }
            var receipt = outcome.Receipt;
            if (receipt is null || Encoding.UTF8.GetByteCount(receipt) > MaxReceiptBytes || outcome.Status != "applied")
            {
                var stopped = await handler.StopAsync(current.Run, current.State with
                {
                    Discovery = null,
                    Failure = new("discovery", outcome.Failure?.Code ?? "pet_plans.discovery_unavailable",
                        outcome.Failure?.Message ?? "The discovery result could not be confirmed.")
                }, "review_required", ct).ConfigureAwait(false);
                return new IsolatedOutcome<bool>(stopped, stopped);
            }
            var sources = outcome.SourceItemIds ?? [.. WriteTargets(discovery.Effect.Parameters)];
            var broad = outcome.UnboundedSourceProvenance && await handler.BroadReadAvailableAsync(current.Run, current.State, ct).ConfigureAwait(false);
            var observation = new PetRunProposal(discovery.Id, discovery.Capability, discovery.Effect.Description, discovery.Effect.Parameters,
                "applied", Receipt: receipt, SourceItemIds: sources, ObservationBlocked: outcome.UnboundedSourceProvenance && !broad,
                UnboundedSourceProvenance: outcome.UnboundedSourceProvenance);
            var state = current.State with
            {
                Discovery = null,
                Proposals = [.. current.State.Proposals, observation],
                PlanRequest = current.State.PlanRequest! with { ProtectedRead = current.State.PlanRequest.ProtectedRead || outcome.LockedContent }
            };
            if (observation.ObservationBlocked || !await handler.ObservationAvailableAsync(current.Run, observation, ct).ConfigureAwait(false))
            {
                state = state with
                {
                    Proposals = [.. current.State.Proposals, observation with { ObservationBlocked = true }],
                    Question = new(Guid.NewGuid(), "This result needs specific source items before it can inform another change. Describe the values to use, or cancel and start with a narrower source scope.")
                };
                var saved = await handler.StopAsync(current.Run, state, "waiting_for_input", ct).ConfigureAwait(false);
                return new IsolatedOutcome<bool>(saved, saved);
            }
            var queued = await handler.QueuePlanAsync(current.Run, state, ct).ConfigureAwait(false);
            return new IsolatedOutcome<bool>(queued.IsSuccess, queued.IsSuccess);
        }, cancellationToken).ConfigureAwait(false);
    }

    private async Task<bool> BroadReadAvailableAsync(PetRunRecord run, PetRunCheckpoint state, CancellationToken cancellationToken)
    {
        if (state.PlanRequest?.SourceScope.Kind != "workspace")
        {
            return false;
        }
        foreach (var raw in new[] { run.WorkspaceId.Value }.Concat(state.PlanRequest.SourceScope.ReadOnlyWorkspaceIds ?? []).Distinct())
        {
            var workspace = Nix.Domain.Tenancy.WorkspaceId.From(raw);
            if (!await WorkspaceAvailableAsync(workspace, cancellationToken).ConfigureAwait(false)
                || await items.AnyItemsWithheldFromPetsAsync(workspace, cancellationToken).ConfigureAwait(false)
                || await itemLocks.AnyInWorkspaceAsync(workspace, cancellationToken).ConfigureAwait(false))
            {
                return false;
            }
        }
        return true;
    }

    private async Task<bool> ObservationAvailableAsync(PetRunRecord run, PetRunProposal proposal, CancellationToken cancellationToken)
    {
        if (proposal.ObservationBlocked)
        {
            return false;
        }
        if (proposal.UnboundedSourceProvenance && !await BroadReadAvailableAsync(run, Checkpoint(run), cancellationToken).ConfigureAwait(false))
        {
            return false;
        }
        foreach (var raw in proposal.SourceItemIds ?? [])
        {
            var item = await items.FindAsync(ItemId.From(raw), cancellationToken).ConfigureAwait(false);
            if (item is null || !CanUseSource(item) || item.WorkspaceId != run.WorkspaceId
                && Checkpoint(run).PlanRequest?.SourceScope.ReadOnlyWorkspaceIds?.Contains(item.WorkspaceId.Value) != true
                || !await WorkspaceAvailableAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false)
                || (await itemLocks.GetStateAsync(item.Id, cancellationToken).ConfigureAwait(false)).Locked)
            {
                return false;
            }
            var scope = Checkpoint(run).PlanRequest?.SourceScope;
            if (item.WorkspaceId == run.WorkspaceId && scope is not null
                && (scope.Kind == "selected" && scope.ItemIds?.Contains(raw) != true
                    || scope.Kind == "subtree" && !await items.IsVisibleSubtreeMemberAsync(item.WorkspaceId,
                        ItemId.From(scope.ItemIds![0]), item.Id, cancellationToken).ConfigureAwait(false)))
            {
                return false;
            }
        }
        return true;
    }
}
