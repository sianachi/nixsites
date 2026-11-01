using Nix.Domain.Sync;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>Reads a current authorized native mirror inside the tenant unit of work.</summary>
/// <remarks>The feed is derived. Rebuilding it forces a complete snapshot and retains durable per-item metadata revisions used by replay.</remarks>
public interface IWorkspaceSync
{
    /// <summary>Publishes a finished native replay mutation before reading its acknowledged revision. Call after the last durable mutation.</summary>
    public ValueTask PublishPendingAsync(CancellationToken cancellationToken);

    /// <summary>Enumerates all visible rows, including rows older than feed retention.</summary>
    public ValueTask<WorkspaceSyncSnapshot?> SnapshotAsync(WorkspaceId workspaceId, long? boundary, Guid? cursor, int limit, CancellationToken cancellationToken);

    /// <summary>Reads current authorized snapshots for committed change markers.</summary>
    public ValueTask<WorkspaceSyncChanges?> ChangesAsync(WorkspaceId workspaceId, long after, int limit, CancellationToken cancellationToken);

    /// <summary>Rechecks only device-supplied identifiers and refuses missing and inaccessible ones identically.</summary>
    public ValueTask<WorkspaceSyncReconciliation> ReconcileAsync(WorkspaceId workspaceId, IReadOnlyList<Guid> itemIds, CancellationToken cancellationToken);
}
