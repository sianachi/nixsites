using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Comments;
using Nix.Domain.Items;

namespace Nix.Persistence.Configurations;

/// <summary>Maps <see cref="NoteComment"/> to <c>note_comment</c>.</summary>
internal sealed class NoteCommentConfiguration : IEntityTypeConfiguration<NoteComment>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<NoteComment> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.NoteComment, table => table.HasCheckConstraint(
            "note_comment_bounded",
            "char_length(body) <= 10000 AND (deleted_at IS NOT NULL OR char_length(body) >= 1) AND cardinality(mention_ids) <= 20"
                + " AND (quote IS NULL OR char_length(quote) <= 1000)"
                + " AND (anchor_start IS NULL OR char_length(anchor_start) <= 512)"
                + " AND (anchor_end IS NULL OR char_length(anchor_end) <= 512)"
                + " AND (imported_author IS NULL OR char_length(imported_author) <= 200)"));
        builder.HasKey(comment => comment.Id);
        builder.Property(comment => comment.Id).HasColumnName("id").ValueGeneratedNever();
        builder.Property(comment => comment.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(comment => comment.ItemId).HasColumnName("item_id");
        builder.Property(comment => comment.ThreadId).HasColumnName("thread_id");
        builder.Property(comment => comment.AuthorPrincipalId).HasColumnName("author_principal_id");
        builder.Property(comment => comment.ImportedAuthor).HasColumnName("imported_author");
        builder.Property(comment => comment.Body).HasColumnName("body").IsRequired();
        builder.Property(comment => comment.MentionIds).HasColumnName("mention_ids").HasColumnType("uuid[]");
        builder.Property(comment => comment.AnchorStart).HasColumnName("anchor_start");
        builder.Property(comment => comment.AnchorEnd).HasColumnName("anchor_end");
        builder.Property(comment => comment.Quote).HasColumnName("quote");
        builder.Property(comment => comment.ResolvedAt).HasColumnName("resolved_at");
        builder.Property(comment => comment.ResolvedBy).HasColumnName("resolved_by");
        builder.Property(comment => comment.CreatedAt).HasColumnName("created_at");
        builder.Property(comment => comment.EditedAt).HasColumnName("edited_at");
        builder.Property(comment => comment.DeletedAt).HasColumnName("deleted_at");

        // Comments are part of the note: purging it takes them with it. No foreign key on the
        // author or resolver, so a comment outlives a removed member.
        builder.HasOne<Item>()
            .WithMany()
            .HasForeignKey(comment => new { comment.TenantId, comment.ItemId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne<NoteComment>()
            .WithMany()
            .HasForeignKey(comment => comment.ThreadId)
            .HasPrincipalKey(comment => comment.Id)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasIndex(comment => new { comment.TenantId, comment.ItemId, comment.CreatedAt })
            .HasDatabaseName("IX_note_comment_tenant_id_item_id_created_at");
        builder.HasIndex(comment => new { comment.TenantId, comment.ThreadId })
            .HasDatabaseName("IX_note_comment_tenant_id_thread_id");
    }
}

/// <summary>Maps <see cref="NoteCommentRevision"/> to <c>note_comment_revision</c>.</summary>
internal sealed class NoteCommentRevisionConfiguration : IEntityTypeConfiguration<NoteCommentRevision>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<NoteCommentRevision> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.NoteCommentRevision);
        builder.HasKey(row => new { row.TenantId, row.ItemId });
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.ItemId).HasColumnName("item_id");
        builder.Property(row => row.Revision).HasColumnName("revision");
        builder.HasOne<Item>()
            .WithMany()
            .HasForeignKey(row => new { row.TenantId, row.ItemId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })
            .OnDelete(DeleteBehavior.Cascade);
    }
}
