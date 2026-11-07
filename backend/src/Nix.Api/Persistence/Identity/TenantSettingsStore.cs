using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Audit;

namespace Nix.Persistence.Identity;

/// <summary>The caller's tenant row switches; the tenant policy leaves the session exactly one row.</summary>
public sealed class TenantSettingsStore(NixDbContext db, INixSessionContextAccessor session) : ITenantSettingsStore
{
    private Domain.Tenancy.TenantId Tenant =>
        (session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.")).TenantId;

    /// <inheritdoc />
    public async ValueTask<TenantSettingsRow> GetAsync(CancellationToken cancellationToken)
    {
        var tenant = Tenant;
        return await db.Tenants.AsNoTracking()
            .Where(row => row.Id == tenant)
            .Select(row => new TenantSettingsRow(row.McpEnabled, row.PublicLinksEnabled))
            .SingleAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask<TenantSettingsRow> SetAsync(bool? mcpEnabled, bool? publicLinksEnabled, CancellationToken cancellationToken)
    {
        var tenant = Tenant;
        var row = await db.Tenants.AsTracking().SingleAsync(candidate => candidate.Id == tenant, cancellationToken).ConfigureAwait(false);
        row.McpEnabled = mcpEnabled ?? row.McpEnabled;
        row.PublicLinksEnabled = publicLinksEnabled ?? row.PublicLinksEnabled;
        return new TenantSettingsRow(row.McpEnabled, row.PublicLinksEnabled);
    }

    /// <inheritdoc />
    public void AddAudit(AuditEvent auditEvent) => db.AuditEvents.Add(auditEvent);

    /// <inheritdoc />
    public async ValueTask SaveAsync(CancellationToken cancellationToken) =>
        await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
}
