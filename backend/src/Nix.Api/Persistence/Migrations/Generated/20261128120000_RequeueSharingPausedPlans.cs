using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>
/// Plan runs that stopped in <c>waiting_for_input</c> to ask the removed sharing question have nothing left to answer.
/// Each is queued again with a new plan job, as if the question had been approved, since saving a provider key is the consent now.
/// </summary>
/// <remarks>Hand-written; both tables are read and written with raw SQL. Down cannot restore the question, so it does nothing.</remarks>
[DbContext(typeof(NixDbContext))]
[Migration("20261128120000_RequeueSharingPausedPlans")]
public sealed class RequeueSharingPausedPlans : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        ArgumentNullException.ThrowIfNull(migrationBuilder);
        // The job's key and payload are the ones PetRunService.QueueJobAsync writes for a plan run at revision + 1.
        migrationBuilder.Sql("""
            WITH stranded AS (
                SELECT id, tenant_id, workspace_id, actor_id, revision, gen_random_uuid() AS job_id
                  FROM pet_run
                 WHERE status = 'waiting_for_input' AND request_id IS NOT NULL
                   AND (jsonb_typeof(state -> 'sharingQuestion') = 'object' OR state -> 'failure' ->> 'code' = 'pet_plans.sharing_required')
            ), queued AS (
                INSERT INTO worker_job (job_id, tenant_id, workspace_id, actor_id, kind, idempotency_key, payload, status, attempts, cancellation_requested, created_at, updated_at)
                SELECT job_id, tenant_id, workspace_id, actor_id, 'pet.plan.advance',
                       'pet-run:' || replace(id::text, '-', '') || ':' || (revision + 1)::text,
                       jsonb_build_object('runId', id), 'queued', 0, false, clock_timestamp(), clock_timestamp()
                  FROM stranded
                RETURNING job_id
            )
            UPDATE pet_run run
               SET status = 'queued', revision = run.revision + 1, updated_at = greatest(run.created_at, clock_timestamp()),
                   state = (run.state - 'sharingQuestion') || jsonb_build_object('activeJobId', stranded.job_id, 'failure', NULL)
              FROM stranded
             WHERE run.id = stranded.id;
            """);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) => ArgumentNullException.ThrowIfNull(migrationBuilder);
}
