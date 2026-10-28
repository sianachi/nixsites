using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>Adds the instance-wide nightly backup log, reachable only through two definer functions.</summary>
/// <remarks>
/// The <c>nix_backup</c> role is cluster-level, so the deploy seed creates it (and Compose's deploy
/// script, idempotently); the grants below fail loudly when it is missing. Retention (six months,
/// pruned by the writer) arrives in <see cref="BackupRunRetention"/>.
/// </remarks>
[DbContext(typeof(NixDbContext))]
[Migration("20261014190000_BackupRuns")]
public sealed class BackupRuns : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        CREATE TABLE backup_runs (
            id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            started_at  timestamptz NOT NULL,
            finished_at timestamptz NOT NULL,
            step        text NOT NULL CHECK (step IN ('local', 'offsite')),
            status      text NOT NULL CHECK (status IN ('succeeded', 'failed')),
            snapshot_id text CHECK (snapshot_id ~ '^[0-9a-f]{8,64}$'),
            bytes       bigint CHECK (bytes >= 0),
            error       text CHECK (char_length(error) BETWEEN 1 AND 300),
            CHECK (finished_at >= started_at),
            CHECK ((status = 'failed') = (error IS NOT NULL))
        );
        CREATE INDEX backup_runs_started_at ON backup_runs (started_at DESC);
        ALTER TABLE backup_runs ENABLE ROW LEVEL SECURITY;
        ALTER TABLE backup_runs FORCE ROW LEVEL SECURITY;
        -- Default privileges handed nix_app full DML; take it back. No policies on purpose.
        REVOKE ALL ON backup_runs FROM PUBLIC, nix_app, nix_collab;
        GRANT USAGE ON SCHEMA public TO nix_backup;

        CREATE FUNCTION nix_record_backup_run(
            p_started_at timestamptz, p_finished_at timestamptz, p_step text, p_status text,
            p_snapshot_id text, p_bytes bigint, p_error text)
        RETURNS void
        LANGUAGE sql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog, public, pg_temp
        AS $function$
            INSERT INTO public.backup_runs (started_at, finished_at, step, status, snapshot_id, bytes, error)
            VALUES (p_started_at, p_finished_at, p_step, p_status,
                    NULLIF(p_snapshot_id, ''), p_bytes, NULLIF(p_error, ''));
        $function$;
        REVOKE ALL ON FUNCTION nix_record_backup_run(timestamptz, timestamptz, text, text, text, bigint, text) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION nix_record_backup_run(timestamptz, timestamptz, text, text, text, bigint, text) TO nix_backup;

        CREATE FUNCTION nix_backup_runs(p_limit integer)
        RETURNS TABLE (id uuid, started_at timestamptz, finished_at timestamptz, step text,
                       status text, snapshot_id text, bytes bigint, error text)
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog, public, pg_temp
        AS $function$
            SELECT r.id, r.started_at, r.finished_at, r.step, r.status, r.snapshot_id, r.bytes, r.error
              FROM public.backup_runs r
             ORDER BY r.started_at DESC, r.id
             LIMIT least(greatest(coalesce(p_limit, 1), 1), 100);
        $function$;
        REVOKE ALL ON FUNCTION nix_backup_runs(integer) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION nix_backup_runs(integer) TO nix_app;
        """);

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        DROP FUNCTION nix_backup_runs(integer);
        DROP FUNCTION nix_record_backup_run(timestamptz, timestamptz, text, text, text, bigint, text);
        DROP TABLE backup_runs;
        """);
}
