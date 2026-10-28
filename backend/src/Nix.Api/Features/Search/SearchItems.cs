using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Search;

/// <summary>Finds items by what they are called and by what their documents say.</summary>
/// <param name="Query">What the person typed.</param>
/// <param name="Limit">The most results to return.</param>
public sealed record SearchItems(string Query, int Limit) : IQuery<Result<SearchResults>>;

/// <summary>What a search found, and whether it found more than it returned.</summary>
/// <param name="Query">The query that was run.</param>
/// <param name="Hits">The matches, most relevant first.</param>
/// <param name="Limit">The ceiling that was applied.</param>
public sealed record SearchResults(string Query, IReadOnlyList<ItemDigest> Hits, int Limit)
{
    /// <summary>
    /// Whether the ceiling was reached, so the interface can say so rather than implying it has
    /// shown everything.
    /// </summary>
    /// <remarks>
    /// Derived from the count rather than counted separately. A second query for the true total
    /// would double the cost of every keystroke to produce a number nobody acts on - "more than
    /// twenty" is what a person needs to know, and it is what this says.
    /// </remarks>
    public bool Truncated => Hits.Count >= Limit;
}

/// <summary>
/// Finds items the caller may read.
/// </summary>
/// <remarks>
/// <para>
/// <b>The whole use case is: ask the authorization port where this principal may look, then hand
/// that to one query.</b> There is no filtering step after the search, because there is nothing
/// left to filter - which is the property that makes a result count, a ranking and a page
/// boundary all describe rows the caller was entitled to.
/// </para>
/// <para>
/// A blank query returns nothing rather than everything. It is what an interface sends while
/// somebody is still deleting what they typed, and answering it with the first twenty items in the
/// tenant would be both expensive and a non-answer.
/// </para>
/// </remarks>
public sealed class SearchItemsHandler(
    IItemSearch search,
    IPermissionResolver permissions)
    : IQueryHandler<SearchItems, Result<SearchResults>>
{
    /// <summary>The most results one search may return.</summary>
    /// <remarks>
    /// A ceiling rather than a page, because search is not paged: a person who did not find what
    /// they wanted in the first twenty rows types more words rather than asking for rows twenty-one
    /// to forty. Paging would be a cursor to maintain and a second round trip to spend on a
    /// behaviour nobody performs.
    /// </remarks>
    public const int MaximumLimit = 50;

    /// <summary>The number of results returned when a caller names none.</summary>
    public const int DefaultLimit = 20;

    /// <summary>
    /// The shortest query that is actually searched.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Three because that is the length of a trigram.</b> <c>gin_trgm_ops</c> cannot extract one
    /// from a shorter pattern, so the planner drops <c>ix_item_title_trgm</c> entirely and falls
    /// back to reading every item in the caller's readable workspaces and applying the <c>ILIKE</c>
    /// as a filter. Measured on a hundred-thousand-item tenant, a two-character query cost 30.6ms
    /// against 8.1ms for an eight-character one - and the two-character figure grows with the
    /// workspace while the eight-character one grows with the number of matches. Both the palette
    /// and the reference picker debounce at 150ms, so somebody typing a word emits two of those
    /// before the third character lands.
    /// </para>
    /// <para>
    /// Returning nothing is therefore the honest answer rather than a refusal: the interface asks
    /// for more letters. Making one- and two-character search work needs a prefix path against
    /// <c>ix_item_title</c>'s <c>text_pattern_ops</c>, which is a different query and a different
    /// goal.
    /// </para>
    /// </remarks>
    public const int MinimumQueryLength = 3;

    private readonly IItemSearch _search = search;

    /// <summary>Runs the search.</summary>
    /// <param name="query">What to look for, and how much to return.</param>
    /// <param name="cancellationToken">Cancels the search.</param>
    /// <returns>The matches.</returns>
    public async ValueTask<Result<SearchResults>> HandleAsync(
        SearchItems query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        var text = query.Query.Trim();
        var limit = Math.Clamp(query.Limit, 1, MaximumLimit);

        // Below the trigram floor this would be a corpus scan per keystroke; see MinimumQueryLength.
        // The empty query lands here too, which is what an interface sends while somebody is still
        // deleting what they typed.
        if (text.Length < MinimumQueryLength)
        {
            return Result.Success(new SearchResults(text, [], limit));
        }

        var workspaces = await permissions
            .ReadableWorkspacesAsync(cancellationToken)
            .ConfigureAwait(false);

        var hits = await _search
            .FindAsync(text, workspaces, limit, cancellationToken)
            .ConfigureAwait(false);

        return Result.Success(new SearchResults(text, hits, limit));
    }
}

/// <summary>
/// Route handler for searching.
/// </summary>
/// <remarks>
/// Named apart from <see cref="SearchItems"/> itself: the query record already owns that
/// identifier in this namespace.
/// </remarks>
internal static class SearchItemsEndpoint
{
    /// <summary>Handles a search request.</summary>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the query to its handler.</param>
    /// <param name="q">What to look for.</param>
    /// <param name="limit">The most results to return.</param>
    /// <returns>The matches.</returns>
    internal static async Task<Results<Ok<SearchResponse>, ProblemHttpResult>> Handle(
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher,
        string? q = null,
        int limit = SearchItemsHandler.DefaultLimit)
    {
        var result = await dispatcher
            .QueryAsync<SearchItems, Result<SearchResults>>(
                new SearchItems(q ?? string.Empty, limit),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        if (result.IsFailure)
        {
            return TypedResults.Problem(SearchEndpoints.Problem(httpContext, result.Error));
        }

        var found = result.Value;
        return TypedResults.Ok(new SearchResponse(
            found.Query,
            SearchMapping.ToResponses(found.Hits),
            found.Limit,
            found.Truncated));
    }
}
