using Nix.Abstractions.PetRuns;
using Nix.Domain.Primitives;
using Nix.Features.PetRuns;

namespace Nix.Authentication;

/// <summary>Checks the purpose-specific sharing grant before companion content leaves Core.</summary>
public sealed class PetDisclosureConsentGuard : IPetDisclosureConsentGuard
{
    private readonly PetPlanSharingService _sharing;
    internal PetDisclosureConsentGuard(PetPlanSharingService sharing) => _sharing = sharing;

    public Task<Result<string>> RequireOwnerTextAsync(Guid workspaceId, Guid petId, Guid turnId,
        CancellationToken cancellationToken) => _sharing.PinOwnerTextAsync(workspaceId, petId, turnId, cancellationToken);

    internal Task<Result<string>> RequireAsync(Guid workspaceId, Guid petId, PetPlanSourceScope scope,
        Guid turnId, CancellationToken cancellationToken) => _sharing.PinAsync(workspaceId, petId, scope, turnId, cancellationToken);
    public Task<bool> ValidateAsync(string attestation, CancellationToken cancellationToken) =>
        _sharing.ValidateAsync(attestation, cancellationToken);
    public Task<Result<string>> RequireAsync(Guid workspaceId, Guid petId, string scopeKind,
        IReadOnlyList<Guid> sourceItemIds, Guid turnId, CancellationToken cancellationToken,
        IReadOnlyList<Guid>? readOnlyWorkspaceIds = null) =>
        _sharing.PinAsync(workspaceId, petId, new(scopeKind, sourceItemIds, readOnlyWorkspaceIds), turnId, cancellationToken);
}
