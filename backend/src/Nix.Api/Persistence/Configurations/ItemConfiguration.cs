using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Persistence.Conversion;

namespace Nix.Persistence.Configurations;

/// <summary>
/// Maps <see cref="Item"/> to <c>item</c>.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why every reference here is composite on <c>tenant_id</c>.</b> Postgres evaluates foreign
/// key checks with the referenced table's owner privileges, and those checks are not subject to
/// row-level security. A plain <c>parent_id -> item(id)</c> constraint would therefore be
/// satisfied by another tenant's row: the policy's <c>WITH CHECK</c> only asserts that the row
/// being written carries this tenant's id, not that the row it points at does. Referencing
/// <c>(tenant_id, parent_id) -> item(tenant_id, id)</c> makes a cross-tenant edge fail at the
/// constraint, which turns "the code must never link across tenants" from a rule someone has to
/// remember into one the database will not allow. Every tenant-scoped table in the M0 schema
/// follows the same pattern.
/// </para>
/// <para>
/// The nullable parent uses the SQL default match semantics: when <c>parent_id</c> is NULL the
/// constraint is not checked at all, which is exactly right for a workspace root.
/// </para>
/// </remarks>
internal sealed class ItemConfiguration : IEntityTypeConfiguration<Item>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<Item> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.Item);

        builder.HasKey(item => item.Id);
        builder.Property(item => item.Id).HasColumnName("id");
        builder.Property(item => item.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(item => item.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(item => item.Type).HasColumnName("type").IsRequired();
        builder.Property(item => item.ParentId).HasColumnName("parent_id");
        builder.Property(item => item.Seq).HasColumnName("seq");

        builder.Property(item => item.Schema).HasColumnName("schema").HasColumnType("jsonb");
        builder.Property(item => item.Views).HasColumnName("views").HasColumnType("jsonb");
        builder.Property(item => item.TemplateId).HasColumnName("template_id");
        builder.Property(item => item.TemplateSourceId).HasColumnName("template_source_id");

        builder.Property(item => item.Properties)
            .HasColumnName("properties")
            .HasColumnType("jsonb");

        builder.Property(item => item.Recurrence).HasColumnName("recurrence").HasColumnType("jsonb");

        // Postgres maintains this: it is the indexable projection of the reserved due_date key,
        // and it exists because a qual over `properties ->> key` can never be an index cond under
        // RLS - `->>` is not leakproof, so row security keeps it above the access method. A plain
        // column reference is leakproof, so the same predicate becomes a boundary qual.
        builder.Property(item => item.DueDay)
            .HasColumnName("due_day")
            .HasColumnType("text")
            .HasComputedColumnSql("left(properties ->> 'due_date', 10)", stored: true)
            .ValueGeneratedOnAddOrUpdate();

        builder.Property(item => item.LifecycleState)
            .HasColumnName("lifecycle_state")
            .HasConversion(new EnumConverters.ItemLifecycleStateConverter())
            .IsRequired();

        builder.Property(item => item.NoDelete).HasColumnName("no_delete").HasDefaultValue(false);
        builder.Property(item => item.NoChildren).HasColumnName("no_children").HasDefaultValue(false);
        builder.Property(item => item.ManagedBy).HasColumnName("managed_by");

        builder.Property(item => item.PurgeAfter).HasColumnName("purge_after");
        builder.Property(item => item.CreatedBy).HasColumnName("created_by");
        builder.Property(item => item.LastModifiedBy).HasColumnName("last_modified_by");
        builder.Property(item => item.CreatedAt).HasColumnName("created_at");
        builder.Property(item => item.LastModifiedAt).HasColumnName("last_modified_at");

        // The target of every composite tenant-scoped reference to an item.
        builder.HasAlternateKey(item => new { item.TenantId, item.Id });

        builder.HasOne<Workspace>()
            .WithMany()
            .HasForeignKey(item => new { item.TenantId, item.WorkspaceId })
            .HasPrincipalKey(workspace => new { workspace.TenantId, workspace.Id })
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne<Item>()
            .WithMany()
            .HasForeignKey(item => new { item.TenantId, item.ParentId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })

            // Restrict, not Cascade. Purging a subtree reparents children to the grandparent and
            // is a deliberate, audited operation; a database cascade would delete them silently
            // and take the audit trail's subject with it.
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasOne<Nix.Domain.Templates.WorkspaceTemplate>()
            .WithMany()
            .HasForeignKey(item => new { item.TenantId, item.TemplateId })
            .HasPrincipalKey(template => new { template.TenantId, template.Id })
            .OnDelete(DeleteBehavior.Restrict);

        // A managed replacement stages the new revision while the previous one remains active, so
        // the stable source identity deliberately appears in both trees during that short window.
        builder.HasIndex(item => new { item.TenantId, item.TemplateId, item.TemplateSourceId });

        // Listing an item's children in order - the single most common tree read.
        //
        // Not prefixed with tenant_id: workspace_id functionally determines it, so prefixing would
        // widen every entry to narrow nothing. The row-level security predicate lands in filter
        // position here rather than as an index condition, which measures at ~54ns per row - a
        // listing query that also carries an explicit tenant_id predicate (which every query
        // should, per the defence-in-depth rule) collapses it to a one-time filter instead.
        builder.HasIndex(item => new { item.WorkspaceId, item.ParentId, item.Seq });

        // The deletion check asks "is anything protected beneath this item", and is driven from
        // the protected rows. Partial, so the overwhelmingly common unprotected item costs nothing.
        builder.HasIndex(item => new { item.TenantId, item.Id })
            .HasDatabaseName("ix_item_no_delete")
            .HasFilter("no_delete");

        // My Day's habit candidates: only items carrying the habit marker, so the statement reads
        // them instead of every item of the tenant. The marker is a bag read, and under row
        // security a bag read cannot be an index condition; what carries it is the partial
        // predicate, which the planner proves from the statement's own matching clause.
        builder.HasIndex(["TenantId", "Id"], "ix_item_habit_marker")
            .HasFilter("lifecycle_state = 'active' AND template_id IS NULL AND (properties ->> '$habit_frequency') IS NOT NULL");

        // No standalone tenant_id index. It would be a strict prefix of the alternate key and of
        // both composite foreign key indexes, so it can serve no query they do not - while costing
        // a write on every insert into the fastest-growing table in the system.
    }
}
