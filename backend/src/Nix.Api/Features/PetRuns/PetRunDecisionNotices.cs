using Nix.Abstractions;
using Nix.Abstractions.PetRuns;
using Nix.Domain.Notifications;

namespace Nix.Features.PetRuns;

internal static class PetRunDecisionNotices
{
    internal static Task CreateAsync(
        INotificationWriter writer, PetRunRecord run, PetRunCheckpoint state, CancellationToken cancellationToken)
    {
        NotificationPetDecisionTarget? target = run.Status switch
        {
            "waiting_for_input" when state.Question is { } question => new(run.Id, question.Id, IsQuestion: true),
            "waiting_for_approval" when state.Proposals is [.., { Status: "pending" or "stale" } proposal] =>
                new(run.Id, proposal.Id, IsQuestion: false),
            _ => null,
        };
        return target is null
            ? Task.CompletedTask
            : run.ItemId is { } anchor
                ? writer.CreatePetDecisionAsync(run.ActorId, anchor, run.WorkspaceId, target, cancellationToken)
                : Task.CompletedTask;
    }
}
