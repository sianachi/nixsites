namespace Nix.Persistence.Migrations;

/// <summary>
/// [SEC] Invitations grant nothing until accepted: removes the provisional access old invitations
/// granted, and queues each new invitation's notice for its invitee.
/// </summary>
/// <remarks>
/// <para>
/// Frozen to the migration that applies it. A later change writes a new file.
/// </para>
/// <para>
/// <b>No new row-security policy is owed.</b> The new columns land on <c>workspace</c> and
/// <c>item</c>, which already carry forced tenant isolation, and the runtime role writes them by
/// the same default privileges as their other columns; Core's handlers decide who may.
/// </para>
/// <para>
/// The notice trigger is SECURITY DEFINER because <c>scheduled_trigger</c> rows are private to
/// their recipient and the inviter is not the invitee. It is narrow: one row per inserted pending
/// invitation with a target, never a read, and the row only names the invitation; the dispatcher
/// re-checks it as the invitee before anything is written to their inbox.
/// </para>
/// </remarks>
public static class WorkspaceSharingSecuritySql
{
    /// <summary>Emits the cleanup and the notice trigger.</summary>
    /// <param name="emit">Receives each statement.</param>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        // Invite refused anyone who already had access, so a direct grant beside a pending
        // invitation is always the provisional one. The migrator holds BYPASSRLS, as for every
        // backfill before it.
        emit("""
            DELETE FROM workspace_member member
             USING workspace_invitation invitation
             WHERE member.tenant_id = invitation.tenant_id
               AND member.workspace_id = invitation.workspace_id
               AND member.subject_type = 'principal'
               AND member.subject_id = invitation.target_principal_id
               AND invitation.status = 'pending';
            """);

        emit("""
            CREATE OR REPLACE FUNCTION nix_queue_invitation_notice()
            RETURNS trigger
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
            DECLARE
                v_now timestamptz := clock_timestamp();
            BEGIN
                INSERT INTO public.scheduled_trigger
                    (tenant_id, id, workspace_id, principal_id, kind, source, source_item_id, rule_id,
                     fire_at, dedupe_key, status, attempts, created_at, updated_at)
                VALUES (NEW.tenant_id, gen_random_uuid(), NEW.workspace_id, NEW.target_principal_id,
                        'system', 'workspace.invitation', NULL, NEW.invitation_id, v_now,
                        'invitation:' || NEW.invitation_id::text, 'pending', 0, v_now, v_now)
                ON CONFLICT (tenant_id, principal_id, dedupe_key) DO NOTHING;
                RETURN NULL;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_queue_invitation_notice() FROM PUBLIC;

            CREATE TRIGGER workspace_invitation_notice
                AFTER INSERT ON workspace_invitation
                FOR EACH ROW
                WHEN (NEW.status = 'pending' AND NEW.target_principal_id IS NOT NULL)
                EXECUTE FUNCTION nix_queue_invitation_notice();
            """);
    }

    /// <summary>Removes the notice trigger. The provisional grants it deleted are not restored.</summary>
    /// <param name="emit">Receives each statement.</param>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            DROP TRIGGER IF EXISTS workspace_invitation_notice ON workspace_invitation;
            DROP FUNCTION IF EXISTS nix_queue_invitation_notice();
            """);
    }
}
