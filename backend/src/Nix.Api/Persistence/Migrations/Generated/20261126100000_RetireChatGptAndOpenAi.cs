using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>
/// Retires the linked ChatGPT account and the OpenAI API-key provider. A pet profile that is on
/// either, or on none, moves to the person's Anthropic key, else their OpenRouter key, else
/// Anthropic (the pet then asks for a key and does nothing else). Stored OpenAI keys go.
/// </summary>
/// <remarks>
/// Hand-written; the model snapshot only changes the provider check. Runs as the migrator, which
/// holds <c>BYPASSRLS</c>. The ChatGPT sign-in itself lives in the companion's data directory,
/// which the companion clears. Down widens the check again; deleted keys and moved profiles are not restored.
/// </remarks>
[DbContext(typeof(NixDbContext))]
[Migration("20261126100000_RetireChatGptAndOpenAi")]
public sealed class RetireChatGptAndOpenAi : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        ArgumentNullException.ThrowIfNull(migrationBuilder);
        migrationBuilder.Sql("""
            UPDATE pet_preferences p
               SET settings = jsonb_set(p.settings, '{profiles}', (
                       SELECT COALESCE(jsonb_agg(
                                  CASE WHEN profile->>'provider' IN ('anthropic', 'openrouter') THEN profile
                                       ELSE jsonb_set(profile, '{provider}', to_jsonb(
                                           CASE WHEN EXISTS (SELECT 1 FROM pet_provider_credential c
                                                              WHERE c.tenant_id = p.tenant_id AND c.principal_id = p.principal_id AND c.provider = 'anthropic')
                                                THEN 'anthropic'
                                                WHEN EXISTS (SELECT 1 FROM pet_provider_credential c
                                                              WHERE c.tenant_id = p.tenant_id AND c.principal_id = p.principal_id AND c.provider = 'openrouter')
                                                THEN 'openrouter'
                                                ELSE 'anthropic' END)) END
                                  ORDER BY ordinal), '[]'::jsonb)
                         FROM jsonb_array_elements(p.settings->'profiles') WITH ORDINALITY AS entry(profile, ordinal))),
                   revision = p.revision + 1
             WHERE jsonb_typeof(p.settings->'profiles') = 'array'
               AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.settings->'profiles') AS entry(profile)
                            WHERE COALESCE(profile->>'provider', '') NOT IN ('anthropic', 'openrouter'));

            DELETE FROM pet_provider_credential WHERE provider = 'openai';
            ALTER TABLE pet_provider_credential
                DROP CONSTRAINT pet_provider_credential_bounded,
                ADD CONSTRAINT pet_provider_credential_bounded CHECK (
                    provider IN ('anthropic', 'openrouter') AND octet_length(protected_key) <= 4096 AND char_length(key_hint) <= 8);
            """);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        ArgumentNullException.ThrowIfNull(migrationBuilder);
        migrationBuilder.Sql("""
            ALTER TABLE pet_provider_credential
                DROP CONSTRAINT pet_provider_credential_bounded,
                ADD CONSTRAINT pet_provider_credential_bounded CHECK (
                    provider IN ('anthropic', 'openrouter', 'openai') AND octet_length(protected_key) <= 4096 AND char_length(key_hint) <= 8);
            """);
    }
}
