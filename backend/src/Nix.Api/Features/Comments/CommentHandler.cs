using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Npgsql;
using Nix.Domain.Comments;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Features.Items;
using Nix.Messaging;

namespace Nix.Features.Comments;

/// <summary>
/// Comments on notes. Every operation first resolves the note as the caller (not found when they
/// cannot read it), refuses a locked body, and writes require the commenter role.
/// </summary>
public sealed class CommentHandler(
    IItemTree tree,
    IPermissionResolver permissions,
    IItemLocks locks,
    INoteComments store,
    INixSessionContextAccessor session,
    TimeProvider clock) :
    IQueryHandler<ListComments, Result<CommentsResponse>>,
    IQueryHandler<WatchComments, Result<CommentsResponse>>,
    ICommandHandler<AddComment, CommentThreadDto>,
    ICommandHandler<ReplyComment, CommentThreadDto>,
    ICommandHandler<EditComment, CommentThreadDto>,
    ICommandHandler<SetCommentAnchor, CommentThreadDto>,
    ICommandHandler<SetCommentResolved, CommentThreadDto>,
    ICommandHandler<DeleteComment, Guid>
{
    private const int MaxBody = 10_000;
    private const int MaxMentions = 20;
    private const int MaxQuote = 1_000;
    private const int MaxPosition = 512;
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(750);
    private static readonly TimeSpan MaxWait = TimeSpan.FromSeconds(20);

    private PrincipalId Me => (session.Current ?? throw new InvalidOperationException("A session is required.")).PrincipalId;

    /// <inheritdoc />
    public async ValueTask<Result<CommentsResponse>> HandleAsync(ListComments query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        var gate = await GateAsync(query.ItemId, write: false, cancellationToken).ConfigureAwait(false);
        return gate.IsFailure ? Result.Failure<CommentsResponse>(gate.Error) : Result.Success(await ReadForCallerAsync(gate.Value, cancellationToken).ConfigureAwait(false));
    }

    /// <inheritdoc />
    public async ValueTask<Result<CommentsResponse>> HandleAsync(WatchComments query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        var gate = await GateAsync(query.ItemId, write: false, cancellationToken).ConfigureAwait(false);
        if (gate.IsFailure)
        {
            return Result.Failure<CommentsResponse>(gate.Error);
        }

        // Each poll is a fresh statement, so read-committed lets it see what another connection
        // committed while this one waited (the same shape as the notifications watch).
        var deadline = DateTimeOffset.UtcNow + MaxWait;
        while (true)
        {
            var revision = await store.RevisionAsync(query.ItemId, cancellationToken).ConfigureAwait(false);
            if (revision > query.After || DateTimeOffset.UtcNow >= deadline)
            {
                // The wait can be long: the caller may have lost access or the note been locked or trashed since.
                var again = await GateAsync(query.ItemId, write: false, cancellationToken).ConfigureAwait(false);
                if (again.IsFailure)
                {
                    return Result.Failure<CommentsResponse>(again.Error);
                }

                return Result.Success(await ReadForCallerAsync(again.Value, cancellationToken).ConfigureAwait(false));
            }

            var remaining = deadline - DateTimeOffset.UtcNow;
            await Task.Delay(remaining < PollInterval ? remaining : PollInterval, cancellationToken).ConfigureAwait(false);
        }
    }

    /// <inheritdoc />
    public async ValueTask<Result<CommentThreadDto>> HandleAsync(AddComment command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var request = command.Request ?? throw new ArgumentNullException(nameof(command));
        var gate = await GateAsync(command.ItemId, write: true, cancellationToken).ConfigureAwait(false);
        if (gate.IsFailure)
        {
            return Result.Failure<CommentThreadDto>(gate.Error);
        }

        var anchor = request.Anchor;
        string? quote = null;
        if (anchor is not null)
        {
            var positioned = !string.IsNullOrEmpty(anchor.Start) || !string.IsNullOrEmpty(anchor.End);
            if (positioned && (string.IsNullOrEmpty(anchor.Start) || string.IsNullOrEmpty(anchor.End)))
            {
                return Invalid<CommentThreadDto>("An anchor needs both a start and an end position.");
            }

            if (anchor.Start?.Length > MaxPosition || anchor.End?.Length > MaxPosition)
            {
                return Invalid<CommentThreadDto>("An anchor position is too long.");
            }

            if (!positioned && string.IsNullOrWhiteSpace(anchor.Quote))
            {
                return Invalid<CommentThreadDto>("An anchor needs a quote or positions.");
            }

            quote = string.IsNullOrEmpty(anchor.Quote) ? null : TextCut.Cut(anchor.Quote, MaxQuote);
        }

        var valid = Validate(request.Body, request.MentionIds);
        if (valid.IsFailure)
        {
            return Result.Failure<CommentThreadDto>(valid.Error);
        }

        if (await FullAsync(command.ItemId, cancellationToken).ConfigureAwait(false))
        {
            return Full<CommentThreadDto>();
        }

        var id = Guid.CreateVersion7();
        if (!await TryAddAsync(New(gate.Value, id, id, request.Body, valid.Value, anchor?.Start, anchor?.End, quote), cancellationToken).ConfigureAwait(false))
        {
            return Full<CommentThreadDto>();
        }

        return await ThreadAsync(command.ItemId, id, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<Result<CommentThreadDto>> HandleAsync(ReplyComment command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var request = command.Request ?? throw new ArgumentNullException(nameof(command));
        var gate = await GateAsync(command.ItemId, write: true, cancellationToken).ConfigureAwait(false);
        if (gate.IsFailure)
        {
            return Result.Failure<CommentThreadDto>(gate.Error);
        }

        var root = await RootAsync(command.ItemId, command.ThreadId, cancellationToken).ConfigureAwait(false);
        if (root is null)
        {
            return NotFound<CommentThreadDto>();
        }

        var valid = Validate(request.Body, request.MentionIds);
        if (valid.IsFailure)
        {
            return Result.Failure<CommentThreadDto>(valid.Error);
        }

        if (await FullAsync(command.ItemId, cancellationToken).ConfigureAwait(false))
        {
            return Full<CommentThreadDto>();
        }

        if (!await TryAddAsync(New(gate.Value, Guid.CreateVersion7(), root.Id, request.Body, valid.Value, null, null, null), cancellationToken).ConfigureAwait(false))
        {
            return Full<CommentThreadDto>();
        }

        return await ThreadAsync(command.ItemId, root.Id, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<Result<CommentThreadDto>> HandleAsync(EditComment command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var gate = await GateAsync(command.ItemId, write: true, cancellationToken).ConfigureAwait(false);
        if (gate.IsFailure)
        {
            return Result.Failure<CommentThreadDto>(gate.Error);
        }

        var valid = Validate(command.Request?.Body, null);
        if (valid.IsFailure)
        {
            return Result.Failure<CommentThreadDto>(valid.Error);
        }

        var own = await OwnAsync(command.ItemId, command.CommentId, cancellationToken).ConfigureAwait(false);
        if (own.IsFailure)
        {
            return Result.Failure<CommentThreadDto>(own.Error);
        }

        var comment = own.Value;
        comment.Body = command.Request!.Body;
        comment.EditedAt = clock.GetUtcNow();
        await store.SaveAsync(cancellationToken).ConfigureAwait(false);
        return await ThreadAsync(command.ItemId, comment.ThreadId, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<Result<CommentThreadDto>> HandleAsync(SetCommentAnchor command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var gate = await GateAsync(command.ItemId, write: true, cancellationToken).ConfigureAwait(false);
        if (gate.IsFailure)
        {
            return Result.Failure<CommentThreadDto>(gate.Error);
        }

        var anchor = command.Anchor;
        if (string.IsNullOrEmpty(anchor?.Start) || string.IsNullOrEmpty(anchor.End) || anchor.Start.Length > MaxPosition || anchor.End.Length > MaxPosition)
        {
            return Invalid<CommentThreadDto>("An anchor needs a start and an end position.");
        }

        var root = await RootAsync(command.ItemId, command.ThreadId, cancellationToken).ConfigureAwait(false);
        if (root is null)
        {
            return NotFound<CommentThreadDto>();
        }

        // Anyone who can comment may place a thread's first anchor; moving one is for its author or an editor.
        if (!string.IsNullOrEmpty(root.AnchorStart) && root.AuthorPrincipalId != Me
            && !await permissions.CanWriteWorkspaceAsync(gate.Value.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return NotAuthor<CommentThreadDto>("Only the thread's author or an editor can move its anchor.");
        }

        root.AnchorStart = anchor.Start;
        root.AnchorEnd = anchor.End;
        await store.SaveAsync(cancellationToken).ConfigureAwait(false);
        return await ThreadAsync(command.ItemId, root.Id, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<Result<CommentThreadDto>> HandleAsync(SetCommentResolved command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var gate = await GateAsync(command.ItemId, write: true, cancellationToken).ConfigureAwait(false);
        if (gate.IsFailure)
        {
            return Result.Failure<CommentThreadDto>(gate.Error);
        }

        var root = await RootAsync(command.ItemId, command.ThreadId, cancellationToken).ConfigureAwait(false);
        if (root is null)
        {
            return NotFound<CommentThreadDto>();
        }

        root.ResolvedAt = command.Resolved ? clock.GetUtcNow() : null;
        root.ResolvedBy = command.Resolved ? Me : null;
        await store.SaveAsync(cancellationToken).ConfigureAwait(false);
        return await ThreadAsync(command.ItemId, root.Id, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<Result<Guid>> HandleAsync(DeleteComment command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var gate = await GateAsync(command.ItemId, write: true, cancellationToken).ConfigureAwait(false);
        if (gate.IsFailure)
        {
            return Result.Failure<Guid>(gate.Error);
        }

        var own = await OwnAsync(command.ItemId, command.CommentId, cancellationToken).ConfigureAwait(false);
        if (own.IsFailure)
        {
            return Result.Failure<Guid>(own.Error);
        }

        var comment = own.Value;
        var thread = (await store.ListAsync(command.ItemId, cancellationToken).ConfigureAwait(false)).Where(row => row.ThreadId == comment.ThreadId).ToList();
        if (comment.ThreadId == comment.Id)
        {
            // A root others replied to stays as a tombstone, so their replies are not deleted with it.
            if (thread.Any(row => row.Id != comment.Id && row.AuthorPrincipalId != Me))
            {
                comment.Body = string.Empty;
                comment.DeletedAt = clock.GetUtcNow();
                await store.SaveAsync(cancellationToken).ConfigureAwait(false);
                return Result.Success(comment.Id);
            }

            await store.DeleteAsync(command.ItemId, comment.Id, cancellationToken).ConfigureAwait(false);
            return Result.Success(comment.Id);
        }

        await store.DeleteAsync(command.ItemId, comment.Id, cancellationToken).ConfigureAwait(false);
        // The last reply under a tombstone takes the tombstone with it.
        if (thread.Count == 2 && thread.Any(row => row.Id == comment.ThreadId && row.DeletedAt is not null))
        {
            await store.DeleteAsync(command.ItemId, comment.ThreadId, cancellationToken).ConfigureAwait(false);
        }

        return Result.Success(comment.Id);
    }

    private async ValueTask<NoteComment?> RootAsync(ItemId itemId, Guid threadId, CancellationToken cancellationToken)
    {
        var root = await store.FindAsync(itemId, threadId, cancellationToken).ConfigureAwait(false);
        return root is not null && root.ThreadId == root.Id ? root : null;
    }

    /// <summary>The comment, when it exists and the caller wrote it.</summary>
    private async ValueTask<Result<NoteComment>> OwnAsync(ItemId itemId, Guid commentId, CancellationToken cancellationToken)
    {
        var comment = await store.FindAsync(itemId, commentId, cancellationToken).ConfigureAwait(false);
        return comment is null || comment.DeletedAt is not null ? NotFound<NoteComment>() : comment.AuthorPrincipalId != Me ? NotAuthor<NoteComment>() : Result.Success(comment);
    }

    private NoteComment New(Item item, Guid id, Guid threadId, string body, Guid[] mentions, string? start, string? end, string? quote) => new()
    {
        TenantId = item.TenantId,
        Id = id,
        ItemId = item.Id,
        ThreadId = threadId,
        AuthorPrincipalId = Me,
        Body = body,
        MentionIds = mentions,
        AnchorStart = start,
        AnchorEnd = end,
        Quote = quote,
        CreatedAt = clock.GetUtcNow(),
    };

    private async ValueTask<Result<Item>> GateAsync(ItemId itemId, bool write, CancellationToken cancellationToken)
    {
        // FindAsync hides a trashed note and anything under a trashed ancestor; the stored row is read
        // only to tell a trashed note (409 on write) from one that is not there.
        var visible = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        var item = visible ?? (write ? await tree.FindStoredAsync(itemId, cancellationToken).ConfigureAwait(false) : null);
        if (item is null
            || (visible is null && item.LifecycleState != ItemLifecycleState.Deleted)
            || !await permissions.CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return NotFound<Item>();
        }

        if (item.Type != "note")
        {
            return Invalid<Item>("Only notes can be commented on.");
        }

        if (!await locks.MayReadBodyAsync(itemId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Item>(new NixError("items.locked", $"Item {itemId} is locked. Unlock it to see its comments."));
        }

        if (!write)
        {
            return Result.Success(item);
        }

        if (!await permissions.CanCommentWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Item>(new NixError("comments.forbidden", "Commenting needs the commenter role or higher."));
        }

        return visible is not null
            ? Result.Success(item)
            : Result.Failure<Item>(ItemErrors.LifecycleConflict("A trashed note cannot be commented on."));
    }

    private async ValueTask<CommentsResponse> ReadForCallerAsync(Item item, CancellationToken cancellationToken) =>
        (await ReadAsync(item.Id, cancellationToken).ConfigureAwait(false)) with
        {
            CanComment = await permissions.CanCommentWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false),
        };

    private async ValueTask<CommentsResponse> ReadAsync(ItemId itemId, CancellationToken cancellationToken)
    {
        // Revision first: a change landing between the two reads then shows up as a newer revision
        // on the next watch instead of being missed.
        var revision = await store.RevisionAsync(itemId, cancellationToken).ConfigureAwait(false);
        var rows = await store.ListAsync(itemId, cancellationToken).ConfigureAwait(false);
        var names = await store.NamesAsync(
            [.. rows.Select(row => row.AuthorPrincipalId.Value).Concat(rows.Where(row => row.ResolvedBy is not null).Select(row => row.ResolvedBy!.Value.Value)).Distinct()],
            cancellationToken).ConfigureAwait(false);
        return new CommentsResponse(revision, [.. rows.Where(row => row.ThreadId == row.Id).Select(root => Thread(root, rows, names))]);
    }

    private async ValueTask<Result<CommentThreadDto>> ThreadAsync(ItemId itemId, Guid threadId, CancellationToken cancellationToken)
    {
        var all = await ReadAsync(itemId, cancellationToken).ConfigureAwait(false);
        var thread = all.Threads.FirstOrDefault(candidate => candidate.Id == threadId);
        return thread is null ? NotFound<CommentThreadDto>() : Result.Success(thread);
    }

    /// <summary>False when the database trigger refused the insert at the per-note limit (a race past <see cref="FullAsync"/>).</summary>
    private async ValueTask<bool> TryAddAsync(NoteComment comment, CancellationToken cancellationToken)
    {
        try
        {
            await store.AddAsync(comment, cancellationToken).ConfigureAwait(false);
            return true;
        }
        catch (DbUpdateException exception) when (IsLimitRefusal(exception))
        {
            return false;
        }
    }

    private static bool IsLimitRefusal(DbUpdateException exception) =>
        exception.InnerException is PostgresException { SqlState: PostgresErrorCodes.CheckViolation, ConstraintName: null };

    private async ValueTask<bool> FullAsync(ItemId itemId, CancellationToken cancellationToken) =>
        await store.CountAsync(itemId, cancellationToken).ConfigureAwait(false) >= NoteComment.MaxPerNote;

    private static CommentThreadDto Thread(NoteComment root, IReadOnlyList<NoteComment> rows, IReadOnlyDictionary<Guid, string> names) => new(
        root.Id, root.AnchorStart, root.AnchorEnd, root.Quote, root.ResolvedAt, root.ResolvedBy?.Value,
        root.ResolvedBy is { } by ? names.GetValueOrDefault(by.Value) : null,
        [.. rows.Where(row => row.ThreadId == root.Id).Select(row => new CommentDto(
            row.Id, row.AuthorPrincipalId.Value, names.GetValueOrDefault(row.AuthorPrincipalId.Value, "Former member"),
            row.ImportedAuthor, row.Body, row.DeletedAt is null ? row.MentionIds : [], row.CreatedAt, row.EditedAt, row.DeletedAt is not null))]);

    private static Result<Guid[]> Validate(string? body, IReadOnlyList<Guid>? mentions)
    {
        if (string.IsNullOrWhiteSpace(body) || body.Length > MaxBody)
        {
            return Invalid<Guid[]>($"A comment needs text of at most {MaxBody} characters.");
        }

        var distinct = mentions?.Distinct().ToArray() ?? [];
        return distinct.Length > MaxMentions ? Invalid<Guid[]>($"A comment can mention at most {MaxMentions} people.") : Result.Success(distinct);
    }

    private static Result<T> Invalid<T>(string message) => Result.Failure<T>(new NixError("comments.invalid", message));

    private static Result<T> NotFound<T>() => Result.Failure<T>(new NixError("comments.not_found", "That note or comment is unavailable."));

    private static Result<T> NotAuthor<T>(string message = "Only the author can change or delete a comment.") => Result.Failure<T>(new NixError("comments.not_author", message));

    private static Result<T> Full<T>() => Result.Failure<T>(new NixError("comments.limit", $"A note holds at most {NoteComment.MaxPerNote} comments."));
}
