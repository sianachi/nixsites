using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Audit;
using Nix.Domain.Authorization;
using Nix.Domain.Identity;
using Nix.Domain.Sites;

namespace Nix.Persistence.Identity;

/// <summary>Site approver and tenant administrator grants, inside the request's tenant transaction.</summary>
public sealed class AccessGrantStore(NixDbContext db, INixSessionContextAccessor session) : IAccessGrantStore
{
    private const string AdminRole = "admin";

    private Domain.Tenancy.TenantId Tenant =>
        (session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.")).TenantId;

    /// <inheritdoc />
    public async ValueTask<bool> IsSiteOperatorAsync(PrincipalId principalId, CancellationToken cancellationToken)
    {
        var tenant = Tenant;
        return await db.SiteOperators.AsNoTracking()
            .AnyAsync(row => row.TenantId == tenant && row.PrincipalId == principalId, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<AccessGrantRow>> ListSiteOperatorsAsync(CancellationToken cancellationToken)
    {
        var tenant = Tenant;
        return await (
            from grant in db.SiteOperators.AsNoTracking()
            join principal in db.Principals.AsNoTracking() on new { grant.TenantId, grant.PrincipalId } equals new { principal.TenantId, PrincipalId = principal.Id }
            where grant.TenantId == tenant
            orderby grant.GrantedAt, grant.PrincipalId
            select new AccessGrantRow(grant.PrincipalId.Value, principal.DisplayName, grant.GrantedBy.Value, grant.GrantedAt))
            .ToListAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<bool> AddSiteOperatorAsync(PrincipalId principalId, PrincipalId grantedBy, DateTimeOffset now, CancellationToken cancellationToken)
    {
        if (await IsSiteOperatorAsync(principalId, cancellationToken).ConfigureAwait(false))
        {
            return false;
        }

        db.SiteOperators.Add(new SiteOperatorGrant { TenantId = Tenant, PrincipalId = principalId, GrantedBy = grantedBy, GrantedAt = now });
        return true;
    }

    /// <inheritdoc />
    public async ValueTask<bool> RemoveSiteOperatorAsync(PrincipalId principalId, CancellationToken cancellationToken)
    {
        var tenant = Tenant;
        return await db.SiteOperators.Where(row => row.TenantId == tenant && row.PrincipalId == principalId)
            .ExecuteDeleteAsync(cancellationToken).ConfigureAwait(false) > 0;
    }

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<AccessGrantRow>> ListTenantAdminsAsync(CancellationToken cancellationToken)
    {
        var tenant = Tenant;
        // subject_id is a bare uuid (it may name a group), so the names come from a second query.
        var admins = await db.TenantRoleGrants.AsNoTracking()
            .Where(grant => grant.TenantId == tenant && grant.Role == AdminRole && grant.SubjectType == SubjectType.Principal)
            .OrderBy(grant => grant.GrantedAt).ThenBy(grant => grant.SubjectId)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        var ids = admins.Select(grant => PrincipalId.From(grant.SubjectId)).ToList();
        var names = await db.Principals.AsNoTracking()
            .Where(principal => principal.TenantId == tenant && ids.Contains(principal.Id))
            .ToDictionaryAsync(principal => principal.Id.Value, principal => principal.DisplayName, cancellationToken).ConfigureAwait(false);
        return [.. admins.Where(grant => names.ContainsKey(grant.SubjectId))
            .Select(grant => new AccessGrantRow(grant.SubjectId, names[grant.SubjectId], grant.GrantedBy.Value, grant.GrantedAt))];
    }

    /// <inheritdoc />
    public async ValueTask<bool> AddTenantAdminAsync(PrincipalId principalId, PrincipalId grantedBy, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var tenant = Tenant;
        var held = await db.TenantRoleGrants.AsNoTracking().AnyAsync(
            row => row.TenantId == tenant && row.SubjectType == SubjectType.Principal && row.SubjectId == principalId.Value && row.Role == AdminRole,
            cancellationToken).ConfigureAwait(false);
        if (held)
        {
            return false;
        }

        db.TenantRoleGrants.Add(new TenantRoleGrant
        {
            TenantId = tenant,
            SubjectType = SubjectType.Principal,
            SubjectId = principalId.Value,
            Role = AdminRole,
            GrantedBy = grantedBy,
            GrantedAt = now,
        });
        return true;
    }

    /// <inheritdoc />
    public async ValueTask<bool> RemoveTenantAdminAsync(PrincipalId principalId, CancellationToken cancellationToken)
    {
        var tenant = Tenant;
        return await db.TenantRoleGrants.Where(
                row => row.TenantId == tenant && row.SubjectType == SubjectType.Principal && row.SubjectId == principalId.Value && row.Role == AdminRole)
            .ExecuteDeleteAsync(cancellationToken).ConfigureAwait(false) > 0;
    }

    /// <inheritdoc />
    /// <remarks>
    /// Locks every admin grant row of the tenant (<c>FOR UPDATE</c>, in key order) before counting, and
    /// the caller deletes in the same transaction. Two administrators revoking each other therefore
    /// serialize: the second blocks on the lock, then counts with a fresh read-committed snapshot that
    /// no longer holds the first's grant. Only grants that can act count: a principal grant whose
    /// principal is active, or a group grant with at least one other active member.
    /// shortcut: membership rows are not locked, so a concurrent removal of the last member of the only
    /// admin group can slip past; lock group_membership too if that ever matters.
    /// </remarks>
    public async ValueTask<bool> AnyOtherTenantAdminAsync(PrincipalId principalId, CancellationToken cancellationToken)
    {
        var tenant = Tenant.Value;
        var excluded = principalId.Value;
        _ = await db.Database.SqlQuery<int>($"""
            SELECT 1 AS "Value" FROM tenant_role
             WHERE tenant_id = {tenant} AND role = 'admin'
             ORDER BY subject_type, subject_id
               FOR UPDATE
            """).ToListAsync(cancellationToken).ConfigureAwait(false);
        return await db.Database.SqlQuery<bool>($"""
            SELECT EXISTS (
                SELECT 1
                  FROM tenant_role grant_row
                 WHERE grant_row.tenant_id = {tenant} AND grant_row.role = 'admin'
                   AND (
                        (grant_row.subject_type = 'principal' AND grant_row.subject_id <> {excluded}
                         AND EXISTS (SELECT 1 FROM principal p
                                      WHERE p.tenant_id = grant_row.tenant_id
                                        AND p.principal_id = grant_row.subject_id
                                        AND p.status = 'active'))
                     OR (grant_row.subject_type = 'group'
                         AND EXISTS (SELECT 1
                                       FROM group_membership m
                                       JOIN principal p ON p.tenant_id = m.tenant_id AND p.principal_id = m.principal_id
                                      WHERE m.tenant_id = grant_row.tenant_id
                                        AND m.group_id = grant_row.subject_id
                                        AND m.principal_id <> {excluded}
                                        AND p.status = 'active'))
                   )) AS "Value"
            """).SingleAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public void AddAudit(AuditEvent auditEvent) => db.AuditEvents.Add(auditEvent);

    /// <inheritdoc />
    public async ValueTask SaveAsync(CancellationToken cancellationToken) =>
        await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
}
