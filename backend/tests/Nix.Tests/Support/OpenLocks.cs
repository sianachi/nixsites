using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Tests.Support;

/// <summary>
/// Item locks that cover nothing, for handler tests that wire the real visible-item gate over their
/// own tree and permission doubles. A call other than the body-open check fails the test.
/// </summary>
internal sealed class OpenLocks : IItemLocks
{
    public ValueTask<bool> MayReadBodyAsync(ItemId itemId, CancellationToken cancellationToken) => ValueTask.FromResult(true);

    public ValueTask<ItemLockState> GetStateAsync(ItemId itemId, CancellationToken cancellationToken) => throw new NotSupportedException();

    public ValueTask<bool> AnyInSubtreeAsync(ItemId itemId, CancellationToken cancellationToken) => throw new NotSupportedException();

    public ValueTask<IReadOnlySet<ItemId>> LockedAmongAsync(IReadOnlyList<ItemId> itemIds, CancellationToken cancellationToken) => throw new NotSupportedException();

    public ValueTask<string?> FindVerifierAsync(ItemId itemId, CancellationToken cancellationToken) => throw new NotSupportedException();

    public ValueTask<bool> LockAsync(ItemId itemId, string verifier, CancellationToken cancellationToken) => throw new NotSupportedException();

    public ValueTask<bool> ChangeVerifierAsync(ItemId itemId, string expected, string verifier, CancellationToken cancellationToken) => throw new NotSupportedException();

    public ValueTask<bool> RemoveAsync(ItemId itemId, string expected, CancellationToken cancellationToken) => throw new NotSupportedException();

    public ValueTask<bool> GrantAsync(ItemId itemId, string verifier, DateTimeOffset expiresAt, CancellationToken cancellationToken) => throw new NotSupportedException();

    public ValueTask<bool> IsLockedAsync(ItemId itemId, CancellationToken cancellationToken) => throw new NotSupportedException();

    public ValueTask RevokeAsync(ItemId itemId, CancellationToken cancellationToken) => throw new NotSupportedException();
}
