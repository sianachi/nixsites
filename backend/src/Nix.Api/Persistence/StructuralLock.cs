using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence;

/// <summary>Transaction-scoped advisory locks keyed on a workspace or an item.</summary>
public sealed class StructuralLock(NixDbContext database) : IStructuralLock
{
    // The key texts keep the name of the feature that first used them: apps/collab
    // (documents/sync.ts) and TemplateStore.CaptureImport take the same workspace key, and a
    // rolling deploy runs old and new Core against the same keys. Do not rename them.
    public ValueTask AcquireWorkspaceTopologyAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
        LockAsync($"finance-workspace:{workspaceId.Value:D}", cancellationToken);

    public ValueTask AcquireAsync(ItemId itemId, CancellationToken cancellationToken) =>
        LockAsync($"finance:{itemId.Value:D}", cancellationToken);

    private async ValueTask LockAsync(string identity, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(database);
        if (database.Database.CurrentTransaction is null)
        {
            throw new InvalidOperationException("Structural locking requires an active Core transaction.");
        }

        await database.Database.ExecuteSqlRawAsync(
            "SELECT pg_advisory_xact_lock(hashtextextended(@identity, 0));",
            [new NpgsqlParameter("identity", NpgsqlDbType.Text) { Value = identity }],
            cancellationToken).ConfigureAwait(false);
    }
}
