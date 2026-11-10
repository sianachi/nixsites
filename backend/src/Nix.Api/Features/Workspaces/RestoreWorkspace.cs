using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

/// <summary>Returns an archived workspace to ordinary navigation.</summary>
public sealed record RestoreWorkspace(WorkspaceId WorkspaceId) : ICommand<WorkspaceSnapshot>;

public sealed class RestoreWorkspaceHandler(WorkspaceAdministrationStore store)
    : ICommandHandler<RestoreWorkspace, WorkspaceSnapshot>
{
    /// <inheritdoc />
    public async ValueTask<Result<WorkspaceSnapshot>> HandleAsync(
        RestoreWorkspace command,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (!await store.RestoreAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<WorkspaceSnapshot>(WorkspaceAdministrationErrors.RestoreRefused());
        }

        var workspace = await store.FindForResponseAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false);
        return workspace is null
            ? Result.Failure<WorkspaceSnapshot>(WorkspaceErrors.NotFound())
            : Result.Success(workspace);
    }
}
