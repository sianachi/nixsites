import { nixSchema } from '@nix/editor-schema';
import type { Pool } from 'pg';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applyUpdate, FRAGMENT_NAME, openDocument } from '../documents/service.ts';
import {
  DB_TESTS_ENABLED,
  TENANTS,
  adminPool,
  clearContent,
  collabPool,
  seedTenants,
  scopeOf,
  type TestTenant,
} from './testing.ts';
import {
  deleteNamedVersion,
  listNamedVersions,
  listRevisions,
  nameVersion,
  pruneHistory,
  stateAt,
} from './history.ts';
import { withTenantScope } from './tenant-scope.ts';

/**
 * The history data layer against real Postgres.
 *
 * Every one of these claims depends on the actual log and the actual isolation policy:
 * `listRevisions` on real paging through `content_update`, `stateAt` on a real replay that can
 * hit a real gap, `nameVersion` on a real snapshot write, and `pruneHistory` on real deletes
 * that must stop exactly where the rule says. None of that is faked without a database.
 *
 * Requires the development stack: `docker compose -f deploy/compose.dev.yml --profile core up
 * -d`, then `deploy/seed/seed.sh`, then the migrator (`scripts/dev-migrate.sh`).
 */
describe.skipIf(!DB_TESTS_ENABLED)('the history data layer, against Postgres', () => {
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

  /** One evolving document: each call replaces its content and returns the diff update. */
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

  /** Writes one update, from a given actor, without a snapshot unless `snapshotEvery` says so. */
  async function write(
    tenant: TestTenant,
    update: Uint8Array,
    actorId: string,
    snapshotEvery = 0,
  ): Promise<bigint> {
    const doc = await open(tenant);
    const result = await withTenantScope(pool, scopeOf(tenant), (sql) =>
      applyUpdate(sql, {
        tenantId: tenant.tenantId,
        doc,
        updateBytes: update,
        actorId,
        clientId: 'client',
        snapshotEvery,
      }),
    );

    if (!result.ok) throw new Error(`The update was refused: ${result.error.code}`);
    return result.value.seq;
  }

  describe('listRevisions', () => {
    it('pages backward through the log, newest first, and stops when the log runs out', async () => {
      const tenant = TENANTS.alpha;
      const doc = await open(tenant);
      const ed = editor();

      const actors: [string, string] = [
        '00000000-0000-4000-8000-0000000000a1',
        '00000000-0000-4000-8000-0000000000a2',
      ];

      // Alternating actors so every write is its own revision - the split this test cares
      // about is paging, not coalescing, which the pure suite already covers.
      const seqs: bigint[] = [];
      for (let index = 0; index < 7; index += 1) {
        const actorId = actors[index % 2 === 0 ? 0 : 1];
        const seq = await write(tenant, ed.rewriteTo(`line ${String(index)}`), actorId);
        seqs.push(seq);
      }

      const firstPage = await withTenantScope(pool, scopeOf(tenant), (sql) =>
        listRevisions(sql, tenant.tenantId, doc.doc_id, { limit: 3 }),
      );

      expect(firstPage.hasMore).toBe(true);
      expect(firstPage.revisions.map((revision) => revision.seq)).toEqual([7, 6, 5]);

      const firstPageOldest = firstPage.revisions[firstPage.revisions.length - 1];
      if (firstPageOldest === undefined) throw new Error('Expected a revision.');

      const secondPage = await withTenantScope(pool, scopeOf(tenant), (sql) =>
        listRevisions(sql, tenant.tenantId, doc.doc_id, { before: firstPageOldest.seq, limit: 3 }),
      );

      expect(secondPage.hasMore).toBe(true);
      expect(secondPage.revisions.map((revision) => revision.seq)).toEqual([4, 3, 2]);

      const secondPageOldest = secondPage.revisions[secondPage.revisions.length - 1];
      if (secondPageOldest === undefined) throw new Error('Expected a revision.');

      const thirdPage = await withTenantScope(pool, scopeOf(tenant), (sql) =>
        listRevisions(sql, tenant.tenantId, doc.doc_id, { before: secondPageOldest.seq, limit: 3 }),
      );

      // The oldest revision, and nothing further behind it to page to.
      expect(thirdPage.hasMore).toBe(false);
      expect(thirdPage.revisions.map((revision) => revision.seq)).toEqual([1]);
    });

    it('attaches a name from content_version to the revision it belongs to', async () => {
      const tenant = TENANTS.alpha;
      const doc = await open(tenant);
      const ed = editor();

      await write(tenant, ed.rewriteTo('first'), tenant.principalId);
      const secondSeq = await write(tenant, ed.rewriteTo('second'), tenant.principalId);

      await withTenantScope(pool, scopeOf(tenant), (sql) =>
        nameVersion(
          sql,
          tenant.tenantId,
          doc.doc_id,
          Number(secondSeq),
          'Milestone',
          tenant.principalId,
        ),
      );

      const page = await withTenantScope(pool, scopeOf(tenant), (sql) =>
        listRevisions(sql, tenant.tenantId, doc.doc_id, { limit: 10 }),
      );

      const named = page.revisions.find((revision) => revision.seq === Number(secondSeq));
      expect(named?.name).toBe('Milestone');
    });
  });

  describe('stateAt', () => {
    it('reconstructs the document exactly as it stood at a mid-log seq', async () => {
      const tenant = TENANTS.alpha;
      const doc = await open(tenant);
      const ed = editor();

      const seqs: bigint[] = [];
      for (const text of ['first', 'second', 'third', 'fourth']) {
        seqs.push(await write(tenant, ed.rewriteTo(text), tenant.principalId));
      }

      const midSeq = seqs[1];
      if (midSeq === undefined) throw new Error('Expected a mid-log sequence.');

      const state = await withTenantScope(pool, scopeOf(tenant), (sql) =>
        stateAt(sql, tenant.tenantId, doc.doc_id, Number(midSeq)),
      );

      expect(state).not.toBeNull();
      const text = state?.getXmlFragment(FRAGMENT_NAME).toJSON();
      expect(text).toContain('second');
      expect(text).not.toContain('third');
      expect(text).not.toContain('fourth');
    });

    it('reconstructs a mid-log state that falls after a snapshot', async () => {
      const tenant = TENANTS.alpha;
      const doc = await open(tenant);
      const ed = editor();

      await write(tenant, ed.rewriteTo('one'), tenant.principalId, 1);
      await write(tenant, ed.rewriteTo('two'), tenant.principalId, 1);
      const thirdSeq = await write(tenant, ed.rewriteTo('three'), tenant.principalId, 0);
      await write(tenant, ed.rewriteTo('four'), tenant.principalId, 0);

      const state = await withTenantScope(pool, scopeOf(tenant), (sql) =>
        stateAt(sql, tenant.tenantId, doc.doc_id, Number(thirdSeq)),
      );

      const text = state?.getXmlFragment(FRAGMENT_NAME).toJSON();
      expect(text).toContain('three');
      expect(text).not.toContain('four');
    });

    it('returns null for a seq beyond the head', async () => {
      const tenant = TENANTS.alpha;
      const doc = await open(tenant);
      const ed = editor();
      const seq = await write(tenant, ed.rewriteTo('only'), tenant.principalId);

      const state = await withTenantScope(pool, scopeOf(tenant), (sql) =>
        stateAt(sql, tenant.tenantId, doc.doc_id, Number(seq) + 100),
      );

      expect(state).toBeNull();
    });

    it('returns null when the base a seq needs has been pruned', async () => {
      const tenant = TENANTS.alpha;
      const doc = await open(tenant);
      const ed = editor();

      const seqs: bigint[] = [];
      for (const text of ['one', 'two', 'three']) {
        seqs.push(await write(tenant, ed.rewriteTo(text), tenant.principalId, 1));
      }

      // Delete the earliest update and its snapshot directly, simulating what pruning leaves
      // behind when the base it kept is newer than the seq being asked for.
      const admin = adminPool();
      try {
        await admin.query('DELETE FROM content_update WHERE doc_id = $1 AND seq = $2', [
          doc.doc_id,
          seqs[0]?.toString(),
        ]);
        await admin.query('DELETE FROM content_snapshot WHERE doc_id = $1 AND seq = $2', [
          doc.doc_id,
          seqs[0]?.toString(),
        ]);
      } finally {
        await admin.end();
      }

      const state = await withTenantScope(pool, scopeOf(tenant), (sql) =>
        stateAt(sql, tenant.tenantId, doc.doc_id, Number(seqs[0])),
      );

      expect(state).toBeNull();
    });
  });

  describe('nameVersion', () => {
    it('pins a snapshot at seq when none exists yet', async () => {
      const tenant = TENANTS.alpha;
      const doc = await open(tenant);
      const ed = editor();

      const seq = await write(tenant, ed.rewriteTo('unsnapshotted'), tenant.principalId, 0);

      const before = await withTenantScope(pool, scopeOf(tenant), (sql) =>
        sql.query('SELECT 1 FROM content_snapshot WHERE doc_id = $1 AND seq = $2', [
          doc.doc_id,
          seq.toString(),
        ]),
      );
      expect(before.rows).toEqual([]);

      const version = await withTenantScope(pool, scopeOf(tenant), (sql) =>
        nameVersion(
          sql,
          tenant.tenantId,
          doc.doc_id,
          Number(seq),
          'First draft',
          tenant.principalId,
        ),
      );

      expect(version).toMatchObject({
        seq: Number(seq),
        name: 'First draft',
        createdBy: tenant.principalId,
      });

      const after = await withTenantScope(pool, scopeOf(tenant), (sql) =>
        sql.query('SELECT 1 FROM content_snapshot WHERE doc_id = $1 AND seq = $2', [
          doc.doc_id,
          seq.toString(),
        ]),
      );
      expect(after.rows).toHaveLength(1);

      const versions = await withTenantScope(pool, scopeOf(tenant), (sql) =>
        listNamedVersions(sql, tenant.tenantId, doc.doc_id),
      );
      expect(versions).toEqual([
        {
          seq: Number(seq),
          name: 'First draft',
          createdBy: tenant.principalId,
          createdAt: version.createdAt,
        },
      ]);
    });

    it('renames in place rather than erroring on a second call at the same seq', async () => {
      const tenant = TENANTS.alpha;
      const doc = await open(tenant);
      const ed = editor();
      const seq = await write(tenant, ed.rewriteTo('draft'), tenant.principalId, 1);

      await withTenantScope(pool, scopeOf(tenant), (sql) =>
        nameVersion(
          sql,
          tenant.tenantId,
          doc.doc_id,
          Number(seq),
          'First name',
          tenant.principalId,
        ),
      );
      await withTenantScope(pool, scopeOf(tenant), (sql) =>
        nameVersion(
          sql,
          tenant.tenantId,
          doc.doc_id,
          Number(seq),
          'Better name',
          tenant.principalId,
        ),
      );

      const versions = await withTenantScope(pool, scopeOf(tenant), (sql) =>
        listNamedVersions(sql, tenant.tenantId, doc.doc_id),
      );

      expect(versions).toHaveLength(1);
      expect(versions[0]?.name).toBe('Better name');
    });

    it('deleteNamedVersion removes the name but leaves the pinned snapshot', async () => {
      const tenant = TENANTS.alpha;
      const doc = await open(tenant);
      const ed = editor();
      const seq = await write(tenant, ed.rewriteTo('draft'), tenant.principalId, 0);

      await withTenantScope(pool, scopeOf(tenant), (sql) =>
        nameVersion(sql, tenant.tenantId, doc.doc_id, Number(seq), 'Temporary', tenant.principalId),
      );

      const removed = await withTenantScope(pool, scopeOf(tenant), (sql) =>
        deleteNamedVersion(sql, tenant.tenantId, doc.doc_id, Number(seq)),
      );
      expect(removed).toBe(true);

      const removedAgain = await withTenantScope(pool, scopeOf(tenant), (sql) =>
        deleteNamedVersion(sql, tenant.tenantId, doc.doc_id, Number(seq)),
      );
      expect(removedAgain).toBe(false);

      const snapshot = await withTenantScope(pool, scopeOf(tenant), (sql) =>
        sql.query('SELECT 1 FROM content_snapshot WHERE doc_id = $1 AND seq = $2', [
          doc.doc_id,
          seq.toString(),
        ]),
      );
      expect(snapshot.rows).toHaveLength(1);
    });
  });

  describe('pruneHistory', () => {
    it('keeps the base snapshot and named snapshots, and deletes only what the rule allows', async () => {
      const tenant = TENANTS.alpha;
      const doc = await open(tenant);
      const ed = editor();

      const seqs: bigint[] = [];
      for (const text of ['one', 'two', 'three', 'four', 'five']) {
        seqs.push(await write(tenant, ed.rewriteTo(text), tenant.principalId, 1));
      }
      const [seq1, seq2, seq3, , seq5] = seqs;
      if (seq1 === undefined || seq2 === undefined || seq3 === undefined || seq5 === undefined) {
        throw new Error('Expected five sequences.');
      }

      // Name the second revision, so its snapshot survives even though it is older than the
      // base pruning will settle on.
      await withTenantScope(pool, scopeOf(tenant), (sql) =>
        nameVersion(sql, tenant.tenantId, doc.doc_id, Number(seq2), 'Keep me', tenant.principalId),
      );

      // Backdate the first three snapshots and updates well past any real retention window,
      // and leave the last two at "now" - the fixture for "some of this history is old,
      // some of it just happened".
      const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      const admin = adminPool();
      try {
        for (const seq of [seq1, seq2, seq3]) {
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
        pruneHistory(sql, tenant.tenantId, doc.doc_id, 30),
      );

      // The base becomes seq3 - the newest snapshot at or before the 30-day cutoff. Updates
      // 1..3 are subsumed by it and are deleted; the named snapshot at seq2 is kept anyway,
      // and the unnamed one at seq1 is not.
      expect(result).toEqual({ updatesDeleted: 3, snapshotsDeleted: 1 });

      const remainingUpdates = await withTenantScope(pool, scopeOf(tenant), (sql) =>
        sql.query<{ seq: string }>(
          'SELECT seq FROM content_update WHERE doc_id = $1 ORDER BY seq',
          [doc.doc_id],
        ),
      );
      expect(remainingUpdates.rows.map((row) => row.seq)).toEqual(['4', '5']);

      const remainingSnapshots = await withTenantScope(pool, scopeOf(tenant), (sql) =>
        sql.query<{ seq: string }>(
          'SELECT seq FROM content_snapshot WHERE doc_id = $1 ORDER BY seq',
          [doc.doc_id],
        ),
      );
      // seq1 gone; seq2 (named), seq3 (base), and seq4/seq5 (after the base, never touched)
      // all remain.
      expect(remainingSnapshots.rows.map((row) => row.seq)).toEqual(['2', '3', '4', '5']);

      // The head is untouched: stateAt at the most recent sequence still works.
      const head = await withTenantScope(pool, scopeOf(tenant), (sql) =>
        stateAt(sql, tenant.tenantId, doc.doc_id, Number(seq5)),
      );
      expect(head?.getXmlFragment(FRAGMENT_NAME).toJSON()).toContain('five');
    });

    it('is a no-op when no snapshot is old enough to be a base', async () => {
      const tenant = TENANTS.alpha;
      const doc = await open(tenant);
      const ed = editor();
      await write(tenant, ed.rewriteTo('fresh'), tenant.principalId, 1);

      const result = await withTenantScope(pool, scopeOf(tenant), (sql) =>
        pruneHistory(sql, tenant.tenantId, doc.doc_id, 30),
      );

      expect(result).toEqual({ updatesDeleted: 0, snapshotsDeleted: 0 });
    });
  });
});
