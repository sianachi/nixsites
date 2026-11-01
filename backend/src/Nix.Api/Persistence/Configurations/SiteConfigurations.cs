using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Sites;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Configurations;

/// <summary>Maps <see cref="Site"/> to <c>site</c>.</summary>
/// <remarks>Every constraint and index is named explicitly; the grants and policies live in <c>SitesSecuritySql</c>.</remarks>
internal sealed class SiteConfiguration : IEntityTypeConfiguration<Site>
{
    public void Configure(EntityTypeBuilder<Site> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.Site, table => table.HasCheckConstraint(
            "ck_site_bounded",
            "slug ~ '^[a-z0-9](-?[a-z0-9]){1,39}$'"
                + " AND layout IN ('docs', 'blog', 'custom')"
                + " AND republish_mode IN ('manual', 'auto', 'on_release')"
                + " AND status IN ('draft', 'published', 'unpublished')"
                + " AND debounce_seconds BETWEEN 60 AND 3600"
                + " AND (republish_mode <> 'auto' OR auto_principal_id IS NOT NULL)"
                + " AND (status = 'published') = (live_build_id IS NOT NULL)"
                + " AND pg_column_size(settings) <= 16384"
                + " AND (primary_hostname IS NULL OR char_length(primary_hostname) BETWEEN 3 AND 253)"
                + " AND (approval_state IS NULL OR approval_state IN ('pending', 'approved', 'rejected'))"
                + " AND (approval_state IS NULL OR (approval_requested_by IS NOT NULL AND approval_requested_at IS NOT NULL))"
                + " AND (approval_note IS NULL OR char_length(approval_note) <= 500)"));
        builder.HasKey(row => new { row.TenantId, row.Id }).HasName("pk_site");
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.Id).HasColumnName("id");
        builder.Property(row => row.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(row => row.RootItemId).HasColumnName("root_item_id");
        builder.Property(row => row.Slug).HasColumnName("slug").HasMaxLength(40).IsRequired();
        builder.Property(row => row.Layout).HasColumnName("layout").HasMaxLength(8).IsRequired();
        builder.Property(row => row.Settings).HasColumnName("settings").HasColumnType("jsonb").IsRequired();
        builder.Property(row => row.RepublishMode).HasColumnName("republish_mode").HasMaxLength(16).IsRequired();
        builder.Property(row => row.AutoPrincipalId).HasColumnName("auto_principal_id");
        builder.Property(row => row.DebounceSeconds).HasColumnName("debounce_seconds");
        builder.Property(row => row.Status).HasColumnName("status").HasMaxLength(16).IsRequired();
        builder.Property(row => row.LiveBuildId).HasColumnName("live_build_id");
        builder.Property(row => row.PrimaryHostname).HasColumnName("primary_hostname").HasMaxLength(253);
        builder.Property(row => row.ApprovalState).HasColumnName("approval_state").HasMaxLength(16);
        builder.Property(row => row.ApprovalRequestedBy).HasColumnName("approval_requested_by");
        builder.Property(row => row.ApprovalRequestedAt).HasColumnName("approval_requested_at");
        builder.Property(row => row.ApprovalDecidedBy).HasColumnName("approval_decided_by");
        builder.Property(row => row.ApprovalDecidedAt).HasColumnName("approval_decided_at");
        builder.Property(row => row.ApprovalNote).HasColumnName("approval_note").HasMaxLength(500);
        builder.Property(row => row.CreatedBy).HasColumnName("created_by");
        builder.Property(row => row.CreatedAt).HasColumnName("created_at");
        builder.Property(row => row.UpdatedAt).HasColumnName("updated_at");

        builder.HasOne<Workspace>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.WorkspaceId })
            .HasPrincipalKey(workspace => new { workspace.TenantId, workspace.Id })
            .HasConstraintName("fk_site_workspace")
            .OnDelete(DeleteBehavior.Restrict);

        // Restrict, not cascade: a site that is live or still has objects in the bucket must be
        // unpublished and drained first, so the purges refuse it and the key backs them.
        builder.HasOne<Item>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.RootItemId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })
            .HasConstraintName("fk_site_root_item")
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<Principal>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.CreatedBy })
            .HasPrincipalKey(principal => new { principal.TenantId, principal.Id })
            .HasConstraintName("fk_site_created_by")
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<Principal>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.AutoPrincipalId })
            .HasPrincipalKey(principal => new { principal.TenantId, principal.Id })
            .HasConstraintName("fk_site_auto_principal")
            .OnDelete(DeleteBehavior.Restrict);

        // One site per root, and a slug is claimed once across every tenant.
        builder.HasIndex(row => new { row.TenantId, row.RootItemId }).IsUnique().HasDatabaseName("ux_site_root");
        builder.HasIndex(row => row.Slug).IsUnique().HasDatabaseName("ux_site_slug");
        builder.HasIndex(row => new { row.TenantId, row.WorkspaceId }).HasDatabaseName("ix_site_workspace");
        builder.HasIndex(row => new { row.TenantId, row.CreatedBy }).HasDatabaseName("ix_site_created_by");
        builder.HasIndex(row => new { row.TenantId, row.AutoPrincipalId }).HasFilter("auto_principal_id IS NOT NULL")
            .HasDatabaseName("ix_site_auto_principal");
        builder.HasIndex(row => new { row.TenantId, row.ApprovalRequestedAt }).HasFilter("approval_state = 'pending'")
            .HasDatabaseName("ix_site_approval_pending");
    }
}

