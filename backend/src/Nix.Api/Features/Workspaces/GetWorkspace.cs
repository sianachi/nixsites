using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

public sealed record GetWorkspace(WorkspaceId WorkspaceId) : IQuery<WorkspaceSnapshot?>;

public sealed class GetWorkspaceHandler(WorkspaceAdministrationStore store)
    : IQueryHandler<GetWorkspace, WorkspaceSnapshot?>
{
    public ValueTask<WorkspaceSnapshot?> HandleAsync(GetWorkspace query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        return store.FindForResponseAsync(query.WorkspaceId, cancellationToken);
    }
}
