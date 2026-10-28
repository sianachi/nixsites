using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Links;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Features.Search;

/// <summary>Finds the readable items in one workspace whose titles a passage of text names.</summary>
/// <param name="Text">The passage, as the caller sent it.</param>
/// <param name="Workspace">
/// The workspace the passage is written in, or <see langword="null"/> when the caller named none
/// (refused). Intersected with what the caller may read, never trusted.
/// </param>
/// <param name="ExcludedItems">
/// Items never to suggest: the note being written and what it already links to. At most
/// <see cref="FindMentionsHandler.MaximumExclusions"/>.
/// </param>
public sealed record FindMentions(string Text, WorkspaceId? Workspace, IReadOnlyList<ItemId> ExcludedItems)
    : IQuery<Result<MentionResults>>;

/// <summary>One item a passage names, and the words that named it.</summary>
/// <param name="Item">The item.</param>
/// <param name="Phrase">The words as they appear in the passage (after Unicode NFC normalisation).</param>
public sealed record FoundMention(ItemDigest Item, string Phrase);

/// <summary>What a mention match found.</summary>
/// <param name="Mentions">The matches, longest phrase first.</param>
/// <param name="Truncated">
/// Whether the answer may be partial: the result ceiling was reached, or the passage yielded more
/// candidate phrases than one request matches and its tail was not considered.
/// </param>
public sealed record MentionResults(IReadOnlyList<FoundMention> Mentions, bool Truncated);

/// <summary>
/// Finds "unlinked mentions": readable items whose title appears in a passage as a whole-word
/// phrase, ignoring case.
/// </summary>
/// <remarks>
/// <para>
/// <b>The server cuts the passage, not the client.</b> <see cref="MentionPhrases"/> turns the text
/// into a bounded set of word n-grams, and one statement compares them for equality with every
/// readable title. The caller controls the text and nothing else - not the number of probes, not
/// their shape - which is what makes the cost a property of this code rather than of a request.
/// </para>
/// <para>
/// <b>One workspace, intersected with the permission answer every search read uses.</b> The caller
/// names the workspace the passage is written in; the handler keeps it only when
/// <see cref="IPermissionResolver"/> lists it as readable, and hands exactly that one workspace into
/// the statement as a predicate. A workspace the caller cannot reach finds nothing - the same
/// answer as a workspace with no matching title - so a passage cannot be used to test whether a
/// document with a given name exists somewhere else in the tenant. Naming one workspace also bounds
/// the scan by the workspace being written in rather than by everything the caller can read.
/// </para>
/// <para>
/// <b>Exclusions are filtered by the server, before any cap.</b> The note itself and the items it
/// already links to would otherwise spend result slots on suggestions the editor then throws away.
/// Their count is bounded so the array parameter stays small.
/// </para>
/// <para>
/// Titles only, so the body rule of a lock does not apply; its title rule does (ADR-0056): a title
/// under a lock this credential has not opened is never a mention.
/// </para>
/// </remarks>
public sealed class FindMentionsHandler(
    IItemSearch search,
    IPermissionResolver permissions)
    : IQueryHandler<FindMentions, Result<MentionResults>>
{
    /// <summary>The longest passage one request may match, in UTF-16 code units.</summary>
    /// <remarks>
    /// A paragraph or two around the cursor, which is what an editor sends; a whole long document
    /// is matched a window at a time. The bound keeps the phrase cut and the request body small.
    /// </remarks>
    public const int MaximumTextLength = 4000;

    /// <summary>The most mentions one request returns.</summary>
    public const int MaximumMentions = 20;

    /// <summary>The most items one request may exclude.</summary>
    /// <remarks>
    /// The note being written plus the distinct targets it links to. A note with more than this
    /// many outgoing links is rare; the editor sends the ones nearest the passage first and checks
    /// the rest itself.
    /// </remarks>
    public const int MaximumExclusions = 256;

    /// <summary>Finds the mentions.</summary>
    /// <param name="query">The passage.</param>
    /// <param name="cancellationToken">Cancels the match.</param>
    /// <returns>The mentions, or why the passage was refused.</returns>
    public async ValueTask<Result<MentionResults>> HandleAsync(
        FindMentions query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        var text = query.Text;
        if (text.Length > MaximumTextLength)
        {
            return Result.Failure<MentionResults>(SearchErrors.MentionTextTooLong(
                $"At most {MaximumTextLength} characters may be matched in one request; this one "
                + $"sent {text.Length}. Send the passage around the cursor rather than the whole "
                + "document."));
        }

        if (query.Workspace is not { } workspace)
        {
            return Result.Failure<MentionResults>(SearchErrors.MentionWorkspaceRequired(
                "Name the workspace the passage is written in as 'workspaceId'; mentions are "
                + "matched against one workspace's titles."));
        }

        if (query.ExcludedItems.Count > MaximumExclusions)
        {
            return Result.Failure<MentionResults>(SearchErrors.TooManyMentionExclusions(
                $"At most {MaximumExclusions} items may be excluded in one request; this one named "
                + $"{query.ExcludedItems.Count}."));
        }

        var phrases = MentionPhrases.Extract(text);
        if (phrases.Phrases.Count == 0)
        {
            // Blank, or nothing in it long enough to be a title. Not worth a round trip.
            return Result.Success(new MentionResults([], phrases.Capped));
        }

        var readable = await permissions
            .ReadableWorkspacesAsync(cancellationToken)
            .ConfigureAwait(false);
        if (!readable.Contains(workspace))
        {
            // Indistinguishable from a workspace with no matching title, on purpose.
            return Result.Success(new MentionResults([], Truncated: false));
        }

        var matches = await search
            .MentionsAsync(phrases.Phrases, [workspace], query.ExcludedItems, MaximumMentions, cancellationToken)
            .ConfigureAwait(false);

        var mentions = new List<FoundMention>(matches.Count);
        foreach (var match in matches)
        {
            // The statement can only return a phrase it was given, so the lookup always succeeds;
            // falling back to the normalised phrase keeps a mismatch visible rather than fatal.
            var original = phrases.Originals.GetValueOrDefault(match.Phrase, match.Phrase);
            mentions.Add(new FoundMention(match.Item, original));
        }

        return Result.Success(new MentionResults(
            mentions,
            phrases.Capped || mentions.Count >= MaximumMentions));
    }
}

