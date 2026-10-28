import type { Pool } from 'pg';

import { pruneHistory } from '../db/history.ts';
import { withTenantScope, type ScopedQuery, type TenantScope } from '../db/tenant-scope.ts';
import type { CollabMetrics } from '../metrics.ts';

/**
 * The version-history retention sweep.
 *
 * `docs/plans/version-history.md` describes this as a walk over "documents whose workspace has
 * a non-null `version_retention_days`". In practice the column is `NOT NULL` - every workspace
 * has always had a retention setting, defaulted at creation - so "no retention" is expressed the
 * way the rest of this service already expresses "disabled": zero. `sweepTenant` below skips a
 * workspace at `version_retention_days = 0` and sweeps every other one.
 *
 * **Which tenants to sweep is the harder question, and it is answered outside this module.**
 * Row-level security means a connection scoped to one tenant cannot enumerate any other, and
 * this service holds no role that bypasses it - `migrate-documents.ts` documents that the
 * migrator role is "the one place in the service that reads across tenants", deliberately kept
 * out of the process that also serves traffic. So `startRetentionSweep` is handed the tenants to
 * walk rather than discovering them itself: `apps/collab/src/http/context.ts` reports the scope
 * of every request it authorizes through `ServerDependencies.onTenantSeen`, and `index.ts` wires
 * that into the `activeScopes` this sweep reads on each tick. A tenant with no request against
 * this process since it started is not swept by it - which is the correct amount of harm for a
 * process restart to do: the next request re-registers the tenant, and the next tick after that
 * catches it up. A tenant is never lost permanently, only delayed until it is next seen.
 */

/** One tenant's sweep, and what it found. */
export interface TenantSweepResult {
  readonly workspacesSwept: number;
  readonly documentsSwept: number;
  readonly updatesDeleted: number;
  readonly snapshotsDeleted: number;
  readonly failures: number;
}

/**
 * Prunes every document in every retention-bearing workspace of one tenant.
 *
 * One query joins `content_doc` to `workspace` - the join the design calls for - to find every
 * document whose workspace has a retention window, all under the tenant scope `sql` already
 * carries. A document that fails to prune (a connection blip, a row already gone) is logged
 * through `onDocumentError` and skipped rather than aborting the rest of the tenant's sweep:
 * retention is a background job with another chance next tick, and one document's problem must
 * never hold every other document in the tenant hostage to it.
 */
export async function sweepTenant(
  sql: ScopedQuery,
  tenantId: string,
  now: Date = new Date(),
  onDocumentError?: (docId: string, error: unknown) => void,
): Promise<TenantSweepResult> {
  // `prunable` is a superset test for what `pruneHistory` would delete (any snapshot at or before
  // the cutoff that has an old update at or below it, or an unpinned snapshot below it), so a
  // sweep that finds nothing to do costs one query rather than one round trip per document.
  const { rows } = await sql.query<{
    doc_id: string;
    workspace_id: string;
    version_retention_days: number;
    prunable: boolean;
  }>(
    `SELECT d.doc_id, d.workspace_id, w.version_retention_days,
            EXISTS (
              SELECT 1 FROM content_snapshot b
               WHERE b.tenant_id = d.tenant_id AND b.doc_id = d.doc_id
                 AND b.created_at <= $2::timestamptz - w.version_retention_days * interval '24 hours'
                 AND (EXISTS (SELECT 1 FROM content_update u
                               WHERE u.tenant_id = d.tenant_id AND u.doc_id = d.doc_id
                                 AND u.seq <= b.seq
                                 AND u.created_at < $2::timestamptz - w.version_retention_days * interval '24 hours')
                      OR EXISTS (SELECT 1 FROM content_snapshot s
                                  WHERE s.tenant_id = d.tenant_id AND s.doc_id = d.doc_id
                                    AND s.seq < b.seq
                                    AND NOT EXISTS (SELECT 1 FROM content_version v
                                                     WHERE v.tenant_id = s.tenant_id
                                                       AND v.doc_id = s.doc_id AND v.seq = s.seq)))
            ) AS prunable
     FROM content_doc d
     JOIN workspace w ON w.tenant_id = d.tenant_id AND w.workspace_id = d.workspace_id
     WHERE d.tenant_id = $1 AND w.version_retention_days > 0`,
    [tenantId, now.toISOString()],
  );

  const workspacesSwept = new Set(rows.map((row) => row.workspace_id)).size;
  let documentsSwept = 0;
  let updatesDeleted = 0;
  let snapshotsDeleted = 0;
  let failures = 0;

  for (const row of rows) {
    try {
      if (!row.prunable) {
        documentsSwept += 1;
        continue;
      }
      const result = await pruneHistory(sql, tenantId, row.doc_id, row.version_retention_days, now);
      documentsSwept += 1;
      updatesDeleted += result.updatesDeleted;
      snapshotsDeleted += result.snapshotsDeleted;
    } catch (error) {
      failures += 1;
      onDocumentError?.(row.doc_id, error);
    }
  }

  return { workspacesSwept, documentsSwept, updatesDeleted, snapshotsDeleted, failures };
}