/// <summary>Maps <see cref="SiteHostname"/> to <c>site_hostname</c>.</summary>
internal sealed class SiteHostnameConfiguration : IEntityTypeConfiguration<SiteHostname>
{
    public void Configure(EntityTypeBuilder<SiteHostname> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.SiteHostname, table => table.HasCheckConstraint(
            "ck_site_hostname_bounded",
            "char_length(hostname) BETWEEN 3 AND 253 AND hostname = lower(hostname) AND kind IN ('default', 'custom')"
                + " AND (kind = 'custom' OR verified_at IS NOT NULL)"
                + " AND serve_mode IN ('serve', 'redirect')"
                + " AND (kind = 'default' OR (verification_token IS NOT NULL AND verification_token ~ '^[0-9a-f]{32}$'))"
                + " AND check_failures BETWEEN 0 AND 10"
                + " AND (check_error IS NULL OR char_length(check_error) <= 64)"
                + " AND (managed_records IS NULL OR (jsonb_typeof(managed_records) = 'object' AND pg_column_size(managed_records) <= 2048))"));

        // A served hostname (a default one, or a custom one once verified) is global: two sites can
        // never answer the same name. An unverified claim is per site, so it cannot squat a name.
        builder.HasKey(row => new { row.TenantId, row.SiteId, row.Hostname }).HasName("pk_site_hostname");
        builder.HasIndex(row => row.Hostname).IsUnique().HasFilter("verified_at IS NOT NULL")
            .HasDatabaseName("ux_site_hostname_verified");
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.Hostname).HasColumnName("hostname").HasMaxLength(253);
        builder.Property(row => row.SiteId).HasColumnName("site_id");
        builder.Property(row => row.Kind).HasColumnName("kind").HasMaxLength(8).IsRequired();
        builder.Property(row => row.VerifiedAt).HasColumnName("verified_at");
        builder.Property(row => row.CreatedAt).HasColumnName("created_at");
        builder.Property(row => row.VerificationToken).HasColumnName("verification_token").HasMaxLength(32);
        builder.Property(row => row.ServeMode).HasColumnName("serve_mode").HasMaxLength(8).HasDefaultValue("serve").IsRequired();
        builder.Property(row => row.CheckedAt).HasColumnName("checked_at");
        builder.Property(row => row.CheckFailures).HasColumnName("check_failures");
        builder.Property(row => row.CheckError).HasColumnName("check_error").HasMaxLength(64);
        builder.Property(row => row.ManagedRecords).HasColumnName("managed_records").HasColumnType("jsonb");

        builder.HasOne<Site>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.SiteId })
            .HasPrincipalKey(site => new { site.TenantId, site.Id })
            .HasConstraintName("fk_site_hostname_site")
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasIndex(row => new { row.TenantId, row.SiteId }).HasDatabaseName("ix_site_hostname_site");
    }
}

