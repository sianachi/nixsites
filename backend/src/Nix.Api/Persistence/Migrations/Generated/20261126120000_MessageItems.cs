using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>
/// Messages between people and pets are items of type <c>message</c>. This adds the <c>message</c>
/// notification kind and the trigger that queues one notice per addressed person when such an
/// item is inserted: the poster's request cannot write into somebody else's inbox, so the notice
/// fires later in the recipient's own session (the same route comment notices take).
/// </summary>
/// <remarks>
/// Hand-written; the model snapshot only changes the notification kind check. Down removes the
/// trigger and narrows the check again, after deleting message notifications that would break it.
/// </remarks>
[DbContext(typeof(NixDbContext))]
[Migration("20261126120000_MessageItems")]
public sealed class MessageItems : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        ArgumentNullException.ThrowIfNull(migrationBuilder);
        migrationBuilder.Sql("""
            ALTER TABLE notification
                DROP CONSTRAINT notification_bounded,
                ADD CONSTRAINT notification_bounded CHECK (
                    char_length(title) <= 200 AND char_length(body) <= 1000
                    AND kind IN ('reminder', 'automation', 'calendar', 'system', 'invitation', 'comment', 'message'));

            CREATE OR REPLACE FUNCTION nix_queue_message_notice()
            RETURNS trigger
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, pg_temp
            AS $function$
            DECLARE
                v_now timestamptz := clock_timestamp();
                v_to jsonb;
            BEGIN
                BEGIN
                    v_to := (NEW.properties ->> '$message')::jsonb -> 'to';
                EXCEPTION WHEN others THEN
                    RETURN NULL;
                END;
                IF jsonb_typeof(v_to) IS DISTINCT FROM 'array' THEN
                    RETURN NULL;
                END IF;

                -- Addressed people only, never the poster; joined to principal so a forged id cannot fail the post.
                INSERT INTO public.scheduled_trigger
                    (tenant_id, id, workspace_id, principal_id, kind, source, source_item_id, rule_id,
                     fire_at, dedupe_key, status, attempts, created_at, updated_at)
                SELECT NEW.tenant_id, gen_random_uuid(), NEW.workspace_id, known.principal_id,
                       'system', 'message.posted', NEW.id, NEW.id, v_now,
                       'message:' || NEW.id::text, 'pending', 0, v_now, v_now
                  FROM (
                        SELECT DISTINCT CASE WHEN entry ->> 'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                             THEN (entry ->> 'id')::uuid END AS principal_id
                          FROM jsonb_array_elements(v_to) AS entry
                         WHERE jsonb_typeof(entry) = 'object' AND entry ->> 'kind' = 'person'
                       ) who
                  JOIN public.principal known
                    ON known.tenant_id = NEW.tenant_id AND known.principal_id = who.principal_id
                 WHERE who.principal_id <> NEW.created_by
                ON CONFLICT (tenant_id, principal_id, dedupe_key) DO NOTHING;
                RETURN NULL;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_queue_message_notice() FROM PUBLIC;

            DROP TRIGGER IF EXISTS item_message_notice ON item;
            CREATE TRIGGER item_message_notice
                AFTER INSERT ON item
                FOR EACH ROW
                WHEN (NEW.type = 'message')
                EXECUTE FUNCTION nix_queue_message_notice();
            """);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        ArgumentNullException.ThrowIfNull(migrationBuilder);
        migrationBuilder.Sql("""
            DROP TRIGGER IF EXISTS item_message_notice ON item;
            DROP FUNCTION IF EXISTS nix_queue_message_notice();
            DELETE FROM scheduled_trigger WHERE source = 'message.posted';
            DELETE FROM notification WHERE kind = 'message';
            ALTER TABLE notification
                DROP CONSTRAINT notification_bounded,
                ADD CONSTRAINT notification_bounded CHECK (
                    char_length(title) <= 200 AND char_length(body) <= 1000
                    AND kind IN ('reminder', 'automation', 'calendar', 'system', 'invitation', 'comment'));
            """);
    }
}
