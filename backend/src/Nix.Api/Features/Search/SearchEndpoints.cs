using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Primitives;
using Nix.Errors;
using Nix.Http;

namespace Nix.Features.Search;

/// <summary>
/// Route registration for the search feature: finding items, resolving what a document points at,
/// reading what points back, what is cited alongside, and which titles a passage names.
/// </summary>
/// <remarks>
/// <para>
/// One feature rather than three, because all three answer the same question with a different
/// starting point - "which items may this caller see, given X" - and all three stand on the same
/// pair of derived tables. Splitting them would mean the permission predicate written three times.
/// </para>
/// <para>
/// Searching has no route of its own under an item or a workspace: it opens over whatever is on
/// screen and is scoped by what the caller may read, not by where they happen to be.
/// </para>
/// </remarks>
internal static class SearchEndpoints
{
    /// <summary>Stable code for "no such item, or the caller cannot see it".</summary>
    internal const string NotFoundCode = "items.not_found";

    /// <summary>Stable code for a passage search that ran past its statement timeout.</summary>
    internal const string TimedOutCode = "search.timed_out";

    /// <summary>Stable code for a resolution request naming too many identifiers.</summary>
    internal const string TooManyReferencesCode = "search.too_many_references";

    /// <summary>Stable code for a resolution request whose identifier list will not parse.</summary>
    internal const string MalformedReferencesCode = "search.malformed_references";

    /// <summary>Stable code for a mention request whose text exceeds the accepted length.</summary>
    internal const string MentionTextTooLongCode = "search.mention_text_too_long";

    /// <summary>Stable code for a mention request that names no workspace.</summary>
    internal const string MentionWorkspaceRequiredCode = "search.mention_workspace_required";

    /// <summary>Stable code for a mention request excluding more items than one request may.</summary>
    internal const string TooManyMentionExclusionsCode = "search.too_many_mention_exclusions";

    /// <summary>
    /// The largest mention request body accepted, in bytes.
    /// </summary>
    /// <remarks>
    /// Four thousand characters is at most 24 KiB of JSON even if every one is escaped as
    /// <c>\uXXXX</c>, and 256 excluded identifiers are about 10 KiB more; 48 KiB leaves room for
    /// the envelope and refuses anything larger before it is buffered, well under the host-wide
    /// ceiling.
    /// </remarks>
    internal const long MentionRequestBodyLimit = 48 * 1024;

    /// <summary>
    /// Registers the search feature's routes on <paramref name="endpoints"/>.
    /// </summary>
    internal static IEndpointRouteBuilder MapSearchEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var search = endpoints.MapGroup("/api/v1/search").WithTags("Search");

        search.MapGet("/", SearchItemsEndpoint.Handle)
            .WithName("SearchItems")
            .WithSummary("Find items by title or document text")
            .WithDescription(
                "Returns items whose title contains 'q', or whose document text matches it, with "
                + "title matches ranked first. The search covers every workspace the caller may "
                + "read and nothing else - the filter is a predicate inside the query, so the "
                + "limit is never spent on rows that would then be discarded. An item in a "
                + "workspace the caller cannot reach is omitted entirely rather than redacted. A "
                + "blank query returns no results rather than every item.")
            .Produces<SearchResponse>(StatusCodes.Status200OK);

