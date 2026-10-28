using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Features.Items;

/// <summary>
/// Which of these items have children of their own.
/// </summary>
/// <param name="WorkspaceId">The workspace the items live in.</param>
/// <param name="Parents">The items to ask about.</param>
/// <remarks>
/// <para>
/// <b>Its own use case rather than a field on every read.</b> Every item can hold children, so the
/// interface has to know whether to offer an expand control - and an item that offers one and
/// expands to nothing is exactly the dishonest state the tree would otherwise be full of. But it is
/// a fact about <i>other rows</i>, not about the item, so it does not belong on the envelope and it
/// is not carried by the reads that do not need it.
/// </para>
/// <para>
/// Batched by construction: callers hand it a page and get back the subset. A single item is a page
/// of one, which is why there is one code path here rather than a bulk one and a scalar one that
/// can disagree.
/// </para>
/// <para>
/// <b>No permission check, deliberately.</b> A caller reaches this holding items a read check
/// already returned, and the only thing it learns is whether rows exist beneath them - which
/// row-level security scopes to the tenant anyway. Adding a second check here would re-ask a
/// question already answered and invite the two to drift.
/// </para>
/// </remarks>
public sealed record ItemsWithChildren(
    WorkspaceId WorkspaceId,
    IReadOnlyList<ItemId> Parents) : IQuery<IReadOnlySet<ItemId>>;

/// <summary>
/// Which of these items have children of their own.
/// </summary>
/// <remarks>
/// <para>
/// <b>Its own use case rather than a field on every read.</b> Every item can hold children, so the
/// interface has to know whether to offer an expand control - and an item that offers one and
/// expands to nothing is exactly the dishonest state the tree would otherwise be full of. But it is
/// a fact about <i>other rows</i>, not about the item, so it does not belong on the envelope and it
/// is not carried by the reads that do not need it.
/// </para>
/// <para>
/// Batched by construction: callers hand it a page and get back the subset. A single item is a page
/// of one, which is why there is one code path here rather than a bulk one and a scalar one that
/// can disagree.
/// </para>
/// <para>
/// <b>No permission check, deliberately.</b> A caller reaches this holding items a read check
/// already returned, and the only thing it learns is whether rows exist beneath them - which
/// row-level security scopes to the tenant anyway. Adding a second check here would re-ask a
/// question already answered and invite the two to drift.
/// </para>
/// </remarks>
public sealed class ItemsWithChildrenHandler(
    IItemTree tree)
    : IQueryHandler<ItemsWithChildren, IReadOnlySet<ItemId>>
{
    /// <summary>Reads which of the given items have at least one child that is not deleted.</summary>
    /// <param name="query">The workspace the items live in, and the items to ask about.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The subset that have children.</returns>
    public async ValueTask<IReadOnlySet<ItemId>> HandleAsync(
        ItemsWithChildren query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        return await tree
            .WithChildrenAsync(query.WorkspaceId, query.Parents, cancellationToken)
            .ConfigureAwait(false);
    }
}
