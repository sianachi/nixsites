using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Drops <c>nix_complete_worker_job</c>, which nothing calls any more.</summary>
/// <remarks>No schema change, so the model snapshot is untouched. Grants go with the function.</remarks>
[DbContext(typeof(NixDbContext))]
[Migration("20261030130000_DropUnusedCompleteWorkerJob")]
public sealed class DropUnusedCompleteWorkerJob : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) =>
        migrationBuilder.Sql("DROP FUNCTION IF EXISTS nix_complete_worker_job(uuid, text, boolean, jsonb, text, text);");

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) =>
        // Same body as WorkerDispatchFunctions, with pg_temp pinned last as the later sweeps require.
        migrationBuilder.Sql("""
            CREATE FUNCTION nix_complete_worker_job(
                p_job_id uuid,
                p_owner text,
                p_succeeded boolean,
                p_result jsonb,
                p_error_code text,
                p_error_detail text)
            RETURNS boolean
            LANGUAGE sql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
                UPDATE worker_job
                   SET status = CASE WHEN p_succeeded THEN 'completed' ELSE 'failed' END,
                       result = p_result,
                       error_code = left(p_error_code, 64),
                       error_detail = left(p_error_detail, 2000),
                       lease_owner = NULL,
                       lease_until = NULL,
                       completed_at = clock_timestamp(),
                       updated_at = clock_timestamp()
                 WHERE job_id = p_job_id
                   AND status = 'running'
                   AND lease_owner = p_owner
                   AND lease_until >= clock_timestamp()
                RETURNING true
            $function$;

            REVOKE ALL ON FUNCTION nix_complete_worker_job(uuid, text, boolean, jsonb, text, text) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_complete_worker_job(uuid, text, boolean, jsonb, text, text) TO nix_app;
            """);
}