/// <summary>Maps <see cref="SiteExclusion"/> to <c>site_exclusion</c>.</summary>
internal sealed class SiteExclusionConfiguration : IEntityTypeConfiguration<SiteExclusion>
{
    public void Configure(EntityTypeBuilder<SiteExclusion> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.SiteExclusion);
        builder.HasKey(row => new { row.TenantId, row.SiteId, row.ItemId }).HasName("pk_site_exclusion");
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.SiteId).HasColumnName("site_id");
        builder.Property(row => row.ItemId).HasColumnName("item_id");

        builder.HasOne<Site>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.SiteId })
            .HasPrincipalKey(site => new { site.TenantId, site.Id })
            .HasConstraintName("fk_site_exclusion_site")
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<Item>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.ItemId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })
            .HasConstraintName("fk_site_exclusion_item")
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasIndex(row => new { row.TenantId, row.ItemId }).HasDatabaseName("ix_site_exclusion_item");
    }
}

/// <summary>Maps <see cref="SiteDatedCollectionSetting"/> to <c>site_dated_collection</c>.</summary>
internal sealed class SiteDatedCollectionSettingConfiguration : IEntityTypeConfiguration<SiteDatedCollectionSetting>
{
    public void Configure(EntityTypeBuilder<SiteDatedCollectionSetting> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.SiteDatedCollection, table => table.HasCheckConstraint(
            "ck_site_dated_collection_bounded",
            "char_length(date_property) BETWEEN 1 AND 128"
                + " AND (tags_property IS NULL OR char_length(tags_property) BETWEEN 1 AND 128)"
                + " AND (cover_property IS NULL OR char_length(cover_property) BETWEEN 1 AND 128)"
                + " AND (summary_property IS NULL OR char_length(summary_property) BETWEEN 1 AND 128)"));
        builder.HasKey(row => new { row.TenantId, row.SiteId, row.ItemId }).HasName("pk_site_dated_collection");
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.SiteId).HasColumnName("site_id");
        builder.Property(row => row.ItemId).HasColumnName("item_id");
        builder.Property(row => row.DateProperty).HasColumnName("date_property").HasMaxLength(128).IsRequired();
        builder.Property(row => row.TagsProperty).HasColumnName("tags_property").HasMaxLength(128);
        builder.Property(row => row.CoverProperty).HasColumnName("cover_property").HasMaxLength(128);
        builder.Property(row => row.SummaryProperty).HasColumnName("summary_property").HasMaxLength(128);

        builder.HasOne<Site>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.SiteId })
            .HasPrincipalKey(site => new { site.TenantId, site.Id })
            .HasConstraintName("fk_site_dated_collection_site")
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<Item>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.ItemId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })
            .HasConstraintName("fk_site_dated_collection_item")
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasIndex(row => new { row.TenantId, row.ItemId }).HasDatabaseName("ix_site_dated_collection_item");
    }
}

