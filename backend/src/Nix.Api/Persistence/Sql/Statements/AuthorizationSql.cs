namespace Nix.Persistence.Sql.Statements;

/// <summary>
/// The membership questions the permission resolver asks.
/// </summary>
/// <remarks>
/// <para>
/// Hand-written rather than LINQ because these run on every request that touches an item, and
/// because the shape is a union of membership paths whose plan should be legible.
/// </para>
/// <para>
/// These statements report what was granted; they do not decide what it means. Which role permits
/// writing is a domain rule and lives in <c>Nix.Domain.Authorization.WorkspaceRoles</c> — a policy
/// spelled into a <c>WHERE</c> clause is a policy nobody can unit-test and everybody forgets to
/// update.
/// </para>
/// <para>
/// Every statement is tenant-parameterised as well as relying on the isolation policies. That is
/// defence in depth, and it is also what lets the planner use the tenant-leading indexes instead of
/// evaluating the policy predicate per row.
/// </para>
/// </remarks>
public static class AuthorizationSql
{
    /// <summary>
    /// Every workspace role the acting principal holds in one workspace, directly or through a
    /// group.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Returns rows rather than a single answer because a principal can be granted the same
    /// workspace twice — once by name and once through a group — and the strongest grant wins. The
    /// result is at most a handful of rows, so ordering and de-duplication are cheaper in the
    /// caller than in a <c>DISTINCT</c> the planner would have to sort for.
    /// </para>
    /// <para>
    /// The group arm goes through <c>group_membership</c>, so adding somebody to a group grants
    /// them everything that group holds without rewriting a single grant.
    /// </para>
    /// <para>
    /// Index dependencies: <c>IX_workspace_member_tenant_id_subject_type_subject_id</c> for both
    /// arms and <c>IX_group_membership_tenant_id_principal_id</c> for the group lookup.
    /// </para>
    /// </remarks>
    public const string WorkspaceRolesIgnoringLock = """
        SELECT member.role
        FROM workspace_member member
        JOIN workspace
          ON workspace.tenant_id = member.tenant_id
         AND workspace.workspace_id = member.workspace_id
        WHERE member.tenant_id = @tenant_id
          AND member.workspace_id = @workspace_id
          AND workspace.lifecycle_state = 'active'
          AND member.subject_type = 'principal'
          AND member.subject_id = @principal_id

        UNION ALL

        SELECT member.role
        FROM workspace_member member
        JOIN workspace
          ON workspace.tenant_id = member.tenant_id
         AND workspace.workspace_id = member.workspace_id
        JOIN group_membership membership
          ON membership.group_id = member.subject_id
         AND membership.tenant_id = member.tenant_id
        WHERE member.tenant_id = @tenant_id
          AND member.workspace_id = @workspace_id
          AND workspace.lifecycle_state = 'active'
          AND member.subject_type = 'group'
          AND membership.principal_id = @principal_id
        """;

    /// <summary>
    /// Every workspace the acting principal holds any role in, directly or through a group.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>UNION</c> rather than <c>UNION ALL</c>, and the resolver deduplicates workspaces on top:
    /// with the role projected, two different grants over one workspace are two rows here, and a
    /// principal granted the same workspace by name and through a group must still search it once
    /// rather than twice - the duplicate would otherwise travel all the way into the search
    /// statement's parameter array.
    /// </para>
    /// <para>
    /// Holding <i>any interpretable</i> role is the test: every workspace role this build defines
    /// can read, and which of them can also write is
    /// <c>Nix.Domain.Authorization.WorkspaceRoles</c>'s question, not this one's. The role text
    /// is projected so the resolver can apply the same rule the point check applies - a grant
    /// whose role this build cannot parse grants nothing - because this list feeds the permission
    /// predicate of every bulk read, and a list wider than the point check would let a filter
    /// disclose what the gate refuses.
    /// </para>
    /// <para>
    /// Index dependencies: <c>IX_workspace_member_tenant_id_subject_type_subject_id</c> for both
    /// arms and <c>IX_group_membership_tenant_id_principal_id</c> for the group lookup.
    /// </para>
    /// </remarks>
    private const string WorkspacesReadableIgnoringLock = """
        SELECT member.workspace_id, member.role
        FROM workspace_member member
        JOIN workspace
          ON workspace.tenant_id = member.tenant_id
         AND workspace.workspace_id = member.workspace_id
        WHERE member.tenant_id = @tenant_id
          AND workspace.lifecycle_state = 'active'
          AND member.subject_type = 'principal'
          AND member.subject_id = @principal_id

        UNION

        SELECT member.workspace_id, member.role
        FROM workspace_member member
        JOIN workspace
          ON workspace.tenant_id = member.tenant_id
         AND workspace.workspace_id = member.workspace_id
        JOIN group_membership membership
          ON membership.group_id = member.subject_id
         AND membership.tenant_id = member.tenant_id
        WHERE member.tenant_id = @tenant_id
          AND workspace.lifecycle_state = 'active'
          AND member.subject_type = 'group'
          AND membership.principal_id = @principal_id
        """;

