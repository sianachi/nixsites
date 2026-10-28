using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

public sealed record AcceptWorkspaceInvitation(WorkspaceId WorkspaceId, Guid InvitationId) : ICommand<bool>;

public sealed class AcceptWorkspaceInvitationHandler(WorkspaceAdministrationStore store, TimeProvider clock)
    : ICommandHandler<AcceptWorkspaceInvitation, bool>
{
    public async ValueTask<Result<bool>> HandleAsync(
        AcceptWorkspaceInvitation command,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (await store.AcceptInvitationAsync(
                command.WorkspaceId, command.InvitationId, clock.GetUtcNow(), cancellationToken)
            .ConfigureAwait(false))
        {
            return Result.Success(true);
        }

        // The invitee can still read the workspace row while invited, so a closed workspace says why.
        var workspace = await store.FindAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false);
        return Result.Failure<bool>(workspace is { MembershipLocked: true, PendingInvitationId: not null }
            ? WorkspaceAdministrationErrors.MembershipLocked()
            : WorkspaceErrors.NotFound());
    }
}
