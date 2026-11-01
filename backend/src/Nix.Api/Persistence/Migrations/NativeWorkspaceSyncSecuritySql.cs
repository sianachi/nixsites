namespace Nix.Persistence.Migrations;

/// <summary>Frozen native mirror feed schema, tenant isolation and transaction-held revision locks.</summary>
internal static class NativeWorkspaceSyncSecuritySql
{
    private static readonly string[] ItemTables = ["item", "content_doc", "file_body", "file_version"];
    private static readonly string[] ScopeTables = ["workspace", "workspace_member", "acl_entry", "item_lock", "item_unlock"];
    private static readonly string[] TenantTables = ["tenant_role", "group_membership"];

    internal static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            CREATE TABLE workspace_sync_revision (
                tenant_id uuid NOT NULL,
                workspace_id uuid NOT NULL,
                seq bigint NOT NULL DEFAULT 0 CHECK (seq >= 0),
                retained_floor bigint NOT NULL DEFAULT 0 CHECK (retained_floor >= 0 AND retained_floor <= seq),
                PRIMARY KEY (tenant_id, workspace_id),
                FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspace(tenant_id, workspace_id) ON DELETE CASCADE
            );
            CREATE TABLE workspace_sync_change (
                tenant_id uuid NOT NULL,
                workspace_id uuid NOT NULL,
                seq bigint NOT NULL,
                item_id uuid,
                metadata_revision boolean NOT NULL,
                created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
                PRIMARY KEY (tenant_id, workspace_id, seq),
                FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspace(tenant_id, workspace_id) ON DELETE CASCADE
            );
            CREATE INDEX workspace_sync_change_retention ON workspace_sync_change(tenant_id, workspace_id, created_at);
            CREATE TABLE workspace_sync_item_revision (
                tenant_id uuid NOT NULL,
                workspace_id uuid NOT NULL,
                item_id uuid NOT NULL,
                seq bigint NOT NULL CHECK (seq >= 0),
                PRIMARY KEY (tenant_id, workspace_id, item_id),
                FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspace(tenant_id, workspace_id) ON DELETE CASCADE
            );
            CREATE TABLE workspace_sync_pending (
                tenant_id uuid NOT NULL,
                workspace_id uuid NOT NULL,
                transaction_id bigint NOT NULL,
                item_id uuid NOT NULL,
                publish boolean NOT NULL,
                metadata_revision boolean NOT NULL,
                PRIMARY KEY (tenant_id, workspace_id, transaction_id, item_id),
                FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspace(tenant_id, workspace_id) ON DELETE CASCADE
            );
            CREATE INDEX workspace_sync_pending_transaction ON workspace_sync_pending(transaction_id, tenant_id, workspace_id);
            CREATE INDEX item_native_snapshot ON item(tenant_id, workspace_id, id)
                WHERE template_id IS NULL AND lifecycle_state = 'active';
            INSERT INTO workspace_sync_revision(tenant_id, workspace_id)
                SELECT tenant_id, workspace_id FROM workspace;
            """);
        foreach (var table in new[] { "workspace_sync_revision", "workspace_sync_change", "workspace_sync_item_revision", "workspace_sync_pending" })
        {
            emit($"""
                ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;
                ALTER TABLE {table} FORCE ROW LEVEL SECURITY;
                CREATE POLICY {table}_tenant_isolation ON {table}
                    USING (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid)
                    WITH CHECK (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid);
                REVOKE ALL ON {table} FROM PUBLIC, nix_app, nix_collab;
                """);
            if (table != "workspace_sync_pending")
            {
                emit($"GRANT SELECT ON {table} TO nix_app;");
            }
        }
        emit("""
            CREATE FUNCTION native_sync_mark(tenant uuid, workspace uuid, item uuid, metadata boolean DEFAULT false) RETURNS void
            LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM public.workspace AS stored_workspace
                    WHERE stored_workspace.tenant_id = tenant AND stored_workspace.workspace_id = workspace) THEN
                    RETURN;
                END IF;
                IF item IS NOT NULL AND NOT metadata AND EXISTS (
                    SELECT 1 FROM public.item_closure AS edge
                    JOIN public.item_lock AS password_lock
                      ON password_lock.tenant_id = edge.tenant_id AND password_lock.item_id = edge.ancestor_id
                    WHERE edge.tenant_id = tenant AND edge.descendant_id = item
                ) THEN
                    RETURN;
                END IF;
                -- Staging takes no revision lock while durable item rows are still being changed.
                -- One sentinel row queues publication once per workspace, even for a bulk import.
                INSERT INTO public.workspace_sync_pending(tenant_id, workspace_id, transaction_id, item_id, publish, metadata_revision)
                    VALUES (tenant, workspace, txid_current(), '00000000-0000-0000-0000-000000000000'::uuid, item IS NULL, false)
                    ON CONFLICT (tenant_id, workspace_id, transaction_id, item_id) DO UPDATE
                    SET publish = public.workspace_sync_pending.publish OR EXCLUDED.publish
                    WHERE public.workspace_sync_pending.publish IS DISTINCT FROM (public.workspace_sync_pending.publish OR EXCLUDED.publish);
                IF item IS NOT NULL THEN
                    INSERT INTO public.workspace_sync_pending(tenant_id, workspace_id, transaction_id, item_id, publish, metadata_revision)
                        VALUES (tenant, workspace, txid_current(), item, true, metadata)
                        ON CONFLICT (tenant_id, workspace_id, transaction_id, item_id) DO UPDATE
                        SET metadata_revision = public.workspace_sync_pending.metadata_revision OR EXCLUDED.metadata_revision
                        WHERE EXCLUDED.metadata_revision AND NOT public.workspace_sync_pending.metadata_revision;
                END IF;
            END;
            $$;
            REVOKE ALL ON FUNCTION native_sync_mark(uuid, uuid, uuid, boolean) FROM PUBLIC, nix_app, nix_collab;

            CREATE FUNCTION native_sync_flush() RETURNS trigger
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
                    WITH removed AS (
                        DELETE FROM public.workspace_sync_change
                        WHERE tenant_id = candidate.tenant_id AND workspace_id = candidate.workspace_id
                          AND created_at < clock_timestamp() - interval '30 days'
                        RETURNING seq
                    ) SELECT max(seq) INTO expired FROM removed;
                    IF expired IS NOT NULL THEN
                        UPDATE public.workspace_sync_revision SET retained_floor = greatest(retained_floor, expired)
                            WHERE tenant_id = candidate.tenant_id AND workspace_id = candidate.workspace_id;
                    END IF;
                END LOOP;
                DELETE FROM public.workspace_sync_pending WHERE transaction_id = txid_current();
                RETURN NEW;
            END;
            $$;
            REVOKE ALL ON FUNCTION native_sync_flush() FROM PUBLIC, nix_app, nix_collab;
            CREATE CONSTRAINT TRIGGER native_sync_flush AFTER INSERT ON workspace_sync_pending
                DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
                WHEN (NEW.item_id = '00000000-0000-0000-0000-000000000000'::uuid) EXECUTE FUNCTION native_sync_flush();

            CREATE FUNCTION native_sync_row_changed() RETURNS trigger
            LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
            DECLARE previous jsonb; current_row jsonb; tenant uuid; old_workspace uuid; new_workspace uuid;
                    old_item uuid; new_item uuid; candidate uuid; metadata boolean;
            BEGIN
                IF TG_OP = 'UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
                IF TG_OP <> 'INSERT' THEN old_workspace = OLD.workspace_id; END IF;
                IF TG_OP <> 'DELETE' THEN new_workspace = NEW.workspace_id; tenant = NEW.tenant_id;
                ELSE tenant = OLD.tenant_id; END IF;
                IF TG_ARGV[0] = 'item' THEN
                    IF TG_TABLE_NAME = 'item' THEN
                        IF TG_OP <> 'INSERT' THEN old_item = OLD.id; previous = to_jsonb(OLD); END IF;
                        IF TG_OP <> 'DELETE' THEN new_item = NEW.id; current_row = to_jsonb(NEW); END IF;
                    ELSE
                        IF TG_OP <> 'INSERT' THEN old_item = OLD.item_id; END IF;
                        IF TG_OP <> 'DELETE' THEN new_item = NEW.item_id; END IF;
                    END IF;
                END IF;
                metadata = TG_TABLE_NAME = 'item' AND (TG_OP <> 'UPDATE'
                    OR previous - ARRAY['last_modified_at', 'last_modified_by'] IS DISTINCT FROM current_row - ARRAY['last_modified_at', 'last_modified_by']);
                -- Transfers stage both workspaces; the deferred publisher locks the whole transaction's workspace set.
                FOR candidate IN SELECT DISTINCT value FROM unnest(ARRAY[old_workspace, new_workspace]) AS value
                                 WHERE value IS NOT NULL ORDER BY value LOOP
                    PERFORM native_sync_mark(tenant, candidate,
                        CASE WHEN candidate = new_workspace THEN new_item ELSE old_item END, metadata);
                    IF TG_TABLE_NAME = 'item' AND TG_OP = 'UPDATE'
                       AND (previous -> 'parent_id' IS DISTINCT FROM current_row -> 'parent_id'
                         OR previous -> 'workspace_id' IS DISTINCT FROM current_row -> 'workspace_id'
                         OR previous -> 'lifecycle_state' IS DISTINCT FROM current_row -> 'lifecycle_state'
                         OR previous -> 'template_id' IS DISTINCT FROM current_row -> 'template_id') THEN
                        PERFORM native_sync_mark(tenant, candidate, NULL);
                    END IF;
                END LOOP;
                IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
                RETURN NEW;
            END;
            $$;
            REVOKE ALL ON FUNCTION native_sync_row_changed() FROM PUBLIC, nix_app, nix_collab;

            CREATE FUNCTION native_sync_tenant_changed() RETURNS trigger
            LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
            DECLARE tenant uuid; candidate uuid;
            BEGIN
                IF TG_OP = 'DELETE' THEN tenant = OLD.tenant_id; ELSE tenant = NEW.tenant_id; END IF;
                FOR candidate IN SELECT workspace_id FROM public.workspace WHERE tenant_id = tenant ORDER BY workspace_id LOOP
                    PERFORM native_sync_mark(tenant, candidate, NULL);
                END LOOP;
                IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
                RETURN NEW;
            END;
            $$;
            REVOKE ALL ON FUNCTION native_sync_tenant_changed() FROM PUBLIC, nix_app, nix_collab;
            """);
        foreach (var table in ItemTables.Concat(ScopeTables))
        {
            var scope = ItemTables.Contains(table, StringComparer.Ordinal) ? "item" : "scope";
            // Lock tables identify only an item; resolve the workspace inside their specialized trigger.
            if (table is "item_lock" or "item_unlock")
            {
                continue;
            }
            emit($"CREATE TRIGGER native_sync_{table} AFTER INSERT OR UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION native_sync_row_changed('{scope}');");
        }
        emit("""
            CREATE FUNCTION native_sync_lock_changed() RETURNS trigger
            LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
            DECLARE tenant uuid; subject uuid; workspace uuid;
            BEGIN
                IF TG_OP = 'DELETE' THEN tenant = OLD.tenant_id; subject = OLD.item_id;
                ELSE tenant = NEW.tenant_id; subject = NEW.item_id; END IF;
                SELECT workspace_id INTO workspace FROM public.item WHERE tenant_id = tenant AND id = subject;
                IF workspace IS NOT NULL THEN PERFORM native_sync_mark(tenant, workspace, NULL); END IF;
                IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
                RETURN NEW;
            END;
            $$;
            REVOKE ALL ON FUNCTION native_sync_lock_changed() FROM PUBLIC, nix_app, nix_collab;
            CREATE TRIGGER native_sync_item_lock AFTER INSERT OR UPDATE OR DELETE ON item_lock
                FOR EACH ROW EXECUTE FUNCTION native_sync_lock_changed();
            CREATE TRIGGER native_sync_item_unlock AFTER INSERT OR UPDATE OR DELETE ON item_unlock
                FOR EACH ROW EXECUTE FUNCTION native_sync_lock_changed();
            """);
        foreach (var table in TenantTables)
        {
            emit($"CREATE TRIGGER native_sync_{table} AFTER INSERT OR UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION native_sync_tenant_changed();");
        }
    }

    internal static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        foreach (var table in ItemTables.Concat(ScopeTables).Concat(TenantTables))
        {
            emit($"DROP TRIGGER native_sync_{table} ON {table};");
        }
        emit("""
            DROP FUNCTION native_sync_lock_changed();
            DROP FUNCTION native_sync_tenant_changed();
            DROP FUNCTION native_sync_row_changed();
            DROP FUNCTION native_sync_mark(uuid, uuid, uuid, boolean);
            DROP TRIGGER native_sync_flush ON workspace_sync_pending;
            DROP FUNCTION native_sync_flush();
            DROP INDEX item_native_snapshot;
            DROP TABLE workspace_sync_pending, workspace_sync_item_revision, workspace_sync_change, workspace_sync_revision;
            """);
    }
}
