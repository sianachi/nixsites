using Microsoft.EntityFrameworkCore;
using Nix.Domain.Items;

namespace Nix.Persistence.Scheduling;

/// <summary>
/// Whether an item sits under one of a principal's muted containers, at fire time: an ordinary, RLS-scoped read of
/// <c>item_closure</c> - the same table permission resolution joins, asked the same question a
/// mute list asks: is this item, or any ancestor of it (the zero-depth self edge makes "is this
/// item itself muted" the same query as "is an ancestor of it muted"), one of the given ids.
/// </summary>
public sealed class MutedContainerChecker(NixDbContext database)
{
    public async Task<bool> IsMutedAsync(
        Guid itemId,
        IReadOnlyList<Guid> mutedContainerIds,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(mutedContainerIds);
        if (mutedContainerIds.Count == 0)
        {
            return false;
        }

        // Materialized rather than translated into one query: mutedContainerIds is an
        // IReadOnlyList captured from outside, and EF Core's SQL translator does not accept every
        // shape of "the parameter list a plain array or List<T> would produce" for a
        // Contains(...) predicate - the ancestor chain is at most a few dozen rows, cheap either
        // way, so checking membership in memory sidesteps the question entirely.
        var ancestorIds = await database.Set<ItemClosureEdge>()
            .AsNoTracking()
            .Where(edge => edge.DescendantId == ItemId.From(itemId))
            .Select(edge => edge.AncestorId.Value)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        return ancestorIds.Any(mutedContainerIds.Contains);
    }
}
