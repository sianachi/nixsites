using Nix.Abstractions;
using Nix.Domain.Bookmarks;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Bookmarks;

/// <summary>Reads what the acting principal has kept.</summary>
public sealed record GetShelf : IQuery<Result<ShelfResults>>;

/// <summary>A shelf, and how much of it is not shown.</summary>
/// <param name="Items">What the caller may still read, most recently kept first.</param>
/// <param name="Hidden">How many kept rows are not in <paramref name="Items"/>.</param>
public sealed record ShelfResults(IReadOnlyList<KeptItem> Items, int Hidden);

/// <summary>Puts an item on the acting principal's shelf.</summary>
/// <param name="ItemId">The item to keep.</param>
public sealed record KeepItem(ItemId ItemId) : ICommand<bool>;

/// <summary>Takes an item off the acting principal's shelf.</summary>
/// <param name="ItemId">The item to release.</param>
public sealed record ReleaseItem(ItemId ItemId) : ICommand<bool>;

/// <summary>
/// Reads the acting principal's shelf.
/// </summary>
/// <remarks>
/// <para>
/// <b>The shelf outlives access to what is on it, and the read is what keeps that honest.</b> Being
/// removed from a workspace does not delete rows - there is nothing that would, short of a job
/// watching every membership change - so the list is filtered by what the caller may read today,
/// inside the statement, and the count says how many rows that left out.
/// </para>
/// <para>
/// Naming the omitted items would disclose the titles of documents somebody has been removed from,
/// which is most of what there was to hide. Dropping them silently would be a shelf that loses
/// things without saying so. A number is the only one of the three that is both honest and safe.
/// </para>
/// </remarks>
public sealed class GetShelfHandler(
    IBookmarkShelf shelf,
    IPermissionResolver permissions)
    : IQueryHandler<GetShelf, Result<ShelfResults>>
{
    private readonly IBookmarkShelf _shelf = shelf;

    /// <summary>Reads the shelf.</summary>
    /// <param name="query">Carries nothing: a shelf belongs to whoever is asking.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The shelf.</returns>
    public async ValueTask<Result<ShelfResults>> HandleAsync(
        GetShelf query,
        CancellationToken cancellationToken)
    {
        var workspaces = await permissions
            .ReadableWorkspacesAsync(cancellationToken)
            .ConfigureAwait(false);

        var items = await _shelf.ListAsync(workspaces, cancellationToken).ConfigureAwait(false);
        var kept = await _shelf.CountAsync(cancellationToken).ConfigureAwait(false);

        // Never negative, even if a row were somehow added between the two statements: a shelf that
        // reported "-1 hidden" would be a worse bug than the race it came from.
        return Result.Success(new ShelfResults(items, Math.Max(kept - items.Count, 0)));
    }
}

/// <summary>
/// Puts an item on the acting principal's shelf.
/// </summary>
/// <remarks>
/// <b>Keeping something is only possible for something the caller can read.</b> The readable
/// workspaces go into the insert as a predicate, so the statement selects the item rather than
/// trusting the identifier. Without that, anybody could put any identifier on their own shelf and
/// read its title back from the list - a shelf would become an oracle for whether an item exists.
/// A refusal is reported as "not found" for the same reason every other read is.
/// </remarks>
public sealed class KeepItemHandler(
    IBookmarkShelf shelf,
    IPermissionResolver permissions)
    : ICommandHandler<KeepItem, bool>
{
    private readonly IBookmarkShelf _shelf = shelf;

    /// <summary>Keeps the item.</summary>
    /// <param name="command">The item to keep.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>Whether a row was written, or why it could not be.</returns>
    public async ValueTask<Result<bool>> HandleAsync(
        KeepItem command,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var workspaces = await permissions
            .ReadableWorkspacesAsync(cancellationToken)
            .ConfigureAwait(false);

        var kept = await _shelf
            .KeepAsync(command.ItemId, workspaces, cancellationToken)
            .ConfigureAwait(false);

        // `false` here is either "already kept" or "not visible", and the two are not told apart on
        // purpose. Distinguishing them would answer, for any identifier, whether it names something
        // the caller cannot see - which is the disclosure the predicate exists to prevent. Both are
        // reported as success, because in both cases the item is on the shelf if it can be.
        return Result.Success(kept);
    }
}

/// <summary>
/// Takes an item off the acting principal's shelf.
/// </summary>
/// <remarks>
/// No permission check, deliberately, and it is the one write here without one. Somebody who has
/// lost access to an item must still be able to clear it off their own shelf: a row they can
/// neither see nor remove would be permanent clutter, and refusing would disclose that the row is
/// there. The statement is scoped to their own principal, so this can only ever remove their own.
/// </remarks>
public sealed class ReleaseItemHandler(IBookmarkShelf shelf) : ICommandHandler<ReleaseItem, bool>
{
    private readonly IBookmarkShelf _shelf = shelf;

    /// <summary>Releases the item.</summary>
    /// <param name="command">The item to release.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>Whether a row was removed.</returns>
    public async ValueTask<Result<bool>> HandleAsync(
        ReleaseItem command,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        // Removing something that is not on the shelf is not an error: the reader asked for it to
        // be off, and it is off. Reporting a failure would make the control fail when somebody
        // presses it twice.
        var removed = await _shelf
            .ReleaseAsync(command.ItemId, cancellationToken)
            .ConfigureAwait(false);

        return Result.Success(removed);
    }
}
