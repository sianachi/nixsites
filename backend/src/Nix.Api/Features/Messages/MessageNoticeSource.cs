using Nix.Abstractions;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Items;
using Nix.Domain.Notifications;
using Nix.Domain.Primitives;
using Nix.Domain.Scheduling;

namespace Nix.Features.Messages;

/// <summary>
/// Tells a person a message was addressed to them (<c>message.posted</c>). The poster's request cannot
/// write into somebody else's inbox, so the <c>item_message_notice</c> trigger queues one row per
/// addressed person and this fires it in the recipient's own session. Reading the message as the
/// recipient is the check: someone who cannot read it is told nothing.
/// </summary>
public sealed class MessageNoticeSource(IVisibleItems visible, INotificationWriter notifications) : ITriggerSource
{
    /// <summary>The source name the database trigger records.</summary>
    public const string SourceName = "message.posted";

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
        if (trigger.SourceItemId is not { } itemGuid)
        {
            return TriggerOutcome.Skipped("malformed");
        }

        var lookup = await visible.FindAsync(ItemId.From(itemGuid), ItemAccess.Read, cancellationToken, lockedDetail: "locked").ConfigureAwait(false);
        if (lookup.IsFailure || MessagePetRunner.Parse(lookup.Value) is not { } message)
        {
            return TriggerOutcome.Skipped("unreadable");
        }

        var via = message.Author.Via is { Length: > 0 } token ? $" via {token}" : "";
        await notifications.CreateAsync(
            trigger.PrincipalId,
            NotificationKind.Message,
            TextCut.Cut($"{message.Author.Name}{via} sent you a message", 200),
            TextCut.Cut(message.Text, Nix.Features.Comments.CommentNoticeSource.SnippetLength),
            lookup.Value.Id,
            lookup.Value.WorkspaceId,
            trigger.DedupeKey,
            cancellationToken).ConfigureAwait(false);
        return TriggerOutcome.Fired("message_notified");
    }
}
