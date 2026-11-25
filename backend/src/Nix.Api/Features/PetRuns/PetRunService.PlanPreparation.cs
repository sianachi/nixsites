using System.Text.Json;
using Nix.Abstractions.PetRuns;
using Nix.Domain.Primitives;
using Nix.Features.Pets;

namespace Nix.Features.PetRuns;

internal sealed partial class PetRunService
{
    private async Task<Result<PetPlanPrepared>> PreparePlanAsync(PetRunRecord run, PetRunCheckpoint state,
        string summary, IReadOnlyList<PetTaskPlanStep> proposed, CancellationToken cancellationToken)
    {
        if (proposed.Count is < 1 or > PetPlanExecution.MaximumSteps || state.PlanRequest is null)
        {
            return PlanPreparationFailure("Prepare between one and twelve concrete changes.");
        }
        var provenance = await services.GetRequiredService<PetPlanSourceGuard>().CheckAsync(run, state, cancellationToken).ConfigureAwait(false);
        if (!provenance.Available)
        {
            return PlanPreparationFailure("The original conversation changed. Prepare a fresh plan in that conversation.");
        }
        state = state with { PlanRequest = state.PlanRequest with { ProtectedRead = state.PlanRequest.ProtectedRead || provenance.ProtectedRead } };
        if (!await services.GetRequiredService<PetPlanDispatchService>().SourcesAvailableAsync(run, state, cancellationToken).ConfigureAwait(false))
        {
            return PlanPreparationFailure("The sources used by this plan are no longer available. Start a new conversation or choose current sources.");
        }
        var descriptor = await services.GetRequiredService<PetPlanSharingService>().DescribeAsync(run.WorkspaceId.Value,
            state.PetId, state.PlanRequest.SourceScope, cancellationToken).ConfigureAwait(false);
        if (descriptor.IsFailure)
        {
            return Result.Failure<PetPlanPrepared>(descriptor.Error);
        }
        var prepared = new List<PetPlanPreparedStep>();
        var priorTargets = new HashSet<Guid>();
        foreach (var step in proposed)
        {
            if (!RunAbilities(run, state).Contains(step.Capability, StringComparer.Ordinal)
                || !_capabilities.TryGetValue(step.Capability, out var capability)
                || state.PlanRequest.SourceReadOnly && !PetWorkspaceToolCapability.ReadOnlyOperation(step.Capability)
                || step.Arguments.ValueKind != JsonValueKind.Object)
            {
                return PlanPreparationFailure("This plan contains an unavailable change.");
            }
            var preview = await capability.PreviewAsync(EffectiveRun(run, state), step.Arguments, cancellationToken).ConfigureAwait(false);
            if (preview.IsFailure)
            {
                return Result.Failure<PetPlanPrepared>(preview.Error);
            }
            var effect = preview.Value;
            if (state.PlanRequest.SourceReadOnly && capability.RequiresApproval(effect))
            {
                return PlanPreparationFailure("This conversation may only read its shared sources. Start a writable task to prepare changes.");
            }
            if (string.IsNullOrWhiteSpace(effect.Description) || effect.Parameters.ValueKind != JsonValueKind.Object)
            {
                return PlanPreparationFailure("This change needs a complete preview before it can be reviewed.");
            }
            var adapter = capability as IPetPlanCapability;
            var executor = adapter?.Executor(effect) ?? "server";
            if (executor is not ("server" or "client"))
            {
                return PlanPreparationFailure("This change has no supported executor.");
            }
            var arguments = adapter?.Arguments(effect, step.Arguments) ?? step.Arguments;
            var fields = adapter?.Fields(effect) ?? PetPlanExecution.Fields(arguments, effect);
            // First-version plans cannot rebase a later approved preview after an earlier write.
            var targets = WriteTargets(effect.Parameters);
            if (targets.Overlaps(priorTargets))
            {
                return PlanPreparationFailure("Changes to the same target need one supported batch or separate reviewed plans.");
            }
            if (capability.RequiresApproval(effect))
            {
                priorTargets.UnionWith(targets);
            }
            prepared.Add(new(Guid.NewGuid(), step.Capability, arguments.Clone(), effect, executor, "pending", fields));
        }
        var scopeDigest = PetPlanExecution.Hash(JsonSerializer.SerializeToElement(new
        {
            sourceScope = state.PlanRequest.SourceScope,
            sharingDigest = descriptor.Value.ScopeDigest,
            descriptor.Value.RecipientRevision,
            state.PlanRequest.ProtectedRead,
            state.PlanRequest.DisclosureSourceItemIds,
            state.PlanRequest.UnboundedDisclosure,
            effects = prepared.Select(step => new { step.Capability, step.Effect, step.Executor }),
        }));
        var plan = new PetPlanPrepared(state.Plan?.Id ?? Guid.NewGuid(), checked((state.Plan?.Version ?? 0) + 1),
            Cut(summary, 1600), "", scopeDigest, descriptor.Value.RecipientRevision, "awaiting_review", prepared,
            ProtectedRead: state.PlanRequest.ProtectedRead);
        if (state.PlanRequest.ChatSource is not null && prepared.Any(step => !_capabilities[step.Capability].RequiresApproval(step.Effect)))
        {
            plan = plan with
            {
                Summary = "Read the shared sources before preparing changes.",
                Steps = [.. plan.Steps.Select(step =>
                _capabilities[step.Capability].RequiresApproval(step.Effect) ? step with { Status = "cancelled", IncludedInReview = false,
                    Receipt = "Not dispatched. Discovery must finish before a fresh write plan can be prepared." } : step)]
            };
        }
        plan = plan with { ReviewDigest = PetPlanExecution.Digest(run, plan) };
        return Fits(state with { Plan = plan }) ? Result.Success(plan) : PlanPreparationFailure("Prepare a smaller plan so its review and receipts can be saved.");
    }

    private static HashSet<Guid> WriteTargets(JsonElement preview)
    {
        var ids = new HashSet<Guid>();
        foreach (var key in new[] { "itemId", "parentId", "targetId" })
        {
            if (preview.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String && value.TryGetGuid(out var id))
            {
                ids.Add(id);
            }
        }
        if (preview.TryGetProperty("targetIds", out var targets) && targets.ValueKind == JsonValueKind.Array)
        {
            foreach (var target in targets.EnumerateArray())
            {
                if (target.ValueKind == JsonValueKind.String && target.TryGetGuid(out var id))
                {
                    ids.Add(id);
                }
            }
        }
        if (preview.TryGetProperty("targets", out var named) && named.ValueKind == JsonValueKind.Array)
        {
            foreach (var target in named.EnumerateArray())
            {
                if ((target.TryGetProperty("id", out var value) || target.TryGetProperty("Id", out value))
                    && value.ValueKind == JsonValueKind.String && value.TryGetGuid(out var id))
                {
                    ids.Add(id);
                }
            }
        }
        return ids;
    }

    private static Result<PetPlanPrepared> PlanPreparationFailure(string message) =>
        Result.Failure<PetPlanPrepared>(new NixError("pet_plans.preview_unavailable", message));
}
