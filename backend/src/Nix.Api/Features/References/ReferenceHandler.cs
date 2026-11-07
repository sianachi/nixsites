using System.Buffers.Text;
using Nix.Abstractions;
using Nix.Domain.Files;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.References;
using Nix.Messaging;

namespace Nix.Features.References;

/// <summary>Adds a reference from <paramref name="HolderId"/>.</summary>
public sealed record AddReference(ItemId HolderId, AddItemReferenceRequest Request) : ICommand<ItemReferenceResponse>;

/// <summary>Removes a reference held by <paramref name="HolderId"/>.</summary>
public sealed record RemoveReference(ItemId HolderId, Guid ReferenceId) : ICommand<Guid>;

/// <summary>One page of references and the cursor for the next, or null on the last page.</summary>
public sealed record ReferencePage<T>(IReadOnlyList<T> Items, string? NextCursor);

/// <summary>Lists the references an item holds.</summary>
public sealed record ListReferences(ItemId HolderId, string? Cursor, int Limit) : IQuery<Result<ReferencePage<ItemReferenceResponse>>>;

/// <summary>Lists the references pointing at an item.</summary>
public sealed record ListReferencedBy(ItemId TargetId, string? Cursor, int Limit) : IQuery<Result<ReferencePage<ItemReferencedByResponse>>>;

