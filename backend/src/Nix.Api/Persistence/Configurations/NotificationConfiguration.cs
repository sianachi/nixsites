using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Identity;
using Nix.Domain.Notifications;

namespace Nix.Persistence.Configurations;

internal sealed class NotificationConfiguration : IEntityTypeConfiguration<Notification>
{
    public void Configure(EntityTypeBuilder<Notification> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.Notification, table => table.HasCheckConstraint(
            "notification_bounded",
            "char_length(title) <= 200 AND char_length(body) <= 1000"
                + " AND kind IN ('reminder', 'automation', 'calendar', 'system', 'invitation', 'comment')"));
        builder.HasKey(row => row.Id);
        builder.Property(row => row.Id).HasColumnName("id");
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.PrincipalId).HasColumnName("principal_id");
        builder.Property(row => row.Kind)
            .HasColumnName("kind")
            .HasConversion(
                kind => NotificationKindStorage.ToText(kind),
                stored => NotificationKindStorage.FromText(stored))
            .HasMaxLength(16)
            .IsRequired();
        builder.Property(row => row.Title).HasColumnName("title").IsRequired();
        builder.Property(row => row.Body).HasColumnName("body").IsRequired();
        builder.Property(row => row.ItemId).HasColumnName("item_id");
        builder.Property(row => row.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(row => row.CreatedAt).HasColumnName("created_at");
        builder.Property(row => row.Seq).HasColumnName("seq").ValueGeneratedOnAdd();
        builder.Property(row => row.ReadAt).HasColumnName("read_at");
        builder.Property(row => row.DedupeKey).HasColumnName("dedupe_key").HasMaxLength(200).IsRequired();

        builder.HasOne<Principal>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.PrincipalId })
            .HasPrincipalKey(row => new { row.TenantId, row.Id })

            // Notifications are personal state addressed to the principal, not a reference to
            // them: when they are purged, their inbox goes with them.
            .OnDelete(DeleteBehavior.Cascade);

        // The only list read: this principal's inbox, newest first, optionally filtered to unread.
        builder.HasIndex(row => new { row.TenantId, row.PrincipalId, row.Seq }, "IX_notification_tenant_id_principal_id_seq");

        // Creating a notification is idempotent per recipient: a repeated dedupe key (a redelivered
        // trigger, a retried worker call) returns the row that already exists. The key is unique
        // per principal, not per tenant: row-level security hides other principals' rows, so a
        // tenant-wide index would let one recipient's key silently swallow another's notification.
        builder.HasIndex(row => new { row.TenantId, row.PrincipalId, row.DedupeKey })
            .IsUnique()
            .HasDatabaseName("IX_notification_tenant_id_principal_id_dedupe_key");

        // The unread count every inbox read and watch poll needs, and the unread-only list and
        // mark-all-read: served from the unread rows alone instead of scanning the whole inbox.
        // Named separately so EF keeps it beside, not instead of, the full index on the same columns.
        builder.HasIndex(row => new { row.TenantId, row.PrincipalId, row.Seq }, "IX_notification_tenant_id_principal_id_seq_unread")
            .HasFilter("read_at IS NULL");

        // Serves nix_purge_old_notifications, which scans every tenant's old notifications by age
        // alone (ADR-0051 Amendment 2's retention indexes owed to lane B1) - the SECURITY DEFINER
        // retention function crosses every principal, so a tenant- or principal-scoped index would
        // not serve it the way it serves every ordinary, RLS-scoped read above.
        builder.HasIndex(row => row.CreatedAt)
            .HasDatabaseName("IX_notification_created_at");
    }
}
