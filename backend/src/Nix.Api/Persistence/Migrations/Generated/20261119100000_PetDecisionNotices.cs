using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Adds a typed pet decision target to the existing private inbox.</summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261119100000_PetDecisionNotices")]
public sealed class PetDecisionNotices : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        ALTER TABLE notification
            ADD COLUMN pet_run_id uuid,
            ADD COLUMN pet_decision_id uuid,
            ADD COLUMN pet_decision_is_question boolean,
            ADD CONSTRAINT notification_pet_decision CHECK (
                (pet_run_id IS NULL AND pet_decision_id IS NULL AND pet_decision_is_question IS NULL)
                OR (pet_run_id IS NOT NULL AND pet_decision_id IS NOT NULL AND pet_decision_is_question IS NOT NULL
                    AND kind = 'system' AND item_id IS NOT NULL AND workspace_id IS NOT NULL));
        """);

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        ALTER TABLE notification
            DROP CONSTRAINT notification_pet_decision,
            DROP COLUMN pet_run_id,
            DROP COLUMN pet_decision_id,
            DROP COLUMN pet_decision_is_question;
        """);
}
