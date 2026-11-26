using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>
/// One row per finished pet turn: tokens and an estimated cost, private to the person who spent
/// them, kept 13 months. The purge function runs from the retention loop.
/// </summary>
/// <remarks>Hand-written; the table is read and written with raw SQL, so the model snapshot does not change.</remarks>
[DbContext(typeof(NixDbContext))]
[Migration("20261126110000_PetUsage")]
public sealed class PetUsage : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        ArgumentNullException.ThrowIfNull(migrationBuilder);
        migrationBuilder.Sql("""
            CREATE TABLE pet_usage (
                id uuid PRIMARY KEY, tenant_id uuid NOT NULL, principal_id uuid NOT NULL, pet_id uuid NOT NULL,
                workspace_id uuid,
                provider text NOT NULL CHECK (provider IN ('anthropic', 'openrouter')),
                model text NOT NULL CHECK (length(model) <= 160),
                source text NOT NULL CHECK (length(source) BETWEEN 1 AND 100),
                input_tokens bigint NOT NULL CHECK (input_tokens >= 0),
                cache_read_tokens bigint NOT NULL CHECK (cache_read_tokens >= 0),
                cache_write_tokens bigint NOT NULL CHECK (cache_write_tokens >= 0),
                output_tokens bigint NOT NULL CHECK (output_tokens >= 0),
                cost_usd numeric(14, 6) CHECK (cost_usd >= 0),
                started_at timestamptz NOT NULL,
                duration_ms integer NOT NULL CHECK (duration_ms >= 0),
                FOREIGN KEY (tenant_id, principal_id) REFERENCES principal(tenant_id, principal_id) ON DELETE CASCADE
            );
            CREATE INDEX ix_pet_usage_person ON pet_usage(tenant_id, principal_id, started_at DESC);
            CREATE INDEX ix_pet_usage_age ON pet_usage(started_at);
            ALTER TABLE pet_usage ENABLE ROW LEVEL SECURITY;
            ALTER TABLE pet_usage FORCE ROW LEVEL SECURITY;
            CREATE POLICY pet_usage_owner ON pet_usage USING (
                tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            ) WITH CHECK (
                tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            );
            REVOKE ALL ON pet_usage FROM PUBLIC, nix_app;
            GRANT SELECT, INSERT ON pet_usage TO nix_app;

            CREATE OR REPLACE FUNCTION nix_purge_pet_usage(p_limit integer)
            RETURNS integer
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
            DECLARE
                v_rows integer;
            BEGIN
                IF p_limit NOT BETWEEN 1 AND 10000 THEN
                    RAISE EXCEPTION 'invalid pet-usage purge limit';
                END IF;

                WITH doomed AS (
                    SELECT usage.id
                      FROM public.pet_usage usage
                     WHERE usage.started_at < clock_timestamp() - interval '13 months'
                     ORDER BY usage.started_at
                     LIMIT p_limit
                       FOR UPDATE SKIP LOCKED
                )
                DELETE FROM public.pet_usage target
                 USING doomed
                 WHERE target.id = doomed.id;
                GET DIAGNOSTICS v_rows = ROW_COUNT;
                RETURN v_rows;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_purge_pet_usage(integer) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_purge_pet_usage(integer) TO nix_app;
            """);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        ArgumentNullException.ThrowIfNull(migrationBuilder);
        migrationBuilder.Sql("""
            DROP FUNCTION IF EXISTS nix_purge_pet_usage(integer);
            DROP TABLE pet_usage;
            """);
    }
}
