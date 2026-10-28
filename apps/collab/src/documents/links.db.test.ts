import { nixSchema } from '@nix/editor-schema';
import type { Pool } from 'pg';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  DB_TESTS_ENABLED,
  TENANTS,
  clearContent,
  collabPool,
  seedTenants,
  scopeOf,
  type TestTenant,
} from '../db/testing.ts';
import { withTenantScope } from '../db/tenant-scope.ts';
import { FRAGMENT_NAME, applyUpdate, openDocument } from './service.ts';

/**
 * The link graph and the search text, written as a side effect of a snapshot, against Postgres.
 *
 * These are the two derived tables MVP-3 reads from, and neither can be checked without a
 * database: the interesting behaviour is in the upsert's conflict clause, in a foreign key that
 * must not be allowed to fail the transaction, and in whether row-level security confines an edge
 * to the tenant whose document produced it.
 *
 * Requires the development stack: `docker compose -f deploy/compose.dev.yml --profile core up
 * -d`, then `deploy/seed/seed.sh`, then the migrator.
 */
describe.skipIf(!DB_TESTS_ENABLED)('the link graph, against Postgres', () => {
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

  /**
   * One editor, editing one document over time.
   *
   * **Stateful on purpose.** Yjs updates merge, they do not replace: two updates built from two
   * fresh `Y.Doc`s produce a document holding both paragraphs, which is exactly the convergence
   * property the log exists for and exactly the wrong fixture for "the document now says
   * something else". Rewriting the same document carries the deletions with it, which is what a
   * person removing a link actually sends.
   *
   * Built through the shared schema, so a node this build cannot express cannot be smuggled into
   * a fixture - which is the whole point of the schema living in its own package.
   */
  function editor(): { rewriteTo: (...inline: object[]) => Uint8Array } {
    const doc = new Y.Doc();

    return {
      rewriteTo(...inline: object[]): Uint8Array {
        const fragment = doc.getXmlFragment(FRAGMENT_NAME);
        doc.transact(() => {
          fragment.delete(0, fragment.length);
        });

        prosemirrorJSONToYXmlFragment(
          nixSchema,
          { type: 'doc', content: [{ type: 'paragraph', content: inline }] },
          fragment,
        );

        return Y.encodeStateAsUpdate(doc);
      },
    };
  }

  function referenceTo(targetId: string) {
    return { type: 'reference', attrs: { kind: 'item', targetId, label: 'A title' } };
  }

  function text(value: string) {
    return { type: 'text', text: value };
  }

  /** Writes one update and forces the snapshot that publishes the derived rows. */
  async function writeAndSnapshot(tenant: TestTenant, update: Uint8Array): Promise<void> {
    const doc = await open(tenant);
    const result = await withTenantScope(pool, scopeOf(tenant), (sql) =>
      applyUpdate(sql, {
        tenantId: tenant.tenantId,
        doc,
        updateBytes: update,
        actorId: tenant.principalId,
        clientId: 'client',
        // Every sequence is a snapshot: this suite is about what a snapshot writes, not about
        // when one is due.
        snapshotEvery: 1,
      }),
    );

    if (!result.ok) throw new Error(`The update was refused: ${result.error.code}`);
  }

  async function edgesOf(tenant: TestTenant): Promise<{ target: string; occurrences: number }[]> {
    const { rows } = await withTenantScope(pool, scopeOf(tenant), (sql) =>
      sql.query<{ target_item_id: string; occurrences: number }>(
        `SELECT target_item_id, occurrences FROM item_link
          WHERE tenant_id = $1 AND source_item_id = $2
          ORDER BY target_item_id`,
        [tenant.tenantId, tenant.itemId],
      ),
    );

    return rows.map((row) => ({ target: row.target_item_id, occurrences: row.occurrences }));
  }

  it('writes an edge for a reference the document holds', async () => {
    const alpha = editor();
    await writeAndSnapshot(TENANTS.alpha, alpha.rewriteTo(referenceTo(TENANTS.alpha.targetItemId)));

    expect(await edgesOf(TENANTS.alpha)).toEqual([
      { target: TENANTS.alpha.targetItemId, occurrences: 1 },
    ]);
  });

  it('clears an edge the document no longer holds', async () => {
    const alpha = editor();
    await writeAndSnapshot(TENANTS.alpha, alpha.rewriteTo(referenceTo(TENANTS.alpha.targetItemId)));
    expect(await edgesOf(TENANTS.alpha)).toHaveLength(1);

    // The panel showing a link that was deleted is worse than showing none: it sends a reader to
    // a document that says nothing about them.
    await writeAndSnapshot(TENANTS.alpha, alpha.rewriteTo(text('The link is gone')));

    expect(await edgesOf(TENANTS.alpha)).toEqual([]);
  });

  it('replaces the count rather than accumulating it across snapshots', async () => {
    const target = TENANTS.alpha.targetItemId;
    const alpha = editor();

    await writeAndSnapshot(
      TENANTS.alpha,
      alpha.rewriteTo(referenceTo(target), text(' and '), referenceTo(target)),
    );
    await writeAndSnapshot(TENANTS.alpha, alpha.rewriteTo(referenceTo(target)));

    // Two snapshots of a document mentioning a target once must not read as two mentions. An
    // insert that added instead of replacing would grow this on every keystroke batch.
    expect(await edgesOf(TENANTS.alpha)).toEqual([{ target, occurrences: 1 }]);
  });

  it('drops a reference to an item that does not exist rather than failing the snapshot', async () => {
    const missing = '00000000-0000-4000-8000-0000000000ff';

    // A reference can outlive its target - the item was deleted, or the id was never real. Left
    // to the foreign key this would abort the transaction and take the snapshot with it, so the
    // document would stop saving because of a stale link.
    await writeAndSnapshot(
      TENANTS.alpha,
      editor().rewriteTo(referenceTo(missing), referenceTo(TENANTS.alpha.targetItemId)),
    );

    expect(await edgesOf(TENANTS.alpha)).toEqual([
      { target: TENANTS.alpha.targetItemId, occurrences: 1 },
    ]);
  });

  it('refuses to write an edge into another tenant s item', async () => {
    // The worst case, and the one the constraint exists for: a document naming an identifier it
    // could only have got by guessing. The target is real, and it is not this tenant's.
    await writeAndSnapshot(
      TENANTS.alpha,
      editor().rewriteTo(referenceTo(TENANTS.beta.targetItemId)),
    );

    expect(await edgesOf(TENANTS.alpha)).toEqual([]);
  });

  it('never shows one tenant the other tenant s edges', async () => {
    await writeAndSnapshot(
      TENANTS.alpha,
      editor().rewriteTo(referenceTo(TENANTS.alpha.targetItemId)),
    );

    // Beta knows Alpha's item identifier, which is not a secret. The policy is what makes the
    // row invisible anyway.
    const { rows } = await withTenantScope(pool, scopeOf(TENANTS.beta), (sql) =>
      sql.query('SELECT 1 FROM item_link WHERE source_item_id = $1', [TENANTS.alpha.itemId]),
    );

    expect(rows).toEqual([]);
  });

  it('indexes the document s words, and the titles it links to', async () => {
    // `leafText` puts a reference's label into the plaintext on purpose: a note whose only
    // mention of a topic is a link to it should still be findable by that topic.
    await writeAndSnapshot(
      TENANTS.alpha,
      editor().rewriteTo(text('Groundwork for '), referenceTo(TENANTS.alpha.targetItemId)),
    );

    const { rows } = await withTenantScope(pool, scopeOf(TENANTS.alpha), (sql) =>
      sql.query<{ matched: boolean }>(
        `SELECT body_vector @@ websearch_to_tsquery('english', $2) AS matched
           FROM item_search WHERE tenant_id = $1 AND item_id = $3`,
        [TENANTS.alpha.tenantId, 'groundwork', TENANTS.alpha.itemId],
      ),
    );

    expect(rows.map((row) => row.matched)).toEqual([true]);
  });

  it('replaces the indexed text rather than keeping what the document used to say', async () => {
    const alpha = editor();
    await writeAndSnapshot(TENANTS.alpha, alpha.rewriteTo(text('Postgres replication')));
    await writeAndSnapshot(TENANTS.alpha, alpha.rewriteTo(text('Something else entirely')));

    const { rows } = await withTenantScope(pool, scopeOf(TENANTS.alpha), (sql) =>
      sql.query<{ stale: boolean; fresh: boolean }>(
        `SELECT body_vector @@ websearch_to_tsquery('english', 'replication') AS stale,
                body_vector @@ websearch_to_tsquery('english', 'entirely')    AS fresh
           FROM item_search WHERE tenant_id = $1 AND item_id = $2`,
        [TENANTS.alpha.tenantId, TENANTS.alpha.itemId],
      ),
    );

    // One row, and it describes the document as it is now. This is the whole reason the vector
    // is not a generated column on `content_snapshot`, which keeps every version it ever had.
    expect(rows).toEqual([{ stale: false, fresh: true }]);
  });
});
