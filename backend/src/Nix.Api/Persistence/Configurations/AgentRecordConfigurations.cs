using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Files;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.PublicLinks;
using Nix.Domain.References;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Configurations;

/// <summary>Maps <see cref="ItemReference"/> to <c>item_reference</c>.</summary>
/// <remarks>All foreign keys are composite on tenant_id, as elsewhere, so a cross-tenant row fails at the constraint.</remarks>
internal sealed class ItemReferenceConfiguration : IEntityTypeConfiguration<ItemReference>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<ItemReference> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.ItemReference, table => table.HasCheckConstraint(
            "item_reference_role_bounded", "role IS NULL OR char_length(role) BETWEEN 1 AND 80"));
        builder.HasKey(reference => reference.Id);
        builder.Property(reference => reference.Id).HasColumnName("id").ValueGeneratedNever();
        builder.Property(reference => reference.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(reference => reference.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(reference => reference.HolderItemId).HasColumnName("holder_item_id");
        builder.Property(reference => reference.TargetItemId).HasColumnName("target_item_id");
        builder.Property(reference => reference.TargetFileVersionId).HasColumnName("target_file_version_id");
        builder.Property(reference => reference.Role).HasColumnName("role");
        builder.Property(reference => reference.CreatedBy).HasColumnName("created_by");
        builder.Property(reference => reference.CreatedAt).HasColumnName("created_at");

        builder.HasOne<Workspace>().WithMany()
            .HasForeignKey(reference => new { reference.TenantId, reference.WorkspaceId })
            .HasPrincipalKey(workspace => new { workspace.TenantId, workspace.Id })
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<Item>().WithMany()
            .HasForeignKey(reference => new { reference.TenantId, reference.HolderItemId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<Item>().WithMany()
            .HasForeignKey(reference => new { reference.TenantId, reference.TargetItemId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })
            .OnDelete(DeleteBehavior.Cascade);
        // A pin names a version of the target item itself: the (tenant, item, version) alternate key.
        builder.HasOne<FileVersion>().WithMany()
            .HasForeignKey(reference => new { reference.TenantId, reference.TargetItemId, reference.TargetFileVersionId })
            .HasPrincipalKey(version => new { version.TenantId, version.ItemId, version.Id })
            .OnDelete(DeleteBehavior.Cascade);

        // One row per (holder, target, version, role); NULLs compare equal so two unpinned,
        // role-less references cannot coexist.
        builder.HasIndex(reference => new
        {
            reference.TenantId,
            reference.HolderItemId,
            reference.TargetItemId,
            reference.TargetFileVersionId,
            reference.Role,
        })
            .IsUnique()
            .AreNullsDistinct(false)
            .HasDatabaseName("ux_item_reference_edge");
        // Reverse lookup by target item uses the foreign key's index (tenant, target item, version);
        // the holder side uses the unique edge index above, which leads with the holder.
        builder.HasIndex(reference => new { reference.TenantId, reference.TargetFileVersionId })
            .HasFilter("target_file_version_id IS NOT NULL")
            .HasDatabaseName("ix_item_reference_pin");
    }
}

/// <summary>Maps <see cref="PublicLink"/> to <c>public_link</c>.</summary>
internal sealed class PublicLinkConfiguration : IEntityTypeConfiguration<PublicLink>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<PublicLink> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.PublicLink);
        builder.HasKey(link => link.Id);
        builder.Property(link => link.Id).HasColumnName("id").ValueGeneratedNever();
        builder.Property(link => link.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(link => link.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(link => link.ItemId).HasColumnName("item_id");
        builder.Property(link => link.Nonce).HasColumnName("nonce").HasMaxLength(64);
        builder.Property(link => link.FileVersionId).HasColumnName("file_version_id");
        builder.Property(link => link.ServicePrincipalId).HasColumnName("service_principal_id");
        builder.Property(link => link.CreatedBy).HasColumnName("created_by");
        builder.Property(link => link.CreatedAt).HasColumnName("created_at");
        builder.Property(link => link.RevokedAt).HasColumnName("revoked_at");

        builder.HasOne<Tenant>().WithMany()
            .HasForeignKey(link => link.TenantId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<Workspace>().WithMany()
            .HasForeignKey(link => new { link.TenantId, link.WorkspaceId })
            .HasPrincipalKey(workspace => new { workspace.TenantId, workspace.Id })
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<Item>().WithMany()
            .HasForeignKey(link => new { link.TenantId, link.ItemId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<FileVersion>().WithMany()
            .HasForeignKey(link => new { link.TenantId, link.ItemId, link.FileVersionId })
            .HasPrincipalKey(version => new { version.TenantId, version.ItemId, version.Id })
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<Principal>().WithMany()
            .HasForeignKey(link => new { link.TenantId, link.ServicePrincipalId })
            .HasPrincipalKey(principal => new { principal.TenantId, principal.Id })
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<Principal>().WithMany()
            .HasForeignKey(link => new { link.TenantId, link.CreatedBy })
            .HasPrincipalKey(principal => new { principal.TenantId, principal.Id })
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasIndex(link => new { link.TenantId, link.ItemId })
            .IsUnique()
            .HasFilter("revoked_at IS NULL")
            .HasDatabaseName("ux_public_link_active_item");
        builder.HasIndex(link => link.Nonce)
            .HasDatabaseName("ix_public_link_nonce");
    }
}

/// <summary>Maps <see cref="RecordKey"/> to <c>record_key</c>.</summary>
internal sealed class RecordKeyConfiguration : IEntityTypeConfiguration<RecordKey>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<RecordKey> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        // The octet bound keeps the unique btree entry under Postgres' index tuple limit.
        builder.ToTable(NixTables.RecordKey, table => table.HasCheckConstraint(
            "record_key_bounded",
            "char_length(value) BETWEEN 1 AND 2048 AND octet_length(value) <= 2400 AND char_length(field) BETWEEN 1 AND 128"));
        builder.HasKey(key => new { key.TenantId, key.ScopeItemId, key.Field, key.Value })
            .HasName("ux_record_key_value");
        builder.Property(key => key.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(key => key.ScopeItemId).HasColumnName("scope_item_id");
        builder.Property(key => key.Field).HasColumnName("field");
        builder.Property(key => key.Value).HasColumnName("value");
        builder.Property(key => key.ItemId).HasColumnName("item_id");

        builder.HasOne<Item>().WithMany()
            .HasForeignKey(key => new { key.TenantId, key.ScopeItemId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<Item>().WithMany()
            .HasForeignKey(key => new { key.TenantId, key.ItemId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasIndex(key => new { key.TenantId, key.ItemId })
            .HasDatabaseName("ix_record_key_item");
    }
}
