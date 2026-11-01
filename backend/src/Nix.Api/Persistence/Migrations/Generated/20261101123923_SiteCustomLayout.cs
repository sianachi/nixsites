using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Nix.Persistence.Migrations.Generated
{
    /// <inheritdoc />
    public partial class SiteCustomLayout : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_site_bounded",
                table: "site");

            migrationBuilder.AddCheckConstraint(
                name: "ck_site_bounded",
                table: "site",
                sql: "slug ~ '^[a-z0-9](-?[a-z0-9]){1,39}$' AND layout IN ('docs', 'blog', 'custom') AND republish_mode IN ('manual', 'auto', 'on_release') AND status IN ('draft', 'published', 'unpublished') AND debounce_seconds BETWEEN 60 AND 3600 AND (republish_mode <> 'auto' OR auto_principal_id IS NOT NULL) AND (status = 'published') = (live_build_id IS NOT NULL) AND pg_column_size(settings) <= 16384 AND (primary_hostname IS NULL OR char_length(primary_hostname) BETWEEN 3 AND 253) AND (approval_state IS NULL OR approval_state IN ('pending', 'approved', 'rejected')) AND (approval_state IS NULL OR (approval_requested_by IS NOT NULL AND approval_requested_at IS NOT NULL)) AND (approval_note IS NULL OR char_length(approval_note) <= 500)");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_site_bounded",
                table: "site");

            migrationBuilder.AddCheckConstraint(
                name: "ck_site_bounded",
                table: "site",
                sql: "slug ~ '^[a-z0-9](-?[a-z0-9]){1,39}$' AND layout IN ('docs', 'blog') AND republish_mode IN ('manual', 'auto', 'on_release') AND status IN ('draft', 'published', 'unpublished') AND debounce_seconds BETWEEN 60 AND 3600 AND (republish_mode <> 'auto' OR auto_principal_id IS NOT NULL) AND (status = 'published') = (live_build_id IS NOT NULL) AND pg_column_size(settings) <= 16384 AND (primary_hostname IS NULL OR char_length(primary_hostname) BETWEEN 3 AND 253) AND (approval_state IS NULL OR approval_state IN ('pending', 'approved', 'rejected')) AND (approval_state IS NULL OR (approval_requested_by IS NOT NULL AND approval_requested_at IS NOT NULL)) AND (approval_note IS NULL OR char_length(approval_note) <= 500)");
        }
    }
}
