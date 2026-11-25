using Nix.Domain.Primitives;

namespace Nix.Abstractions.PetRuns;

/// <summary>The disclosure boundary used by the provider gateway and its I/O fakes.</summary>
public interface IPetDisclosureConsentGuard
{
    /// <summary>Pins the recipient for verified owner text without granting access to source content.</summary>
    public Task<Result<string>> RequireOwnerTextAsync(Guid workspaceId, Guid petId, Guid turnId,
        CancellationToken cancellationToken) => RequireAsync(workspaceId, petId, "selected", [], turnId, cancellationToken);
    /// <summary>Pins an unexpired destination-bound grant before any content is prepared.</summary>
    public Task<Result<string>> RequireAsync(Guid workspaceId, Guid petId, string scopeKind,
        IReadOnlyList<Guid> sourceItemIds, Guid turnId, CancellationToken cancellationToken,
        IReadOnlyList<Guid>? readOnlyWorkspaceIds = null);
    /// <summary>Rechecks the pinned turn immediately before further disclosure.</summary>
    public Task<bool> ValidateAsync(string attestation, CancellationToken cancellationToken);
}
