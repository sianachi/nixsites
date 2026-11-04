namespace Nix.Persistence.Migrations;

/// <summary>
/// Drops the <c>worker_outbox_event</c> table and everything that only fed it: the search-index
/// triggers and queue functions, the outbox lease functions, and the outbox inserts inside the
/// result and export-cleanup functions (a retry or a cleanup job is simply a leasable <c>worker_job</c>).
/// </summary>
public static class RemoveWorkerOutboxSecuritySql
{
    private const string ApplicationRole = "nix_app";

    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            DROP TRIGGER IF EXISTS acl_entry_search_outbox ON acl_entry;
            DROP TRIGGER IF EXISTS item_search_body_outbox ON item_search;
            DROP TRIGGER IF EXISTS item_search_metadata_outbox ON item;
            DROP TRIGGER IF EXISTS item_lock_search_outbox ON item_lock;
            DROP TRIGGER IF EXISTS worker_outbox_search_version ON worker_outbox_event;
            DROP FUNCTION IF EXISTS nix_queue_permission_search_event();
            DROP FUNCTION IF EXISTS nix_queue_body_search_event();
            DROP FUNCTION IF EXISTS nix_queue_item_search_event();
            DROP FUNCTION IF EXISTS nix_queue_lock_search_event();
            DROP FUNCTION IF EXISTS nix_assign_search_index_version();
            DROP FUNCTION IF EXISTS nix_search_index_outbox_status();
            DROP FUNCTION IF EXISTS nix_enqueue_search_rebuild_page(uuid, uuid, timestamptz, integer);
            DROP FUNCTION IF EXISTS nix_lease_worker_outbox(text, text, integer, integer);
            DROP FUNCTION IF EXISTS nix_finish_worker_outbox(uuid, text, boolean, text);
            DROP FUNCTION IF EXISTS nix_finish_worker_job(uuid, text, boolean, boolean, jsonb, text, text);
            """);
        emit($$"""
            CREATE OR REPLACE FUNCTION nix_schedule_export_result_cleanup(p_job_id uuid)
            RETURNS boolean
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
            DECLARE
                source worker_job%ROWTYPE;
                cleanup worker_job%ROWTYPE;
                cleanup_job_id uuid;
                cleanup_key text;
                cleanup_at timestamptz;
                cleanup_payload jsonb;
                extension text;
                attempt_id text;
            BEGIN
                SELECT job.*
                  INTO source
                  FROM worker_job job
                 WHERE job.job_id = p_job_id
                   AND job.status = 'completed'
                   AND job.kind LIKE 'export.%'
                   AND job.actor_id IS NOT NULL
                   AND job.workspace_id IS NOT NULL
                   AND job.completed_at IS NOT NULL
                 FOR UPDATE;

                IF NOT FOUND THEN
                    RETURN false;
                END IF;

                extension := source.payload ->> 'extension';
                IF extension IS NULL OR extension !~ '^[a-z0-9]{1,16}$' THEN
                    RETURN false;
                END IF;

                attempt_id := source.result ->> 'attemptId';
                IF attempt_id IS NULL
                   OR attempt_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                    RETURN false;
                END IF;

                cleanup_key := 'exports/results/' || source.tenant_id::text || '/'
                    || source.job_id::text || '/' || attempt_id || '.' || extension;
                IF source.result ->> 'objectKey' IS DISTINCT FROM cleanup_key THEN
                    RETURN false;
                END IF;

                cleanup_at := source.completed_at + interval '24 hours';
                cleanup_payload := jsonb_build_object(
                    'ownerKind', 'export',
                    'ownerId', source.job_id,
                    'notBefore', cleanup_at,
                    'objectKeys', jsonb_build_array(cleanup_key));

                SELECT existing.*
                  INTO cleanup
                  FROM worker_job existing
                 WHERE existing.tenant_id = source.tenant_id
                   AND existing.actor_id = source.actor_id
                   AND existing.idempotency_key = 'object.cleanup:export:' || source.job_id::text
                 FOR UPDATE;

