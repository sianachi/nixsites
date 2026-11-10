using Nix.Domain.Tenancy;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

public sealed record ListWorkspaces(DateTimeOffset? AfterCreatedAt, WorkspaceId? AfterId, int Limit)
    : IQuery<IReadOnlyList<WorkspaceSnapshot>>;

public sealed class ListWorkspacesHandler(WorkspaceAdministrationStore store)
    : IQueryHandler<ListWorkspaces, IReadOnlyList<WorkspaceSnapshot>>
{
    public ValueTask<IReadOnlyList<WorkspaceSnapshot>> HandleAsync(
        ListWorkspaces query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        return store.ListForResponseAsync(query.AfterCreatedAt, query.AfterId, query.Limit, cancellationToken);
    }
}
