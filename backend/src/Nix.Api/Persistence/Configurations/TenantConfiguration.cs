using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Configurations;

/// <summary>
/// Maps <see cref="Tenant"/> to <c>tenant</c>.
/// </summary>
/// <remarks>
/// The tenant table is itself tenant-scoped: its policy filters <c>tenant_id</c> against the
/// session exactly like every other table, so a session pinned to one tenant sees precisely one
/// row here. That is deliberate - it means "list the tenants I can see" is answered by the same
/// mechanism as everything else rather than by a special case that has to be got right separately.
/// </remarks>
internal sealed class TenantConfiguration : IEntityTypeConfiguration<Tenant>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<Tenant> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.Tenant);

        builder.HasKey(tenant => tenant.Id);
        builder.Property(tenant => tenant.Id).HasColumnName(NixTables.TenantIdColumn);

        builder.Property(tenant => tenant.Name).HasColumnName("name").IsRequired();
        builder.Property(tenant => tenant.IsolationMode).HasColumnName("isolation_mode").IsRequired();
        builder.Property(tenant => tenant.CreatedAt).HasColumnName("created_at").IsRequired();
        builder.Property(tenant => tenant.McpEnabled).HasColumnName("mcp_enabled").IsRequired();
        builder.Property(tenant => tenant.PublicLinksEnabled).HasColumnName("public_links_enabled").IsRequired();
    }
}