                IF NOT FOUND THEN
                    cleanup_job_id := gen_random_uuid();
                    INSERT INTO worker_job (
                        job_id,
                        tenant_id,
                        workspace_id,
                        actor_id,
                        kind,
                        idempotency_key,
                        payload,
                        status,
                        attempts,
                        cancellation_requested,
                        created_at,
                        updated_at)
                    VALUES (
                        cleanup_job_id,
                        source.tenant_id,
                        source.workspace_id,
                        source.actor_id,
                        'object.cleanup',
                        'object.cleanup:export:' || source.job_id::text,
                        cleanup_payload,
                        'queued',
                        0,
                        false,
                        clock_timestamp(),
                        clock_timestamp());
                ELSE
                    cleanup_job_id := cleanup.job_id;
                    IF cleanup.kind IS DISTINCT FROM 'object.cleanup'
                       OR cleanup.workspace_id IS DISTINCT FROM source.workspace_id
                       OR cleanup.payload IS DISTINCT FROM cleanup_payload THEN
                        RETURN false;
                    END IF;

                    IF cleanup.status = 'completed' THEN
                        RETURN true;
                    END IF;

                    IF cleanup.status IN ('failed', 'cancelled') THEN
                        UPDATE worker_job repair
                           SET status = 'queued',
                               attempts = 0,
                               cancellation_requested = false,
                               result = NULL,
                               error_code = NULL,
                               error_detail = NULL,
                               lease_owner = NULL,
                               lease_until = NULL,
                               started_at = NULL,
                               completed_at = NULL,
                               updated_at = clock_timestamp()
                         WHERE repair.job_id = cleanup_job_id;
                    END IF;
                END IF;

                RETURN true;
            END
            $function$;
            CREATE OR REPLACE FUNCTION nix_apply_worker_result(
                p_job_id uuid,
                p_owner text,
                p_succeeded boolean,
                p_retryable boolean,
                p_result jsonb,
                p_error_code text,
                p_error_detail text,
                p_expected_export_attempt uuid)
            RETURNS TABLE (
                outcome text,
                requires_export_cleanup boolean)
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
            DECLARE
                current_job worker_job%ROWTYPE;
                changed worker_job%ROWTYPE;
                retry_delay integer;
                export_valid boolean := true;
                expected_key text;
            BEGIN
                IF p_job_id IS NULL
                   OR p_job_id = '00000000-0000-0000-0000-000000000000'::uuid
                   OR p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 128
                   OR p_owner ~ '[[:cntrl:]]' THEN
                    RETURN QUERY SELECT 'invalid_request'::text, false;
                    RETURN;
                END IF;

                SELECT job.*
                  INTO current_job
                  FROM worker_job job
                 WHERE job.job_id = p_job_id
                 FOR UPDATE;

                IF NOT FOUND THEN
                    RETURN QUERY SELECT 'not_found'::text, false;
                    RETURN;
                END IF;

                IF current_job.status = 'completed'
                   AND p_succeeded
                   AND current_job.result IS NOT DISTINCT FROM p_result
                   AND (current_job.kind NOT LIKE 'export.%'
                        OR (p_expected_export_attempt IS NOT NULL
                            AND current_job.result ->> 'attemptId'
                                = p_expected_export_attempt::text)) THEN
                    IF current_job.kind LIKE 'export.%'
                       AND NOT nix_schedule_export_result_cleanup(current_job.job_id) THEN
                        RAISE EXCEPTION 'completed export cleanup could not be repaired';
                    END IF;
                    RETURN QUERY SELECT
                        'already_completed'::text,
                        current_job.kind LIKE 'export.%';
                    RETURN;
                END IF;

                IF current_job.status IN ('completed', 'failed', 'cancelled') THEN
                    RETURN QUERY SELECT 'already_terminal'::text, false;
                    RETURN;
                END IF;