    /// <summary>
    /// <see cref="WorkspaceRolesIgnoringLock"/> for an archived workspace as well (never one being
    /// deleted). Used only to let a member unlock an archived workspace so it can be restored or
    /// deleted; the point check behind every read still requires an active one.
    /// </summary>
    public static readonly string WorkspaceRolesIgnoringLockAnyLifecycle =
        WorkspaceRolesIgnoringLock.Replace(
            "workspace.lifecycle_state = 'active'",
            "workspace.lifecycle_state <> 'purging'",
            StringComparison.Ordinal);

    /// <summary>
    /// <see cref="WorkspaceRolesIgnoringLock"/> narrowed to a workspace that has no password or has
    /// one this credential has opened. The point check behind every permission answer.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A workspace password closes the workspace to its own members until they present it, so the
    /// lock is part of the membership answer itself: a closed workspace yields no role, callers
    /// report not found as they do for any workspace the principal cannot see, and no handler has
    /// to remember to ask. <c>@credential_id</c> binds null for a request with no credential a
    /// person holds, which matches no grant: fail closed.
    /// </para>
    /// <para>
    /// Binds <c>@tenant_id</c>, <c>@workspace_id</c>, <c>@principal_id</c>, <c>@credential_id</c>
    /// and <c>@now</c>. The lock probe is a primary-key lookup on <c>workspace_lock</c>.
    /// </para>
    /// </remarks>
    public const string WorkspaceRolesForPrincipal = $$"""
        SELECT held.role
        FROM ({{WorkspaceRolesIgnoringLock}}) held
        WHERE EXISTS (
            SELECT 1 FROM workspace
            WHERE workspace.tenant_id = @tenant_id
              AND workspace.workspace_id = @workspace_id
              AND ({{WorkspaceLockSql.WorkspaceIsOpen}} OR {{WorkspaceLockSql.IsPublicFormPrincipal}}))
        """;

    /// <summary>
    /// The workspaces the principal holds a role in, minus those closed to this credential by a
    /// workspace password. Feeds the permission predicate of every bulk read, so a closed
    /// workspace's rows are filtered out inside the query that would have returned them.
    /// </summary>
    /// <remarks>Binds <c>@tenant_id</c>, <c>@principal_id</c>, <c>@credential_id</c> and <c>@now</c>.</remarks>
    public const string WorkspacesReadableByPrincipal = $$"""
        SELECT held.workspace_id, held.role
        FROM ({{WorkspacesReadableIgnoringLock}}) held
        JOIN workspace
          ON workspace.tenant_id = @tenant_id AND workspace.workspace_id = held.workspace_id
        WHERE {{WorkspaceLockSql.WorkspaceIsOpen}} OR {{WorkspaceLockSql.IsPublicFormPrincipal}}
        """;

    /// <summary>
    /// Whether the acting principal holds a tenant-wide administrative role, by name or through a
    /// group.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Asked once per unit of work. It decides whether tenant administration (administrators, site
    /// approvals, workspace recovery) is offered. It grants no workspace access: an administrator
    /// reads or changes a workspace only as a member of it.
    /// </para>
    /// <para>
    /// Index dependencies: <c>PK_tenant_role</c> for the direct arm and
    /// <c>IX_group_membership_tenant_id_principal_id</c> for the group arm.
    /// </para>
    /// </remarks>
    public const string PrincipalIsTenantAdministrator = """
        SELECT EXISTS (
            SELECT 1
            FROM tenant_role grant_row
            WHERE grant_row.tenant_id = @tenant_id
              AND grant_row.role = 'admin'
              AND (
                    (grant_row.subject_type = 'principal' AND grant_row.subject_id = @principal_id)
                 OR (grant_row.subject_type = 'group' AND EXISTS (
                        SELECT 1
                        FROM group_membership membership
                        WHERE membership.tenant_id = grant_row.tenant_id
                          AND membership.group_id = grant_row.subject_id
                          AND membership.principal_id = @principal_id))
              )
        )
        """;
}
