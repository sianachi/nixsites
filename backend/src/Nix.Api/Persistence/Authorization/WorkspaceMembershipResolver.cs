using Nix.Abstractions;
using Nix.Domain.Authorization;
using Nix.Domain.Tenancy;
using Nix.Persistence.Sql;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Authorization;

/// <summary>
/// Resolves permissions from workspace membership: a member by name or a member through a group.
/// Tenant administrators get no workspace access from that role.
/// </summary>
/// <remarks>
/// <para>
/// The first implementation of the authorization port, and a real one — it reads
/// <c>workspace_member</c>, <c>group_membership</c> and <c>tenant_role</c> against live rows rather
/// than standing in for something later. Before it existed nothing in the system read any of those
/// tables at runtime, which meant any authenticated principal could reach every workspace in their
/// tenant. Row-level security was isolating tenants from each other and nothing else.
/// </para>
/// <para>
/// Access control entries replace this class and keep the port. What changes then is granularity:
/// the answer becomes per item rather than per workspace, and the filtering moves inside the item
/// query because the two stop being equivalent.
/// </para>
/// <para>
/// <b>Answers are memoised for the unit of work.</b> A scope is one request and one tenant, and the
/// rows behind the answer cannot change underneath it — the transaction that would change them is
/// this one. Listing an item's children therefore asks the database once rather than once per item, which is
/// the difference between a page of two hundred children costing one round trip and costing two
/// hundred.
/// </para>
/// </remarks>
public sealed class WorkspaceMembershipResolver(
    NixSqlExecutor sql,
    INixSessionContextAccessor session)
    : IPermissionResolver
{
    private readonly INixSessionContextAccessor _session = session;
    private readonly Dictionary<WorkspaceId, WorkspaceRole?> _roles = [];

    private bool? _isAdministrator;
    private IReadOnlyList<WorkspaceId>? _readableWorkspaces;

    private NixSessionContext Session => _session.Current
        ?? throw new InvalidOperationException(
            "No session context has been established for this unit of work. Every authorization "
            + "question is asked on behalf of a specific principal in a specific tenant; there is "
            + "no anonymous path.");

    /// <inheritdoc />
    public async ValueTask<bool> CanReadWorkspaceAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken)
    {
        var role = await RoleInAsync(workspaceId, cancellationToken).ConfigureAwait(false);
        return role is not null;
    }

    /// <inheritdoc />
    public async ValueTask<bool> CanWriteWorkspaceAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken)
    {
        var role = await RoleInAsync(workspaceId, cancellationToken).ConfigureAwait(false);
        return role is { } held && held.GrantsWrite();
    }

    /// <inheritdoc />
    public async ValueTask<bool> CanCommentWorkspaceAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken)
    {
        var role = await RoleInAsync(workspaceId, cancellationToken).ConfigureAwait(false);
        return role is { } held && held.GrantsComment();
    }

    /// <inheritdoc />
    public async ValueTask<bool> CanManageWorkspaceAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken)
    {
        var role = await RoleInAsync(workspaceId, cancellationToken).ConfigureAwait(false);
        return role == WorkspaceRole.Owner;
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<WorkspaceId>> ReadableWorkspacesAsync(
        CancellationToken cancellationToken)
    {
        if (_readableWorkspaces is { } cached)
        {
            return cached;
        }

        var context = Session;

        // A tenant administrator gets exactly their own memberships, like anyone else: administering
        // the tenant (administrators, site approvals, recovery) never needs a workspace's content.
        //
        // The same rule the point check applies, applied to the list: a grant whose role this
        // build cannot parse grants nothing. This list feeds the permission predicate of every
        // bulk read, so a list wider than the point check would let a filter disclose rows the
        // gate refuses - the wrong fail direction for a database written by a newer build.
        var workspaces = new List<WorkspaceId>();
        var seen = new HashSet<WorkspaceId>();
        var grantRows = sql.QueryAsync<WorkspaceGrant, WorkspaceGrantMapper>(
            AuthorizationSql.WorkspacesReadableByPrincipal,
            default,
            [
                Uuid("tenant_id", context.TenantId.Value),
                Uuid("principal_id", context.PrincipalId.Value),
            ],
            cancellationToken);

        await foreach (var grant in grantRows.ConfigureAwait(false))
        {
            if (WorkspaceRoles.TryParse(grant.Role, out _) && seen.Add(grant.WorkspaceId))
            {
                workspaces.Add(grant.WorkspaceId);
            }
        }

        // Deliberately not seeding `_roles` from this. The statement answers "may read", and the
        // cache holds "which role", which is a strictly stronger claim: writing `Owner` for every
        // workspace that came back would turn a reader into a writer the next time anything asked
        // `CanWriteWorkspaceAsync`. One saved round trip is not worth a cache that can promote.
        _readableWorkspaces = workspaces;
        return workspaces;
    }

    /// <inheritdoc />
    public async ValueTask<bool> IsTenantAdministratorAsync(CancellationToken cancellationToken)
    {
        if (_isAdministrator is { } cached)
        {
            return cached;
        }

        var context = Session;
        var answer = await sql.ScalarOrDefaultAsync<bool>(
            AuthorizationSql.PrincipalIsTenantAdministrator,
            [
                Uuid("tenant_id", context.TenantId.Value),
                Uuid("principal_id", context.PrincipalId.Value),
            ],
            cancellationToken).ConfigureAwait(false);

        _isAdministrator = answer;
        return answer;
    }

    /// <summary>
    /// The strongest role the acting principal holds in a workspace, or <see langword="null"/> when
    /// they hold none.
    /// </summary>
    /// <remarks>
    /// Being a tenant administrator adds nothing here: administrators manage the tenant, and read or
    /// change a workspace only as a member of it.
    /// </remarks>
    private async ValueTask<WorkspaceRole?> RoleInAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken)
    {
        if (_roles.TryGetValue(workspaceId, out var cached))
        {
            return cached;
        }

        var context = Session;
        WorkspaceRole? strongest = null;

        var rows = sql.QueryAsync<string, RoleTextMapper>(
            AuthorizationSql.WorkspaceRolesForPrincipal,
            default,
            [
                Uuid("tenant_id", context.TenantId.Value),
                Uuid("workspace_id", workspaceId.Value),
                Uuid("principal_id", context.PrincipalId.Value),
            ],
            cancellationToken);

        await foreach (var text in rows.ConfigureAwait(false))
        {
            // Unrecognised role text is skipped rather than thrown on: a database written by a
            // newer build must leave this one refusing grants it cannot interpret, not failing
            // every request that touches the workspace.
            if (WorkspaceRoles.TryParse(text, out var role) && (strongest is null || role > strongest))
            {
                strongest = role;
            }
        }

        _roles[workspaceId] = strongest;
        return strongest;
    }

    private static NpgsqlParameter Uuid(string name, Guid value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value };

    /// <summary>One membership grant row: the workspace, and the role text as stored.</summary>
    private readonly record struct WorkspaceGrant(WorkspaceId WorkspaceId, string Role);

    /// <summary>Reads a grant's <c>workspace_id</c> and <c>role</c> columns.</summary>
    /// <remarks>A struct, so the query loop devirtualises and allocates only the role string.</remarks>
    private readonly struct WorkspaceGrantMapper : INixRowMapper<WorkspaceGrant>
    {
        /// <inheritdoc />
        public WorkspaceGrant Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);
            return new WorkspaceGrant(WorkspaceId.From(reader.GetGuid(0)), reader.GetString(1));
        }
    }

    /// <summary>Reads the single <c>role</c> column.</summary>
    /// <remarks>
    /// A struct so the query loop devirtualises and allocates nothing per row beyond the string
    /// itself.
    /// </remarks>
    private readonly struct RoleTextMapper : INixRowMapper<string>
    {
        /// <inheritdoc />
        public string Map(NpgsqlDataReader reader)
        {
            ArgumentNullException.ThrowIfNull(reader);
            return reader.GetString(0);
        }
    }
}
