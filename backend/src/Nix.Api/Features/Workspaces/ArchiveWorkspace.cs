using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

/// <summary>Moves an owner-managed workspace out of ordinary navigation.</summary>
public sealed record ArchiveWorkspace(WorkspaceId WorkspaceId) : ICommand<WorkspaceSnapshot>;

public sealed class ArchiveWorkspaceHandler(WorkspaceAdministrationStore store, TimeProvider clock)
    : ICommandHandler<ArchiveWorkspace, WorkspaceSnapshot>
{
    /// <inheritdoc />
    public async ValueTask<Result<WorkspaceSnapshot>> HandleAsync(
        ArchiveWorkspace command,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (!await store.ArchiveAsync(command.WorkspaceId, clock.GetUtcNow(), cancellationToken)
                .ConfigureAwait(false))
        {
            return Result.Failure<WorkspaceSnapshot>(WorkspaceAdministrationErrors.ArchiveRefused());
        }

        var workspace = await store.FindForResponseAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false);
        return workspace is null
            ? Result.Failure<WorkspaceSnapshot>(WorkspaceErrors.NotFound())
            : Result.Success(workspace);
    }
}
