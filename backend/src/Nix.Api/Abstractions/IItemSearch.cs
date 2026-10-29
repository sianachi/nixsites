using Nix.Domain.Items;
using Nix.Domain.Links;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>
/// Finds items the acting principal may read - by what they are called, by what their documents
/// say, or by identifier.
/// </summary>
/// <remarks>
/// <para>
/// A port because the dependency direction requires one: both questions are joins across
/// <c>item</c> and <c>item_search</c>, and only Persistence may write those. It is also the seam a
/// different engine would arrive behind - the moment ranking wants more than Postgres's own text
/// search, nothing above this interface should notice.
/// </para>
/// <para>
/// <b>Every method takes the readable workspaces and none of them works it out.</b> That looks
/// like a caller's chore and is the whole design: the set comes from
/// <see cref="IPermissionResolver"/>, which is the single authorization code path, and passing it
/// in means the filter is a predicate inside the query rather than a pass over its results.
/// Filtering afterwards would let a limit be spent on rows the caller may not see - so a page could
/// come back empty while matches existed - and would compute a ranking against them. An
/// implementation that resolved permissions for itself would be a second authorization path, which
/// is the thing that eventually disagrees with the first.
/// </para>
/// <para>
/// An empty set of readable workspaces is a legitimate answer to ask with, and it returns nothing.
/// A principal who belongs to no workspace searches an empty product rather than an error.
/// </para>
/// </remarks>
public interface IItemSearch
{
    /// <summary>
    /// Items whose title or document text matches, most relevant first.
    /// </summary>
    /// <param name="query">What the person typed. Never a pattern; never SQL.</param>
    /// <param name="readableWorkspaces">Where the caller is allowed to look.</param>
    /// <param name="limit">The most results to return.</param>
    /// <param name="cancellationToken">Cancels the search.</param>
    /// <returns>The matches, ordered with title matches first.</returns>
    /// <remarks>
    /// A title match ranks above a body match: somebody typing into a palette is usually trying to
    /// reach a document they can already name, and the note merely mentioning the word must not
    /// come above the note called it. Nothing under a lock the credential has not opened is
    /// returned, by title or by body (ADR-0056).
    /// </remarks>
    public ValueTask<IReadOnlyList<ItemDigest>> FindAsync(
        string query,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int limit,
        CancellationToken cancellationToken);

    /// <summary>
    /// The items among <paramref name="itemIds"/> that the caller may read.
    /// </summary>
    /// <param name="itemIds">The identifiers to resolve.</param>
    /// <param name="readableWorkspaces">Where the caller is allowed to look.</param>
    /// <param name="cancellationToken">Cancels the lookup.</param>
    /// <returns>
    /// A digest per readable identifier, in no particular order, and nothing at all for the rest.
    /// </returns>
    /// <remarks>
    /// <b>What a document's references resolve against, and the reason a title cannot leak.</b> A
    /// reference node carries the target's title as it was when the link was made, cached for
    /// rendering - and that cache is a title the reader may have no entitlement to. An identifier
    /// missing from the result is one of three things: it never existed, it was deleted, or it is
    /// in a workspace this caller cannot reach. They are deliberately indistinguishable, because
    /// telling them apart is how an outsider enumerates a tenant one identifier at a time.
    /// </remarks>
    public ValueTask<IReadOnlyList<ItemDigest>> ResolveAsync(
        IReadOnlyList<ItemId> itemIds,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        CancellationToken cancellationToken);

    /// <summary>
    /// The readable items whose title, lower-cased, equals one of <paramref name="phrases"/>,
    /// longest title first, a few per phrase.
    /// </summary>
    /// <param name="phrases">
    /// Normalised phrases cut from a passage by <c>MentionPhrases</c>. Never a caller's list, never
    /// a pattern.
    /// </param>
    /// <param name="readableWorkspaces">
    /// Where to look: the workspace the passage is written in, already intersected with what the
    /// caller may read.
    /// </param>
    /// <param name="excludedItems">
    /// Items never to return - the note being written and what it already links to - left out
    /// before any cap so they spend no slot.
    /// </param>
    /// <param name="limit">The most mentions to return.</param>
    /// <param name="cancellationToken">Cancels the lookup.</param>
    /// <returns>Each matching item with the phrase it matched.</returns>
    /// <remarks>
    /// Titles only, so the body rule a lock carries does not apply; the title rule does
    /// (ADR-0056): nothing under a lock this credential has not opened is returned, exactly as for
    /// <see cref="FindAsync"/>'s title arm. The locked item's own title is.
    /// </remarks>
    public ValueTask<IReadOnlyList<TitleMention>> MentionsAsync(
        IReadOnlyList<string> phrases,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        IReadOnlyList<ItemId> excludedItems,
        int limit,
        CancellationToken cancellationToken);

    /// <summary>
    /// The passages of a note and every note under it, or of every note in
    /// <paramref name="readableWorkspaces"/> when <paramref name="rootId"/> is null, that best
    /// answer <paramref name="query"/>.
    /// </summary>
    /// <param name="rootId">The note whose subtree is searched, itself included; null for the workspaces.</param>
    /// <param name="query">What to find, in the person's or the pet's words.</param>
    /// <param name="readableWorkspaces">Where the caller is allowed to look.</param>
    /// <param name="limit">The most passages to return.</param>
    /// <param name="cancellationToken">Cancels the search.</param>
    /// <returns>The passages, most relevant first.</returns>
    /// <remarks>
    /// Ranked by full text and, when the local model is loaded, by meaning, fused. Passages are
    /// body text, so the body rule a lock carries applies (ADR-0056): nothing at or under any lock
    /// is returned, opened or not, and neither is anything trashed, under a trashed ancestor or in a
    /// template.
    /// </remarks>
    public ValueTask<IReadOnlyList<NotePassage>> FindPassagesAsync(
        ItemId? rootId,
        string query,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int limit,
        CancellationToken cancellationToken);
}

/// <summary>One retrieved passage of a note body.</summary>
/// <param name="ItemId">The note the passage is from.</param>
/// <param name="Title">That note's title.</param>
/// <param name="Heading">The heading trail above the passage, outermost first; empty before the first heading.</param>
/// <param name="Ord">The passage's position in its note, from zero.</param>
/// <param name="Text">The passage.</param>
public sealed record NotePassage(ItemId ItemId, string Title, string Heading, int Ord, string Text);
