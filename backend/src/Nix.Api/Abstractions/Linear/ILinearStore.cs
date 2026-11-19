using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions.Linear;

/// <summary>A workspace-bound Linear grant belonging to the connection owner.</summary>
public sealed record LinearConnection(Guid Id, WorkspaceId WorkspaceId, PrincipalId OwnerId, long Revision, string? ProtectedOAuthState);

/// <summary>A consumed browser authorization whose result can replace the grant only if still current.</summary>
public sealed record LinearOAuthAttempt(Guid ConnectionId, WorkspaceId WorkspaceId, long Revision, string ProtectedOAuthState, string StateHash);

/// <summary>The durable request and receipt for one approved Linear issue read.</summary>
public sealed record LinearTaskRequest(
    Guid Id, ItemId ItemId, Guid ConnectionId, long ConnectionRevision, PrincipalId RequesterId,
    Guid? RequesterTokenId, string IssueId, string Status, DateTimeOffset CreatedAt, DateTimeOffset ExpiresAt,
    PrincipalId? ApproverId, string? ResultJson, Guid? PetId = null, string? PetName = null, Guid? CommentId = null);

/// <summary>States of a single Linear issue request.</summary>
public static class LinearRequestStatus
{
    public const string Pending = "pending";
    public const string Running = "running";
    public const string Declined = "declined";
    public const string Succeeded = "succeeded";
    public const string Failed = "failed";
    public const string Unknown = "unknown";
    public const string Expired = "expired";
}

/// <summary>Persists the acting principal's connection and task requests inside a tenant unit of work.</summary>
public interface ILinearStore
{
    public Task<LinearConnection?> FindConnectionAsync(WorkspaceId workspaceId, CancellationToken cancellationToken);
    public Task<LinearConnection?> LockConnectionAsync(Guid connectionId, CancellationToken cancellationToken);
    public Task<bool> BeginOAuthAsync(WorkspaceId workspaceId, string stateHash, string protectedOAuthState, DateTimeOffset expiresAt, CancellationToken cancellationToken);
    public Task<LinearOAuthAttempt?> ConsumeOAuthAsync(string stateHash, DateTimeOffset now, CancellationToken cancellationToken);
    public Task<bool> CompleteOAuthAsync(LinearOAuthAttempt attempt, string protectedOAuthState, CancellationToken cancellationToken);
    public Task<bool> SaveOAuthAsync(Guid connectionId, long revision, string protectedOAuthState, CancellationToken cancellationToken);
    public Task<bool> DisconnectAsync(WorkspaceId workspaceId, CancellationToken cancellationToken);
    public Task<bool> CreateRequestAsync(LinearTaskRequest request, CancellationToken cancellationToken);
    public Task<LinearTaskRequest?> FindRequestAsync(ItemId itemId, Guid id, Guid? callerTokenId, CancellationToken cancellationToken);
    public Task<IReadOnlyList<LinearTaskRequest>> ListRequestsAsync(ItemId itemId, Guid? callerTokenId, CancellationToken cancellationToken);
    public Task<LinearTaskRequest?> DecideAsync(ItemId itemId, Guid id, bool approve, DateTimeOffset now, CancellationToken cancellationToken);
    public Task<bool> FinishAsync(Guid id, string status, string? resultJson, CancellationToken cancellationToken, Guid? commentId = null);
    public Task<LinearItemLink?> FindLinkAsync(WorkspaceId workspaceId, ItemId itemId, CancellationToken cancellationToken);
    public Task<bool> CreateLinkAsync(LinearItemLink link, CancellationToken cancellationToken);
    public Task<bool> UpdateLinkAsync(LinearItemLink link, Guid expectedRevision, CancellationToken cancellationToken);
    public Task<bool> LockLinkItemAsync(WorkspaceId workspaceId, ItemId itemId, Guid revision, CancellationToken cancellationToken);
    public Task<bool> DeleteLinkAsync(WorkspaceId workspaceId, ItemId itemId, Guid expectedRevision, CancellationToken cancellationToken);
}
