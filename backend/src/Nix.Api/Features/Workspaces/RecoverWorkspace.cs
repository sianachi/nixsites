using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

public sealed record RecoverWorkspace(WorkspaceId WorkspaceId, PrincipalId NewOwnerPrincipalId)
    : ICommand<WorkspaceSnapshot>;

public sealed class RecoverWorkspaceHandler(
    WorkspaceAdministrationStore store,
    IPermissionResolver permissions,
    TimeProvider clock) : ICommandHandler<RecoverWorkspace, WorkspaceSnapshot>
{
    public async ValueTask<Result<WorkspaceSnapshot>> HandleAsync(
        RecoverWorkspace command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        // Recovery is tenant administration, so it does not ask for workspace access: an
        // administrator is rarely a member of the deactivated person's workspace it hands over.
        // The recovery statement itself is scoped to the tenant and to a deactivated owner.
        if (!await permissions.IsTenantAdministratorAsync(cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<WorkspaceSnapshot>(WorkspaceAdministrationErrors.RecoveryForbidden());
        }
        if (!await store.RecoverAsync(command.WorkspaceId, command.NewOwnerPrincipalId,
                clock.GetUtcNow(), cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<WorkspaceSnapshot>(WorkspaceAdministrationErrors.RecoveryRefused());
        }
        var row = await store.FindAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidOperationException("The recovered workspace could not be read back.");
        return Result.Success(row);
    }
}
