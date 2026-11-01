using Nix.Abstractions;
using Nix.Domain.Sync;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Features.Sync;

/// <summary>Reads one complete-enumeration page.</summary>
public sealed record GetWorkspaceSyncSnapshot(WorkspaceId WorkspaceId, long? Boundary, Guid? Cursor, int Limit) : IQuery<WorkspaceSyncSnapshot?>;

/// <summary>Reads one committed change page.</summary>
public sealed record GetWorkspaceSyncChanges(WorkspaceId WorkspaceId, long After, int Limit) : IQuery<WorkspaceSyncChanges?>;

/// <summary>Rechecks only identifiers held by the device.</summary>
public sealed record ReconcileWorkspaceSync(WorkspaceId WorkspaceId, IReadOnlyList<Guid> ItemIds) : IQuery<WorkspaceSyncReconciliation>;

/// <summary>Dispatches mirror reads through the tenant persistence port.</summary>
public sealed class WorkspaceSyncQueries(IWorkspaceSync sync) :
    IQueryHandler<GetWorkspaceSyncSnapshot, WorkspaceSyncSnapshot?>,
    IQueryHandler<GetWorkspaceSyncChanges, WorkspaceSyncChanges?>,
    IQueryHandler<ReconcileWorkspaceSync, WorkspaceSyncReconciliation>
{
    /// <inheritdoc />
    public ValueTask<WorkspaceSyncSnapshot?> HandleAsync(GetWorkspaceSyncSnapshot query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        return sync.SnapshotAsync(query.WorkspaceId, query.Boundary, query.Cursor, query.Limit, cancellationToken);
    }

    /// <inheritdoc />
    public ValueTask<WorkspaceSyncChanges?> HandleAsync(GetWorkspaceSyncChanges query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        return sync.ChangesAsync(query.WorkspaceId, query.After, query.Limit, cancellationToken);
    }

    /// <inheritdoc />
    public ValueTask<WorkspaceSyncReconciliation> HandleAsync(ReconcileWorkspaceSync query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        return sync.ReconcileAsync(query.WorkspaceId, query.ItemIds, cancellationToken);
    }
}
