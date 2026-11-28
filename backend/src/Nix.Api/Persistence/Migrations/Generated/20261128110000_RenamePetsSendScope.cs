using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>
/// Renames the token scope <c>pets:send</c> to <c>agents</c> in every stored token, so existing tokens keep working
/// under the one name the code knows.
/// </summary>
/// <remarks>Hand-written; the column is unchanged, so the model snapshot does not change.</remarks>
[DbContext(typeof(NixDbContext))]
[Migration("20261128110000_RenamePetsSendScope")]
public sealed class RenamePetsSendScope : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        ArgumentNullException.ThrowIfNull(migrationBuilder);
        migrationBuilder.Sql("UPDATE personal_access_token SET scopes = array_replace(scopes, 'pets:send', 'agents') WHERE 'pets:send' = ANY(scopes);");
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        ArgumentNullException.ThrowIfNull(migrationBuilder);
        migrationBuilder.Sql("UPDATE personal_access_token SET scopes = array_replace(scopes, 'agents', 'pets:send') WHERE 'agents' = ANY(scopes);");
    }
}
