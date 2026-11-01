using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>Transaction-scoped receipts and revision checks for native structural replay.</summary>
/// <remarks>
/// Postgres is the production implementation. A replacement can be wired through DI after it
/// provides operation locking, item CAS, savepoints, and immutable receipts in the mutation's
/// transaction. The HTTP integration suite is the acceptance contract for such a replacement.
/// </remarks>
public interface INativeReplayStore
{
    /// <summary>Serializes the current principal's operation before looking up its receipt.</summary>
    public ValueTask LockOperationAsync(Guid operationId, CancellationToken cancellationToken);

    /// <summary>Reads only the current principal's exact receipt.</summary>
    public ValueTask<NativeReplayReceipt?> FindAsync(Guid operationId, CancellationToken cancellationToken);

    /// <summary>Locks the target row before comparing its persistent revision.</summary>
    public ValueTask<long?> LockItemRevisionAsync(WorkspaceId workspaceId, ItemId itemId, CancellationToken cancellationToken);

    /// <summary>Records the response in the same transaction as the accepted mutation.</summary>
    public ValueTask SaveAsync(Guid operationId, WorkspaceId workspaceId, string fingerprint, string response, CancellationToken cancellationToken);

    /// <summary>Starts a savepoint so an expected command refusal cannot leave partial changes.</summary>
    public ValueTask BeginMutationAsync(CancellationToken cancellationToken);

    /// <summary>Ends the mutation, rolling it back when the existing command refused it.</summary>
    public ValueTask EndMutationAsync(bool accepted, CancellationToken cancellationToken);
}

/// <summary>An immutable bounded response and the canonical request fingerprint that produced it.</summary>
public sealed record NativeReplayReceipt(Guid WorkspaceId, string Fingerprint, string Response);
