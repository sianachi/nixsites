using System.Collections.Frozen;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Properties;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Features.Properties;

/// <summary>
/// The rollup values for a page of items: every rollup the schema in force declares, folded across
/// each item's own children.
/// </summary>
/// <param name="WorkspaceId">The workspace the items live in.</param>
/// <param name="Items">The items to fold for.</param>
/// <param name="SchemaSource">
/// Where the rollup declarations come from: the item whose effective schema is in force for
/// <paramref name="Items"/>. For a listing that is the container being listed, whose own schema is
/// exactly what its children carry; for a single item it is that item. Null when there is no
/// schema at all - a workspace root - in which case there is nothing to fold.
/// </param>
/// <remarks>
/// <para>
/// <b>Its own use case rather than a field on every read.</b> A rollup is a fact about <i>other
/// rows</i> and costs a query over them, so it is asked for by the reads that draw one and not
/// carried by the reads that do not - the argument <c>ItemsWithChildren</c> makes for the same
/// shape.
/// </para>
/// <para>
/// <b>One schema resolution and one aggregate for the whole page.</b> The schema is resolved once
/// at the source rather than once per item, which is what <c>SchemaResolver</c>'s own remark says
/// a listing should do; the fold is one statement over the page's children, fanned out per rollup
/// key. Fifty items with three rollups is two queries, not a hundred and fifty.
/// </para>
/// </remarks>
public sealed record ItemRollups(
    WorkspaceId WorkspaceId,
    IReadOnlyList<ItemId> Items,
    ItemId? SchemaSource) : IQuery<IReadOnlyDictionary<ItemId, JsonObject>>;

/// <summary>Handles <see cref="ItemRollups"/>.</summary>
public sealed class ItemRollupsHandler(
    ISchemaResolver schemas,
    IChildAggregates aggregates)
    : IQueryHandler<ItemRollups, IReadOnlyDictionary<ItemId, JsonObject>>
{
    /// <summary>
    /// The most distinct child properties one page's fold will read.
    /// </summary>
    /// <remarks>
    /// The third dimension of this read's cost, and the one that had no ceiling: the listing has
    /// <c>MaximumPageSize</c> and the chart has <c>MaximumBuckets</c>, and a schema may declare as
    /// many rollups as somebody likes. The children of a page are replayed once per key, so a
    /// schema with fifty rollups would multiply an unrated read fifty-fold. Rollups past the bound
    /// simply have no entry, which the client already draws as an absent value rather than as a
    /// zero - see <c>ChildAggregate.Empty</c> for why the two are kept apart.
    /// </remarks>
    public const int MaximumFoldKeys = 8;

    /// <summary>Folds the rollups.</summary>
    /// <param name="query">The workspace, the items, and where their schema comes from.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>
    /// One bag per item, carrying a value for every rollup the schema declares. Every item asked
    /// about gets a bag: a container with no children still has a count of zero, and leaving it out
    /// would be reporting "no answer" where the answer is zero.
    /// </returns>
    public async ValueTask<IReadOnlyDictionary<ItemId, JsonObject>> HandleAsync(
        ItemRollups query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        if (query.Items.Count == 0 || query.SchemaSource is not { } source)
        {
            return Nothing;
        }

        var schema = await schemas.ResolveForItemAsync(source, cancellationToken).ConfigureAwait(false);

        var rollups = new List<PropertyDefinition>();
        foreach (var property in schema.Properties)
        {
            if (property.Type == PropertyType.Rollup && property.Aggregate is not null)
            {
                rollups.Add(property);
            }
        }

        if (rollups.Count == 0)
        {
            return Nothing;
        }

        // The distinct source keys, because two rollups over one property - a sum and an average of
        // the same estimate - fold the same column and must not scan it twice.
        var keys = new List<string>(rollups.Count);
        foreach (var rollup in rollups)
        {
            if (rollup.Source is { } folded
                && keys.Count < MaximumFoldKeys
                && !keys.Contains(folded, StringComparer.Ordinal))
            {
                keys.Add(folded);
            }
        }

        // A count of the children needs no property, but the statement folds per key, so it is
        // given one to fold against - the counts it produces are per (parent, key) and identical
        // for every key, and `sourceless` is what tells the reduction to use them.
        if (keys.Count == 0)
        {
            keys.Add(ChildCountKey);
        }

        var folds = await aggregates
            .FoldAsync(query.WorkspaceId, query.Items, keys, cancellationToken)
            .ConfigureAwait(false);

        var results = new Dictionary<ItemId, JsonObject>(query.Items.Count);
        foreach (var item in query.Items)
        {
            var bag = new JsonObject();
            foreach (var rollup in rollups)
            {
                if (rollup.Aggregate is not { } aggregate)
                {
                    continue;
                }

                var sourceless = rollup.Source is null;
                var key = new ChildAggregateKey(item, rollup.Source ?? keys[0]);
                var fold = folds.TryGetValue(key, out var found) ? found : ChildAggregate.Empty;

                bag[rollup.Key] = fold.Reduce(aggregate, sourceless);
            }

            results[item] = bag;
        }

        return results;
    }

    /// <summary>
    /// The key a bare child count folds against.
    /// </summary>
    /// <remarks>
    /// Any key would do - the counts the statement produces are per row and identical whichever
    /// property is being looked at - so this is named for what it is rather than borrowed from a
    /// property that might exist. <c>title</c> would have worked and would have read as though the
    /// title mattered.
    /// </remarks>
    private const string ChildCountKey = "";

    /// <summary>Frozen for the reason <c>ChildAggregateReader.EmptyFold</c> is.</summary>
    private static readonly FrozenDictionary<ItemId, JsonObject> Nothing =
        FrozenDictionary<ItemId, JsonObject>.Empty;
}