/// <summary>Maps <see cref="SitePage"/> to <c>site_page</c>.</summary>
internal sealed class SitePageConfiguration : IEntityTypeConfiguration<SitePage>
{
    public void Configure(EntityTypeBuilder<SitePage> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.SitePage, table => table.HasCheckConstraint(
            "ck_site_page_path",
            "path ~ '^/([a-z0-9][a-z0-9-]{0,79}/)*$' AND char_length(path) <= 512"));
        builder.HasKey(row => new { row.TenantId, row.SiteId, row.ItemId }).HasName("pk_site_page");
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.SiteId).HasColumnName("site_id");
        builder.Property(row => row.ItemId).HasColumnName("item_id");
        builder.Property(row => row.Path).HasColumnName("path").HasMaxLength(512).IsRequired();
        builder.Property(row => row.Pinned).HasColumnName("pinned");
        builder.Property(row => row.CreatedAt).HasColumnName("created_at");
        builder.Property(row => row.UpdatedAt).HasColumnName("updated_at");

        builder.HasOne<Site>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.SiteId })
            .HasPrincipalKey(site => new { site.TenantId, site.Id })
            .HasConstraintName("fk_site_page_site")
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<Item>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.ItemId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })
            .HasConstraintName("fk_site_page_item")
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasIndex(row => new { row.TenantId, row.SiteId, row.Path }).IsUnique().HasDatabaseName("ux_site_page_path");
        builder.HasIndex(row => new { row.TenantId, row.ItemId }).HasDatabaseName("ix_site_page_item");
    }
}

/// <summary>Maps <see cref="SiteRedirect"/> to <c>site_redirect</c>.</summary>
internal sealed class SiteRedirectConfiguration : IEntityTypeConfiguration<SiteRedirect>
{
    public void Configure(EntityTypeBuilder<SiteRedirect> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.SiteRedirect, table => table.HasCheckConstraint(
            "ck_site_redirect_path",
            "from_path ~ '^/([a-z0-9][a-z0-9-]{0,79}/)+$' AND char_length(from_path) <= 512"));
        builder.HasKey(row => new { row.TenantId, row.SiteId, row.FromPath }).HasName("pk_site_redirect");
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.SiteId).HasColumnName("site_id");
        builder.Property(row => row.FromPath).HasColumnName("from_path").HasMaxLength(512);
        builder.Property(row => row.ItemId).HasColumnName("item_id");
        builder.Property(row => row.CreatedAt).HasColumnName("created_at");

        builder.HasOne<Site>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.SiteId })
            .HasPrincipalKey(site => new { site.TenantId, site.Id })
            .HasConstraintName("fk_site_redirect_site")
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<Item>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.ItemId })
            .HasPrincipalKey(item => new { item.TenantId, item.Id })
            .HasConstraintName("fk_site_redirect_item")
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasIndex(row => new { row.TenantId, row.ItemId }).HasDatabaseName("ix_site_redirect_item");
    }
}

