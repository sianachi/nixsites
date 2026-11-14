using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>
/// Adds the per-item settings column and the workspace defaults new items start with.
/// </summary>
/// <remarks>
/// <para>
/// Hand-written (the Design package is not referenced); the model snapshot was edited by hand.
/// Both columns are nullable JSON objects: null is every switch off, so no existing row changes
/// meaning except the one below.
/// </para>
/// <para>
/// A note that already has a comment thread gets <c>comments</c> on, so its threads do not
/// disappear when comments become opt-in. Every existing file gets <c>reviewStates</c> on, so a public
/// note keeps serving only its approved version instead of the newest upload. Runs as the migrator, which holds BYPASSRLS, and adds
/// no table, grant or policy: both columns sit on tables that already carry row security.
/// </para>
/// </remarks>
[DbContext(typeof(NixDbContext))]
[Migration("20261113120000_AddItemSettings")]
public sealed class AddItemSettings : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        ArgumentNullException.ThrowIfNull(migrationBuilder);

        migrationBuilder.Sql("""
            ALTER TABLE item
                ADD COLUMN settings jsonb,
                ADD CONSTRAINT ck_item_settings CHECK (settings IS NULL OR jsonb_typeof(settings) = 'object');
            ALTER TABLE workspace
                ADD COLUMN item_defaults jsonb,
                ADD CONSTRAINT ck_workspace_item_defaults CHECK (item_defaults IS NULL OR jsonb_typeof(item_defaults) = 'object');
            UPDATE item
               SET settings = jsonb_build_object('comments', true)
             WHERE EXISTS (SELECT 1 FROM note_comment c WHERE c.tenant_id = item.tenant_id AND c.item_id = item.id);
            UPDATE item
               SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('reviewStates', true)
             WHERE type = 'file';
            """);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        ArgumentNullException.ThrowIfNull(migrationBuilder);
        migrationBuilder.Sql("""
            ALTER TABLE workspace DROP CONSTRAINT ck_workspace_item_defaults, DROP COLUMN item_defaults;
            ALTER TABLE item DROP CONSTRAINT ck_item_settings, DROP COLUMN settings;
            """);
    }
}