                IF current_job.status IS DISTINCT FROM 'running'
                   OR current_job.lease_owner IS DISTINCT FROM p_owner THEN
                    RETURN QUERY SELECT 'stale_execution'::text, false;
                    RETURN;
                END IF;

                -- A committed cancellation wins over every later worker result, including success.
                IF current_job.cancellation_requested THEN
                    UPDATE worker_job cancelled
                       SET status = 'cancelled',
                           result = NULL,
                           error_code = 'job_cancelled',
                           error_detail = 'The job was cancelled.',
                           lease_owner = NULL,
                           lease_until = NULL,
                           completed_at = clock_timestamp(),
                           updated_at = clock_timestamp()
                     WHERE cancelled.job_id = current_job.job_id
                    RETURNING cancelled.* INTO changed;
                    RETURN QUERY SELECT 'cancelled'::text, false;
                    RETURN;
                END IF;

                IF p_succeeded AND current_job.kind LIKE 'export.%' THEN
                    IF p_retryable
                       OR p_result IS NULL
                       OR jsonb_typeof(p_result) IS DISTINCT FROM 'object'
                       OR p_error_code IS NOT NULL
                       OR p_error_detail IS NOT NULL
                       OR p_expected_export_attempt IS NULL
                       OR p_expected_export_attempt = '00000000-0000-0000-0000-000000000000'::uuid
                       OR current_job.workspace_id IS NULL
                       OR jsonb_typeof(current_job.payload) IS DISTINCT FROM 'object'
                       OR NOT (current_job.payload ?& ARRAY[
                           'itemId', 'workspaceId', 'format', 'scope', 'title',
                           'extension', 'mediaType', 'declaredLoss']::text[])
                       OR jsonb_typeof(current_job.payload -> 'format') IS DISTINCT FROM 'string'
                       OR jsonb_typeof(current_job.payload -> 'extension') IS DISTINCT FROM 'string'
                       OR (current_job.payload ->> 'format') !~ '^[a-z0-9-]{1,32}$'
                       OR (current_job.payload ->> 'extension') !~ '^[a-z0-9]{1,16}$'
                       OR current_job.kind IS DISTINCT FROM ('export.' || (current_job.payload ->> 'format'))
                       OR (current_job.payload ->> 'workspaceId') IS DISTINCT FROM current_job.workspace_id::text THEN
                        export_valid := false;
                    END IF;

                    IF export_valid THEN
                        IF NOT (p_result ?& ARRAY[
                               'attemptId', 'format', 'objectKey', 'itemCount', 'omittedCount',
                               'byteLength', 'sha256', 'loss', 'omissions']::text[])
                           OR EXISTS (
                               SELECT 1
                                 FROM jsonb_object_keys(p_result) AS result_key(name)
                                WHERE NOT (result_key.name = ANY (ARRAY[
                                    'attemptId', 'format', 'objectKey', 'itemCount',
                                    'omittedCount', 'byteLength', 'sha256', 'loss',
                                    'omissions']::text[]))) THEN
                            export_valid := false;
                        END IF;
                    END IF;