        search.MapGet("/references", ResolveReferencesEndpoint.Handle)
            .WithName("ResolveReferences")
            .WithSummary("Resolve the items a document's references point at")
            .WithDescription(
                "Takes 'ids' as a comma-separated list of identifiers and returns one entry for "
                + "each, in the order asked. An entry the caller may read carries the item's "
                + "current title; one they may not carries 'readable: false' and no title at all. "
                + "The two are distinguishable on purpose, because a reference node caches the "
                + "target's title for rendering and must show a stub rather than that cache when "
                + "the reader has no permission on it. Why an identifier did not resolve is "
                + "deliberately not reported: deleted, never existed, and not visible to you are "
                + "one answer.")
            .Produces<ReferencesResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status400BadRequest);

        search.MapPost("/mentions", FindMentionsEndpoint.Handle)
            .WithName("FindMentions")
            .WithSummary("Find the items whose titles a passage of text names")
            .WithDescription(
                "Takes 'text' (at most 4000 characters) and 'workspaceId', and returns up to 20 "
                + "items in that workspace whose title appears in the text as a whole-word phrase, "
                + "ignoring case, longest phrase first and at most three per phrase (the most "
                + "recently modified) - the editor's 'unlinked mentions'. The server cuts the text "
                + "into word phrases of one to six words itself; single words under four "
                + "characters and phrases made only of numbers are ignored, and phrases do not "
                + "span a line break or sentence punctuation. A workspace the caller may not read "
                + "finds nothing. Items listed in 'excludeIds' (at most 256: the note itself and "
                + "what it already links to) are never returned, and an item under a lock the "
                + "caller has not opened is never matched. A POST because the text is too long for "
                + "a URL; it reads and changes nothing, so a read-scoped token may call it. "
                + "'truncated' is set when 20 matches were found or the text held more phrases "
                + "than one request matches. Refusals: 'search.mention_text_too_long', "
                + "'search.mention_workspace_required', 'search.too_many_mention_exclusions', 413 "
                + "for a body over 48 KiB. Has its own per-address rate limit ('suggestions', 60 a "
                + "minute by default), separate from writes; send it when typing pauses and wait "
                + "out a 429's Retry-After.")
            .Accepts<MentionsRequest>("application/json")
            .Produces<MentionsResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status413PayloadTooLarge)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .WithRequestBodyLimit(MentionRequestBodyLimit)

            // A read, but a POST that scans a workspace per call, so it carries a per-address
            // window rather than being the one unthrottled way to make the server work. Its own
            // window, not the one writes share: a burst of lookups while somebody types must never
            // cost them a save.
            .RequireRateLimiting(RateLimitRefusal.SuggestionsPolicyName);

        var items = endpoints.MapGroup("/api/v1/items").WithTags("Search");

        items.MapGet("/{itemId:guid}/backlinks", GetBacklinksEndpoint.Handle)
            .WithName("GetBacklinks")
            .WithSummary("The documents that refer to an item")
            .WithDescription(
                "Returns the items whose documents link to this one, most-referring first. Only "
                + "referring documents the caller may read are included, and they are excluded "
                + "from the count as well as from the list: being able to read an item does not "
                + "entitle you to know that a document elsewhere mentions it. Backlinks are "
                + "derived from documents when they are snapshotted, so a link made moments ago "
                + "may not have been published yet.")
            .Produces<BacklinksResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);

        items.MapGet("/{itemId:guid}/passages", GetPassagesEndpoint.Handle)
            .WithName("GetPassages")
            .WithSummary("The passages of a note and the notes under it that best answer a query")
            .WithDescription(
                "Returns up to 'limit' (default 8, at most 20) passages from this item's document "
                + "and every readable document beneath it, ranked by full-text match fused with "
                + "semantic similarity when the server's local embedding model is loaded. Locked, "
                + "trashed and template content is never returned, opened or not. Passages are "
                + "derived when a document is snapshotted, so the newest edits may not be "
                + "searchable yet. An item the caller may not read is reported as not found.")
            .Produces<PassagesResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);

        items.MapGet("/{itemId:guid}/related", GetRelatedItemsEndpoint.Handle)
            .WithName("GetRelatedItems")
            .WithSummary("The items most often linked alongside an item")
            .WithDescription(
                "Returns the items that the documents linking to this one also link to, ranked by "
                + "how many such documents they share, then by title. 'limit' defaults to 10 and is "
                + "capped at 25. Only referring documents the caller may read, and that are not "
                + "locked, count towards a ranking - a locked document's links come from its body "
                + "- and only items the caller may read are returned. The ranking considers the "
                + "item's 200 most-referring readable documents, so a heavily linked item is "
                + "ranked from its strongest sources rather than all of them. An item the caller "
                + "may not read is reported as not found.")
            .Produces<RelatedItemsResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status404NotFound);

        return endpoints;
    }

    /// <summary>
    /// Maps a use case's failure onto the status its stable code implies.
    /// </summary>
    /// <param name="httpContext">The current request.</param>
    /// <param name="error">Why the use case failed.</param>
    /// <returns>Problem details describing the failure.</returns>
    /// <remarks>
    /// The code is the contract; the status is a consequence of it. Deciding the status here, in
    /// one place, is what stops two endpoints answering the same failure differently.
    /// </remarks>
    internal static ProblemDetails Problem(HttpContext httpContext, NixError error)
    {
        // Total over the codes this feature can raise, and 500 for anything else. A default of 404
        // would be the worst possible one: a code added to SearchErrors and forgotten here would
        // reach clients as the one status they already handle, carrying a message about something
        // else entirely.
        var status = error.Code switch
        {
            NotFoundCode => StatusCodes.Status404NotFound,
            TimedOutCode => StatusCodes.Status503ServiceUnavailable,
            TooManyReferencesCode or MalformedReferencesCode or MentionTextTooLongCode
                or MentionWorkspaceRequiredCode or TooManyMentionExclusionsCode
                => StatusCodes.Status400BadRequest,
            _ => StatusCodes.Status500InternalServerError,
        };

        return ApiProblem.Create(httpContext, status, error.Code, "Request refused", error.Message);
    }
}
