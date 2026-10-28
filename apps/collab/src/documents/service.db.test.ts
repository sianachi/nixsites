import { SCHEMA_VERSION, nixSchema } from '@nix/editor-schema';
import type { Pool } from 'pg';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { appendUpdates, findDocByItem, updatesAfter } from '../db/documents.ts';
import {
  DB_TESTS_ENABLED,
  TENANTS,
  clearContent,
  collabPool,
  seedTenants,
  scopeOf,
  type TestTenant,
} from '../db/testing.ts';
import { listRevisions, stateAt } from '../db/history.ts';
import { withTenantScope, type ScopedQuery } from '../db/tenant-scope.ts';
import { canvasStrategy, noteStrategy } from './body-kinds.ts';
import {
  FRAGMENT_NAME,
  applyUpdate,
  loadDocument,
  openDocument,
  restoreDocument,
} from './service.ts';

/**
 * The collaboration service against real Postgres.
 *
 * Two claims are being made here and neither can be checked without a database. The first is
 * that this service isolates tenants - it reaches the content tables directly, with its own
 * credentials, and the .NET interceptor that enforces the scope on the other side does not
 * exist in Node. The second is that concurrent edits converge, which is the whole reason the
 * log holds Yjs updates rather than document snapshots.
 *
 * Requires the development stack: `docker compose -f deploy/compose.dev.yml --profile core up
 * -d`, then `deploy/seed/seed.sh`, then the migrator.
 */