                    IF export_valid
                       AND (jsonb_typeof(p_result -> 'attemptId') IS DISTINCT FROM 'string'
                       OR (p_result ->> 'attemptId') IS DISTINCT FROM p_expected_export_attempt::text
                       OR jsonb_typeof(p_result -> 'format') IS DISTINCT FROM 'string'
                       OR (p_result ->> 'format') IS DISTINCT FROM (current_job.payload ->> 'format')
                       OR jsonb_typeof(p_result -> 'objectKey') IS DISTINCT FROM 'string'
                       OR jsonb_typeof(p_result -> 'itemCount') IS DISTINCT FROM 'number'
                       OR (p_result ->> 'itemCount') !~ '^[0-9]{1,6}$'
                       OR jsonb_typeof(p_result -> 'omittedCount') IS DISTINCT FROM 'number'
                       OR (p_result ->> 'omittedCount') !~ '^[0-9]{1,6}$'
                       OR jsonb_typeof(p_result -> 'byteLength') IS DISTINCT FROM 'number'
                       OR (p_result ->> 'byteLength') !~ '^[0-9]{1,12}$'
                       OR jsonb_typeof(p_result -> 'sha256') IS DISTINCT FROM 'string'
                       OR (p_result ->> 'sha256') !~ '^[0-9A-Fa-f]{64}$'
                       OR jsonb_typeof(p_result -> 'loss') IS DISTINCT FROM 'array'
                       OR jsonb_typeof(p_result -> 'omissions') IS DISTINCT FROM 'array') THEN
                        export_valid := false;
                    END IF;

                    IF export_valid THEN
                        expected_key := 'exports/results/' || current_job.tenant_id::text || '/'
                            || current_job.job_id::text || '/' || p_expected_export_attempt::text
                            || '.' || (current_job.payload ->> 'extension');
                        IF p_result ->> 'objectKey' IS DISTINCT FROM expected_key
                           OR (p_result ->> 'itemCount')::integer NOT BETWEEN 1 AND 100000
                           OR (p_result ->> 'omittedCount')::integer NOT BETWEEN 0 AND 100000
                           OR (p_result ->> 'byteLength')::bigint NOT BETWEEN 1 AND 268435456
                           OR jsonb_array_length(p_result -> 'loss') > 128
                           OR jsonb_array_length(p_result -> 'omissions') > 100000 THEN
                            export_valid := false;
                        END IF;
                    END IF;

