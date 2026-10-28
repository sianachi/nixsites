import { nixSchema } from '@nix/editor-schema';
import type { Pool } from 'pg';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  DB_TESTS_ENABLED,
  TENANTS,
  adminPool,
  clearContent,
  collabPool,
  seedTenants,
  scopeOf,
  type TestTenant,
} from '../db/testing.ts';
import { withTenantScope } from '../db/tenant-scope.ts';
import { FRAGMENT_NAME, applyUpdate, openDocument } from './service.ts';
import { sweepTenant } from './retention.ts';

/**
 * The retention sweep against real Postgres.
 *
 * `sweepTenant` is the part of the sweep that touches the database - the join from
 * `content_doc` to `workspace`, and the calls into `pruneHistory` it drives. What
 * `startRetentionSweep` adds on top (the timer, and reading `activeScopes` on each tick) is
 * plain scheduling and is covered without a database in `retention.test.ts`.
 *
 * Requires the development stack: `docker compose -f deploy/compose.dev.yml --profile core up
 * -d`, then `deploy/seed/seed.sh`, then the migrator (`scripts/dev-migrate.sh`).
 */
describe.skipIf(!DB_TESTS_ENABLED)('the retention sweep, against Postgres', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = collabPool();
    await seedTenants();
  });

  afterAll(async () => {
    await clearContent();
    await pool.end();
  });

  beforeEach(async () => {
    await clearContent();
    // seedTenants leaves every workspace at 30 days; each test sets what it needs.
    const admin = adminPool();
    try {
      await admin.query(
        'UPDATE workspace SET version_retention_days = 30 WHERE workspace_id = $1',
        [TENANTS.alpha.workspaceId],
      );
      await admin.query(
        'UPDATE workspace SET version_retention_days = 30 WHERE workspace_id = $1',
        [TENANTS.beta.workspaceId],
      );
    } finally {
      await admin.end();
    }
  });

  async function open(tenant: TestTenant) {
    return await withTenantScope(pool, scopeOf(tenant), async (sql) => {
      const doc = await openDocument(
        sql,
        tenant.tenantId,
        tenant.itemId,
        tenant.workspaceId,
        () => tenant.docId,
      );

      if (doc === null) throw new Error('The document was not created.');
      return doc;
    });
  }

  function editor(): { rewriteTo: (text: string) => Uint8Array } {
    const doc = new Y.Doc();

    return {
      rewriteTo(text: string): Uint8Array {
        const fragment = doc.getXmlFragment(FRAGMENT_NAME);
        doc.transact(() => {
          fragment.delete(0, fragment.length);
        });
        prosemirrorJSONToYXmlFragment(
          nixSchema,
          { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
          fragment,
        );

        return Y.encodeStateAsUpdate(doc);
      },
    };
  }

  async function write(tenant: TestTenant, update: Uint8Array): Promise<bigint> {
    const doc = await open(tenant);
    const result = await withTenantScope(pool, scopeOf(tenant), (sql) =>
      applyUpdate(sql, {
        tenantId: tenant.tenantId,
        doc,
        updateBytes: update,
        actorId: tenant.principalId,
        clientId: 'client',
        snapshotEvery: 1,
      }),
    );

    if (!result.ok) throw new Error(`The update was refused: ${result.error.code}`);
    return result.value.seq;
  }

  it('prunes a backdated document in a workspace with a retention window', async () => {
    const tenant = TENANTS.alpha;
    const doc = await open(tenant);
    const ed = editor();

    const seqs: bigint[] = [];
    for (const text of ['one', 'two', 'three']) {
      seqs.push(await write(tenant, ed.rewriteTo(text)));
    }

    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const admin = adminPool();
    try {
      for (const seq of seqs.slice(0, 2)) {
        await admin.query(
          'UPDATE content_update SET created_at = $1 WHERE doc_id = $2 AND seq = $3',
          [longAgo, doc.doc_id, seq.toString()],
        );
        await admin.query(
          'UPDATE content_snapshot SET created_at = $1 WHERE doc_id = $2 AND seq = $3',
          [longAgo, doc.doc_id, seq.toString()],
        );
      }
    } finally {
      await admin.end();
    }

    const result = await withTenantScope(pool, scopeOf(tenant), (sql) =>
      sweepTenant(sql, tenant.tenantId, new Date()),
    );

    expect(result.failures).toBe(0);
    expect(result.documentsSwept).toBe(1);
    expect(result.workspacesSwept).toBe(1);
    // The base becomes seq 2 - the newest snapshot at or before the cutoff. Updates 1 and 2
    // are subsumed by it and are deleted; update 3, after the base, is untouched. The
    // snapshot at seq 1 goes too, in favour of the one at seq 2 becoming the base.
    expect(result.updatesDeleted).toBe(2);
    expect(result.snapshotsDeleted).toBe(1);

    const remaining = await withTenantScope(pool, scopeOf(tenant), (sql) =>
      sql.query<{ seq: string }>('SELECT seq FROM content_update WHERE doc_id = $1 ORDER BY seq', [
        doc.doc_id,
      ]),
    );
    expect(remaining.rows.map((row) => row.seq)).toEqual(['3']);
  });

  it('skips a workspace with retention disabled (version_retention_days = 0)', async () => {
    const tenant = TENANTS.beta;
    const doc = await open(tenant);
    const ed = editor();

    const seqs: bigint[] = [];
    for (const text of ['one', 'two']) {
      seqs.push(await write(tenant, ed.rewriteTo(text)));
    }

    const admin = adminPool();
    try {
      await admin.query('UPDATE workspace SET version_retention_days = 0 WHERE workspace_id = $1', [
        tenant.workspaceId,
      ]);

      const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
      for (const seq of seqs) {
        await admin.query(
          'UPDATE content_update SET created_at = $1 WHERE doc_id = $2 AND seq = $3',
          [longAgo, doc.doc_id, seq.toString()],
        );
        await admin.query(
          'UPDATE content_snapshot SET created_at = $1 WHERE doc_id = $2 AND seq = $3',
          [longAgo, doc.doc_id, seq.toString()],
        );
      }
    } finally {
      await admin.end();
    }

    const result = await withTenantScope(pool, scopeOf(tenant), (sql) =>
      sweepTenant(sql, tenant.tenantId, new Date()),
    );

    expect(result).toEqual({
      workspacesSwept: 0,
      documentsSwept: 0,
      updatesDeleted: 0,
      snapshotsDeleted: 0,
      failures: 0,
    });

    const remaining = await withTenantScope(pool, scopeOf(tenant), (sql) =>
      sql.query<{ seq: string }>('SELECT seq FROM content_update WHERE doc_id = $1 ORDER BY seq', [
        doc.doc_id,
      ]),
    );
    // Nothing pruned: every update from a workspace with retention disabled survives.
    expect(remaining.rows.map((row) => row.seq)).toEqual(['1', '2']);
  });

  it('never shows one tenant the other tenant documents when sweeping', async () => {
    const alpha = TENANTS.alpha;
    const beta = TENANTS.beta;
    const ed = editor();

    await open(beta);
    const alphaDoc = await open(alpha);
    const alphaSeq = await write(alpha, ed.rewriteTo('alpha only'));

    const admin = adminPool();
    try {
      const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
      await admin.query(
        'UPDATE content_update SET created_at = $1 WHERE doc_id = $2 AND seq = $3',
        [longAgo, alphaDoc.doc_id, alphaSeq.toString()],
      );
      await admin.query(
        'UPDATE content_snapshot SET created_at = $1 WHERE doc_id = $2 AND seq = $3',
        [longAgo, alphaDoc.doc_id, alphaSeq.toString()],
      );
    } finally {
      await admin.end();
    }

    // Beta's own sweep is scoped to beta's tenant - it finds beta's own (empty) document and
    // nothing to prune on it, and never so much as sees alpha's, however old alpha's history
    // has been made. Sweeping beta must not be the thing that prunes alpha.
    const betaResult = await withTenantScope(pool, scopeOf(beta), (sql) =>
      sweepTenant(sql, beta.tenantId, new Date()),
    );
    expect(betaResult.updatesDeleted).toBe(0);
    expect(betaResult.snapshotsDeleted).toBe(0);

    const alphaUpdates = await withTenantScope(pool, scopeOf(alpha), (sql) =>
      sql.query<{ seq: string }>('SELECT seq FROM content_update WHERE doc_id = $1', [
        alphaDoc.doc_id,
      ]),
    );
    // Alpha's backdated update is still exactly where it was - beta's sweep left it alone.
    expect(alphaUpdates.rows).toHaveLength(1);
  });
});
