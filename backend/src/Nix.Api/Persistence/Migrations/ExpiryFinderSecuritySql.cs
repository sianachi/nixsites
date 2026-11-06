namespace Nix.Persistence.Migrations;

/// <summary>
/// [SEC] Cross-tenant discovery for <c>ExpirySource</c>: items carrying an <c>expiry</c> property
/// that someone set through the write path (<c>$expiry_set_by</c>), with the index it walks.
/// </summary>
/// <remarks>
/// Built like <c>nix_find_explicit_reminder_candidates</c>
/// (<see cref="ReminderSourceSecuritySql"/>): owned by the migrator role, SECURITY DEFINER with
/// <c>pg_temp</c> named last in the search path, every relation schema-qualified, a bounded
/// <c>LIMIT</c>, explicit REVOKE/GRANT, and values parsed with the safe helpers rather than cast.
/// It requires <c>$expiry_set_by</c>, so an <c>expiry</c> a user stored before the feature existed
/// is never acted on. There is no lower bound on the instant: an item past its date that could not
/// be trashed must stay a candidate until it is.
/// </remarks>
internal static class ExpiryFinderSecuritySql
{
    private const string ApplicationRole = "nix_app";

    /// <summary>Creates the index and the finder.</summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    internal static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        emit("""
            CREATE INDEX ix_item_expiry
                ON item ((properties ->> 'expiry'))
                WHERE properties ? '$expiry_set_by'
                  AND properties ? 'expiry'
                  AND lifecycle_state = 'active'
                  AND template_id IS NULL;
            """);

        emit($$"""
            CREATE OR REPLACE FUNCTION nix_find_expiry_candidates(
                p_until timestamptz, p_limit integer,
                p_after_at timestamptz DEFAULT '-infinity', p_after_id uuid DEFAULT '00000000-0000-0000-0000-000000000000')
            RETURNS TABLE (
                tenant_id uuid,
                item_id uuid,
                workspace_id uuid,
                principal_id uuid,
                expiry_at timestamptz)
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
            DECLARE
                v_to_text text := to_char(p_until + interval '2 days', 'YYYY-MM-DD');
            BEGIN
                IF p_limit NOT BETWEEN 1 AND 500 THEN
                    RAISE EXCEPTION 'invalid expiry candidate limit';
                END IF;

                RETURN QUERY
                SELECT candidate.tenant_id,
                       candidate.id,
                       candidate.workspace_id,
                       -- Whoever set the expiry while still active in the item's tenant; the
                       -- creator otherwise.
                       COALESCE(setter.principal_id, candidate.created_by),
                       candidate.expiry_at
                  FROM (
                      SELECT i.tenant_id,
                             i.id,
                             i.workspace_id,
                             i.created_by,
                             i.properties ->> '$expiry_set_by' AS set_by_text,
                             public.nix_safe_timestamptz(split_part(i.properties ->> 'expiry', '[', 1)) AS expiry_at
                        FROM public.item i
                       WHERE i.lifecycle_state = 'active'
                         AND i.template_id IS NULL
                         AND i.properties ? '$expiry_set_by'
                         AND i.properties ? 'expiry'
                         AND (i.properties ->> 'expiry') < v_to_text
                  ) candidate
                  LEFT JOIN public.principal setter
                    ON setter.tenant_id = candidate.tenant_id
                   AND setter.principal_id = public.nix_safe_uuid(candidate.set_by_text)
                   AND setter.status = 'active'
                 WHERE candidate.expiry_at IS NOT NULL
                   AND candidate.expiry_at < p_until
                   AND (candidate.expiry_at, candidate.id) > (p_after_at, p_after_id)
                 ORDER BY candidate.expiry_at, candidate.id
                 LIMIT p_limit;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_find_expiry_candidates(timestamptz, integer, timestamptz, uuid) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_find_expiry_candidates(timestamptz, integer, timestamptz, uuid) TO {{ApplicationRole}};
            """);
    }

    /// <summary>Drops the finder and its index.</summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    internal static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            DROP FUNCTION IF EXISTS nix_find_expiry_candidates(timestamptz, integer, timestamptz, uuid);
            DROP INDEX IF EXISTS ix_item_expiry;
            """);
    }
}
