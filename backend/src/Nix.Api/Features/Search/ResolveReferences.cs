using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Search;

/// <summary>Resolves the identifiers a document's references point at.</summary>
/// <param name="ItemIds">The identifiers to resolve, in the order the caller asked.</param>
public sealed record ResolveReferences(IReadOnlyList<ItemId> ItemIds) : IQuery<Result<ResolvedReferences>>;

/// <summary>
/// What each requested identifier resolved to, in the order it was asked about.
/// </summary>
/// <param name="Resolutions">One entry per requested identifier.</param>
public sealed record ResolvedReferences(IReadOnlyList<ResolvedReference> Resolutions);

/// <summary>One identifier's answer.</summary>
/// <param name="Id">The identifier that was asked about.</param>
/// <param name="Item">The item, or <see langword="null"/> when the caller may not see it.</param>
public sealed record ResolvedReference(ItemId Id, ItemDigest? Item);

/// <summary>
/// Resolves references, and refuses to say why one could not be resolved.
/// </summary>
/// <remarks>
/// <para>
/// <b>This is what stops a title leaking out of a document.</b> A reference node stores the
/// target's title as it was when the link was made, so it can render something before resolution
/// returns. That cache is a title, and a reader with no permission on the target has no
/// entitlement to it - so resolution has to be the thing that decides, and it has to answer
/// "resolved" and "not yours to see" as two distinguishable states. A client that could not tell
/// them apart would have to choose between showing the cache to everybody and showing it to
/// nobody, and the first is a leak wearing a fallback's clothes.
/// </para>
/// <para>
/// It refuses to distinguish the reasons, though. Deleted, never existed, and in a workspace you
/// cannot reach are one answer, because telling them apart turns this endpoint into a way to
/// enumerate a tenant one identifier at a time.
/// </para>
/// </remarks>
public sealed class ResolveReferencesHandler(
    IItemSearch search,
    IPermissionResolver permissions)
    : IQueryHandler<ResolveReferences, Result<ResolvedReferences>>
{
    /// <summary>The most identifiers one request may name.</summary>
    /// <remarks>
    /// A document holds as many references as somebody cares to type, and the client asks about
    /// the ones on screen. Two hundred is far above a screenful and far below anything that makes
    /// the array parameter expensive to plan.
    /// </remarks>
    public const int MaximumIdentifiers = 200;

    /// <summary>Resolves the identifiers.</summary>
    /// <param name="query">The identifiers to resolve.</param>
    /// <param name="cancellationToken">Cancels the lookup.</param>
    /// <returns>One answer per identifier.</returns>
    public async ValueTask<Result<ResolvedReferences>> HandleAsync(
        ResolveReferences query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        var requested = query.ItemIds;
        if (requested.Count == 0)
        {
            return Result.Success(new ResolvedReferences([]));
        }

        if (requested.Count > MaximumIdentifiers)
        {
            return Result.Failure<ResolvedReferences>(
                SearchErrors.TooManyReferences(
                    $"At most {MaximumIdentifiers} references may be resolved in one request; "
                    + $"this one named {requested.Count}."));
        }

        var workspaces = await permissions
            .ReadableWorkspacesAsync(cancellationToken)
            .ConfigureAwait(false);

        var readable = await search
            .ResolveAsync(requested, workspaces, cancellationToken)
            .ConfigureAwait(false);

        var byId = new Dictionary<ItemId, ItemDigest>(readable.Count);
        foreach (var digest in readable)
        {
            byId[digest.Id] = digest;
        }

        // Answered in the order asked, including for the ones that resolved to nothing. The caller
        // is a document with a reference per position, and an answer it has to match up by
        // identifier is one it can get wrong.
        var resolutions = new List<ResolvedReference>(requested.Count);
        foreach (var itemId in requested)
        {
            resolutions.Add(new ResolvedReference(itemId, byId.GetValueOrDefault(itemId)));
        }

        return Result.Success(new ResolvedReferences(resolutions));
    }
}

/// <summary>
/// Route handler for resolving references.
/// </summary>
internal static class ResolveReferencesEndpoint
{
    /// <summary>Handles a bulk resolution request.</summary>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the query to its handler.</param>
    /// <param name="ids">The identifiers, comma-separated.</param>
    /// <returns>One answer per identifier.</returns>
    internal static async Task<Results<Ok<ReferencesResponse>, ProblemHttpResult>> Handle(
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher,
        string? ids = null)
    {
        if (!TryParseIdentifiers(ids, out var itemIds))
        {
            return TypedResults.Problem(SearchEndpoints.Problem(
                httpContext,
                SearchErrors.MalformedReferences(
                    "Every value in 'ids' must be an identifier. The whole request is refused "
                    + "rather than the unreadable ones being dropped, because a caller that "
                    + "asked about five references and got four answers cannot tell which.")));
        }

        var result = await dispatcher
            .QueryAsync<ResolveReferences, Result<ResolvedReferences>>(
                new ResolveReferences(itemIds),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        if (result.IsFailure)
        {
            return TypedResults.Problem(SearchEndpoints.Problem(httpContext, result.Error));
        }

        var responses = new List<ReferenceResolutionResponse>(result.Value.Resolutions.Count);
        foreach (var resolution in result.Value.Resolutions)
        {
            responses.Add(new ReferenceResolutionResponse(
                resolution.Id.Value,
                resolution.Item is not null,
                resolution.Item is null ? null : SearchMapping.ToResponse(resolution.Item)));
        }

        return TypedResults.Ok(new ReferencesResponse(responses));
    }

    private static bool TryParseIdentifiers(string? ids, out IReadOnlyList<ItemId> itemIds)
    {
        if (string.IsNullOrWhiteSpace(ids))
        {
            itemIds = [];
            return true;
        }

        var parts = ids.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var parsed = new List<ItemId>(parts.Length);

        foreach (var part in parts)
        {
            if (!Guid.TryParse(part, out var value))
            {
                itemIds = [];
                return false;
            }

            parsed.Add(ItemId.From(value));
        }

        itemIds = parsed;
        return true;
    }
}
