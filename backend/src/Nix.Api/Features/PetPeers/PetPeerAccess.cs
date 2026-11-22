using System.Diagnostics.CodeAnalysis;
using Nix.Abstractions;
using Nix.Abstractions.PetPeers;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Features.PetRuns;
using Nix.Features.Pets;
using Nix.Messaging;

namespace Nix.Features.PetPeers;

[SuppressMessage("Performance", "CA1812", Justification = "Created by ASP.NET Core dependency injection.")]
internal sealed class PetPeerAccess(
    IVisibleItems visible, IItemLocks locks, IWorkspaceLocks workspaceLocks,
    ITenantSettingsStore tenant, NixDispatcher dispatcher, TimeProvider clock, IIdentityDirectory identity,
    INixSessionContextAccessor session, IConfiguration configuration)
{
    internal async Task<Item?> GetTaskAsync(ItemId itemId, CancellationToken cancellationToken)
    {
        var item = await GetOwnedTaskAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null || ItemSettings.Read(item.Settings).WithholdFromPets
            || !PetRunService.IsEnabled(configuration, item.WorkspaceId)
            || (await workspaceLocks.GetStateAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false)).PasswordProtected
            || (await locks.LockedAmongAsync([itemId], cancellationToken).ConfigureAwait(false)).Contains(itemId))
        {
            return null;
        }
        return item;
    }

    internal async Task<Item?> GetOwnedTaskAsync(ItemId itemId, CancellationToken cancellationToken)
    {
        var lookup = await visible.FindAsync(itemId, ItemAccess.Manage, cancellationToken).ConfigureAwait(false);
        return lookup.IsSuccess ? lookup.Value : null;
    }

    internal async Task<Guid?> ActivePetAsync(CancellationToken cancellationToken)
    {
        var settings = (await dispatcher.QueryAsync<GetPetSettings, PetSettingsResponse>(new(), cancellationToken)
            .ConfigureAwait(false)).Settings;
        return settings.Enabled && settings.ActivePetId is { } id && settings.Profiles.Any(profile => profile.Id == id)
            ? id : null;
    }

    internal async Task<bool> AllowsAsync(PetPeerRegistration peer, CancellationToken cancellationToken) =>
        peer.RevokedAt is null && peer.ExpiresAt > clock.GetUtcNow()
        && session.Current is { } actor
        && (await identity.FindPrincipalByIdAsync(actor.TenantId, actor.PrincipalId, cancellationToken)
            .ConfigureAwait(false))?.Status == PrincipalStatus.Active
        && (await tenant.GetAsync(cancellationToken).ConfigureAwait(false)).McpEnabled
        && await ActivePetAsync(cancellationToken).ConfigureAwait(false) == peer.PetId
        && (await GetTaskAsync(ItemId.From(peer.ItemId), cancellationToken).ConfigureAwait(false))?.WorkspaceId == WorkspaceId.From(peer.WorkspaceId);
}
