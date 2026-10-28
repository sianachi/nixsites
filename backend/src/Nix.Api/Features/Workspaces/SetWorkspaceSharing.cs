using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

/// <summary>Closes or opens a workspace to new members, and turns live collaboration on or off. Owners only.</summary>
public sealed record SetWorkspaceSharing(WorkspaceId WorkspaceId, bool? MembershipLocked, bool? Collaboration)
    : ICommand<WorkspaceSnapshot>;

public sealed class SetWorkspaceSharingHandler(WorkspaceAdministrationStore store)
    : ICommandHandler<SetWorkspaceSharing, WorkspaceSnapshot>
{
    public async ValueTask<Result<WorkspaceSnapshot>> HandleAsync(
        SetWorkspaceSharing command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (!await store.SetSharingAsync(command.WorkspaceId, command.MembershipLocked, command.Collaboration, cancellationToken)
            .ConfigureAwait(false))
        {
            return Result.Failure<WorkspaceSnapshot>(WorkspaceErrors.NotFound());
        }

        var updated = await store.FindAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidOperationException("The workspace could not be read back.");
        return Result.Success(updated);
    }
}
