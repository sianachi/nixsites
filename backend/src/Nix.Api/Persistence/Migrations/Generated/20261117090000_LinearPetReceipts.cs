using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Records the pet named in a confirmed handoff and the resulting task comment, if any.</summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261117090000_LinearPetReceipts")]
public sealed class LinearPetReceipts : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        ALTER TABLE linear_task_request
            ADD COLUMN pet_id uuid,
            ADD COLUMN pet_name text,
            ADD COLUMN comment_id uuid,
            ADD CONSTRAINT linear_task_request_pet_metadata CHECK (
                (pet_id IS NULL AND pet_name IS NULL)
                OR (
                    pet_id IS NOT NULL AND pet_id <> '00000000-0000-0000-0000-000000000000'::uuid
                    AND pet_name IS NOT NULL AND btrim(pet_name) = pet_name
                    AND char_length(pet_name) BETWEEN 1 AND 80
                    AND requester_token_id IS NULL
                )
            ),
            ADD CONSTRAINT linear_task_request_pet_comment CHECK (
                comment_id IS NULL OR (
                    comment_id <> '00000000-0000-0000-0000-000000000000'::uuid
                    AND pet_id IS NOT NULL AND status = 'succeeded'
                )
            );
        """);

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        ALTER TABLE linear_task_request
            DROP CONSTRAINT linear_task_request_pet_comment,
            DROP CONSTRAINT linear_task_request_pet_metadata,
            DROP COLUMN comment_id,
            DROP COLUMN pet_name,
            DROP COLUMN pet_id;
        """);
}