describe.skipIf(!DB_TESTS_ENABLED)('the collaboration service, against Postgres', () => {
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
   * One update that types `text` into an empty document.
   *
   * Built through the shared schema, so a block this build cannot express cannot be smuggled
   * into a fixture - which is the whole point of the schema living in its own package.
   */
  function updateTyping(text: string): Uint8Array {
    const doc = new Y.Doc();
    prosemirrorJSONToYXmlFragment(
      nixSchema,
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
      doc.getXmlFragment(FRAGMENT_NAME),
    );

    return Y.encodeStateAsUpdate(doc);
  }

  it('creates a document body on first use, once, whoever asks first', async () => {
    const first = await open(TENANTS.alpha);
    const second = await open(TENANTS.alpha);

    expect(second.doc_id).toBe(first.doc_id);
    expect(second.schema_version).toBe(SCHEMA_VERSION);
  });

  it('never shows one tenant the other tenant s document', async () => {
    await open(TENANTS.alpha);
    await open(TENANTS.beta);

    // Beta asking for Alpha's item. The row exists; the policies make it invisible.
    const seen = await withTenantScope(pool, scopeOf(TENANTS.beta), (sql) =>
      findDocByItem(sql, TENANTS.alpha.tenantId, TENANTS.alpha.itemId),
    );

    expect(seen).toBeNull();
  });

  it('never shows one tenant the other tenant s updates', async () => {
    const alpha = await open(TENANTS.alpha);

    await withTenantScope(pool, scopeOf(TENANTS.alpha), (sql) =>
      applyUpdate(sql, {
        tenantId: TENANTS.alpha.tenantId,
        doc: alpha,
        updateBytes: updateTyping('Alpha writes here'),
        actorId: TENANTS.alpha.principalId,
        clientId: 'alpha-client',
        snapshotEvery: 0,
      }),
    );

    // Beta knows Alpha's document identifier - the worst case, and the one the policies have
    // to survive, because an identifier is not a secret.
    const rows = await withTenantScope(pool, scopeOf(TENANTS.beta), (sql) =>
      updatesAfter(sql, TENANTS.alpha.tenantId, alpha.doc_id, 0n, 100),
    );

    expect(rows).toEqual([]);
  });

  it('allocates sequences without gaps or collisions across concurrent appends', async () => {
    const alpha = await open(TENANTS.alpha);

    const appends = Array.from({ length: 8 }, (_unused, index) =>
      withTenantScope(pool, scopeOf(TENANTS.alpha), (sql) =>
        applyUpdate(sql, {
          tenantId: TENANTS.alpha.tenantId,
          doc: alpha,
          updateBytes: updateTyping(`edit ${String(index)}`),
          actorId: TENANTS.alpha.principalId,
          clientId: `client-${String(index)}`,
          snapshotEvery: 0,
        }),
      ),
    );

    const results = await Promise.all(appends);
    const sequences = results
      .map((result) => (result.ok ? Number(result.value.seq) : -1))
      .sort((left, right) => left - right);

    // The database allocates them under a row lock, so eight concurrent appends produce
    // exactly 1..8. A number chosen in the service would collide the first time two people
    // typed at once, and the log would lose one of them.
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('converges two clients that edited without seeing each other', async () => {
    const alpha = await open(TENANTS.alpha);

    // Two documents that share no history: this is the offline case, and the reason the log
    // holds CRDT updates rather than document snapshots. Last-write-wins would lose one side.
    const left = new Y.Doc();
    const right = new Y.Doc();

    left.getXmlFragment(FRAGMENT_NAME);
    right.getXmlFragment(FRAGMENT_NAME);

    prosemirrorJSONToYXmlFragment(
      nixSchema,
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'left' }] }] },
      left.getXmlFragment(FRAGMENT_NAME),
    );
    prosemirrorJSONToYXmlFragment(
      nixSchema,
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'right' }] }] },
      right.getXmlFragment(FRAGMENT_NAME),
    );

    for (const [clientId, update] of [
      ['left', Y.encodeStateAsUpdate(left)],
      ['right', Y.encodeStateAsUpdate(right)],
    ] as const) {
      const result = await withTenantScope(pool, scopeOf(TENANTS.alpha), (sql) =>
        applyUpdate(sql, {
          tenantId: TENANTS.alpha.tenantId,
          doc: alpha,
          updateBytes: update,
          actorId: TENANTS.alpha.principalId,
          clientId,
          snapshotEvery: 0,
        }),
      );

      expect(result.ok).toBe(true);
    }

    const merged = await withTenantScope(pool, scopeOf(TENANTS.alpha), async (sql) => {
      const doc = await findDocByItem(sql, TENANTS.alpha.tenantId, TENANTS.alpha.itemId);
      if (doc === null) throw new Error('The document disappeared.');
      return await loadDocument(sql, TENANTS.alpha.tenantId, doc);
    });

    const text = merged.getXmlFragment(FRAGMENT_NAME).toJSON();

    // Both survive. Which order they appear in is the CRDT's decision and is deliberately
    // not asserted - what matters is that nothing was thrown away.
    expect(text).toContain('left');
    expect(text).toContain('right');
  });

  it('writes a snapshot on the cadence, and the snapshot is only an optimisation', async () => {
    const alpha = await open(TENANTS.alpha);

    for (let index = 0; index < 3; index += 1) {
      await withTenantScope(pool, scopeOf(TENANTS.alpha), (sql) =>
        applyUpdate(sql, {
          tenantId: TENANTS.alpha.tenantId,
          doc: alpha,
          updateBytes: updateTyping(`line ${String(index)}`),
          actorId: TENANTS.alpha.principalId,
          clientId: 'client',
          snapshotEvery: 2,
        }),
      );
    }

    const snapshots = await withTenantScope(pool, scopeOf(TENANTS.alpha), (sql) =>
      sql.query<{ seq: string }>(
        'SELECT seq FROM content_snapshot WHERE doc_id = $1 ORDER BY seq',
        [alpha.doc_id],
      ),
    );

    expect(snapshots.rows.map((row) => row.seq)).toEqual(['2']);
  });

  it('snapshots every update logged before its own, including one that committed mid-request', async () => {
    // The request reads the log, then takes the row lock that allocates its sequence. Another
    // writer committing between the two takes a sequence below this one that the request never
    // read - and a snapshot labelled with this request's sequence but built without it makes every
    // later load start past it. Interleaved deterministically: the other write commits, on its own
    // connection, at the moment this request is about to take the lock.
    const alpha = await open(TENANTS.alpha);
    const other = collabPool();
    try {
      let interleaved = false;
      await withTenantScope(pool, scopeOf(TENANTS.alpha), async (sql) => {
        const racing: ScopedQuery = {
          query: async (text, values) => {
            if (!interleaved && text.trimStart().startsWith('UPDATE content_doc')) {
              interleaved = true;
              const committed = await withTenantScope(other, scopeOf(TENANTS.alpha), (peer) =>
                applyUpdate(peer, {
                  tenantId: TENANTS.alpha.tenantId,
                  doc: alpha,
                  updateBytes: updateTyping('committed in between'),
                  actorId: TENANTS.alpha.principalId,
                  clientId: 'peer',
                  snapshotEvery: 1_000,
                }),
              );
              expect(committed.ok).toBe(true);
            }
            return await sql.query(text, values);
          },
        };
        const applied = await applyUpdate(racing, {
          tenantId: TENANTS.alpha.tenantId,
          doc: alpha,
          updateBytes: updateTyping('this request'),
          actorId: TENANTS.alpha.principalId,
          clientId: 'client',
          snapshotEvery: 1,
        });
        expect(applied.ok && applied.value).toMatchObject({ seq: 2n, snapshotWritten: true });
      });
    } finally {
      await other.end();
    }

    const reloaded = await withTenantScope(pool, scopeOf(TENANTS.alpha), async (sql) => {
      const doc = await findDocByItem(sql, TENANTS.alpha.tenantId, TENANTS.alpha.itemId);
      if (doc === null) throw new Error('The document vanished.');
      return await loadDocument(sql, TENANTS.alpha.tenantId, doc);
    });
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Y.XmlFragment defines its own XML toString.
    const text = reloaded.getXmlFragment(FRAGMENT_NAME).toString();
    expect(text).toContain('this request');
    expect(text).toContain('committed in between');
  });

  it('appends a run longer than one statement can carry', async () => {
    // Three parameters a row, and Postgres takes at most 65,535 in a statement: one INSERT tops
    // out near 21,800 updates. A flush requeued through a long outage reaches that with one person
    // typing, and every retry after recovery would fail on the protocol limit rather than the
    // database - the batch could never be written.
    const alpha = await open(TENANTS.alpha);
    const count = 22_000;
    const updates = Array.from({ length: count }, () => ({
      bytes: updateTyping('x'),
      clientId: 'long-run',
    }));

    const appended = await withTenantScope(pool, scopeOf(TENANTS.alpha), (sql) =>
      appendUpdates(sql, {
        tenantId: TENANTS.alpha.tenantId,
        docId: alpha.doc_id,
        updates,
        actorId: TENANTS.alpha.principalId,
      }),
    );

    expect(appended).toEqual({ firstSeq: 1n, lastSeq: BigInt(count) });
    const rows = await withTenantScope(pool, scopeOf(TENANTS.alpha), (sql) =>
      sql.query<{ count: string; max: string }>(
        'SELECT count(*)::text AS count, max(seq)::text AS max FROM content_update WHERE doc_id = $1',
        [alpha.doc_id],
      ),
    );
    expect(rows.rows[0]).toEqual({ count: String(count), max: String(count) });
    // This exercises 22,000 durable rows; allow a bounded margin when suites share a host.
  }, 20_000);

  it('refuses an update that is not a Yjs payload at all', async () => {
    const alpha = await open(TENANTS.alpha);

    const result = await withTenantScope(pool, scopeOf(TENANTS.alpha), (sql) =>
      applyUpdate(sql, {
        tenantId: TENANTS.alpha.tenantId,
        doc: alpha,
        updateBytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
        actorId: TENANTS.alpha.principalId,
        clientId: 'client',
        snapshotEvery: 0,
      }),
    );

    expect(result.ok).toBe(false);

    // Refused means nothing was stored: the log is the source of truth and must not hold a
    // payload that cannot be replayed.
    const rows = await withTenantScope(pool, scopeOf(TENANTS.alpha), (sql) =>
      updatesAfter(sql, TENANTS.alpha.tenantId, alpha.doc_id, 0n, 10),
    );

    expect(rows).toEqual([]);
  });

  it('refuses an update larger than the column would accept', async () => {
    const alpha = await open(TENANTS.alpha);

    const result = await withTenantScope(pool, scopeOf(TENANTS.alpha), (sql) =>
      applyUpdate(sql, {
        tenantId: TENANTS.alpha.tenantId,
        doc: alpha,
        updateBytes: new Uint8Array(2 * 1024 * 1024),
        actorId: TENANTS.alpha.principalId,
        clientId: 'client',
        snapshotEvery: 0,
      }),
    );

    // The service's ceiling matches the CHECK on the column, so this is a 413 with a code a
    // client can act on rather than a constraint violation surfacing as a 500.
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.code).toBe('update_too_large');
    expect(result.ok ? null : result.error.status).toBe(413);
  });

  describe('restoreDocument', () => {
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

    it('replaces the head with an old state as a new revision, keeping every old revision', async () => {
      const tenant = TENANTS.alpha;
      const doc = await open(tenant);
      const ed = editor();

      const seqs: bigint[] = [];
      for (const text of ['first', 'second', 'third']) {
        const applied = await withTenantScope(pool, scopeOf(tenant), (sql) =>
          applyUpdate(sql, {
            tenantId: tenant.tenantId,
            doc,
            updateBytes: ed.rewriteTo(text),
            actorId: tenant.principalId,
            clientId: 'writer',
            snapshotEvery: 0,
          }),
        );
        if (!applied.ok) throw new Error(`Setup update was refused: ${applied.error.code}`);
        seqs.push(applied.value.seq);
      }

      const targetSeq = seqs[1];
      if (targetSeq === undefined) throw new Error('Expected a target sequence.');

      const targetState = await withTenantScope(pool, scopeOf(tenant), (sql) =>
        stateAt(sql, tenant.tenantId, doc.doc_id, Number(targetSeq)),
      );
      if (targetState === null) throw new Error('Expected the target state to reconstruct.');
      const targetPlaintext = noteStrategy.materialize(targetState).plaintext;
      expect(targetPlaintext).toBe('second');

      // A different actor from the setup writes, so the restore lands as its own revision
      // rather than coalescing into the run that wrote 'third' - matching the ordinary case
      // where whoever restores is not whoever made the most recent edit.
      const restorerId = '00000000-0000-4000-8000-0000000000aa';
      const restored = await withTenantScope(pool, scopeOf(tenant), (sql) =>
        restoreDocument(sql, {
          tenantId: tenant.tenantId,
          doc,
          seq: Number(targetSeq),
          actorId: restorerId,
          clientId: 'restorer',
        }),
      );
      if (!restored.ok) throw new Error(`Restore was refused: ${restored.error.code}`);

      // The restore is a new revision, strictly after every prior write - not a rewind of the
      // log, and not a no-op that happened to leave the head where it already was.
      expect(restored.value.seq).toBeGreaterThan(seqs[2] ?? 0n);

      const head = await withTenantScope(pool, scopeOf(tenant), async (sql) => {
        const current = await findDocByItem(sql, tenant.tenantId, tenant.itemId);
        if (current === null) throw new Error('The document disappeared.');
        return await loadDocument(sql, tenant.tenantId, current);
      });
      expect(noteStrategy.materialize(head).plaintext).toBe(targetPlaintext);

      // Restoring never deletes history: every prior revision is still exactly as
      // reconstructable as it was before the restore ran.
      for (const [index, text] of ['first', 'second', 'third'].entries()) {
        const seq = seqs[index];
        if (seq === undefined) throw new Error('Expected a sequence.');
        const state = await withTenantScope(pool, scopeOf(tenant), (sql) =>
          stateAt(sql, tenant.tenantId, doc.doc_id, Number(seq)),
        );
        if (state === null) throw new Error('Expected the old state to reconstruct.');
        expect(noteStrategy.materialize(state).plaintext).toBe(text);
      }

      const revisions = await withTenantScope(pool, scopeOf(tenant), (sql) =>
        listRevisions(sql, tenant.tenantId, doc.doc_id, { limit: 10 }),
      );
      // The three original writes (one actor, one revision) plus the restore (a different
      // actor, its own revision). Nothing about restoring collapsed or removed the earlier one.
      expect(revisions.revisions).toHaveLength(2);
      expect(revisions.revisions[0]?.actorId).toBe(restorerId);
    });

    it('refuses to restore a sequence beyond the head', async () => {
      const tenant = TENANTS.alpha;
      const doc = await open(tenant);
      const ed = editor();

      const applied = await withTenantScope(pool, scopeOf(tenant), (sql) =>
        applyUpdate(sql, {
          tenantId: tenant.tenantId,
          doc,
          updateBytes: ed.rewriteTo('only'),
          actorId: tenant.principalId,
          clientId: 'writer',
          snapshotEvery: 0,
        }),
      );
      if (!applied.ok) throw new Error(`Setup update was refused: ${applied.error.code}`);

      const restored = await withTenantScope(pool, scopeOf(tenant), (sql) =>
        restoreDocument(sql, {
          tenantId: tenant.tenantId,
          doc,
          seq: Number(applied.value.seq) + 100,
          actorId: tenant.principalId,
          clientId: 'restorer',
        }),
      );

      expect(restored.ok).toBe(false);
      expect(restored.ok ? null : restored.error.code).toBe('history_state_unavailable');
      expect(restored.ok ? null : restored.error.status).toBe(404);
    });

    it('refuses to restore a body kind with no fragment to restore into', async () => {
      const tenant = TENANTS.alpha;
      const doc = await open(tenant);

      const restored = await withTenantScope(pool, scopeOf(tenant), (sql) =>
        restoreDocument(sql, {
          tenantId: tenant.tenantId,
          doc,
          seq: 0,
          actorId: tenant.principalId,
          clientId: 'restorer',
          strategy: canvasStrategy,
        }),
      );

      expect(restored.ok).toBe(false);
      expect(restored.ok ? null : restored.error.code).toBe('history_state_unavailable');
    });
  });
});
