using System.Diagnostics.CodeAnalysis;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Features.PetRuns;

[SuppressMessage("Performance", "CA1812", Justification = "Created by dependency injection.")]
internal sealed class PetPlanHistoryGuard(IItemTree items, IItemLocks itemLocks,
    IWorkspaceLocks workspaceLocks, IPermissionResolver permissions)
{
    internal async Task<bool> ValidateAsync(PetSharingAttestation bound, ValidatePetSharingRequest request,
        CancellationToken cancellationToken)
    {
        if (request.PriorTurnId is null)
        {
            return request.ContextSourceItemIds is null && !request.ContextProtected && !request.ContextUnbounded
                && request.PriorRecipientRevision is null && request.PriorSourceScope is null;
        }
        if (request.PriorTurnId == Guid.Empty || request.PriorRecipientRevision != bound.RecipientRevision
            || request.PriorSourceScope is not { } previous || !ValidScope(previous)
            || request.ContextSourceItemIds is not { Count: <= 128 } sources
            || sources.Any(id => id == Guid.Empty) || sources.Distinct().Count() != sources.Count
            || request.ContextProtected
            || request.ContextUnbounded && (request.PriorTurnId != bound.TurnId || bound.OwnerTextOnly))
        {
            return false;
        }
        if (bound.OwnerTextOnly && (sources.Count != 0 || previous.Kind != "selected"
            || previous.ItemIds is { Count: > 0 } || previous.ReadOnlyWorkspaceIds is { Count: > 0 }))
        {
            return false;
        }
        foreach (var raw in sources)
        {
            var item = await items.FindAsync(ItemId.From(raw), cancellationToken).ConfigureAwait(false);
            if (item is null || item.LifecycleState != ItemLifecycleState.Active || ItemSettings.Read(item.Settings).WithholdFromPets
                || !await WorkspaceAvailableAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false)
                || (await itemLocks.GetStateAsync(item.Id, cancellationToken).ConfigureAwait(false)).Locked)
            {
                return false;
            }
            if (item.WorkspaceId.Value != bound.WorkspaceId)
            {
                if (bound.SourceScope.ReadOnlyWorkspaceIds?.Contains(item.WorkspaceId.Value) != true)
                {
                    return false;
                }
            }
            else if (bound.SourceScope.Kind == "selected" && bound.SourceScope.ItemIds?.Contains(raw) != true
                || bound.SourceScope.Kind == "subtree" && !await items.IsVisibleSubtreeMemberAsync(item.WorkspaceId,
                    ItemId.From(bound.SourceScope.ItemIds![0]), item.Id, cancellationToken).ConfigureAwait(false))
            {
                return false;
            }
        }
        if (request.ContextUnbounded)
        {
            if (bound.SourceScope.Kind != "workspace" || previous.Kind != "workspace"
                || (previous.ReadOnlyWorkspaceIds ?? []).Except(bound.SourceScope.ReadOnlyWorkspaceIds ?? []).Any())
            {
                return false;
            }
            foreach (var raw in new[] { bound.WorkspaceId }.Concat(bound.SourceScope.ReadOnlyWorkspaceIds ?? []).Distinct())
            {
                var workspace = WorkspaceId.From(raw);
                if (!await WorkspaceAvailableAsync(workspace, cancellationToken).ConfigureAwait(false)
                    || await items.AnyItemsWithheldFromPetsAsync(workspace, cancellationToken).ConfigureAwait(false)
                    || await itemLocks.AnyInWorkspaceAsync(workspace, cancellationToken).ConfigureAwait(false))
                {
                    return false;
                }
            }
        }
        return true;
    }

    private async Task<bool> WorkspaceAvailableAsync(WorkspaceId workspace, CancellationToken cancellationToken) =>
        await permissions.CanReadWorkspaceAsync(workspace, cancellationToken).ConfigureAwait(false)
        && !(await workspaceLocks.GetStateAsync(workspace, cancellationToken).ConfigureAwait(false)).PasswordProtected;

    private static bool ValidScope(PetPlanSourceScope scope) => scope.Kind is "workspace" or "selected" or "subtree"
        && scope.ItemIds is not { Count: > 100 } && scope.ItemIds?.Contains(Guid.Empty) != true
        && scope.ItemIds?.Distinct().Count() == scope.ItemIds?.Count
        && scope.ReadOnlyWorkspaceIds is not { Count: > 20 } && scope.ReadOnlyWorkspaceIds?.Contains(Guid.Empty) != true
        && scope.ReadOnlyWorkspaceIds?.Distinct().Count() == scope.ReadOnlyWorkspaceIds?.Count
        && (scope.Kind != "workspace" || scope.ItemIds is not { Count: > 0 })
        && (scope.Kind != "subtree" || scope.ItemIds is { Count: 1 });
}
