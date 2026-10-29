using System.Collections.Immutable;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Query;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;

namespace Nix.Tests.Features.Query;

// The query handlers' test doubles, shared by the saved-query and the ad-hoc query tests so both
// meet the same ports the same way.

/// <summary>Finds the one prepared item, however it is asked.</summary>
internal sealed class StubTree : IItemTree
{
    private readonly Item?[] _items;
    private readonly IReadOnlyList<WorkspaceId> _workspaces;

    internal StubTree(Item? item, params WorkspaceId[] workspaces)
    {
        _items = [item];
        _workspaces = workspaces;
    }

    private StubTree(Item?[] items, WorkspaceId[] workspaces)
    {
        _items = items;
        _workspaces = workspaces;
    }

    /// <summary>A tree holding several items and the workspaces that exist.</summary>
    internal static StubTree With(IReadOnlyList<Item> items, params WorkspaceId[] workspaces) =>
        new([.. items], workspaces);

    public ValueTask<Item?> FindAsync(ItemId id, CancellationToken cancellationToken) =>
        ValueTask.FromResult(_items.FirstOrDefault(item => item?.Id == id));

    public ValueTask<Item?> FindStoredAsync(ItemId id, CancellationToken cancellationToken) =>
        FindAsync(id, cancellationToken);

    public ValueTask<IReadOnlySet<ItemId>> WithChildrenAsync(
        WorkspaceId workspaceId,
        IReadOnlyList<ItemId> parents,
        CancellationToken cancellationToken) => throw new NotSupportedException();

    public ValueTask<IReadOnlyList<Item>> ListChildrenAsync(
        WorkspaceId workspaceId,
        ItemId? parentId,
        bool includeDeleted,
        long? afterSequence,
        int limit,
        CancellationToken cancellationToken) => throw new NotSupportedException();

    public ValueTask<bool> WorkspaceExistsAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
        ValueTask.FromResult(_workspaces.Contains(workspaceId));

    public ValueTask<long> NextSiblingSequenceAsync(
        WorkspaceId workspaceId,
        ItemId? parentId,
        CancellationToken cancellationToken) => throw new NotSupportedException();

    public ValueTask<long> AllocateSiblingSequenceAsync(
        WorkspaceId workspaceId,
        ItemId? parentId,
        ItemId movingId,
        ItemId? afterId,
        CancellationToken cancellationToken) => throw new NotSupportedException();

    public ValueTask InsertAsync(Item item, CancellationToken cancellationToken) =>
        throw new NotSupportedException();

    public ValueTask UpdatePropertiesAsync(
        ItemId id,
        string properties,
        PrincipalId actor,
        DateTimeOffset at,
        CancellationToken cancellationToken) => throw new NotSupportedException();

    public ValueTask UpdateSchemaAsync(
        ItemId id,
        string? schema,
        PrincipalId actor,
        DateTimeOffset at,
        CancellationToken cancellationToken) => throw new NotSupportedException();

    public ValueTask UpdateViewsAsync(
        ItemId id,
        string? views,
        PrincipalId actor,
        DateTimeOffset at,
        CancellationToken cancellationToken) => throw new NotSupportedException();

    public ValueTask TouchAsync(
        ItemId id,
        PrincipalId actor,
        DateTimeOffset at,
        CancellationToken cancellationToken) => throw new NotSupportedException();

    public ValueTask<bool> WouldCreateCycleAsync(
        ItemId id,
        ItemId newParentId,
        CancellationToken cancellationToken) => throw new NotSupportedException();

    public ValueTask ReparentAsync(
        ItemId id,
        ItemId? newParentId,
        long seq,
        PrincipalId actor,
        DateTimeOffset at,
        CancellationToken cancellationToken) => throw new NotSupportedException();

    public ValueTask SetLifecycleAsync(
        ItemId id,
        ItemLifecycleState state,
        PrincipalId actor,
        DateTimeOffset at,
        CancellationToken cancellationToken) => throw new NotSupportedException();
}

/// <summary>Answers every lock question with one fixed answer: everything open, or everything closed.</summary>
internal sealed class StubLocks(bool open) : IItemLocks
{
    public ValueTask<ItemLockState> GetStateAsync(ItemId itemId, CancellationToken cancellationToken) =>
        ValueTask.FromResult(new ItemLockState(!open, null, open ? null : itemId, !open));

    public ValueTask<bool> MayReadBodyAsync(ItemId itemId, CancellationToken cancellationToken) =>
        ValueTask.FromResult(open);

    public ValueTask<bool> AnyInSubtreeAsync(ItemId itemId, CancellationToken cancellationToken) =>
        ValueTask.FromResult(!open);

    public ValueTask<IReadOnlySet<ItemId>> LockedAmongAsync(
        IReadOnlyList<ItemId> itemIds,
        CancellationToken cancellationToken) =>
        ValueTask.FromResult<IReadOnlySet<ItemId>>(open ? new HashSet<ItemId>() : itemIds.ToHashSet());

    public ValueTask<string?> FindVerifierAsync(ItemId itemId, CancellationToken cancellationToken) =>
        throw new NotSupportedException();

    public ValueTask<bool> LockAsync(ItemId itemId, string verifier, CancellationToken cancellationToken) =>
        throw new NotSupportedException();

    public ValueTask<bool> ChangeVerifierAsync(
        ItemId itemId,
        string expected,
        string verifier,
        CancellationToken cancellationToken) => throw new NotSupportedException();

