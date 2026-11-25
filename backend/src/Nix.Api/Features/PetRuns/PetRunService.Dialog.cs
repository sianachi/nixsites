using Nix.Abstractions.PetRuns;
using Nix.Domain.Items;
using Nix.Domain.Primitives;

namespace Nix.Features.PetRuns;

internal sealed partial class PetRunService
{
    public async ValueTask<Result<PetRunResponse>> HandleAsync(RevisePetRunProposal command, CancellationToken cancellationToken)
    {
        if (command.Request.Feedback is not null && !ValidText(command.Request.Feedback, 2_000, 8_000))
        {
            return Invalid("Use at most 2000 characters of feedback.");
        }

        var found = await FindAsync(command.ItemId, command.RunId, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<PetRunResponse>(found.Error);
        }

        var run = found.Value;
        var state = Checkpoint(run);
        if (run.Status != "waiting_for_approval" || state.Turns >= MaxTurns || state.Proposals.Count == 0
            || state.Proposals[^1] is not { Status: "pending" or "stale" } pending || pending.Id != command.ProposalId)
        {
            return Conflict();
        }

        var revised = Replace(state, pending with { Status = "superseded", DecisionAt = pending.DecisionAt ?? clock.GetUtcNow() });
        var feedback = command.Request.Feedback?.Trim();
        IReadOnlyList<string> instructions = OwnerRevisions(state);
        return await QueueAsync(run, revised with
        {
            RevisionFeedback = new PetRunRevisionFeedback(pending.Id, feedback),
            OwnerRevisions = feedback is null ? instructions : [.. instructions, feedback],
        }, cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask<Result<PetRunResponse>> HandleAsync(DecidePetRunScope command, CancellationToken cancellationToken)
    {
        var found = await FindAsync(command.ItemId, command.RunId, cancellationToken).ConfigureAwait(false);
        if (found.IsFailure)
        {
            return Result.Failure<PetRunResponse>(found.Error);
        }

        var run = found.Value;
        var state = Checkpoint(run);
        if (run.Status != "waiting_for_input" || state.IncludeTargetText is null || state.Turns >= MaxTurns
            || state.Question is not { Scope: "source" or "ability" } question || question.Id != command.Request.QuestionId)
        {
            return Conflict();
        }

        string observation;
        if (!command.Request.Approve)
        {
            if (command.Request.SourceItemId is not null)
            {
                return Invalid("Decline this request without selecting a source.");
            }
            observation = "The owner declined the request for additional access. Continue with the existing scope.";
        }
        else if (question is { Scope: "ability", Ability: { } ability })
        {
            if (command.Request.SourceItemId is not null || !_capabilities.ContainsKey(ability)
                || RunAbilities(run, state).Count >= 32 || RunAbilities(run, state).Contains(ability, StringComparer.Ordinal))
            {
                return Invalid("This ability is no longer available to add to this job.");
            }
            state = state with { AddedAbilities = [.. (state.AddedAbilities ?? []), ability] };
            observation = $"The owner enabled the requested ability {ability}. Continue to ask for approval of effects as required.";
        }
        else
        {
            if (question.Scope != "source" || command.Request.SourceItemId is not { } source || source == Guid.Empty)
            {
                return Invalid("Choose the item to share as a read-only source.");
            }
            var granted = await GrantSourceAsync(run, state, source, cancellationToken).ConfigureAwait(false);
            if (granted is null)
            {
                return Invalid("Choose an available source in this workspace that has not already been shared.");
            }
            state = granted;
            observation = $"The owner shared read-only source {source:D}.";
        }

        return await QueueAsync(run, state with { Question = null, Answers = [.. state.Answers, observation] }, cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task<PetRunCheckpoint?> GrantSourceAsync(
        PetRunRecord run, PetRunCheckpoint state, Guid source, CancellationToken cancellationToken)
    {
        if (run.ItemId is not { } anchor)
        {
            return null;
        }
        var root = await items.FindAsync(anchor, cancellationToken).ConfigureAwait(false);
        if (root is null || root.WorkspaceId != run.WorkspaceId
            || !await ScopeAvailableAsync(root, source == anchor.Value ? [] : [source], cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        if (source == anchor.Value)
        {
            return root.Type == "note" && state.IncludeTargetText == false ? state with { IncludeTargetText = true } : null;
        }
        var sources = ReadSources(run, state);
        return sources.Count >= 24 || sources.Contains(source)
            ? null
            : state with { AddedSources = [.. (state.AddedSources ?? []), source] };
    }

    private static IReadOnlyList<string> OwnerRevisions(PetRunCheckpoint state) =>
        state.OwnerRevisions ?? (state.RevisionFeedback?.Feedback is { } prior ? [prior] : []);

    private static PetRunCheckpoint FinishRevisionTurn(PetRunCheckpoint state) =>
        state.RevisionFeedback is null ? state : state with { RevisionFeedback = null, OwnerRevisions = OwnerRevisions(state) };

    private static IReadOnlyList<string> DefaultAbilities(Item item) => item.Type switch
    {
        "canvas" => ["nix.action", "canvas.read", "canvas.edit"],
        "spreadsheet" or "sheet" => ["nix.action", "sheet.edit"],
        _ => ["nix.action", "task.comment", "task.rename"],
    };

    private static IReadOnlyList<Guid> ReadSources(PetRunRecord run, PetRunCheckpoint state) => state.PlanRequest is { } plan
        ? plan.SourceScope.ItemIds ?? []
        : state.AddedSources is { Count: > 0 } extra ? [.. run.SourceItemIds, .. extra] : run.SourceItemIds;

    private static IReadOnlyList<string> RunAbilities(PetRunRecord run, PetRunCheckpoint state) =>
        state.AddedAbilities is { Count: > 0 } extra ? [.. run.Abilities, .. extra] : run.Abilities;

    // Scope passed to executors is transient. The store compares the immutable starting scope on every update.
    private static PetRunRecord EffectiveRun(PetRunRecord run, PetRunCheckpoint state) => state.IncludeTargetText is null
        ? run with
        {
            ProtectedRead = state.PlanRequest?.ProtectedRead ?? false,
            TimeZone = state.PlanRequest?.TimeZone,
            BuildLedger = state.PlanRequest?.BuildLedger is { } ledger ? System.Text.Json.JsonSerializer.SerializeToElement(ledger, PetPlanJsonContext.Default.BuildLedger) : null,
            ScopeRootItemId = state.PlanRequest?.ChatSource?.RootItemId ?? (state.PlanRequest?.SourceScope.Kind == "subtree" ? run.ItemId?.Value : null),
            WorkspaceScope = state.PlanRequest is null ? run.WorkspaceScope
                : state.PlanRequest.SourceScope.Kind == "workspace" && state.PlanRequest.ChatSource?.RootItemId is null,
            SourceItemIds = state.PlanRequest?.SourceScope.ItemIds ?? run.SourceItemIds
        }
        : run with
        {
            IncludeTargetText = state.IncludeTargetText,
            ReadOnlySourceItemIds = ReadSources(run, state),
            SourceItemIds = [],
            Abilities = RunAbilities(run, state),
            ProtectedRead = state.PlanRequest?.ProtectedRead ?? false,
            TimeZone = state.PlanRequest?.TimeZone,
            BuildLedger = state.PlanRequest?.BuildLedger is { } scopedLedger ? System.Text.Json.JsonSerializer.SerializeToElement(scopedLedger, PetPlanJsonContext.Default.BuildLedger) : null,
        };
}
