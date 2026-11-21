using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Lets a pet use an OpenAI API key, stored like the other provider keys.</summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261121100000_PetProviderOpenAi")]
public sealed class PetProviderOpenAi : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        ALTER TABLE pet_provider_credential
            DROP CONSTRAINT pet_provider_credential_bounded,
            ADD CONSTRAINT pet_provider_credential_bounded CHECK (
                provider IN ('anthropic', 'openrouter', 'openai') AND octet_length(protected_key) <= 4096 AND char_length(key_hint) <= 8);
        """);

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        DELETE FROM pet_provider_credential WHERE provider = 'openai';
        ALTER TABLE pet_provider_credential
            DROP CONSTRAINT pet_provider_credential_bounded,
            ADD CONSTRAINT pet_provider_credential_bounded CHECK (
                provider IN ('anthropic', 'openrouter') AND octet_length(protected_key) <= 4096 AND char_length(key_hint) <= 8);
        """);
}
