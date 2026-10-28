using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Links;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Search;

/// <summary>Reads the items most often linked alongside an item.</summary>
/// <param name="TargetId">The item whose co-citations are wanted.</param>
/// <param name="Limit">The most related items to return.</param>
public sealed record GetRelatedItems(ItemId TargetId, int Limit) : IQuery<Result<RelatedItemResults>>;

/// <summary>What a related-items read found.</summary>
/// <param name="Related">The co-cited items, most shared sources first.</param>
/// <param name="Limit">The ceiling that was applied.</param>
public sealed record RelatedItemResults(IReadOnlyList<RelatedItem> Related, int Limit)
{
    /// <summary>Whether the ceiling was reached.</summary>
    public bool Truncated => Related.Count >= Limit;
}

/// <summary>
/// Reads an item's co-citations: the items that the documents linking to it also link to.
/// </summary>
/// <remarks>
/// <para>
/// A suggestion signal with no model behind it. Two notes that keep being cited together are
/// usually about the same thing, and a person writing about one of them is often about to want the
/// other - which is what a "related" panel or a picker's tie-break is for.
/// </para>
/// <para>
/// <b>The same permission shape as backlinks, and for the same reasons.</b> The target must be
/// readable or the answer is not found, because "nothing is related to it" is still a statement
/// about an identifier somebody may have guessed. Each source must be readable and unlocked before
/// it may contribute to a count, and each result must be readable before it is returned. All three
/// come from one readable-workspace answer, asked once.
/// </para>
/// </remarks>
public sealed class GetRelatedItemsHandler(
    IItemLinks links,
    IItemTree tree,
    IPermissionResolver permissions)
    : IQueryHandler<GetRelatedItems, Result<RelatedItemResults>>
{
    /// <summary>The most related items one read may return.</summary>
    public const int MaximumLimit = 25;

    /// <summary>The number returned when a caller names none.</summary>
    public const int DefaultLimit = 10;

    /// <summary>
    /// The most referring documents whose links are read for one target.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The bound on the work. A hub - a daily index, a project's home page - can be linked from
    /// thousands of documents, and reading all of their links to rank a ten-row panel would make the
    /// cost of the panel grow with the tenant. The most-referring sources are the ones whose links
    /// say most about the target, so they are the ones kept.
    /// </para>
    /// <para>
    /// Two hundred because the backlinks panel reads up to a hundred of the same rows by the same
    /// index for the same item, and doubling that is still a bounded probe of the
    /// <c>(tenant_id, source_item_id)</c> primary key per source.
    /// </para>
    /// </remarks>
    public const int MaximumSources = 200;

    private readonly IItemLinks _links = links;

    /// <summary>Reads the related items.</summary>
    /// <param name="query">The target, and how many to return.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The related items, or why they could not be read.</returns>
    public async ValueTask<Result<RelatedItemResults>> HandleAsync(
        GetRelatedItems query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        var limit = Math.Clamp(query.Limit, 1, MaximumLimit);
        var notFound = SearchErrors.NotFound($"No item {query.TargetId} is visible.");

        var target = await tree.FindAsync(query.TargetId, cancellationToken).ConfigureAwait(false);
        if (target is null)
        {
            return Result.Failure<RelatedItemResults>(notFound);
        }

        // One question, asked once, for the reason GetBacklinksHandler gives: gating on one answer
        // and filtering by another is how the two drift apart.
        var workspaces = await permissions
            .ReadableWorkspacesAsync(cancellationToken)
            .ConfigureAwait(false);

        if (!workspaces.Contains(target.WorkspaceId))
        {
            return Result.Failure<RelatedItemResults>(notFound);
        }

        var related = await _links
            .RelatedAsync(query.TargetId, workspaces, MaximumSources, limit, cancellationToken)
            .ConfigureAwait(false);

        return Result.Success(new RelatedItemResults(related, limit));
    }
}

/// <summary>
/// Route handler for reading an item's related items.
/// </summary>
internal static class GetRelatedItemsEndpoint
{
    /// <summary>Handles a related-items request.</summary>
    /// <param name="itemId">The item whose co-citations are wanted.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the query to its handler.</param>
    /// <param name="limit">The most related items to return.</param>
    /// <returns>The related items.</returns>
    internal static async Task<Results<Ok<RelatedItemsResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher,
        int limit = GetRelatedItemsHandler.DefaultLimit)
    {
        var result = await dispatcher
            .QueryAsync<GetRelatedItems, Result<RelatedItemResults>>(
                new GetRelatedItems(ItemId.From(itemId), limit),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        if (result.IsFailure)
        {
            return TypedResults.Problem(SearchEndpoints.Problem(httpContext, result.Error));
        }

        var found = result.Value;
        var responses = new List<RelatedItemResponse>(found.Related.Count);
        foreach (var related in found.Related)
        {
            responses.Add(new RelatedItemResponse(
                SearchMapping.ToResponse(related.Item),
                related.SharedSources));
        }

        return TypedResults.Ok(new RelatedItemsResponse(responses, found.Limit, found.Truncated));
    }
}
