namespace Nix.Persistence.Migrations;

/// <summary>
/// The in-process workers' additions to the dispatch SQL: a lease that honours an
/// <c>object.cleanup</c> job's <c>notBefore</c> (the delay used to live on its RabbitMQ hint),
/// the startup sweep's <c>nix_interrupt_worker_jobs</c>, and the one-shot push hand-out column.
/// </summary>
public static class InProcessWorkersSecuritySql
{
    private const string ApplicationRole = "nix_app";

    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit($$"""
            ALTER TABLE notification ADD COLUMN IF NOT EXISTS push_attempted_at timestamptz;

            CREATE OR REPLACE FUNCTION nix_lease_worker_jobs(
                p_kind text,
                p_owner text,
                p_limit integer,
                p_lease_seconds integer)
            RETURNS TABLE (
                job_id uuid,
                tenant_id uuid,
                workspace_id uuid,
                actor_id uuid,
                kind text,
                payload jsonb,
                attempts integer,
                cancellation_requested boolean)
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
            BEGIN
                IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 128
                   OR p_owner ~ '[[:cntrl:]]'
                   OR p_limit NOT BETWEEN 1 AND 100
                   OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
                    RAISE EXCEPTION 'invalid worker lease request';
                END IF;

                UPDATE worker_job cancelled
                   SET status = 'cancelled',
                       result = NULL,
                       error_code = 'job_cancelled',
                       error_detail = 'The job was cancelled.',
                       lease_owner = NULL,
                       lease_until = NULL,
                       completed_at = COALESCE(cancelled.completed_at, clock_timestamp()),
                       updated_at = clock_timestamp()
                 WHERE cancelled.status IN ('queued', 'running')
                   AND cancelled.cancellation_requested = true;

                UPDATE worker_job exhausted
                   SET status = 'failed',
                       result = NULL,
                       error_code = 'worker_attempts_exhausted',
                       error_detail = 'The worker exhausted its five execution attempts without reporting a terminal result.',
                       lease_owner = NULL,
                       lease_until = NULL,
                       completed_at = COALESCE(exhausted.completed_at, clock_timestamp()),
                       updated_at = clock_timestamp()
                 WHERE exhausted.status = 'running'
                   AND exhausted.cancellation_requested = false
                   AND exhausted.attempts >= 5
                   AND COALESCE(exhausted.lease_until, '-infinity'::timestamptz)
                       <= clock_timestamp();

                RETURN QUERY
                WITH candidates AS (
                    SELECT queued.job_id
                      FROM worker_job queued
                     WHERE (p_kind IS NULL OR queued.kind = p_kind)
                       AND queued.cancellation_requested = false
                       AND queued.attempts < 5
                       AND (queued.status = 'queued'
                            OR (queued.status = 'running'
                                AND queued.lease_until <= clock_timestamp()))
                       -- An object cleanup waits for its retention boundary; the delay used to sit
                       -- on the broker hint, now it is read from the job itself.
                       AND (queued.kind <> 'object.cleanup'
                            OR COALESCE((queued.payload ->> 'notBefore')::timestamptz, '-infinity'::timestamptz)
                               <= clock_timestamp())
                     ORDER BY queued.created_at, queued.job_id
                     FOR UPDATE SKIP LOCKED
                     LIMIT p_limit
                )
                UPDATE worker_job leased
                   SET status = 'running',
                       attempts = leased.attempts + 1,
                       lease_owner = p_owner,
                       lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
                       started_at = COALESCE(leased.started_at, clock_timestamp()),
                       updated_at = clock_timestamp()
                  FROM candidates
                 WHERE leased.job_id = candidates.job_id
                RETURNING leased.job_id,
                          leased.tenant_id,
                          leased.workspace_id,
                          leased.actor_id,
                          leased.kind::text,
                          leased.payload,
                          leased.attempts,
                          leased.cancellation_requested;
            END
            $function$;

            CREATE OR REPLACE FUNCTION nix_interrupt_worker_jobs(
                p_owner_prefix text,
                p_kinds text[],
                p_error_code text)
            RETURNS TABLE (
                job_id uuid,
                tenant_id uuid,
                workspace_id uuid,
                actor_id uuid,
                kind text,
                payload jsonb,
                attempts integer,
                cancellation_requested boolean)
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
            BEGIN
                IF p_owner_prefix IS NULL OR length(p_owner_prefix) NOT BETWEEN 1 AND 128
                   OR p_owner_prefix ~ '[[:cntrl:]]'
                   OR p_kinds IS NULL OR cardinality(p_kinds) = 0
                   OR p_error_code IS NULL OR p_error_code !~ '^[a-z_]{1,64}$' THEN
                    RAISE EXCEPTION 'invalid worker interrupt request';
                END IF;

                -- Only this instance's own running executions: a replica's live lease, a queued
                -- row and a delayed retry (running, lease lapsed, owner cleared) are all left alone.
                RETURN QUERY
                UPDATE worker_job interrupted
                   SET status = 'failed',
                       result = NULL,
                       error_code = p_error_code,
                       error_detail = 'The worker was restarted before the job finished. Try again.',
                       lease_owner = NULL,
                       lease_until = NULL,
                       completed_at = clock_timestamp(),
                       updated_at = clock_timestamp()
                 WHERE interrupted.status = 'running'
                   AND interrupted.lease_owner IS NOT NULL
                   AND left(interrupted.lease_owner, length(p_owner_prefix)) = p_owner_prefix
                   AND interrupted.kind = ANY (p_kinds)
                RETURNING interrupted.job_id,
                          interrupted.tenant_id,
                          interrupted.workspace_id,
                          interrupted.actor_id,
                          interrupted.kind::text,
                          interrupted.payload,
                          interrupted.attempts,
                          interrupted.cancellation_requested;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_interrupt_worker_jobs(text, text[], text) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_interrupt_worker_jobs(text, text[], text) TO {{ApplicationRole}};
            """);
    }

    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("DROP FUNCTION IF EXISTS nix_interrupt_worker_jobs(text, text[], text);");
        // The lease function keeps the notBefore predicate on the way down: without it an in-flight
        // cleanup would run early, and the predicate is harmless for a broker-driven worker.
        emit("ALTER TABLE notification DROP COLUMN IF EXISTS push_attempted_at;");
    }
}
