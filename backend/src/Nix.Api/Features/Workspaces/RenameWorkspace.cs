using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

public sealed record RenameWorkspace(WorkspaceId WorkspaceId, string Name) : ICommand<WorkspaceSnapshot>;

public sealed class RenameWorkspaceHandler(WorkspaceAdministrationStore store)
    : ICommandHandler<RenameWorkspace, WorkspaceSnapshot>
{
    public async ValueTask<Result<WorkspaceSnapshot>> HandleAsync(
        RenameWorkspace command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var name = WorkspaceRules.NormalizeName(command.Name);
        if (name is null)
        {
            return Result.Failure<WorkspaceSnapshot>(WorkspaceErrors.InvalidName());
        }

        if (!await store.RenameAsync(command.WorkspaceId, name, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<WorkspaceSnapshot>(WorkspaceErrors.NotFound());
        }

        var renamed = await store.FindForResponseAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidOperationException("The renamed workspace could not be read back.");
        return Result.Success(renamed);
    }
}
