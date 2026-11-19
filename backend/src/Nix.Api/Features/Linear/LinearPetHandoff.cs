using Nix.Abstractions;
using Nix.Abstractions.Linear;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Features.Comments;
using Nix.Features.Pets;

namespace Nix.Features.Linear;

internal sealed partial class LinearRequests
{
    private const string HandoffInstruction = """
        Choose one next step for the task based only on the issue category.
        Output exactly one of these tokens and nothing else:
        check_acceptance_criteria (for active or new work)
        ask_for_update (for blocked work or unclear status)
        review_completed_work (for complete work)
        """;

    private sealed record PetLookup(WorkspaceId WorkspaceId, LinearIssueResponse Issue);

    private static bool CanLeaveComment(Item item) => item.Type == "note" && ItemSettings.Read(item.Settings).Comments;

    private async Task<PetProfile?> FindEnabledPetAsync(Guid id, CancellationToken token)
    {
        var settings = (await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), token).ConfigureAwait(false)).Settings;
        var pet = settings.Enabled ? settings.Profiles.FirstOrDefault(profile => profile.Id == id) : null;
        return pet is not null && pet.Name.Trim() is { Length: > 0 and <= 80 } name && !name.Any(char.IsControl)
            ? pet : null;
    }

    private async Task RunPetHandoffAsync(NixSessionContext caller, LinearTaskRequest request, PetLookup lookup)
    {
        // The read and any refreshed credentials have committed. The provider turn never holds
        // the Linear grant row lock, receives only a fixed category, and has no workspace tools.
        var nextStep = await isolated.RunAsync(caller, async (services, ct) =>
        {
            var handler = services.GetRequiredService<LinearRequests>();
            var step = await handler.ChooseNextStepAsync(services, request, lookup, ct).ConfigureAwait(false);
            return new IsolatedOutcome<string?>(step, Commit: false);
        }, CancellationToken.None).ConfigureAwait(false);

        await isolated.RunAsync(caller, async (services, ct) =>
        {
            var handler = services.GetRequiredService<LinearRequests>();
            var saved = await handler.CompleteHandoffAsync(request, lookup, nextStep, ct).ConfigureAwait(false);
            return new IsolatedOutcome<bool>(saved, Commit: saved);
        }, CancellationToken.None).ConfigureAwait(false);
    }

    private async Task<string?> ChooseNextStepAsync(
        IServiceProvider services, LinearTaskRequest request, PetLookup lookup, CancellationToken token)
    {
        if (request.PetId is not { } petId
            || !Matches(request, await store.FindConnectionAsync(lookup.WorkspaceId, token).ConfigureAwait(false))
            || !await CanUseRequestAsync(request, lookup.WorkspaceId, token).ConfigureAwait(false)
            || await FindEnabledPetAsync(petId, token).ConfigureAwait(false) is not { } pet)
        {
            return null;
        }

        using var lease = services.GetRequiredService<PetInlineLimiter>().TryAcquire(Session.PrincipalId.Value);
        if (lease is null)
        {
            return null;
        }

        var prompt = new PetInlineRequest(lookup.WorkspaceId.Value, request.ItemId.Value, request.Id, "custom",
            IssueCategory(lookup.Issue.Status), HandoffInstruction);
        return await services.GetRequiredService<PetWorkerClient>().ChooseTaskNextStepAsync(prompt, pet, token).ConfigureAwait(false);
    }

    private async Task<bool> CompleteHandoffAsync(LinearTaskRequest request, PetLookup lookup, string? nextStep, CancellationToken token)
    {
        var connection = await store.LockConnectionAsync(request.ConnectionId, token).ConfigureAwait(false);
        if (!Matches(request, connection) || !await CanUseRequestAsync(request, lookup.WorkspaceId, token).ConfigureAwait(false))
        {
            return await FinishAsync(request, LinearRequestStatus.Unknown, null, token).ConfigureAwait(false);
        }

        Guid? commentId = null;
        if (nextStep is not null
            && request.PetId is { } petId
            && request.PetName is { } petName
            && await FindEnabledPetAsync(petId, token).ConfigureAwait(false) is not null)
        {
            var comment = await dispatcher.SendAsync<AddComment, CommentThreadDto>(
                new(request.ItemId, new($"{petName} (pet)\n\nNext step\n{nextStep}", MentionIds: null, Anchor: null)), token).ConfigureAwait(false);
            if (comment.IsSuccess)
            {
                commentId = comment.Value.Id;
            }
        }

        // A lost finish fence rolls back the comment as well as the receipt.
        return await FinishAsync(request, LinearRequestStatus.Succeeded, lookup.Issue, token, commentId).ConfigureAwait(false);
    }

    private static string IssueCategory(string status) => status.Trim().ToUpperInvariant() switch
    {
        "IN PROGRESS" or "IN REVIEW" or "STARTED" => "active",
        "TODO" or "TO DO" or "OPEN" or "BACKLOG" => "new",
        "BLOCKED" => "blocked",
        "DONE" or "COMPLETE" or "COMPLETED" or "CLOSED" => "complete",
        _ => "unclear",
    };
}
