using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Switches comments on for the notes under an item that has a board view.</summary>
/// <remarks>
/// A board's cards open on their conversation. Only notes whose settings carry no comments value
/// change, so a note someone switched off stays off. Data only: the model snapshot is unchanged.
/// </remarks>
[DbContext(typeof(NixDbContext))]
[Migration("20261121120000_BoardCardComments")]
public sealed class BoardCardComments : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        UPDATE item c
        SET settings = COALESCE(c.settings, jsonb_build_object()) || jsonb_build_object('comments', true)
        FROM item p
        WHERE p.tenant_id = c.tenant_id AND p.id = c.parent_id AND c.type = 'note'
          AND jsonb_path_exists(p.views, '$.views[*] ? (@.kind == "board")')
          AND NOT jsonb_exists(COALESCE(c.settings, jsonb_build_object()), 'comments');
        """);

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        // Nothing to undo: the switch is ordinary item data once set.
    }
}
