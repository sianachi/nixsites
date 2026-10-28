using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>[SEC] The nightly backup log keeps six months of runs: recording a run prunes older ones.</summary>
/// <remarks>
/// The cutoff is measured from the run being recorded rather than from <c>now()</c>, so a backfilled
/// or test run prunes relative to its own date; nightly runs record the current time, so the two
/// agree in production. The prune runs before the insert, so the recorded run always remains.
/// Signature, owner, grants and <c>search_path</c> are unchanged; only the body is replaced.
/// </remarks>
[DbContext(typeof(NixDbContext))]
[Migration("20261028140000_BackupRunRetention")]
public sealed class BackupRunRetention : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        CREATE OR REPLACE FUNCTION nix_record_backup_run(
            p_started_at timestamptz, p_finished_at timestamptz, p_step text, p_status text,
            p_snapshot_id text, p_bytes bigint, p_error text)
        RETURNS void
        LANGUAGE sql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog, public, pg_temp
        AS $function$
            DELETE FROM public.backup_runs WHERE started_at < p_started_at - interval '6 months';
            INSERT INTO public.backup_runs (started_at, finished_at, step, status, snapshot_id, bytes, error)
            VALUES (p_started_at, p_finished_at, p_step, p_status,
                    NULLIF(p_snapshot_id, ''), p_bytes, NULLIF(p_error, ''));
        $function$;
        """);

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        CREATE OR REPLACE FUNCTION nix_record_backup_run(
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
        """);
}
