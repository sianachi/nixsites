using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Links;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Search;

/// <summary>Reads what points at an item.</summary>
/// <param name="TargetId">The item being pointed at.</param>
/// <param name="Limit">The most backlinks to return.</param>
public sealed record GetBacklinks(ItemId TargetId, int Limit) : IQuery<Result<BacklinkResults>>;

/// <summary>What a backlinks read found.</summary>
/// <param name="Backlinks">The referring documents, most-referring first.</param>
/// <param name="Limit">The ceiling that was applied.</param>
public sealed record BacklinkResults(IReadOnlyList<Backlink> Backlinks, int Limit)
{
    /// <summary>Whether the ceiling was reached.</summary>
    public bool Truncated => Backlinks.Count >= Limit;
}

/// <summary>
/// Reads the documents that refer to an item.
/// </summary>
/// <remarks>
/// <para>
/// <b>One permission answer, used twice.</b> The caller must be able to read the item they are
/// asking about - otherwise this endpoint answers "nothing points at it", which for an identifier
/// they guessed is still a statement about a document they may not see. And each referring document
/// must be one they may read: being entitled to the item in front of you does not entitle you to
/// know that a document in another workspace mentions it. Both fall out of the readable-workspace
/// set, so the port is asked once and the two uses cannot drift apart.
/// </para>
/// <para>
/// An unreadable target is reported as not found, matching every other item read. "You may not see
/// this" confirms the thing exists.
/// </para>
/// </remarks>
public sealed class GetBacklinksHandler(
    IItemLinks links,
    IItemTree tree,
    IPermissionResolver permissions)
    : IQueryHandler<GetBacklinks, Result<BacklinkResults>>
{
    /// <summary>The most backlinks one read may return.</summary>
    public const int MaximumLimit = 100;

    /// <summary>The number returned when a caller names none.</summary>
    public const int DefaultLimit = 25;

    /// <summary>Reads the backlinks.</summary>
    /// <param name="query">The target, and how many to return.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The referring documents, or why they could not be read.</returns>
    public async ValueTask<Result<BacklinkResults>> HandleAsync(
        GetBacklinks query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        var limit = Math.Clamp(query.Limit, 1, MaximumLimit);
        var notFound = SearchErrors.NotFound($"No item {query.TargetId} is visible.");

        var target = await tree.FindAsync(query.TargetId, cancellationToken).ConfigureAwait(false);
        if (target is null)
        {
            return Result.Failure<BacklinkResults>(notFound);
        }

        // One question, asked once. This used to call `CanReadWorkspaceAsync` for the target and
        // then `ReadableWorkspacesAsync` for the filter - two statements answering the same
        // question, which are equivalent only while permission is per workspace. The moment access
        // control entries make it per item, the handler would be gating on one answer and filtering
        // by another, and nothing would fail until somebody noticed a backlink they should not see.
        var workspaces = await permissions
            .ReadableWorkspacesAsync(cancellationToken)
            .ConfigureAwait(false);

        if (!workspaces.Contains(target.WorkspaceId))
        {
            return Result.Failure<BacklinkResults>(notFound);
        }

        var backlinks = await links
            .BacklinksAsync(query.TargetId, workspaces, limit, cancellationToken)
            .ConfigureAwait(false);

        return Result.Success(new BacklinkResults(backlinks, limit));
    }
}

/// <summary>
/// Route handler for reading an item's backlinks.
/// </summary>
internal static class GetBacklinksEndpoint
{
    /// <summary>Handles a backlinks request.</summary>
    /// <param name="itemId">The item being pointed at.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the query to its handler.</param>
    /// <param name="limit">The most backlinks to return.</param>
    /// <returns>The referring documents.</returns>
    internal static async Task<Results<Ok<BacklinksResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher,
        int limit = GetBacklinksHandler.DefaultLimit)
    {
        var result = await dispatcher
            .QueryAsync<GetBacklinks, Result<BacklinkResults>>(
                new GetBacklinks(ItemId.From(itemId), limit),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        if (result.IsFailure)
        {
            return TypedResults.Problem(SearchEndpoints.Problem(httpContext, result.Error));
        }

        var found = result.Value;
        var responses = new List<BacklinkResponse>(found.Backlinks.Count);
        foreach (var backlink in found.Backlinks)
        {
            responses.Add(new BacklinkResponse(
                SearchMapping.ToResponse(backlink.Source),
                backlink.Occurrences));
        }

        return TypedResults.Ok(new BacklinksResponse(responses, found.Limit, found.Truncated));
    }
}
