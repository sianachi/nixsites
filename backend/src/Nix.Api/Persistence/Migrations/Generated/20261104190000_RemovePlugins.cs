using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>
/// Removes the WebAssembly plugin feature: its seven tables, the three SECURITY DEFINER
/// functions the plugin worker called, and the policies and grants on those tables. Objects
/// under <c>plugins/components/</c> in storage are left for the operator to purge.
/// </summary>
/// <remarks>
/// Hand-written (the Design package is not referenced); the model snapshot was edited by hand
/// to drop the seven entities. Down replays the two plugin migrations' operations so a walk
/// back through history (the migration tests do one) finds the relations their own Down needs.
/// </remarks>
[DbContext(typeof(NixDbContext))]
[Migration("20261104190000_RemovePlugins")]
public sealed class RemovePlugins : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("""
            DROP FUNCTION IF EXISTS nix_complete_plugin_invocation(uuid, boolean, boolean, text, text, bytea);
            DROP FUNCTION IF EXISTS nix_plugin_read_item_metadata(uuid, uuid);
            DROP FUNCTION IF EXISTS nix_prepare_plugin_event(uuid, uuid, uuid, uuid, text, bigint, uuid, integer, integer);
            DROP TABLE IF EXISTS plugin_capability_grant;
            DROP TABLE IF EXISTS plugin_invocation;
            DROP TABLE IF EXISTS plugin_event_inbox;
            DROP TABLE IF EXISTS plugin_event_receipt;
            DROP TABLE IF EXISTS plugin_installation;
            DROP TABLE IF EXISTS plugin_component;
            DROP TABLE IF EXISTS plugin_publisher;
            """);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        ArgumentNullException.ThrowIfNull(migrationBuilder);
        foreach (var operation in new PluginEventRuntime().UpOperations)
        {
            migrationBuilder.Operations.Add(operation);
        }
        foreach (var operation in new PluginMetadataLockFilter().UpOperations)
        {
            migrationBuilder.Operations.Add(operation);
        }
    }
}
