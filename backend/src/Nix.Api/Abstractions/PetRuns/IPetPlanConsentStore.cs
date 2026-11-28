using Nix.Domain.Tenancy;

namespace Nix.Abstractions.PetRuns;

/// <summary>A pending or browser-authorized exact delegation. Only its secret hash is stored.</summary>
public sealed record PetPlanDecisionContextRecord(Guid Id, WorkspaceId WorkspaceId, Guid RunId, Guid PlanId,
    int PlanVersion, string ReviewDigest, Guid GranteeCredentialId, string ClientName, bool Approve,
    string SecretHash, DateTimeOffset ExpiresAt, Guid? AuthorityId = null,
    DateTimeOffset? AuthorizedAt = null, DateTimeOffset? RevokedAt = null,
    Guid? ConsumedRequestId = null, DateTimeOffset? ConsumedAt = null);

/// <summary>Persists exact one-use plan decision delegation in the current tenant transaction.</summary>
public interface IPetPlanConsentStore
{
    public Task<bool> CreateContextAsync(PetPlanDecisionContextRecord context, CancellationToken cancellationToken);
    public Task<PetPlanDecisionContextRecord?> ReadContextAsync(Guid contextId, CancellationToken cancellationToken);
    public Task<bool> AuthorizeContextAsync(PetPlanDecisionContextRecord context, Guid authorityId,
        DateTimeOffset now, CancellationToken cancellationToken);
    public Task<PetPlanDecisionContextRecord?> ConsumeContextAsync(string secretHash, WorkspaceId workspaceId,
        Guid runId, Guid planId, int planVersion, string reviewDigest, bool approve,
        Guid granteeCredentialId, Guid requestId, DateTimeOffset now, CancellationToken cancellationToken);
    public Task<bool> RevokeContextAsync(Guid contextId, DateTimeOffset now, CancellationToken cancellationToken);
    public Task CleanupAsync(DateTimeOffset now, CancellationToken cancellationToken);
}
