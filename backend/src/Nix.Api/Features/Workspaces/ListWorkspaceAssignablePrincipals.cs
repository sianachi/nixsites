using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

public sealed record ListWorkspaceAssignablePrincipals(
    WorkspaceId WorkspaceId,
    string? Search,
    PrincipalId? AfterPrincipalId,
    int Limit,
    IReadOnlyList<Guid>? Only = null) : IQuery<IReadOnlyList<WorkspacePrincipalSnapshot>>;

public sealed class ListWorkspaceAssignablePrincipalsHandler(WorkspacePrincipalDirectoryStore store)
    : IQueryHandler<ListWorkspaceAssignablePrincipals, IReadOnlyList<WorkspacePrincipalSnapshot>>
{
    public ValueTask<IReadOnlyList<WorkspacePrincipalSnapshot>> HandleAsync(
        ListWorkspaceAssignablePrincipals query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        return store.ListAsync(
            query.WorkspaceId,
            query.Search,
            query.AfterPrincipalId,
            query.Limit,
            cancellationToken,
            query.Only?.ToArray());
    }
}
