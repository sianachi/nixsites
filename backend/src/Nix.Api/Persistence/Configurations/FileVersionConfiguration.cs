using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Files;
using Nix.Domain.Items;

namespace Nix.Persistence.Configurations;

internal sealed class FileVersionConfiguration : IEntityTypeConfiguration<FileVersion>
{
    public void Configure(EntityTypeBuilder<FileVersion> builder)
    {
        builder.ToTable(NixTables.FileVersion, table => table.HasCheckConstraint(
            "file_version_state_valid", "state IN ('draft', 'in_review', 'approved', 'revoked')"));
        builder.HasKey(version => version.Id);
        builder.Property(version => version.Id).HasColumnName("file_version_id");
        builder.Property(version => version.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(version => version.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(version => version.ItemId).HasColumnName("item_id");
        builder.Property(version => version.Version).HasColumnName("version");
        builder.Property(version => version.ObjectKey).HasColumnName("object_key").HasMaxLength(512);
        builder.Property(version => version.FileName).HasColumnName("file_name").HasMaxLength(255);
        builder.Property(version => version.MediaType).HasColumnName("media_type").HasMaxLength(160);
        builder.Property(version => version.ByteLength).HasColumnName("byte_length");
        builder.Property(version => version.Sha256).HasColumnName("sha256").HasMaxLength(64);
        builder.Property(version => version.ObjectReady).HasColumnName("object_ready").HasDefaultValue(true);
        builder.Property(version => version.PixelWidth).HasColumnName("pixel_width");
        builder.Property(version => version.PixelHeight).HasColumnName("pixel_height");
        builder.Property(version => version.ThumbnailWidth).HasColumnName("thumbnail_width");
        builder.Property(version => version.ThumbnailHeight).HasColumnName("thumbnail_height");
        builder.Property(version => version.ThumbnailBytes).HasColumnName("thumbnail_bytes");
        builder.Property(version => version.Previewable).HasColumnName("previewable");
        builder.Property(version => version.CreatedBy).HasColumnName("created_by");
        builder.Property(version => version.CreatedAt).HasColumnName("created_at");
        builder.Property(version => version.State).HasColumnName("state").HasDefaultValue("draft");
        builder.Property(version => version.StateChangedBy).HasColumnName("state_changed_by");
        builder.Property(version => version.StateChangedAt).HasColumnName("state_changed_at");
        builder.Property(version => version.SourceItemId).HasColumnName("source_item_id");
        builder.Property(version => version.SourceSeq).HasColumnName("source_seq");
        builder.HasAlternateKey(version => new { version.TenantId, version.Id });
        builder.HasAlternateKey(version => new { version.TenantId, version.ItemId, version.Id });
        builder.HasIndex(version => new { version.TenantId, version.ItemId, version.Version }).IsUnique();
        builder.HasIndex(version => new { version.TenantId, version.ObjectKey }).IsUnique();
        builder.HasOne<Item>().WithMany()
            .HasForeignKey(version => new { version.TenantId, version.ItemId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })
            .OnDelete(DeleteBehavior.Cascade);
    }
}
