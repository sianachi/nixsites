using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Domain.Items;
using Nix.Messaging;

namespace Nix.Features.Items;

/// <summary>
/// Maps a domain item onto the shape the contract publishes.
/// </summary>
/// <remarks>
/// The one interesting line is the title. The item table has no title column - a name is one of
/// the schema-driven properties an item carries - and the API promotes it to a first-class field
/// because every client needs it to render a row. This is where that promotion happens, and it is
/// the only place it should.
/// </remarks>
internal static class ItemMapping
{
    /// <summary>
    /// Maps one item, asking whether it has children.
    /// </summary>
    /// <param name="item">The domain item.</param>
    /// <param name="dispatcher">Sends the children query to its handler.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The published shape.</returns>
    /// <remarks>
    /// One indexed probe returning at most a row - see <c>TreeShapeSql</c>. Written once rather
    /// than at each of the four endpoints that return a single existing item, because the failure mode
    /// of forgetting it is not a compile error but a response that says "no children" and costs the
    /// tree its expand control.
    /// </remarks>
    internal static async Task<ItemResponse> RespondAsync(
        Item item,
        NixDispatcher dispatcher,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(item);
        ArgumentNullException.ThrowIfNull(dispatcher);

        var withChildren = await dispatcher
            .QueryAsync<ItemsWithChildren, IReadOnlySet<ItemId>>(
                new ItemsWithChildren(item.WorkspaceId, [item.Id]),
                cancellationToken)
            .ConfigureAwait(false);

        return ToResponse(item, withChildren.Contains(item.Id));
    }

    /// <summary>Maps one item.</summary>
    /// <param name="item">The domain item.</param>
    /// <param name="hasChildren">
    /// Whether it has children of its own. Required rather than defaulted: the tree draws an expand
    /// control from it, and a default would quietly make every caller that forgot say "no children"
    /// - which looks like a working answer and is not.
    /// </param>
    /// <returns>The published shape.</returns>
    /// <param name="computed">
    /// The item's rollup values, or null when this read did not compute them. Defaulted, unlike
    /// <paramref name="hasChildren"/>, because null is the honest answer for the reads that do not
    /// fold children and an accidental null costs a client nothing it could mistake for data - the
    /// opposite of the "no children" default, which looks like a working answer and is not.
    /// </param>
    internal static ItemResponse ToResponse(Item item, bool hasChildren, JsonObject? computed = null)
    {
        ArgumentNullException.ThrowIfNull(item);

        return new ItemResponse(
            item.Id.Value,
            item.WorkspaceId.Value,
            item.ParentId?.Value,
            item.Type,
            ItemProperties.ReadTitle(item.Properties),
            hasChildren,
            item.Seq,
            ToWireName(item.LifecycleState),
            ReadProperties(item.Properties),
            computed,
            item.NoDelete,
            item.NoChildren,
            item.Collaboration,
            item.ManagedBy,
            item.CreatedAt,
            item.LastModifiedAt);
    }

    /// <summary>
    /// Reads the property bag, tolerating anything.
    /// </summary>
    /// <remarks>
    /// A bag that will not parse reads as empty rather than failing the request that listed it.
    /// Property values are client-influenced data and a malformed one is a display problem; a
    /// listing that returned 500 because one of fifty items had a bad bag would be the worse
    /// outcome by a wide margin.
    /// </remarks>
    private static JsonObject ReadProperties(string? properties)
    {
        if (string.IsNullOrWhiteSpace(properties))
        {
            return [];
        }

        try
        {
            return JsonNode.Parse(properties) as JsonObject ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    /// <summary>
    /// The lifecycle state's wire name.
    /// </summary>
    /// <remarks>
    /// Spelled out rather than lower-casing the enum name, so renaming a member in C# cannot
    /// silently change what clients receive.
    /// </remarks>
    private static string ToWireName(ItemLifecycleState state) => state switch
    {
        ItemLifecycleState.Active => "active",
        ItemLifecycleState.Deleted => "deleted",
        ItemLifecycleState.Purged => "purged",
        _ => throw new ArgumentOutOfRangeException(nameof(state), state, "Unknown lifecycle state."),
    };
}
