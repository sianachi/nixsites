namespace Nix.Abstractions.PetPeers;

/// <summary>An owner-registered agent or runner confined to one pet and task.</summary>
public sealed record PetPeerRegistration(Guid Id, Guid PetId, Guid WorkspaceId, Guid ItemId, string Name,
    string Kind, DateTimeOffset ExpiresAt, DateTimeOffset? RevokedAt);

/// <summary>A registered peer's submission or approved delegation on the original pet run.</summary>
public sealed record PetPeerWork(Guid Id, Guid PeerId, Guid RunId, string Direction, string Status, string Brief,
    string? Result, Guid? LeaseId, DateTimeOffset? LeaseExpiresAt, DateTimeOffset CreatedAt);

/// <summary>Persists task-bound peer grants and their work within the actor's unit of work.</summary>
public interface IPetPeerStore
{
    public Task InsertAsync(PetPeerRegistration peer, CancellationToken cancellationToken);
    public Task<PetPeerRegistration?> GetAsync(Guid peerId, bool lockGrant, CancellationToken cancellationToken);
    public Task<IReadOnlyList<PetPeerRegistration>> ListAsync(Guid itemId, CancellationToken cancellationToken);
    public Task<bool> RevokeAsync(Guid itemId, Guid peerId, DateTimeOffset now, CancellationToken cancellationToken);
    public Task<bool> SaveWorkAsync(PetPeerWork work, CancellationToken cancellationToken);
    public Task<PetPeerWork?> GetWorkAsync(Guid peerId, Guid workId, CancellationToken cancellationToken);
    public Task<PetPeerWork?> FindSubmissionAsync(Guid peerId, Guid runId, CancellationToken cancellationToken);
    public Task<IReadOnlyList<PetPeerWork>> ListWorkAsync(Guid itemId, CancellationToken cancellationToken);
    public Task<PetPeerWork?> ClaimAsync(Guid peerId, Guid leaseId, DateTimeOffset leaseExpiresAt, CancellationToken cancellationToken);
    public Task<bool> FinishAsync(Guid peerId, Guid workId, Guid leaseId, string status, string? result,
        DateTimeOffset now, CancellationToken cancellationToken);
    public Task<bool> ShareResultAsync(Guid peerId, Guid runId, string result, CancellationToken cancellationToken);
}
