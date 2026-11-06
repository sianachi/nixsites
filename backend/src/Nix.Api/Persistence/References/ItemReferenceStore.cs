using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Files;
using Nix.Domain.Items;
using Nix.Domain.References;
using Nix.Domain.Tenancy;
using Nix.Features.References;

namespace Nix.Persistence.References;

/// <summary>Postgres store for item references; the tenant comes from the session and row security bounds it too.</summary>
public sealed class ItemReferenceStore(NixDbContext database, INixSessionContextAccessor session) : IItemReferenceStore
{
    private TenantId Tenant => (session.Current
        ?? throw new InvalidOperationException("No session context has been established for this unit of work.")).TenantId;

    /// <inheritdoc />
    public async ValueTask<string?> VersionStateAsync(ItemId itemId, FileVersionId versionId, CancellationToken cancellationToken)
    {
        var tenant = Tenant;
        return await database.FileVersions.AsNoTracking()
            .Where(v => v.TenantId == tenant && v.ItemId == itemId && v.Id == versionId)
            .Select(v => v.State)
            .FirstOrDefaultAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyDictionary<FileVersionId, string>> VersionStatesAsync(IReadOnlyCollection<FileVersionId> versionIds, CancellationToken cancellationToken)
    {
        var tenant = Tenant;
        var ids = versionIds.ToArray();
        return await database.FileVersions.AsNoTracking()
            .Where(v => v.TenantId == tenant && ids.Contains(v.Id))
            .ToDictionaryAsync(v => v.Id, v => v.State, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<ItemReference?> FindEdgeAsync(ItemId holder, ItemId target, FileVersionId? version, string? role, CancellationToken cancellationToken)
    {
        var tenant = Tenant;
        return await database.ItemReferences.AsNoTracking()
            .FirstOrDefaultAsync(r => r.TenantId == tenant && r.HolderItemId == holder && r.TargetItemId == target
                && r.TargetFileVersionId == version && r.Role == role, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask AddAsync(ItemReference reference, CancellationToken cancellationToken)
    {
        database.ItemReferences.Add(reference);
        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<bool> RemoveAsync(ItemId holder, Guid referenceId, CancellationToken cancellationToken)
    {
        var tenant = Tenant;
        return await database.ItemReferences
            .Where(r => r.TenantId == tenant && r.HolderItemId == holder && r.Id == referenceId)
            .ExecuteDeleteAsync(cancellationToken).ConfigureAwait(false) == 1;
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<ItemReference>> ListHeldAsync(ItemId holder, Guid? after, int take, CancellationToken cancellationToken)
    {
        var tenant = Tenant;
        return await database.ItemReferences.AsNoTracking()
            .Where(r => r.TenantId == tenant && r.HolderItemId == holder && (after == null || r.Id > after))
            .OrderBy(r => r.Id).Take(take).ToListAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<ItemReference>> ListTargetingAsync(ItemId target, Guid? after, int take, CancellationToken cancellationToken)
    {
        var tenant = Tenant;
        return await database.ItemReferences.AsNoTracking()
            .Where(r => r.TenantId == tenant && r.TargetItemId == target && (after == null || r.Id > after))
            .OrderBy(r => r.Id).Take(take).ToListAsync(cancellationToken).ConfigureAwait(false);
    }
}
