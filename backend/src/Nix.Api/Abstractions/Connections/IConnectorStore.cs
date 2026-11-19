using Nix.Domain.Tenancy;

namespace Nix.Abstractions.Connections;

/// <summary>An owner-private workspace credential restricted by Core to one resource and action set.</summary>
public sealed record ConnectorGrant(
    Guid Id, WorkspaceId WorkspaceId, Guid Revision, string Provider, string ResourceKind,
    string ResourceId, IReadOnlyList<string> Actions, string? ProtectedTokens);

/// <summary>An owner-private browser authorization consumed before any token exchange.</summary>
public sealed record ConnectorPending(
    Guid ConnectionId, WorkspaceId WorkspaceId, Guid Revision, string Provider, string ProtectedState, string StateHash);

/// <summary>Durable connection receipts and encrypted credentials inside a tenant unit of work.</summary>
public interface IConnectorStore
{
    public Task<IReadOnlyList<ConnectorGrant>> ListAsync(WorkspaceId workspace, CancellationToken cancellationToken);
    public Task<ConnectorGrant?> GetAsync(WorkspaceId workspace, Guid id, bool lockForUpdate, CancellationToken cancellationToken);
    public Task<bool> BeginOAuthAsync(WorkspaceId workspace, string provider, string resourceKind, string resourceId,
        string stateHash, string protectedState, DateTimeOffset expiresAt, CancellationToken cancellationToken);
    public Task<ConnectorPending?> ConsumeOAuthAsync(string stateHash, DateTimeOffset now, CancellationToken cancellationToken);
    public Task<bool> CompleteOAuthAsync(ConnectorPending attempt, string[] actions, string protectedTokens, CancellationToken cancellationToken);
    public Task<bool> SaveScopedAsync(WorkspaceId workspace, string provider, string resourceKind, string resourceId, string[] actions,
        string protectedTokens, CancellationToken cancellationToken);
    public Task<bool> SaveTokensAsync(Guid id, Guid revision, string protectedTokens, CancellationToken cancellationToken);
    public Task<bool> DisconnectAsync(WorkspaceId workspace, Guid id, CancellationToken cancellationToken);
}
