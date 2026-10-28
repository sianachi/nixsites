using Nix.Domain.Identity;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

public sealed record InviteWorkspaceMember(WorkspaceId WorkspaceId, PrincipalId PrincipalId, string Role)
    : ICommand<WorkspaceInvitationSnapshot>;

public sealed class InviteWorkspaceMemberHandler(WorkspaceAdministrationStore store, TimeProvider clock)
    : ICommandHandler<InviteWorkspaceMember, WorkspaceInvitationSnapshot>
{
    public async ValueTask<Result<WorkspaceInvitationSnapshot>> HandleAsync(
        InviteWorkspaceMember command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (!WorkspaceAdministrationRules.TryAssignableRole(command.Role, out var role))
        {
            return Result.Failure<WorkspaceInvitationSnapshot>(WorkspaceAdministrationErrors.InvalidInvitation());
        }
        var mutation = await store.CreateInvitationAsync(command.WorkspaceId, Guid.CreateVersion7(),
            command.PrincipalId, role, clock.GetUtcNow(), cancellationToken).ConfigureAwait(false);
        return mutation.Outcome switch
        {
            "ok" when mutation.Invitation is { } invitation => Result.Success(invitation),
            "not_found" => Result.Failure<WorkspaceInvitationSnapshot>(WorkspaceErrors.NotFound()),
            "locked" => Result.Failure<WorkspaceInvitationSnapshot>(WorkspaceAdministrationErrors.MembershipLocked()),
            _ => Result.Failure<WorkspaceInvitationSnapshot>(WorkspaceAdministrationErrors.InvitationConflict()),
        };
    }
}
