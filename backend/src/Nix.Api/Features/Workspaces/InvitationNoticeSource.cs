using Nix.Abstractions;
using Nix.Abstractions.Scheduling;
using Nix.Domain.Notifications;
using Nix.Domain.Scheduling;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

/// <summary>
/// Tells an invitee about their invitation (<c>workspace.invitation</c>). The inviter's request
/// cannot write into somebody else's inbox, so the <c>workspace_invitation_notice</c> database
/// trigger queues one row per new invitation, and this fires it in the invitee's own session.
/// </summary>
public sealed class InvitationNoticeSource(WorkspaceAdministrationStore workspaces, INotificationWriter notifications)
    : ITriggerSource
{
    /// <summary>The source name the database trigger records.</summary>
    public const string SourceName = "workspace.invitation";

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
        if (trigger.WorkspaceId is not { } workspaceId || trigger.RuleId is not { } invitationId)
        {
            return TriggerOutcome.Skipped("malformed");
        }

        // Read as the invitee: the row is visible only while their invitation is still pending.
        var workspace = await workspaces.FindAsync(workspaceId, cancellationToken).ConfigureAwait(false);
        if (workspace?.PendingInvitationId != invitationId)
        {
            return TriggerOutcome.Skipped("invitation_settled");
        }

        var name = workspace.Name.Length > 160 ? workspace.Name[..160] : workspace.Name;
        await notifications.CreateAsync(
            trigger.PrincipalId,
            NotificationKind.Invitation,
            $"Invitation to {name}",
            "Accept to join this workspace, or decline. Nothing in it is shared with you until you accept.",
            null,
            workspaceId,
            trigger.DedupeKey,
            cancellationToken).ConfigureAwait(false);
        return TriggerOutcome.Fired("invitation_notified");
    }
}