/// <summary>
/// References and pins. Same workspace only; the caller needs write on the workspace to add or
/// remove and read to list; a locked holder or target stays closed, and a locked or trashed item's
/// title is withheld.
/// </summary>
public sealed class ReferenceHandler(
    IItemTree tree,
    IPermissionResolver permissions,
    IItemLocks locks,
    IItemReferenceStore store,
    IFinanceLock topology,
    INixSessionContextAccessor session,
    TimeProvider clock) :
    ICommandHandler<AddReference, ItemReferenceResponse>,
    ICommandHandler<RemoveReference, Guid>,
    IQueryHandler<ListReferences, Result<ReferencePage<ItemReferenceResponse>>>,
    IQueryHandler<ListReferencedBy, Result<ReferencePage<ItemReferencedByResponse>>>
{
    private const int MaxRole = 80;

    /// <inheritdoc />
    public async ValueTask<Result<ItemReferenceResponse>> HandleAsync(AddReference command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var request = command.Request ?? throw new ArgumentNullException(nameof(command));
        var role = string.IsNullOrWhiteSpace(request.Role) ? null : request.Role.Trim();
        if (role?.Length > MaxRole)
        {
            return Invalid<ItemReferenceResponse>("references.role_invalid", $"A role is at most {MaxRole} characters.");
        }

        var holder = await tree.FindAsync(command.HolderId, cancellationToken).ConfigureAwait(false);
        if (holder is null || !await permissions.CanWriteWorkspaceAsync(holder.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return NotFound<ItemReferenceResponse>();
        }

        // Pin creation and trash both run under this lock, so a pin cannot slip in between the
        // delete's pin check and its flag write. Both ends are re-read inside it.
        await topology.AcquireWorkspaceTopologyAsync(holder.WorkspaceId, cancellationToken).ConfigureAwait(false);
        holder = await tree.FindAsync(command.HolderId, cancellationToken).ConfigureAwait(false);
        var target = await tree.FindAsync(ItemId.From(request.TargetItemId), cancellationToken).ConfigureAwait(false);
        if (holder is null)
        {
            return NotFound<ItemReferenceResponse>();
        }

        // One answer for missing, trashed and other-workspace targets, so nothing about another workspace leaks.
        if (target is null || target.WorkspaceId != holder.WorkspaceId)
        {
            return Invalid<ItemReferenceResponse>("references.target_not_found", "The target is not an active item in this workspace.");
        }

        foreach (var end in new[] { holder.Id, target.Id })
        {
            if (!await locks.MayReadBodyAsync(end, cancellationToken).ConfigureAwait(false))
            {
                return Result.Failure<ItemReferenceResponse>(ItemErrorsLocked(end));
            }
        }

        FileVersionId? version = request.TargetFileVersionId is { } pinned ? FileVersionId.From(pinned) : null;
        if (version is { } wanted)
        {
            if (target.Type != "file")
            {
                return Invalid<ItemReferenceResponse>("references.pin_requires_file", "Only a file can be pinned to a version.");
            }

            var state = await store.VersionStateAsync(target.Id, wanted, cancellationToken).ConfigureAwait(false);
            if (state is null)
            {
                return Invalid<ItemReferenceResponse>("references.version_not_found", "That version does not belong to the target file.");
            }

            if (state != FileVersionStates.Approved)
            {
                return Invalid<ItemReferenceResponse>("references.version_not_approved", "Only an approved version can be pinned.");
            }
        }

        // The same edge is the same reference: a retry gets the one that exists.
        var reference = await store.FindEdgeAsync(holder.Id, target.Id, version, role, cancellationToken).ConfigureAwait(false);
        if (reference is null)
        {
            reference = new ItemReference
            {
                Id = Guid.CreateVersion7(),
                TenantId = holder.TenantId,
                WorkspaceId = holder.WorkspaceId,
                HolderItemId = holder.Id,
                TargetItemId = target.Id,
                TargetFileVersionId = version,
                Role = role,
                CreatedBy = (session.Current ?? throw new InvalidOperationException("No session context.")).PrincipalId,
                CreatedAt = clock.GetUtcNow(),
            };
            await store.AddAsync(reference, cancellationToken).ConfigureAwait(false);
        }

        var states = await StatesAsync([reference], cancellationToken).ConfigureAwait(false);
        return Result.Success(await ToResponseAsync(reference, states, cancellationToken).ConfigureAwait(false));
    }

    /// <inheritdoc />
    public async ValueTask<Result<Guid>> HandleAsync(RemoveReference command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        // The stored row, not the visible one: a pin must stay removable while its holder is in the trash.
        var holder = await tree.FindStoredAsync(command.HolderId, cancellationToken).ConfigureAwait(false);
        if (holder is null || holder.LifecycleState == ItemLifecycleState.Purged
            || !await permissions.CanWriteWorkspaceAsync(holder.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return NotFound<Guid>();
        }

        if (!await locks.MayReadBodyAsync(holder.Id, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Guid>(ItemErrorsLocked(holder.Id));
        }

        return await store.RemoveAsync(holder.Id, command.ReferenceId, cancellationToken).ConfigureAwait(false)
            ? Result.Success(command.ReferenceId)
            : Result.Failure<Guid>(new NixError("references.not_found", "No such reference."));
    }

    /// <inheritdoc />
    public async ValueTask<Result<ReferencePage<ItemReferenceResponse>>> HandleAsync(ListReferences query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        if (!TryCursor(query.Cursor, out var after))
        {
            return Invalid<ReferencePage<ItemReferenceResponse>>("references.invalid_cursor", "The cursor is not valid.");
        }

        var holder = await ReadableAsync(query.HolderId, cancellationToken).ConfigureAwait(false);
        if (holder is null)
        {
            return NotFound<ReferencePage<ItemReferenceResponse>>();
        }

        if (!await locks.MayReadBodyAsync(holder.Id, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ReferencePage<ItemReferenceResponse>>(ItemErrorsLocked(holder.Id));
        }

        var take = Clamp(query.Limit);
        var rows = await store.ListHeldAsync(holder.Id, after, take + 1, cancellationToken).ConfigureAwait(false);
        var page = rows.Take(take).ToList();
        var states = await StatesAsync(page, cancellationToken).ConfigureAwait(false);
        var items = new List<ItemReferenceResponse>(page.Count);
        foreach (var row in page)
        {
            items.Add(await ToResponseAsync(row, states, cancellationToken).ConfigureAwait(false));
        }

        return Result.Success(new ReferencePage<ItemReferenceResponse>(items, rows.Count > take ? Encode(page[^1].Id) : null));
    }

    /// <inheritdoc />
    public async ValueTask<Result<ReferencePage<ItemReferencedByResponse>>> HandleAsync(ListReferencedBy query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        if (!TryCursor(query.Cursor, out var after))
        {
            return Invalid<ReferencePage<ItemReferencedByResponse>>("references.invalid_cursor", "The cursor is not valid.");
        }

        var target = await ReadableAsync(query.TargetId, cancellationToken).ConfigureAwait(false);
        if (target is null)
        {
            return NotFound<ReferencePage<ItemReferencedByResponse>>();
        }

        if (!await locks.MayReadBodyAsync(target.Id, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ReferencePage<ItemReferencedByResponse>>(ItemErrorsLocked(target.Id));
        }

        var take = Clamp(query.Limit);
        var rows = await store.ListTargetingAsync(target.Id, after, take + 1, cancellationToken).ConfigureAwait(false);
        var page = rows.Take(take).ToList();
        var items = new List<ItemReferencedByResponse>(page.Count);
        foreach (var row in page)
        {
            var (title, available) = await DescribeAsync(row.HolderItemId, cancellationToken).ConfigureAwait(false);
            items.Add(new ItemReferencedByResponse(
                row.Id, row.HolderItemId.Value, title, available, row.TargetItemId.Value,
                row.TargetFileVersionId?.Value, row.Role, row.CreatedBy.Value, row.CreatedAt));
        }

        return Result.Success(new ReferencePage<ItemReferencedByResponse>(items, rows.Count > take ? Encode(page[^1].Id) : null));
    }

    private async ValueTask<Item?> ReadableAsync(ItemId id, CancellationToken cancellationToken)
    {
        var item = await tree.FindAsync(id, cancellationToken).ConfigureAwait(false);
        return item is not null && await permissions.CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false)
            ? item
            : null;
    }

    private async ValueTask<IReadOnlyDictionary<FileVersionId, string>> StatesAsync(IReadOnlyList<ItemReference> rows, CancellationToken cancellationToken)
    {
        var ids = rows.Where(r => r.TargetFileVersionId is not null).Select(r => r.TargetFileVersionId!.Value).Distinct().ToArray();
        return ids.Length == 0
            ? new Dictionary<FileVersionId, string>()
            : await store.VersionStatesAsync(ids, cancellationToken).ConfigureAwait(false);
    }

    private async ValueTask<ItemReferenceResponse> ToResponseAsync(
        ItemReference row, IReadOnlyDictionary<FileVersionId, string> states, CancellationToken cancellationToken)
    {
        var (title, available) = await DescribeAsync(row.TargetItemId, cancellationToken).ConfigureAwait(false);
        return new ItemReferenceResponse(
            row.Id, row.HolderItemId.Value, row.TargetItemId.Value, title, available,
            row.TargetFileVersionId?.Value,
            row.TargetFileVersionId is { } pinned && states.TryGetValue(pinned, out var state) ? state : null,
            row.Role, row.CreatedBy.Value, row.CreatedAt);
    }

    /// <summary>Title and availability of the item at the other end; a locked item's title is withheld and it reads as unavailable.</summary>
    // shortcut: one lookup per row (at most 200 per page); batch the reads if lists get hot.
    private async ValueTask<(string? Title, bool Available)> DescribeAsync(ItemId id, CancellationToken cancellationToken)
    {
        var stored = await tree.FindStoredAsync(id, cancellationToken).ConfigureAwait(false);
        if (stored is null || stored.LifecycleState == ItemLifecycleState.Purged
            || !await locks.MayReadBodyAsync(id, cancellationToken).ConfigureAwait(false))
        {
            return (null, false);
        }

        var visible = stored.LifecycleState == ItemLifecycleState.Active
            && await tree.FindAsync(id, cancellationToken).ConfigureAwait(false) is not null;
        return (ItemProperties.ReadTitle(stored.Properties), visible);
    }

    private static int Clamp(int limit) => Math.Clamp(limit, 1, 200);

    private static string Encode(Guid id) => Base64Url.EncodeToString(id.ToByteArray());

    private static bool TryCursor(string? cursor, out Guid? after)
    {
        after = null;
        if (string.IsNullOrEmpty(cursor))
        {
            return true;
        }

        var bytes = new byte[16];
        if (!Base64Url.IsValid(cursor) || !Base64Url.TryDecodeFromChars(cursor, bytes, out var written) || written != 16)
        {
            return false;
        }

        after = new Guid(bytes);
        return true;
    }

    private static NixError ItemErrorsLocked(ItemId id) =>
        new("items.locked", $"Item {id} is locked. Unlock it to work with its references.");

    private static Result<T> NotFound<T>() => Result.Failure<T>(new NixError("items.not_found", "No such item is visible."));

    private static Result<T> Invalid<T>(string code, string message) => Result.Failure<T>(new NixError(code, message));
}
