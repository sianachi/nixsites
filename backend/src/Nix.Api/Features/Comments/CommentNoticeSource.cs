using Nix.Abstractions;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Items;
using Nix.Domain.Notifications;
using Nix.Domain.Primitives;
using Nix.Domain.Scheduling;

namespace Nix.Features.Comments;

/// <summary>
/// Tells a person about a reply in a thread they are in, or a mention (<c>note.comment</c>). The
/// commenter's request cannot write into somebody else's inbox, so the <c>note_comment_notice</c>
/// database trigger queues one row per recipient and this fires it in the recipient's own session.
/// Reading as the recipient is the check: they must still be able to read the note and its body
/// must not be locked, so a mention of someone outside the workspace notifies nobody.
/// </summary>
public sealed class CommentNoticeSource(
    IItemTree tree, IPermissionResolver permissions, IItemLocks locks, INoteComments comments, INotificationWriter notifications)
    : ITriggerSource
{
    /// <summary>The source name the database trigger records.</summary>
    public const string SourceName = "note.comment";

    // The push contract is title, body and url only, never full text: the notice carries a snippet.
    internal const int SnippetLength = 140;

    /// <inheritdoc />
    public string Name => SourceName;

    /// <inheritdoc />
    public TriggerKind Kind => TriggerKind.System;

    /// <inheritdoc />
    public bool IsPlanned => false;

    /// <inheritdoc />
    public Task<TriggerPlan> PlanAsync(PlanWindow window, CancellationToken cancellationToken) =>
        Task.FromResult(TriggerPlan.Empty);

    /// <inheritdoc />
    public async Task<TriggerOutcome> FireAsync(DueTrigger trigger, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(trigger);
        if (trigger.SourceItemId is not { } itemGuid || trigger.RuleId is not { } commentId)
        {
            return TriggerOutcome.Skipped("malformed");
        }

        var itemId = ItemId.From(itemGuid);
        var item = await tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await permissions.CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false)
            || !await locks.MayReadBodyAsync(itemId, cancellationToken).ConfigureAwait(false))
        {
            return TriggerOutcome.Skipped("unreadable");
        }

        var comment = await comments.FindAsync(itemId, commentId, cancellationToken).ConfigureAwait(false);
        if (comment is null)
        {
            return TriggerOutcome.Skipped("comment_gone");
        }

        var names = await comments.NamesAsync([comment.AuthorPrincipalId.Value], cancellationToken).ConfigureAwait(false);
        var author = names.GetValueOrDefault(comment.AuthorPrincipalId.Value, "Someone");
        var mentioned = comment.MentionIds.Contains(trigger.PrincipalId.Value);
        var title = TextCut.Cut($"{author} {(mentioned ? "mentioned you in" : "replied in")} {NoteTitle(item)}", 200);
        await notifications.CreateAsync(
            trigger.PrincipalId,
            NotificationKind.Comment,
            title,
            TextCut.Cut(comment.Body, SnippetLength),
            itemId,
            item.WorkspaceId,
            trigger.DedupeKey,
            cancellationToken).ConfigureAwait(false);
        return TriggerOutcome.Fired("comment_notified");
    }

    private static string NoteTitle(Item item)
    {
        try
        {
            using var properties = System.Text.Json.JsonDocument.Parse(item.Properties ?? "{}");
            if (properties.RootElement.TryGetProperty("title", out var title) && title.ValueKind == System.Text.Json.JsonValueKind.String
                && title.GetString() is { Length: > 0 } text)
            {
                return text;
            }
        }
        catch (System.Text.Json.JsonException)
        {
        }

        return "a note";
    }
}