/// <summary>Maps <see cref="SiteBuild"/> to <c>site_build</c>.</summary>
internal sealed class SiteBuildConfiguration : IEntityTypeConfiguration<SiteBuild>
{
    public void Configure(EntityTypeBuilder<SiteBuild> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.SiteBuild, table => table.HasCheckConstraint(
            "ck_site_build_bounded",
            "status IN ('queued', 'sealed', 'live', 'superseded', 'failed', 'purged')"
                + " AND origin IN ('manual', 'auto')"
                + " AND page_count BETWEEN 0 AND 5000"
                + " AND file_count >= 0 AND total_bytes >= 0"
                + " AND char_length(idempotency_key) BETWEEN 1 AND 160"
                + " AND jsonb_typeof(loss) = 'array'"
                + " AND (build_index_sha256 IS NULL OR build_index_sha256 ~ '^[0-9a-f]{64}$')"));
        builder.HasKey(row => new { row.TenantId, row.Id }).HasName("pk_site_build");
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.Id).HasColumnName("id");
        builder.Property(row => row.SiteId).HasColumnName("site_id");
        builder.Property(row => row.Status).HasColumnName("status").HasMaxLength(16).IsRequired();
        builder.Property(row => row.JobId).HasColumnName("job_id");
        builder.Property(row => row.PublisherId).HasColumnName("publisher_id");
        builder.Property(row => row.Origin).HasColumnName("origin").HasMaxLength(8).IsRequired();
        builder.Property(row => row.IdempotencyKey).HasColumnName("idempotency_key").HasMaxLength(160).IsRequired();
        builder.Property(row => row.Header).HasColumnName("header").HasColumnType("jsonb").IsRequired();
        builder.Property(row => row.PageCount).HasColumnName("page_count");
        builder.Property(row => row.FileCount).HasColumnName("file_count");
        builder.Property(row => row.TotalBytes).HasColumnName("total_bytes");
        builder.Property(row => row.Loss).HasColumnName("loss").HasColumnType("jsonb").IsRequired();
        builder.Property(row => row.BuildIndexSha256).HasColumnName("build_index_sha256").HasMaxLength(64);
        builder.Property(row => row.PurgeId).HasColumnName("purge_id");
        builder.Property(row => row.CreatedAt).HasColumnName("created_at");
        builder.Property(row => row.SealedAt).HasColumnName("sealed_at");
        builder.Property(row => row.ActivatedAt).HasColumnName("activated_at");

        builder.HasOne<Site>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.SiteId })
            .HasPrincipalKey(site => new { site.TenantId, site.Id })
            .HasConstraintName("fk_site_build_site")
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<Principal>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.PublisherId })
            .HasPrincipalKey(principal => new { principal.TenantId, principal.Id })
            .HasConstraintName("fk_site_build_publisher")
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasIndex(row => new { row.TenantId, row.SiteId, row.CreatedAt }).IsDescending(false, false, true)
            .HasDatabaseName("ix_site_build_site_created");
        builder.HasIndex(row => new { row.TenantId, row.SiteId, row.IdempotencyKey }).IsUnique()
            .HasDatabaseName("ux_site_build_idempotency");
        builder.HasIndex(row => new { row.TenantId, row.JobId }).IsUnique().HasDatabaseName("ux_site_build_job");
        builder.HasIndex(row => new { row.TenantId, row.PurgeId }).HasFilter("purge_id IS NOT NULL")
            .HasDatabaseName("ix_site_build_purge");
        builder.HasIndex(row => new { row.TenantId, row.PublisherId }).HasDatabaseName("ix_site_build_publisher");
    }
}

/// <summary>Maps <see cref="SiteBuildPage"/> to <c>site_build_page</c>.</summary>
internal sealed class SiteBuildPageConfiguration : IEntityTypeConfiguration<SiteBuildPage>
{
    public void Configure(EntityTypeBuilder<SiteBuildPage> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.SiteBuildPage, table => table.HasCheckConstraint(
            "ck_site_build_page_bounded",
            "ordinal >= 0 AND path ~ '^/([a-z0-9][a-z0-9-]{0,79}/)*$' AND char_length(title) <= 500"
                + " AND jsonb_typeof(properties) = 'object' AND jsonb_typeof(property_files) = 'array'"));
        builder.HasKey(row => new { row.TenantId, row.BuildId, row.Ordinal }).HasName("pk_site_build_page");
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.BuildId).HasColumnName("build_id");
        builder.Property(row => row.Ordinal).HasColumnName("ordinal");
        builder.Property(row => row.ItemId).HasColumnName("item_id");
        builder.Property(row => row.ParentItemId).HasColumnName("parent_item_id");
        builder.Property(row => row.Path).HasColumnName("path").HasMaxLength(512).IsRequired();
        builder.Property(row => row.Title).HasColumnName("title").HasMaxLength(500).IsRequired();
        builder.Property(row => row.Type).HasColumnName("type").IsRequired();
        builder.Property(row => row.Seq).HasColumnName("seq");
        builder.Property(row => row.ItemCreatedAt).HasColumnName("item_created_at");
        builder.Property(row => row.ItemUpdatedAt).HasColumnName("item_updated_at");
        builder.Property(row => row.Properties).HasColumnName("properties").HasColumnType("jsonb").IsRequired();
        builder.Property(row => row.Schema).HasColumnName("schema").HasColumnType("jsonb");
        builder.Property(row => row.Views).HasColumnName("views").HasColumnType("jsonb");
        builder.Property(row => row.Chart).HasColumnName("chart").HasColumnType("jsonb");
        builder.Property(row => row.DocId).HasColumnName("doc_id");
        builder.Property(row => row.ContentSeq).HasColumnName("content_seq");
        builder.Property(row => row.DatedCollectionId).HasColumnName("dated_collection_id");
        builder.Property(row => row.PublishedAt).HasColumnName("published_at");
        builder.Property(row => row.PropertyFiles).HasColumnName("property_files").HasColumnType("jsonb").IsRequired();

        builder.HasOne<SiteBuild>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.BuildId })
            .HasPrincipalKey(build => new { build.TenantId, build.Id })
            .HasConstraintName("fk_site_build_page_build")
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasIndex(row => new { row.TenantId, row.BuildId, row.ItemId }).IsUnique()
            .HasDatabaseName("ux_site_build_page_item");
    }
}

