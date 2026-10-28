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
import { backfillChunks } from './chunk-backfill.ts';
import { FRAGMENT_NAME, applyUpdate, openDocument } from './service.ts';

/**
 * Retrieval chunks, written as a side effect of a snapshot, against Postgres. Requires the
 * development stack, as `links.db.test.ts` does.
 */
describe.skipIf(!DB_TESTS_ENABLED)('note chunks, against Postgres', () => {
  let pool: Pool;
  const doc = new Y.Doc();

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
    doc.getXmlFragment(FRAGMENT_NAME).delete(0, doc.getXmlFragment(FRAGMENT_NAME).length);
  });

  const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const heading = (text: string) => ({
    type: 'heading',
    attrs: { level: 1 },
    content: [{ type: 'text', text }],
  });

  async function writeAndSnapshot(tenant: TestTenant, ...blocks: object[]): Promise<void> {
    const fragment = doc.getXmlFragment(FRAGMENT_NAME);
    doc.transact(() => {
      fragment.delete(0, fragment.length);
    });
    prosemirrorJSONToYXmlFragment(nixSchema, { type: 'doc', content: blocks }, fragment);

    const opened = await withTenantScope(pool, scopeOf(tenant), (sql) =>
      openDocument(sql, tenant.tenantId, tenant.itemId, tenant.workspaceId, () => tenant.docId),
    );
    if (opened === null) throw new Error('The document was not created.');
    const result = await withTenantScope(pool, scopeOf(tenant), (sql) =>
      applyUpdate(sql, {
        tenantId: tenant.tenantId,
        doc: opened,
        updateBytes: Y.encodeStateAsUpdate(doc),
        actorId: tenant.principalId,
        clientId: 'client',
        snapshotEvery: 1,
      }),
    );
    if (!result.ok) throw new Error(`The update was refused: ${result.error.code}`);
  }

  async function chunksOf(tenant: TestTenant) {
    const { rows } = await withTenantScope(pool, scopeOf(tenant), (sql) =>
      sql.query<{ ord: number; heading: string; body: string; embedded: boolean }>(
        `SELECT ord, heading, body, embedding IS NOT NULL AS embedded
           FROM item_chunk WHERE tenant_id = $1 AND item_id = $2 ORDER BY ord`,
        [tenant.tenantId, tenant.itemId],
      ),
    );
    return rows;
  }

  /** Stands in for Core's embedder, which writes through a definer function the test role lacks. */
  async function embedAll(tenant: TestTenant): Promise<void> {
    const admin = adminPool();
    try {
      await admin.query(
        `UPDATE item_chunk SET embedding = array_fill(0.1, ARRAY[384])::vector WHERE tenant_id = $1`,
        [tenant.tenantId],
      );
    } finally {
      await admin.end();
    }
  }

  it('writes one chunk per section, with its heading', async () => {
    await writeAndSnapshot(TENANTS.alpha, heading('Fees'), paragraph('Late fees are 2%.'));

    expect(await chunksOf(TENANTS.alpha)).toEqual([
      { ord: 0, heading: 'Fees', body: 'Late fees are 2%.', embedded: false },
    ]);
  });

  it('keeps the embedding of a passage that only moved, and drops the edited one', async () => {
    await writeAndSnapshot(
      TENANTS.alpha,
      heading('A'),
      paragraph('Kept.'),
      heading('B'),
      paragraph('Edited.'),
    );
    await embedAll(TENANTS.alpha);

    await writeAndSnapshot(
      TENANTS.alpha,
      paragraph('New intro.'),
      heading('A'),
      paragraph('Kept.'),
      heading('B'),
      paragraph('Changed.'),
    );

    expect(await chunksOf(TENANTS.alpha)).toEqual([
      { ord: 0, heading: '', body: 'New intro.', embedded: false },
      { ord: 1, heading: 'A', body: 'Kept.', embedded: true },
      { ord: 2, heading: 'B', body: 'Changed.', embedded: false },
    ]);
  });

  it('deletes the chunks past a shortened note s end', async () => {
    await writeAndSnapshot(
      TENANTS.alpha,
      heading('A'),
      paragraph('One.'),
      heading('B'),
      paragraph('Two.'),
    );
    await writeAndSnapshot(TENANTS.alpha, heading('A'), paragraph('One.'));

    expect((await chunksOf(TENANTS.alpha)).map((chunk) => chunk.body)).toEqual(['One.']);
  });

  it('never shows one tenant the other tenant s chunks', async () => {
    await writeAndSnapshot(TENANTS.alpha, paragraph('Alpha only.'));

    const { rows } = await withTenantScope(pool, scopeOf(TENANTS.beta), (sql) =>
      sql.query('SELECT 1 FROM item_chunk WHERE item_id = $1', [TENANTS.alpha.itemId]),
    );

    expect(rows).toEqual([]);
  });

  it('backfills a note snapshotted before chunks existed', async () => {
    await writeAndSnapshot(TENANTS.alpha, paragraph('Written long ago.'));
    const admin = adminPool();
    try {
      await admin.query('DELETE FROM item_chunk WHERE tenant_id = $1', [TENANTS.alpha.tenantId]);
    } finally {
      await admin.end();
    }

    const written = await withTenantScope(pool, scopeOf(TENANTS.alpha), (sql) =>
      backfillChunks(sql, TENANTS.alpha.tenantId, 10),
    );

    expect(written).toBe(1);
    expect((await chunksOf(TENANTS.alpha)).map((chunk) => chunk.body)).toEqual([
      'Written long ago.',
    ]);
  });
});
