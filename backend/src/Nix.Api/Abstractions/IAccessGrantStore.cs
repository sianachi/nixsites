using Nix.Domain.Audit;
using Nix.Domain.Identity;

namespace Nix.Abstractions;

/// <summary>One person holding a granted right, with the name a list renders.</summary>
/// <param name="PrincipalId">The holder.</param>
/// <param name="DisplayName">Their name.</param>
/// <param name="GrantedBy">Who granted it.</param>
/// <param name="GrantedAt">When.</param>
public sealed record AccessGrantRow(Guid PrincipalId, string DisplayName, Guid GrantedBy, DateTimeOffset GrantedAt);

/// <summary>
/// The two grants an administrator manages from Settings: site approvers (<c>site_operator</c>)
/// and tenant administrators (<c>tenant_role</c>, principal subjects only). Everything is scoped
/// to the caller's tenant by row-level security and by an explicit tenant predicate.
/// </summary>
public interface IAccessGrantStore
{
    /// <summary>Whether the principal holds a site approver grant.</summary>
    public ValueTask<bool> IsSiteOperatorAsync(PrincipalId principalId, CancellationToken cancellationToken);

    /// <summary>The granted site approvers, oldest first.</summary>
    public ValueTask<IReadOnlyList<AccessGrantRow>> ListSiteOperatorsAsync(CancellationToken cancellationToken);

    /// <summary>Grants site approval; <see langword="false"/> when already granted.</summary>
    public ValueTask<bool> AddSiteOperatorAsync(PrincipalId principalId, PrincipalId grantedBy, DateTimeOffset now, CancellationToken cancellationToken);

    /// <summary>Revokes site approval; <see langword="false"/> when there was no grant.</summary>
    public ValueTask<bool> RemoveSiteOperatorAsync(PrincipalId principalId, CancellationToken cancellationToken);

    /// <summary>The principals holding the tenant <c>admin</c> role directly, oldest first.</summary>
    public ValueTask<IReadOnlyList<AccessGrantRow>> ListTenantAdminsAsync(CancellationToken cancellationToken);

    /// <summary>Grants the tenant admin role; <see langword="false"/> when already held.</summary>
    public ValueTask<bool> AddTenantAdminAsync(PrincipalId principalId, PrincipalId grantedBy, DateTimeOffset now, CancellationToken cancellationToken);

    /// <summary>Removes the principal's direct admin role; <see langword="false"/> when they had none.</summary>
    public ValueTask<bool> RemoveTenantAdminAsync(PrincipalId principalId, CancellationToken cancellationToken);

    /// <summary>
    /// Whether an admin who can act other than this principal remains: an active principal grant, or a
    /// group grant with another active member. Also locks the tenant's admin grants until the
    /// transaction ends, so call it in the transaction that deletes.
    /// </summary>
    public ValueTask<bool> AnyOtherTenantAdminAsync(PrincipalId principalId, CancellationToken cancellationToken);

    /// <summary>Queues one audit event, saved with <see cref="SaveAsync"/>.</summary>
    public void AddAudit(AuditEvent auditEvent);

    /// <summary>Saves the queued changes.</summary>
    public ValueTask SaveAsync(CancellationToken cancellationToken);
}
