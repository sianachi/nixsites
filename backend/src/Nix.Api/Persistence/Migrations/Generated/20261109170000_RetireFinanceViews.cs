using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>
/// Retires the finance view kind: every stored view of kind <c>finance</c> becomes a <c>sheet</c>
/// view, so a container that held one still opens after the upgrade.
/// </summary>
/// <remarks>
/// <para>
/// Hand-written (the Design package is not referenced); the model is unchanged, so the snapshot is
/// too. Only <c>item.views</c> is rewritten: the view's id, name, columns and order are kept and
/// only <c>kind</c> changes. Finance items and their <c>$fin_</c> properties are not touched.
/// </para>
/// <para>
/// Runs as the migrator, which holds <c>BYPASSRLS</c>, and adds no table, grant or policy. The
/// numeric enum value 12 stays retired in the C# <c>ViewKind</c>: views are stored as text, so
/// nothing is renumbered. Down is a no-op because the rewritten views are indistinguishable from
/// sheet views the owner made.
/// </para>
/// </remarks>
[DbContext(typeof(NixDbContext))]
[Migration("20261109170000_RetireFinanceViews")]
public sealed class RetireFinanceViews : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        ArgumentNullException.ThrowIfNull(migrationBuilder);
        migrationBuilder.Sql("""
            UPDATE item
            SET views = jsonb_set(
                views,
                '{views}',
                (SELECT jsonb_agg(
                            CASE WHEN entry.value ->> 'kind' = 'finance'
                                 THEN jsonb_set(entry.value, '{kind}', '"sheet"')
                                 ELSE entry.value END
                            ORDER BY entry.ordinality)
                 FROM jsonb_array_elements(views -> 'views') WITH ORDINALITY AS entry(value, ordinality)))
            WHERE jsonb_typeof(views -> 'views') = 'array'
              AND EXISTS (SELECT 1
                          FROM jsonb_array_elements(views -> 'views') AS entry(value)
                          WHERE entry.value ->> 'kind' = 'finance');
            """);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
    }
}
