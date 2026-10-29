namespace Nix.Persistence.Migrations;

/// <summary>
/// [SEC] The hand-written half of the note comments migration: tenant isolation and explicit
/// grants on <c>note_comment</c> and <c>note_comment_revision</c>, the revision counter trigger,
/// and the trigger that queues a notice for each person a comment concerns.
/// </summary>
/// <remarks>
/// <para>
/// Frozen to the migration that applies it. A later change writes a new file.
/// </para>
/// <para>
/// Isolation is by tenant only. Who may read, write or edit a comment is decided in Core, from the
/// workspace role and the item lock, because the same rows are read by every member of a workspace.
/// </para>
/// <para>
/// The notice trigger is SECURITY DEFINER because <c>scheduled_trigger</c> rows are private to
/// their recipient and the commenter is not the recipient. It is narrow: it writes only rows that
/// name the comment, for principals that exist in the tenant, and never reads for the caller. The
/// dispatcher then re-checks, as the recipient, that they can still read the note, that its body is
/// not locked and that the comment still exists, before anything reaches their inbox. A mention of
/// someone outside the workspace therefore queues a row that is skipped, not a notification.
/// </para>
/// </remarks>
public static class NoteCommentsSecuritySql
{
    private const string ApplicationRole = "nix_app";

    /// <summary>Emits the policies, grants and triggers.</summary>
    /// <param name="emit">Receives each statement.</param>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        foreach (var table in new[] { "note_comment", "note_comment_revision" })
        {
            emit($"""
                ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;
                ALTER TABLE {table} FORCE ROW LEVEL SECURITY;

                DROP POLICY IF EXISTS {table}_tenant_isolation ON {table};
                CREATE POLICY {table}_tenant_isolation ON {table}
                    USING (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid)
                    WITH CHECK (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid);

                REVOKE ALL ON {table} FROM PUBLIC;
                GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO {ApplicationRole};
                """);
        }

        // Runs as the writer, so the tenant policy applies to the counter row too. A deleted note
        // cascades its counter away in the same statement, so a row is only bumped while it exists.
        emit("""
            CREATE OR REPLACE FUNCTION nix_bump_note_comment_revision() RETURNS trigger
            LANGUAGE plpgsql AS $function$
            BEGIN
                INSERT INTO note_comment_revision (tenant_id, item_id, revision)
                SELECT DISTINCT tenant_id, item_id, 1 FROM changed
                ON CONFLICT (tenant_id, item_id) DO UPDATE SET revision = note_comment_revision.revision + 1;
                RETURN NULL;
            END
            $function$;

            DROP TRIGGER IF EXISTS note_comment_revision_insert ON note_comment;
            CREATE TRIGGER note_comment_revision_insert
                AFTER INSERT ON note_comment
                REFERENCING NEW TABLE AS changed
                FOR EACH STATEMENT EXECUTE FUNCTION nix_bump_note_comment_revision();

            DROP TRIGGER IF EXISTS note_comment_revision_update ON note_comment;
            CREATE TRIGGER note_comment_revision_update
                AFTER UPDATE ON note_comment
                REFERENCING NEW TABLE AS changed
                FOR EACH STATEMENT EXECUTE FUNCTION nix_bump_note_comment_revision();
            """);

        // A delete bumps through its own function: the item may be going too (cascade), in which
        // case the counter insert would violate the item foreign key, so the bump only happens
        // while the item still exists.
        emit("""
            CREATE OR REPLACE FUNCTION nix_bump_note_comment_revision_on_delete() RETURNS trigger
            LANGUAGE plpgsql AS $function$
            BEGIN
                INSERT INTO note_comment_revision (tenant_id, item_id, revision)
                SELECT DISTINCT gone.tenant_id, gone.item_id, 1
                  FROM gone
                  JOIN item ON item.tenant_id = gone.tenant_id AND item.id = gone.item_id
                ON CONFLICT (tenant_id, item_id) DO UPDATE SET revision = note_comment_revision.revision + 1;
                RETURN NULL;
            END
            $function$;

            DROP TRIGGER IF EXISTS note_comment_revision_delete ON note_comment;
            CREATE TRIGGER note_comment_revision_delete
                AFTER DELETE ON note_comment
                REFERENCING OLD TABLE AS gone
                FOR EACH STATEMENT EXECUTE FUNCTION nix_bump_note_comment_revision_on_delete();
            """);

        // Recipients: the other authors in the thread plus the mentioned principals, never the
        // actor, never an imported comment (its author is the importer, not the person named).
        // Principals are joined so a forged mention id cannot fail the comment on a foreign key.
        emit("""
            CREATE OR REPLACE FUNCTION nix_queue_comment_notice()
            RETURNS trigger
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, pg_temp
            AS $function$
            DECLARE
                v_now timestamptz := clock_timestamp();
                v_workspace uuid;
            BEGIN
                SELECT workspace_id INTO v_workspace
                  FROM public.item WHERE tenant_id = NEW.tenant_id AND id = NEW.item_id;

                INSERT INTO public.scheduled_trigger
                    (tenant_id, id, workspace_id, principal_id, kind, source, source_item_id, rule_id,
                     fire_at, dedupe_key, status, attempts, created_at, updated_at)
                SELECT NEW.tenant_id, gen_random_uuid(), v_workspace, who.principal_id,
                       'system', 'note.comment', NEW.item_id, NEW.id, v_now,
                       'comment:' || NEW.id::text, 'pending', 0, v_now, v_now
                  FROM (
                        SELECT sibling.author_principal_id AS principal_id
                          FROM public.note_comment sibling
                         WHERE sibling.tenant_id = NEW.tenant_id AND sibling.thread_id = NEW.thread_id
                           AND sibling.imported_author IS NULL
                        UNION
                        SELECT mentioned FROM unnest(NEW.mention_ids) AS mentioned
                       ) who
                  JOIN public.principal known
                    ON known.tenant_id = NEW.tenant_id AND known.principal_id = who.principal_id
                 WHERE who.principal_id <> NEW.author_principal_id
                ON CONFLICT (tenant_id, principal_id, dedupe_key) DO NOTHING;
                RETURN NULL;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_queue_comment_notice() FROM PUBLIC;

            DROP TRIGGER IF EXISTS note_comment_notice ON note_comment;
            CREATE TRIGGER note_comment_notice
                AFTER INSERT ON note_comment
                FOR EACH ROW
                WHEN (NEW.imported_author IS NULL)
                EXECUTE FUNCTION nix_queue_comment_notice();
            """);
    }

    /// <summary>Removes the triggers and functions. The tables are dropped by the migration.</summary>
    /// <param name="emit">Receives each statement.</param>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            DROP TRIGGER IF EXISTS note_comment_notice ON note_comment;
            DROP TRIGGER IF EXISTS note_comment_revision_insert ON note_comment;
            DROP TRIGGER IF EXISTS note_comment_revision_update ON note_comment;
            DROP TRIGGER IF EXISTS note_comment_revision_delete ON note_comment;
            DROP FUNCTION IF EXISTS nix_queue_comment_notice();
            DROP FUNCTION IF EXISTS nix_bump_note_comment_revision();
            DROP FUNCTION IF EXISTS nix_bump_note_comment_revision_on_delete();
            """);
    }
}