/// <summary>Maps <see cref="SiteBuildFile"/> to <c>site_build_file</c>.</summary>
internal sealed class SiteBuildFileConfiguration : IEntityTypeConfiguration<SiteBuildFile>
{
    public void Configure(EntityTypeBuilder<SiteBuildFile> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.SiteBuildFile, table => table.HasCheckConstraint(
            "ck_site_build_file_bounded",
            "sha256 ~ '^[0-9a-f]{64}$' AND ("
                + "(media_type IN ('image/png', 'image/jpeg', 'image/webp') AND byte_length BETWEEN 1 AND 10485760)"
                + " OR (media_type = 'image/svg+xml' AND byte_length BETWEEN 1 AND 2097152)"
                + " OR (media_type IN ('application/pdf', 'text/plain', 'text/csv') AND byte_length BETWEEN 1 AND 20971520)"
                + " OR (media_type IN ('video/mp4', 'video/webm') AND byte_length BETWEEN 1 AND 52428800))"));
        builder.HasKey(row => new { row.TenantId, row.BuildId, row.SourceItemId, row.FileItemId })
            .HasName("pk_site_build_file");
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.BuildId).HasColumnName("build_id");
        builder.Property(row => row.SourceItemId).HasColumnName("source_item_id");
        builder.Property(row => row.FileItemId).HasColumnName("file_item_id");
        builder.Property(row => row.FileVersionId).HasColumnName("file_version_id");
        builder.Property(row => row.Sha256).HasColumnName("sha256").HasMaxLength(64).IsRequired();
        builder.Property(row => row.MediaType).HasColumnName("media_type").HasMaxLength(32).IsRequired();
        builder.Property(row => row.ByteLength).HasColumnName("byte_length");
        builder.Property(row => row.CreatedAt).HasColumnName("created_at");

        builder.HasOne<SiteBuild>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.BuildId })
            .HasPrincipalKey(build => new { build.TenantId, build.Id })
            .HasConstraintName("fk_site_build_file_build")
            .OnDelete(DeleteBehavior.Cascade);
    }
}

