using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Search;

/// <summary>The passages of a note and everything under it that best answer a query.</summary>
/// <param name="RootId">The note whose subtree is searched.</param>
/// <param name="Query">What to find.</param>
/// <param name="Limit">The most passages to return.</param>
public sealed record GetPassages(ItemId RootId, string Query, int Limit) : IQuery<Result<IReadOnlyList<NotePassage>>>;

/// <summary>
/// Retrieval for a pet reading a note too long for one reply, or the notes under it.
/// </summary>
/// <remarks>
/// The root must be readable, like a backlinks target; the subtree is then filtered by the same
/// readable workspaces inside the query, so a passage can never come from a note the caller could
/// not open.
/// </remarks>
public sealed class GetPassagesHandler(
    IItemSearch search,
    IItemTree tree,
    IPermissionResolver permissions)
    : IQueryHandler<GetPassages, Result<IReadOnlyList<NotePassage>>>
{
    /// <summary>The most passages one request may return.</summary>
    public const int MaximumLimit = 20;

    /// <summary>The number returned when a caller names none.</summary>
    public const int DefaultLimit = 8;

    /// <summary>The longest query accepted.</summary>
    public const int MaximumQueryLength = 1000;

    /// <inheritdoc />
    public async ValueTask<Result<IReadOnlyList<NotePassage>>> HandleAsync(
        GetPassages query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        var text = query.Query.Trim();
        if (text.Length > MaximumQueryLength)
        {
            text = text[..MaximumQueryLength];
        }

        var notFound = SearchErrors.NotFound($"No item {query.RootId} is visible.");
        var root = await tree.FindAsync(query.RootId, cancellationToken).ConfigureAwait(false);
        if (root is null)
        {
            return Result.Failure<IReadOnlyList<NotePassage>>(notFound);
        }

        var workspaces = await permissions.ReadableWorkspacesAsync(cancellationToken).ConfigureAwait(false);
        if (!workspaces.Contains(root.WorkspaceId))
        {
            return Result.Failure<IReadOnlyList<NotePassage>>(notFound);
        }

        return Result.Success(await search
            .FindPassagesAsync(query.RootId, text, workspaces, Math.Clamp(query.Limit, 1, MaximumLimit), cancellationToken)
            .ConfigureAwait(false));
    }
}

/// <summary>One passage as the API returns it.</summary>
/// <param name="ItemId">The note the passage is from.</param>
/// <param name="Title">That note's title.</param>
/// <param name="Heading">The heading trail above the passage; empty before the first heading.</param>
/// <param name="Ord">The passage's position in its note, from zero.</param>
/// <param name="Text">The passage.</param>
internal sealed record PassageResponse(Guid ItemId, string Title, string Heading, int Ord, string Text);

/// <summary>The passages found, most relevant first.</summary>
/// <param name="Passages">The passages.</param>
internal sealed record PassagesResponse(IReadOnlyList<PassageResponse> Passages);

internal static class GetPassagesEndpoint
{
    /// <summary>Handles a passage search.</summary>
    internal static async Task<Results<Ok<PassagesResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher,
        string? q = null,
        int limit = GetPassagesHandler.DefaultLimit)
    {
        var result = await dispatcher
            .QueryAsync<GetPassages, Result<IReadOnlyList<NotePassage>>>(
                new GetPassages(ItemId.From(itemId), q ?? string.Empty, limit),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        if (result.IsFailure)
        {
            return TypedResults.Problem(SearchEndpoints.Problem(httpContext, result.Error));
        }

        return TypedResults.Ok(new PassagesResponse(
            [.. result.Value.Select(passage => new PassageResponse(
                passage.ItemId.Value, passage.Title, passage.Heading, passage.Ord, passage.Text))]));
    }
}