    public ValueTask<bool> RemoveAsync(ItemId itemId, string expected, CancellationToken cancellationToken) =>
        throw new NotSupportedException();

    public ValueTask<bool> GrantAsync(
        ItemId itemId,
        string verifier,
        DateTimeOffset expiresAt,
        CancellationToken cancellationToken) => throw new NotSupportedException();

    public ValueTask<bool> IsLockedAsync(ItemId itemId, CancellationToken cancellationToken) =>
        ValueTask.FromResult(!open);

    public ValueTask RevokeAsync(ItemId itemId, CancellationToken cancellationToken) =>
        throw new NotSupportedException();
}

/// <summary>Answers with a fixed session context, or none - the way a missing pipeline setup would.</summary>
internal sealed class StubSession : INixSessionContextAccessor
{
    internal StubSession(NixSessionContext? current) => Current = current;

    public NixSessionContext? Current { get; }
}

/// <summary>Answers with a fixed readable set, the way the resolver does for one principal.</summary>
internal sealed class StubPermissions : IPermissionResolver
{
    private readonly IReadOnlyList<WorkspaceId> _readable;

    internal StubPermissions(IReadOnlyList<WorkspaceId> readable) => _readable = readable;

    public ValueTask<bool> CanReadWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
        ValueTask.FromResult(_readable.Contains(workspaceId));

    public ValueTask<bool> CanWriteWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
        ValueTask.FromResult(_readable.Contains(workspaceId));

    public ValueTask<bool> CanCommentWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) => ValueTask.FromResult(false);


    public ValueTask<bool> CanManageWorkspaceAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
        ValueTask.FromResult(false);

    public ValueTask<IReadOnlyList<WorkspaceId>> ReadableWorkspacesAsync(CancellationToken cancellationToken) =>
        ValueTask.FromResult(_readable);

    public ValueTask<bool> IsTenantAdministratorAsync(CancellationToken cancellationToken) =>
        ValueTask.FromResult(false);
}

/// <summary>A query port that answers empty and remembers what it was asked.</summary>
internal sealed class RecordingQuery : IItemQuery
{
    internal int Calls { get; private set; }

    internal QuerySpec? LastSpec { get; private set; }

    internal QueryAggregate? LastAggregate { get; private set; }

    internal ItemId? LastQueryItemId => LastSpec?.ExcludedItemId;

    internal ImmutableArray<FilterRule> LastRules => LastSpec?.Rules ?? default;

    internal QueryOrder? LastOrder => LastSpec?.Order;

    internal IReadOnlyList<WorkspaceId> LastReadableWorkspaces { get; private set; } = [];

    internal int LastLimit { get; private set; }

    public ValueTask<QueryResults> RunAsync(
        QuerySpec spec,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int limit,
        CancellationToken cancellationToken)
    {
        Calls++;
        LastSpec = spec;
        LastReadableWorkspaces = readableWorkspaces;
        LastLimit = limit;

        return ValueTask.FromResult(QueryResults.Empty);
    }

    public ValueTask<QueryAggregateResults> AggregateAsync(
        QuerySpec spec,
        QueryAggregate aggregate,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int maximumGroups,
        CancellationToken cancellationToken)
    {
        Calls++;
        LastSpec = spec;
        LastAggregate = aggregate;
        LastReadableWorkspaces = readableWorkspaces;
        LastLimit = maximumGroups;

        return ValueTask.FromResult(QueryAggregateResults.Empty);
    }
}

/// <summary>Answers one fixed preferences row - a zone - or none at all.</summary>
internal sealed class StubPreferences(string? timeZone = null) : IPrincipalPreferencesStore
{
    internal int Reads { get; private set; }

    public ValueTask<Nix.Domain.Notifications.PrincipalPreferences?> FindAsync(
        TenantId tenantId,
        PrincipalId principalId,
        CancellationToken cancellationToken)
    {
        Reads++;
        return ValueTask.FromResult(timeZone is null
            ? null
            : new Nix.Domain.Notifications.PrincipalPreferences
            {
                TenantId = tenantId,
                PrincipalId = principalId,
                TimeZone = timeZone,
                DueReminderTime = new TimeOnly(9, 0),
                DueReminders = true,
                HabitReminders = true,
                MutedContainerIds = [],
                Revision = 1,
            });
    }

    public Task<bool> SaveAsync(
        Nix.Domain.Notifications.PrincipalPreferences preferences,
        long expectedRevision,
        CancellationToken cancellationToken) => throw new NotSupportedException();
}

/// <summary>A query port that throws the failure the reader raises for a refused statement.</summary>
internal sealed class FailingQuery(bool timedOut) : IItemQuery
{
    public ValueTask<QueryResults> RunAsync(
        QuerySpec spec,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int limit,
        CancellationToken cancellationToken) =>
        throw new ItemQueryFailedException(timedOut, timedOut ? "57014" : "22P02", new InvalidOperationException("stub"));

    public ValueTask<QueryAggregateResults> AggregateAsync(
        QuerySpec spec,
        QueryAggregate aggregate,
        IReadOnlyList<WorkspaceId> readableWorkspaces,
        int maximumGroups,
        CancellationToken cancellationToken) =>
        throw new ItemQueryFailedException(timedOut, timedOut ? "57014" : "22P02", new InvalidOperationException("stub"));
}