/// <summary>Maps <see cref="SiteBuildObject"/> to <c>site_build_object</c>.</summary>
internal sealed class SiteBuildObjectConfiguration : IEntityTypeConfiguration<SiteBuildObject>
{
    public void Configure(EntityTypeBuilder<SiteBuildObject> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.SiteBuildObject, table => table.HasCheckConstraint(
            "ck_site_build_object_bounded",
            "kind IN ('build', 'asset') AND sha256 ~ '^[0-9a-f]{64}$' AND byte_length BETWEEN 0 AND 52428800"
                + " AND char_length(key) BETWEEN 1 AND 700"));
        builder.HasKey(row => new { row.TenantId, row.BuildId, row.Key }).HasName("pk_site_build_object");
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.BuildId).HasColumnName("build_id");
        builder.Property(row => row.Key).HasColumnName("key").HasMaxLength(700);
        builder.Property(row => row.Sha256).HasColumnName("sha256").HasMaxLength(64).IsRequired();
        builder.Property(row => row.ByteLength).HasColumnName("byte_length");
        builder.Property(row => row.Kind).HasColumnName("kind").HasMaxLength(8).IsRequired();
        builder.Property(row => row.CreatedAt).HasColumnName("created_at");

        builder.HasOne<SiteBuild>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.BuildId })
            .HasPrincipalKey(build => new { build.TenantId, build.Id })
            .HasConstraintName("fk_site_build_object_build")
            .OnDelete(DeleteBehavior.Cascade);

        // Asset keys are shared between builds; purging asks which other builds still hold one.
        builder.HasIndex(row => new { row.TenantId, row.Key }).HasFilter("kind = 'asset'")
            .HasDatabaseName("ix_site_build_object_asset");
    }
}

/// <summary>Maps <see cref="SiteActivation"/> to <c>site_activation</c>.</summary>
internal sealed class SiteActivationConfiguration : IEntityTypeConfiguration<SiteActivation>
{
    public void Configure(EntityTypeBuilder<SiteActivation> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.SiteActivation, table => table.HasCheckConstraint(
            "ck_site_activation_bounded",
            "reason IN ('publish', 'rollback', 'unpublish', 'hostnames') AND generation >= 1 AND jsonb_typeof(ops) = 'array'"));
        builder.HasKey(row => new { row.TenantId, row.Id }).HasName("pk_site_activation");
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.Id).HasColumnName("id");
        builder.Property(row => row.SiteId).HasColumnName("site_id");
        builder.Property(row => row.JobId).HasColumnName("job_id");
        builder.Property(row => row.BuildId).HasColumnName("build_id");
        builder.Property(row => row.Reason).HasColumnName("reason").HasMaxLength(16).IsRequired();
        builder.Property(row => row.Generation).HasColumnName("generation");
        builder.Property(row => row.Ops).HasColumnName("ops").HasColumnType("jsonb").IsRequired();
        builder.Property(row => row.CreatedAt).HasColumnName("created_at");
        builder.Property(row => row.AppliedAt).HasColumnName("applied_at");

        builder.HasOne<Site>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.SiteId })
            .HasPrincipalKey(site => new { site.TenantId, site.Id })
            .HasConstraintName("fk_site_activation_site")
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<SiteBuild>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.BuildId })
            .HasPrincipalKey(build => new { build.TenantId, build.Id })
            .HasConstraintName("fk_site_activation_build")
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasIndex(row => new { row.TenantId, row.JobId }).IsUnique().HasDatabaseName("ux_site_activation_job");
        builder.HasIndex(row => new { row.TenantId, row.SiteId, row.Generation }).IsUnique()
            .HasDatabaseName("ux_site_activation_generation");
        builder.HasIndex(row => new { row.TenantId, row.BuildId }).HasDatabaseName("ix_site_activation_build");
    }
}

/// <summary>Maps <see cref="SiteOperatorGrant"/> to <c>site_operator</c>.</summary>
internal sealed class SiteOperatorGrantConfiguration : IEntityTypeConfiguration<SiteOperatorGrant>
{
    public void Configure(EntityTypeBuilder<SiteOperatorGrant> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.SiteOperator);
        builder.HasKey(row => new { row.TenantId, row.PrincipalId }).HasName("pk_site_operator");
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.PrincipalId).HasColumnName("principal_id");
        builder.Property(row => row.GrantedBy).HasColumnName("granted_by");
        builder.Property(row => row.GrantedAt).HasColumnName("granted_at");
        builder.HasOne<Principal>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.PrincipalId })
            .HasPrincipalKey(principal => new { principal.TenantId, principal.Id })
            .HasConstraintName("fk_site_operator_principal")
            .OnDelete(DeleteBehavior.Cascade);
    }
}
