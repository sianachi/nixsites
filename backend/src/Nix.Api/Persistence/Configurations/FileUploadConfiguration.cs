using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Files;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Configurations;

internal sealed class FileUploadConfiguration : IEntityTypeConfiguration<FileUpload>
{
    public void Configure(EntityTypeBuilder<FileUpload> builder)
    {
        builder.ToTable(NixTables.FileUpload);
        builder.HasKey(upload => upload.Id);
        builder.Property(upload => upload.Id).HasColumnName("upload_id");
        builder.Property(upload => upload.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(upload => upload.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(upload => upload.ParentId).HasColumnName("parent_id");
        builder.Property(upload => upload.TargetItemId).HasColumnName("target_item_id");
        builder.Property(upload => upload.ActorId).HasColumnName("actor_id");
        builder.Property(upload => upload.IdempotencyKey).HasColumnName("idempotency_key").HasMaxLength(160);
        builder.Property(upload => upload.Purpose).HasColumnName("purpose").HasMaxLength(32).HasDefaultValue("file");
        builder.Property(upload => upload.FileName).HasColumnName("file_name").HasMaxLength(255);
        builder.Property(upload => upload.DeclaredMediaType).HasColumnName("declared_media_type").HasMaxLength(160);
        builder.Property(upload => upload.DeclaredByteLength).HasColumnName("declared_byte_length");
        builder.Property(upload => upload.ObjectKey).HasColumnName("object_key").HasMaxLength(512);
        builder.Property(upload => upload.Status).HasColumnName("status").HasMaxLength(32);
        builder.Property(upload => upload.FailureCode).HasColumnName("failure_code").HasMaxLength(80);
        builder.Property(upload => upload.PublishedItemId).HasColumnName("published_item_id");
        builder.Property(upload => upload.ExpiresAt).HasColumnName("expires_at");
        builder.Property(upload => upload.CreatedAt).HasColumnName("created_at");
        builder.Property(upload => upload.UpdatedAt).HasColumnName("updated_at");
        builder.Property(upload => upload.SourceItemId).HasColumnName("source_item_id");
        builder.Property(upload => upload.SourceSeq).HasColumnName("source_seq");
        builder.Property(upload => upload.PublishedVersionId).HasColumnName("published_version_id");
        builder.HasAlternateKey(upload => new { upload.TenantId, upload.Id });
        builder.HasIndex(upload => new { upload.TenantId, upload.ActorId, upload.IdempotencyKey }).IsUnique();
        builder.HasIndex(upload => new { upload.Status, upload.ExpiresAt });
        builder.HasOne<Workspace>().WithMany()
            .HasForeignKey(upload => new { upload.TenantId, upload.WorkspaceId })
            .HasPrincipalKey(workspace => new { workspace.TenantId, workspace.Id })
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<Item>().WithMany()
            .HasForeignKey(upload => new { upload.TenantId, upload.TargetItemId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })
            .OnDelete(DeleteBehavior.Restrict);
    }
}
