using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>
/// Makes the native sync flush delete at most 20,000 expired change markers per call. After a long idle
/// period the first flush used to delete every expired marker in one transaction while holding the
/// workspace revision row lock. The oldest markers go first and the retained floor moves to the newest
/// one removed, so later flushes finish the cleanup and no marker inside the 30 day window is touched.
/// Only the expiry statement differs from NativeWorkspaceSync; owner, search_path and grants are unchanged
/// (CREATE OR REPLACE keeps the owner, the ACL and the trigger).
/// </summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261122140000_SyncBoundedExpiry")]
public sealed class SyncBoundedExpiry : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) =>
        migrationBuilder.Sql(Flush("""
                WITH removed AS (
                        DELETE FROM public.workspace_sync_change
                        WHERE ctid = ANY (ARRAY(
                            SELECT ctid FROM public.workspace_sync_change
                            WHERE tenant_id = candidate.tenant_id AND workspace_id = candidate.workspace_id
                              AND created_at < clock_timestamp() - interval '30 days'
                            ORDER BY seq LIMIT 20000))
                        RETURNING seq
                    ) SELECT max(seq) INTO expired FROM removed;
            """));

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) =>
        migrationBuilder.Sql(Flush("""
                WITH removed AS (
                        DELETE FROM public.workspace_sync_change
                        WHERE tenant_id = candidate.tenant_id AND workspace_id = candidate.workspace_id
                          AND created_at < clock_timestamp() - interval '30 days'
                        RETURNING seq
                    ) SELECT max(seq) INTO expired FROM removed;
            """));

    private static string Flush(string expire) =>
        """
        CREATE OR REPLACE FUNCTION native_sync_flush() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
        DECLARE candidate record; marker_count bigint; base_revision bigint; expired bigint;
        BEGIN
            -- All durable writes finish before publication. Acquire every touched counter in one canonical order.
            FOR candidate IN SELECT DISTINCT tenant_id, workspace_id FROM public.workspace_sync_pending
                             WHERE transaction_id = txid_current() ORDER BY tenant_id, workspace_id LOOP
                INSERT INTO public.workspace_sync_revision(tenant_id, workspace_id)
                    VALUES (candidate.tenant_id, candidate.workspace_id) ON CONFLICT DO NOTHING;
                PERFORM 1 FROM public.workspace_sync_revision
                    WHERE tenant_id = candidate.tenant_id AND workspace_id = candidate.workspace_id FOR UPDATE;
            END LOOP;
            FOR candidate IN SELECT DISTINCT tenant_id, workspace_id FROM public.workspace_sync_pending
                             WHERE transaction_id = txid_current() ORDER BY tenant_id, workspace_id LOOP
                SELECT count(*) INTO marker_count FROM public.workspace_sync_pending
                    WHERE tenant_id = candidate.tenant_id AND workspace_id = candidate.workspace_id
                      AND transaction_id = txid_current() AND publish;
                UPDATE public.workspace_sync_revision SET seq = seq + marker_count
                    WHERE tenant_id = candidate.tenant_id AND workspace_id = candidate.workspace_id
                    RETURNING seq - marker_count INTO base_revision;
                WITH markers AS MATERIALIZED (
                    SELECT tenant_id, workspace_id, base_revision + row_number() OVER (ORDER BY item_id) AS seq,
                           NULLIF(item_id, '00000000-0000-0000-0000-000000000000'::uuid) AS item_id, metadata_revision
                    FROM public.workspace_sync_pending
                    WHERE tenant_id = candidate.tenant_id AND workspace_id = candidate.workspace_id
                      AND transaction_id = txid_current() AND publish
                ), changes AS (
                    INSERT INTO public.workspace_sync_change(tenant_id, workspace_id, seq, item_id, metadata_revision)
                    SELECT tenant_id, workspace_id, seq, item_id, metadata_revision FROM markers
                )
                INSERT INTO public.workspace_sync_item_revision(tenant_id, workspace_id, item_id, seq)
                    SELECT tenant_id, workspace_id, item_id, 1 FROM markers WHERE item_id IS NOT NULL AND metadata_revision
                    ON CONFLICT (tenant_id, workspace_id, item_id) DO UPDATE
                    SET seq = public.workspace_sync_item_revision.seq + 1;
        """
        + expire +
        """

                IF expired IS NOT NULL THEN
                    UPDATE public.workspace_sync_revision SET retained_floor = greatest(retained_floor, expired)
                        WHERE tenant_id = candidate.tenant_id AND workspace_id = candidate.workspace_id;
                END IF;
            END LOOP;
            DELETE FROM public.workspace_sync_pending WHERE transaction_id = txid_current();
            RETURN NEW;
        END;
        $$;
        """;
}
