import type { Pool } from 'pg';

import { writeItemChunks } from '../db/documents.ts';
import { withTenantScope, type ScopedQuery, type TenantScope } from '../db/tenant-scope.ts';
import { chunkNote } from './chunks.ts';

/**
 * Chunks notes whose latest snapshot predates retrieval chunks.
 *
 * Chunks are otherwise written only when a note is next snapshotted, so a note nobody edits would
 * never become retrievable. Each tick takes a bounded batch per tenant this process has seen, the
 * same tenant source the retention sweep uses and for the same reason: this service holds no role
 * that reads across tenants. Only prose snapshots with text are candidates, so an empty note is
 * not picked up again on every tick.
 */
export async function backfillChunks(
  sql: ScopedQuery,
  tenantId: string,
  limit: number,
): Promise<number> {
  const { rows } = await sql.query<{ item_id: string; seq: string; prosemirror_json: unknown }>(
    `SELECT d.item_id, s.seq, s.prosemirror_json
       FROM content_doc d
       JOIN LATERAL (
            SELECT seq, prosemirror_json, plaintext
              FROM content_snapshot
             WHERE tenant_id = d.tenant_id AND doc_id = d.doc_id
             ORDER BY seq DESC
             LIMIT 1
       ) s ON true
      WHERE d.tenant_id = $1
        AND s.prosemirror_json ->> 'type' = 'doc'
        AND btrim(s.plaintext) <> ''
        AND NOT EXISTS (
            SELECT 1 FROM item_chunk c WHERE c.tenant_id = d.tenant_id AND c.item_id = d.item_id
        )
      LIMIT $2`,
    [tenantId, limit],
  );
  let written = 0;
  for (const row of rows) {
    const chunks = chunkNote(row.prosemirror_json);
    if (chunks === null || chunks.length === 0) continue;
    // A snapshot may have chunked the note since the select above; its passages are newer.
    if (
      await writeItemChunks(sql, {
        tenantId,
        itemId: row.item_id,
        seq: BigInt(row.seq),
        chunks,
        onlyIfEmpty: true,
      })
    )
      written += 1;
  }
  return written;
}

export function startChunkBackfill(deps: {
  readonly pool: Pool;
  readonly activeScopes: () => readonly TenantScope[];
  readonly intervalMs: number;
  readonly log: (message: string) => void;
}): { stop(): void } {
  if (deps.intervalMs <= 0) return { stop: () => undefined };

  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      for (const scope of deps.activeScopes()) {
        try {
          // One note per transaction: each write holds that note's chunk lock until it commits, and
          // a live snapshot of the note must not wait behind a whole batch.
          // shortcut: a note that cannot be chunked is selected again first on every pass and stops
          // the tenant's backfill; mark such notes once that happens outside development.
          let written = 0;
          for (let index = 0; index < 100; index += 1) {
            const one = await withTenantScope(deps.pool, scope, (sql) =>
              backfillChunks(sql, scope.tenantId, 1),
            );
            if (one === 0) break;
            written += one;
          }
          if (written > 0)
            deps.log(`chunk backfill: ${String(written)} note(s) in tenant ${scope.tenantId}.`);
        } catch (error) {
          deps.log(
            `chunk backfill: tenant ${scope.tenantId} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    })().finally(() => {
      running = false;
    });
  }, deps.intervalMs);
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
