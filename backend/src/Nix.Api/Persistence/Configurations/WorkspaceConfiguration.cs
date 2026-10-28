using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Persistence.Conversion;

namespace Nix.Persistence.Configurations;

/// <summary>
/// Maps <see cref="Workspace"/> to <c>workspace</c>.
/// </summary>
/// <remarks>
/// Carries the alternate key on <c>(tenant_id, workspace_id)</c> that every workspace-referencing
/// table points at. See <see cref="ItemConfiguration"/> for why the references are composite.
/// </remarks>
internal sealed class WorkspaceConfiguration : IEntityTypeConfiguration<Workspace>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<Workspace> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(
            NixTables.Workspace,
            table => table.HasCheckConstraint(
                "CK_workspace_lifecycle_state",
                "lifecycle_state IN ('active', 'archived', 'purging')"));

        builder.HasKey(workspace => workspace.Id);
        builder.Property(workspace => workspace.Id).HasColumnName("workspace_id");
        builder.Property(workspace => workspace.TenantId).HasColumnName(NixTables.TenantIdColumn);

        builder.Property(workspace => workspace.Name).HasColumnName("name").IsRequired();
        builder.Property(workspace => workspace.PersonalOwnerPrincipalId)
            .HasColumnName("personal_owner_principal_id");
        builder.Property(workspace => workspace.VersionRetentionDays).HasColumnName("version_retention_days");
        builder.Property(workspace => workspace.CoalesceWindowMinutes).HasColumnName("coalesce_window_min");
        builder.Property(workspace => workspace.DailyNotes).HasColumnName("daily_notes").HasColumnType("jsonb");
        builder.Property(workspace => workspace.StorageQuotaBytes).HasColumnName("storage_quota_bytes");
        builder.Property(workspace => workspace.CreatedAt).HasColumnName("created_at").IsRequired();
        builder.Property(workspace => workspace.LifecycleState)
            .HasColumnName("lifecycle_state")
            .HasConversion(new EnumConverters.WorkspaceLifecycleStateConverter())
            .HasDefaultValue(WorkspaceLifecycleState.Active)
            .IsRequired();
        builder.Property(workspace => workspace.ArchivedAt).HasColumnName("archived_at");
        builder.Property(workspace => workspace.MembershipLocked).HasColumnName("membership_locked").HasDefaultValue(false);
        builder.Property(workspace => workspace.Collaboration).HasColumnName("collaboration").HasDefaultValue(true);

        // The target of every composite tenant-scoped reference to a workspace.
        builder.HasAlternateKey(workspace => new { workspace.TenantId, workspace.Id });

        builder.HasOne<Tenant>()
            .WithMany()
            .HasForeignKey(workspace => workspace.TenantId)
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasOne<Principal>()
            .WithMany()
            .HasForeignKey(workspace => new { workspace.TenantId, workspace.PersonalOwnerPrincipalId })
            .HasPrincipalKey(principal => new { principal.TenantId, principal.Id })
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasIndex(workspace => new { workspace.TenantId, workspace.PersonalOwnerPrincipalId })
            .IsUnique()
            .HasFilter("personal_owner_principal_id IS NOT NULL");

        builder.HasIndex(workspace => new { workspace.TenantId, workspace.CreatedAt, workspace.Id })
            .IsDescending(false, true, true)
            .HasDatabaseName("ix_workspace_list");

        // No standalone tenant_id index: it is a strict prefix of the alternate key above.
    }
}