/// <summary>
/// Route handler for matching a passage's mentions.
/// </summary>
internal static class FindMentionsEndpoint
{
    /// <summary>Handles a mention-matching request.</summary>
    /// <param name="request">The passage.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the query to its handler.</param>
    /// <returns>The mentions.</returns>
    internal static async Task<Results<Ok<MentionsResponse>, ProblemHttpResult>> Handle(
        MentionsRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(httpContext);
        ArgumentNullException.ThrowIfNull(dispatcher);

        var excluded = new List<ItemId>(request.ExcludeIds?.Count ?? 0);
        if (request.ExcludeIds is { } identifiers)
        {
            foreach (var identifier in identifiers)
            {
                excluded.Add(ItemId.From(identifier));
            }
        }

        var result = await dispatcher
            .QueryAsync<FindMentions, Result<MentionResults>>(
                new FindMentions(
                    request.Text ?? string.Empty,
                    request.WorkspaceId is { } workspace ? WorkspaceId.From(workspace) : null,
                    excluded),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        if (result.IsFailure)
        {
            return TypedResults.Problem(SearchEndpoints.Problem(httpContext, result.Error));
        }

        var found = result.Value;
        var responses = new List<MentionResponse>(found.Mentions.Count);
        foreach (var mention in found.Mentions)
        {
            responses.Add(new MentionResponse(SearchMapping.ToResponse(mention.Item), mention.Phrase));
        }

        return TypedResults.Ok(new MentionsResponse(responses, found.Truncated));
    }
}
