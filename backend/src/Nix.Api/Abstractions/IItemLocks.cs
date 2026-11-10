using Nix.Domain.Items;

namespace Nix.Abstractions;

/// <summary>
/// Item locks and the grants past them, for the tenant and credential of the current unit of work.
/// </summary>
/// <remarks>
/// <para>
/// <b>A lock covers its subtree.</b> Every read here except <see cref="IsLockedAsync"/> and
/// <see cref="FindVerifierAsync"/> counts an item's ancestors' locks as its own, so a child of a
/// locked folder is closed until the folder is opened, and so are the children lists and views
/// under it. Those two read the item's own lock only, because they back setting, changing and
/// removing that one password.
/// </para>
/// <para>
/// <b>Not a permission resolver.</b> A lock narrows what somebody who may already read an item can
/// see of it - the body - and every caller asks <see cref="IPermissionResolver"/> first. Nothing
/// here answers whether the item is visible at all.
/// </para>
/// <para>
/// The credential is taken from <see cref="CredentialSessionContext"/>, never from a parameter, so a
/// handler cannot check or issue a grant for a credential other than the one that authenticated.
/// </para>
/// </remarks>
public interface IItemLocks
{
    /// <summary>
    /// Whether the item is locked by its own lock or an ancestor's, and until when the current
    /// credential has every one of them open.
    /// </summary>
    /// <param name="itemId">The item.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The lock state as the current credential sees it.</returns>
    public ValueTask<ItemLockState> GetStateAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>
    /// Whether the current credential may read the item's body and list its children: no lock
    /// covers it, or this credential holds an unexpired grant for every lock that does.
    /// </summary>
    /// <param name="itemId">The item.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns><see langword="true"/> when the body and children may be served.</returns>
    public ValueTask<bool> MayReadBodyAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>
    /// As <see cref="MayReadBodyAsync"/> but judging item locks only. For a surface its owner
    /// published on purpose (a public note link), which is served under a service identity that
    /// can never hold a workspace unlock.
    /// </summary>
    /// <param name="itemId">The item.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns><see langword="true"/> when no item lock withholds the body.</returns>
    public ValueTask<bool> MayReadBodyIgnoringWorkspaceLockAsync(ItemId itemId, CancellationToken cancellationToken) =>
        MayReadBodyAsync(itemId, cancellationToken);

    /// <summary>
    /// Whether the item, any of its descendants, or any of its ancestors is locked, whoever has
    /// them unlocked.
    /// </summary>
    /// <param name="itemId">The root of the subtree.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns><see langword="true"/> when any lock covers part of the subtree.</returns>
    public ValueTask<bool> AnyInSubtreeAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>Which of these items are locked, by their own lock or an ancestor's, whoever is asking.</summary>
    /// <param name="itemIds">The items.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The locked ones.</returns>
    public ValueTask<IReadOnlySet<ItemId>> LockedAmongAsync(
        IReadOnlyList<ItemId> itemIds,
        CancellationToken cancellationToken);

    /// <summary>The stored verifier, or <see langword="null"/> when the item is not locked.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The verifier.</returns>
    public ValueTask<string?> FindVerifierAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>Locks an unlocked item.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="verifier">The derived verifier to store.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns><see langword="false"/> when the item was already locked and nothing was written.</returns>
    public ValueTask<bool> LockAsync(ItemId itemId, string verifier, CancellationToken cancellationToken);

    /// <summary>Replaces a lock's verifier and ends every grant issued under the old one.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="expected">The verifier the current password was checked against.</param>
    /// <param name="verifier">The new verifier.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>
    /// <see langword="false"/> when the item is no longer locked, or its password changed since the check.
    /// </returns>
    public ValueTask<bool> ChangeVerifierAsync(
        ItemId itemId,
        string expected,
        string verifier,
        CancellationToken cancellationToken);

    /// <summary>Removes a lock and every grant past it only while its verified password still holds.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="expected">The verifier the password was checked against.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns><see langword="false"/> when the lock was removed or its password changed.</returns>
    public ValueTask<bool> RemoveAsync(ItemId itemId, string expected, CancellationToken cancellationToken);

    /// <summary>
    /// Issues or extends the current credential's grant past a lock, provided the lock still
    /// carries <paramref name="verifier"/> - the one the password was just checked against.
    /// </summary>
    /// <param name="itemId">The item.</param>
    /// <param name="verifier">The verifier the password was checked against.</param>
    /// <param name="expiresAt">When the grant stops being honoured.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>
    /// <see langword="false"/> when the lock was removed, or its password changed, since the check.
    /// </returns>
    /// <exception cref="InvalidOperationException">The current credential cannot hold a grant.</exception>
    public ValueTask<bool> GrantAsync(
        ItemId itemId,
        string verifier,
        DateTimeOffset expiresAt,
        CancellationToken cancellationToken);

    /// <summary>
    /// Whether the item carries a lock of its own, whoever is asking and whatever they have
    /// unlocked. An ancestor's lock does not count.
    /// </summary>
    /// <param name="itemId">The item.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns><see langword="true"/> when the item has a lock.</returns>
    public ValueTask<bool> IsLockedAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>Ends the current credential's grant, if it holds one.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>A task that completes when the grant is gone.</returns>
    public ValueTask RevokeAsync(ItemId itemId, CancellationToken cancellationToken);
}

/// <summary>An item's locks as one credential sees them.</summary>
/// <param name="Locked">Whether the item or any ancestor has a lock.</param>
/// <param name="UnlockedUntil">
/// When the first of the current credential's grants past those locks ends, or
/// <see langword="null"/> while any of them is not open.
/// </param>
/// <param name="LockItemId">
/// The lock to open next - the nearest one without a grant - or, when all are open, the nearest
/// one. <see langword="null"/> when nothing is locked.
/// </param>
/// <param name="SelfLocked">Whether the item carries a lock of its own.</param>
public sealed record ItemLockState(
    bool Locked,
    DateTimeOffset? UnlockedUntil,
    ItemId? LockItemId,
    bool SelfLocked);
