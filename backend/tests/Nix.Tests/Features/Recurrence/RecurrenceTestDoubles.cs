using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Tests.Features.Recurrence;

/// <summary>The shared row two fakes read and write, the way one database row would.</summary>
internal sealed class FakeItemRow
{
    public required Item Base { get; init; }

    public string? RecurrenceJson { get; set; }
}

internal sealed class FakeItemTree(FakeItemRow? row) : IItemTree
{
    public ValueTask<Item?> FindAsync(ItemId id, CancellationToken cancellationToken) =>
        ValueTask.FromResult(row is not null && row.Base.Id == id ? WithRecurrence(row) : null);

    public ValueTask<Item?> FindStoredAsync(ItemId id, CancellationToken cancellationToken) =>
        FindAsync(id, cancellationToken);

    /// <summary>
    /// A fresh copy of the row's base item carrying its current recurrence JSON. <see cref="Item"/>
    /// is a plain class rather than a record, so this rebuilds it field by field instead of using
    /// a <c>with</c> expression.
    /// </summary>
    private static Item WithRecurrence(FakeItemRow row) => new()
    {
        Id = row.Base.Id,
        TenantId = row.Base.TenantId,
        WorkspaceId = row.Base.WorkspaceId,
        Type = row.Base.Type,
        ParentId = row.Base.ParentId,
        Seq = row.Base.Seq,
        Properties = row.Base.Properties,
        Schema = row.Base.Schema,
        Views = row.Base.Views,
        Recurrence = row.RecurrenceJson,
        DueDay = row.Base.DueDay,
        TemplateSourceId = row.Base.TemplateSourceId,
        LifecycleState = row.Base.LifecycleState,
        PurgeAfter = row.Base.PurgeAfter,
        CreatedBy = row.Base.CreatedBy,
        LastModifiedBy = row.Base.LastModifiedBy,
        CreatedAt = row.Base.CreatedAt,
        LastModifiedAt = row.Base.LastModifiedAt,
    };

    public ValueTask<IReadOnlySet<ItemId>> WithChildrenAsync(
        WorkspaceId workspaceId,
        IReadOnlyList<ItemId> parents,
        CancellationToken cancellationToken) => throw new NotSupportedException();

    public ValueTask<IReadOnlyList<Item>> ListChildrenAsync(
        WorkspaceId workspaceId,
        ItemId? parentId,
        bool includeDeleted,
        long? afterSeq,
        int limit,
        CancellationToken cancellationToken) => throw new NotSupportedException();

    public ValueTask<bool> WorkspaceExistsAsync(WorkspaceId workspaceId, CancellationToken cancellationToken) =>
        throw new NotSupportedException();

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
        ItemId parentId,
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