                    IF export_valid THEN
                        IF EXISTS (
                            SELECT 1
                              FROM jsonb_array_elements(p_result -> 'loss') AS entries(value)
                             WHERE jsonb_typeof(value) IS DISTINCT FROM 'string'
                                OR length(value #>> '{}') NOT BETWEEN 1 AND 500
                                OR btrim(value #>> '{}') = ''
                                OR (value #>> '{}') ~ '[[:cntrl:]]') THEN
                            export_valid := false;
                        END IF;
                    END IF;

                    IF export_valid THEN
                        IF EXISTS (
                            SELECT 1
                              FROM jsonb_array_elements(p_result -> 'omissions') AS entries(value)
                             WHERE jsonb_typeof(value) IS DISTINCT FROM 'string'
                                OR length(value #>> '{}') NOT BETWEEN 1 AND 500
                                OR btrim(value #>> '{}') = ''
                                OR (value #>> '{}') ~ '[[:cntrl:]]') THEN
                            export_valid := false;
                        END IF;
                    END IF;

                    IF NOT export_valid THEN
                        UPDATE worker_job invalid_export
                           SET status = 'failed',
                               result = NULL,
                               error_code = 'export_result_invalid',
                               error_detail = 'The export worker returned a result that did not match its durable job and execution.',
                               lease_owner = NULL,
                               lease_until = NULL,
                               completed_at = clock_timestamp(),
                               updated_at = clock_timestamp()
                         WHERE invalid_export.job_id = current_job.job_id
                        RETURNING invalid_export.* INTO changed;
                        RETURN QUERY SELECT 'invalid_export_result'::text, false;
                        RETURN;
                    END IF;
                END IF;

                retry_delay := CASE
                    WHEN current_job.attempts <= 1 THEN 5
                    WHEN current_job.attempts = 2 THEN 30
                    WHEN current_job.attempts = 3 THEN 120
                    ELSE 300
                END;

                UPDATE worker_job job
                   SET status = CASE
                           WHEN p_succeeded THEN 'completed'
                           WHEN p_error_code = 'job_cancelled' THEN 'cancelled'
                           WHEN p_retryable AND job.attempts < 5 THEN 'running'
                           ELSE 'failed'
                       END,
                       result = CASE WHEN p_succeeded THEN p_result ELSE NULL END,
                       error_code = CASE WHEN p_succeeded THEN NULL ELSE left(p_error_code, 64) END,
                       error_detail = CASE WHEN p_succeeded THEN NULL ELSE left(p_error_detail, 2000) END,
                       cancellation_requested = CASE
                           WHEN p_error_code = 'job_cancelled' THEN true
                           ELSE job.cancellation_requested
                       END,
                       lease_owner = NULL,
                       lease_until = CASE
                           WHEN NOT p_succeeded
                                AND p_error_code IS DISTINCT FROM 'job_cancelled'
                                AND p_retryable
                                AND job.attempts < 5
                               THEN clock_timestamp() + make_interval(secs => retry_delay)
                           ELSE NULL
                       END,
                       completed_at = CASE
                           WHEN NOT p_succeeded
                                AND p_error_code IS DISTINCT FROM 'job_cancelled'
                                AND p_retryable
                                AND job.attempts < 5 THEN NULL
                           ELSE clock_timestamp()
                       END,
                       updated_at = clock_timestamp()
                 WHERE job.job_id = current_job.job_id
                   AND job.status = 'running'
                   AND job.lease_owner = p_owner
                RETURNING job.* INTO changed;

                IF NOT FOUND THEN
                    RETURN QUERY SELECT 'stale_execution'::text, false;
                    RETURN;
                END IF;

                IF changed.status = 'completed'
                      AND changed.kind LIKE 'export.%'
                      AND NOT nix_schedule_export_result_cleanup(changed.job_id) THEN
                    RAISE EXCEPTION 'completed export cleanup could not be scheduled';
                END IF;

                RETURN QUERY SELECT
                    CASE changed.status
                        WHEN 'completed' THEN 'completed'
                        WHEN 'running' THEN 'retry_scheduled'
                        WHEN 'cancelled' THEN 'cancelled'
                        ELSE 'failed'
                    END::text,
                    changed.status = 'completed' AND changed.kind LIKE 'export.%';
                RETURN;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_apply_worker_result(uuid, text, boolean, boolean, jsonb, text, text, uuid) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_apply_worker_result(uuid, text, boolean, boolean, jsonb, text, text, uuid) TO {{ApplicationRole}};
            """);
        emit("""
            DROP TABLE IF EXISTS worker_outbox_event;
            DROP SEQUENCE IF EXISTS nix_search_index_version;
            """);
    }

    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        // A stub: older Downs (item locks) create a trigger on this function before the Down that drops it.
        emit("""
            CREATE OR REPLACE FUNCTION nix_queue_body_search_event()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $function$
            BEGIN
                RETURN NULL;
            END
            $function$;
            """);
        emit("""
            CREATE SEQUENCE IF NOT EXISTS nix_search_index_version AS bigint;
            CREATE TABLE IF NOT EXISTS worker_outbox_event (
                event_id uuid NOT NULL,
                tenant_id uuid NOT NULL,
                workspace_id uuid,
                item_id uuid,
                kind character varying(64) NOT NULL,
                aggregate_version bigint,
                payload jsonb NOT NULL,
                available_at timestamp with time zone NOT NULL,
                attempts integer NOT NULL,
                lease_owner character varying(128),
                lease_until timestamp with time zone,
                processed_at timestamp with time zone,
                last_error character varying(2000),
                CONSTRAINT "PK_worker_outbox_event" PRIMARY KEY (event_id)
            );
            CREATE INDEX IF NOT EXISTS "IX_worker_outbox_event_processed_at_available_at_lease_until"
                ON worker_outbox_event (processed_at, available_at, lease_until);
            CREATE INDEX IF NOT EXISTS "IX_worker_outbox_event_tenant_id_item_id_aggregate_version"
                ON worker_outbox_event (tenant_id, item_id, aggregate_version);
            """);
    }
}
