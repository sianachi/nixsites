using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>Advisory locks that serialise structural writes for the rest of the transaction.</summary>
/// <remarks>
/// One implementation, Postgres advisory locks, because they are a statement about Postgres
/// transactions and a fake would test nothing. The workspace key text is shared with the
/// collaboration service and the item key text with older Core instances during a rolling deploy,
/// so neither may change.
/// </remarks>
public interface IStructuralLock
{
    /// <summary>Serialises changes to item ancestry and record keys within one workspace.</summary>
    public ValueTask AcquireWorkspaceTopologyAsync(WorkspaceId workspaceId, CancellationToken cancellationToken);

    /// <summary>Serialises writes that read an item's state and then decide what to change.</summary>
    public ValueTask AcquireAsync(ItemId itemId, CancellationToken cancellationToken);
}