export interface RetentionSweepDeps {
  readonly pool: Pool;

  /** Every tenant scope this process has seen a request for, as of this tick. */
  readonly activeScopes: () => readonly TenantScope[];

  /** How often to sweep, in milliseconds. Zero or below disables the sweep entirely. */
  readonly intervalMs: number;

  readonly now?: () => Date;
  readonly log?: (message: string) => void;
  readonly metrics?: CollabMetrics;
}

export interface RetentionSweepHandle {
  /** Stops the timer. Idempotent, and safe to call even when the sweep was disabled. */
  stop(): void;
}

/**
 * Starts the periodic retention sweep, and returns a handle to stop it.
 *
 * Never fatal, at either grain the contract asks for: one document's failure is logged and
 * skipped by {@link sweepTenant}, and one tenant's failure - the transaction itself throwing -
 * is caught here so it costs that tenant's turn and nothing else. A tick that finds no active
 * tenants, or is disabled outright, is silent rather than an error: both are ordinary states,
 * a fresh process and a deployment with retention turned off alike.
 */
export function startRetentionSweep(deps: RetentionSweepDeps): RetentionSweepHandle {
  if (deps.intervalMs <= 0) {
    return { stop: () => undefined };
  }

  const log = deps.log ?? (() => undefined);
  const now = deps.now ?? (() => new Date());

  async function tick(): Promise<void> {
    const scopes = deps.activeScopes();
    let documentsSwept = 0;
    let updatesDeleted = 0;
    let snapshotsDeleted = 0;
    let failures = 0;

    for (const scope of scopes) {
      try {
        const result = await withTenantScope(deps.pool, scope, (sql) =>
          sweepTenant(sql, scope.tenantId, now(), (docId, error) => {
            log(
              `retention sweep: could not prune document ${docId} in tenant ${scope.tenantId}: ` +
                describeError(error),
            );
          }),
        );

        documentsSwept += result.documentsSwept;
        updatesDeleted += result.updatesDeleted;
        snapshotsDeleted += result.snapshotsDeleted;
        failures += result.failures;
      } catch (error) {
        failures += 1;
        log(`retention sweep: tenant ${scope.tenantId} failed: ${describeError(error)}`);
      }
    }

    deps.metrics?.retentionDeletedTotal.inc({ kind: 'update' }, updatesDeleted);
    deps.metrics?.retentionDeletedTotal.inc({ kind: 'snapshot' }, snapshotsDeleted);
    if (failures > 0) {
      deps.metrics?.retentionFailuresTotal.inc(failures);
    }

    log(
      `retention sweep: ${String(scopes.length)} tenant(s), ${String(documentsSwept)} document(s) ` +
        `pruned, ${String(updatesDeleted)} update(s) and ${String(snapshotsDeleted)} snapshot(s) ` +
        `deleted${failures > 0 ? `, ${String(failures)} failure(s)` : ''}.`,
    );
  }

  const timer = setInterval(() => {
    void tick();
  }, deps.intervalMs);
  // A sweep timer must never be the reason the process does not exit - it has a clean `stop()`
  // for the ordinary shutdown path, but nothing else should depend on this firing again.
  timer.unref();

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
