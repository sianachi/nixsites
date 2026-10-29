namespace Nix.Persistence.Migrations;

/// <summary>
/// [SEC] The hand-written half of the note comment limits migration: a note holds at most 2,000
/// comments, enforced by a statement trigger so no writer (API, import, a future path) can grow a
/// note's thread table without bound.
/// </summary>
/// <remarks>
/// Frozen to the migration that applies it. A later change writes a new file. The function is not
/// SECURITY DEFINER: it runs as the writer, so the tenant policy applies to the count too, and it
/// reads only <c>note_comment</c>. Counted per statement over the distinct notes the statement
/// touched, so a bulk import is one count per note, not per row.
/// The same migration also widens <c>nix_authorize_worker_execution</c> with <c>include_comments</c>
/// (the export payload's flag), so the comments route can be delegated only to an export that asked
/// for comments. Its body is the one <see cref="WorkerExecutionSecuritySql.ApplyAllowingSystemCleanup"/> wrote.
/// </remarks>
public static class NoteCommentLimitsSecuritySql
{
    /// <summary>Emits the count trigger.</summary>
    /// <param name="emit">Receives each statement.</param>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            CREATE OR REPLACE FUNCTION nix_bound_note_comments() RETURNS trigger
            LANGUAGE plpgsql
            SET search_path = pg_catalog, pg_temp
            AS $function$
            BEGIN
                IF EXISTS (
                    SELECT 1
                      FROM public.note_comment kept
                      JOIN (SELECT DISTINCT tenant_id, item_id FROM added) touched
                        ON touched.tenant_id = kept.tenant_id AND touched.item_id = kept.item_id
                     GROUP BY kept.tenant_id, kept.item_id
                    HAVING count(*) > 2000) THEN
                    RAISE EXCEPTION 'note comment limit reached'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NULL;
            END
            $function$;

            DROP TRIGGER IF EXISTS note_comment_bounded ON public.note_comment;
            CREATE TRIGGER note_comment_bounded
                AFTER INSERT ON public.note_comment
                REFERENCING NEW TABLE AS added
                FOR EACH STATEMENT EXECUTE FUNCTION nix_bound_note_comments();
            """);

        emit("DROP FUNCTION IF EXISTS nix_authorize_worker_execution(uuid, text);");
        emit("""
            CREATE FUNCTION nix_authorize_worker_execution(
                p_job_id uuid,
                p_owner text)
            RETURNS TABLE (
                tenant_id uuid,
                workspace_id uuid,
                actor_id uuid,
                kind text,
                include_comments boolean)
            LANGUAGE sql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
                SELECT job.tenant_id,
                       job.workspace_id,
                       job.actor_id,
                       job.kind::text,
                       COALESCE(job.payload -> 'includeComments' = 'true'::jsonb, false)
                  FROM worker_job job
                  JOIN principal actor
                    ON actor.tenant_id = job.tenant_id
                   AND actor.principal_id = job.actor_id
                 WHERE job.job_id = p_job_id
                   AND job.status = 'running'
                   AND job.cancellation_requested = false
                   AND job.lease_owner = p_owner
                   AND job.lease_until >= clock_timestamp()
                   AND (actor.status = 'active' OR job.kind = 'object.cleanup')
                   AND p_owner IS NOT NULL
                   AND length(p_owner) BETWEEN 1 AND 128
            $function$;

            REVOKE ALL ON FUNCTION nix_authorize_worker_execution(uuid, text) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_authorize_worker_execution(uuid, text) TO nix_app;
            """);
    }

    /// <summary>Removes the count trigger.</summary>
    /// <param name="emit">Receives each statement.</param>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            DROP TRIGGER IF EXISTS note_comment_bounded ON public.note_comment;
            DROP FUNCTION IF EXISTS nix_bound_note_comments();
            DROP FUNCTION IF EXISTS nix_authorize_worker_execution(uuid, text);
            """);
        WorkerExecutionSecuritySql.ApplyAllowingSystemCleanup(emit);
    }
}
