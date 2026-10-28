import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';

import { nixSchema } from '@nix/editor-schema';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';

import { connectDocumentLocks } from '../db/advisory-lock.ts';
import {
  DB_TESTS_ENABLED,
  TENANTS,
  TEST_DATABASE_URL,
  collabPool,
  clearContent,
  seedTenants,
} from '../db/testing.ts';
import { withTenantScope } from '../db/tenant-scope.ts';
import { CLOSE_CODES, MESSAGE_AWARENESS, MESSAGE_NOTICE } from '../ws/protocol.ts';
import { createDocumentRegistry } from './registry.ts';
import { LIMITS } from './limits.ts';
import { applyUpdate, openDocument } from './service.ts';
import { DocumentSession } from './session.ts';
import {
  FAST,
  SECOND_PRINCIPAL,
  adminPool,
  connectTestClient,
  countUpdates,
  fakeSocketSession,
  startLiveServer,
  textOf,
  typeParagraph,
  until,
  updateFrame,
  type FakeSocketSession,
  type LiveHarness,
  type TestClient,
} from './testing-live.ts';

/**
 * The document lifecycle against real Postgres and real sockets: load once, sync live,
 * flush batched, snapshot on cadence, evict when idle - and recover all of it on
 * reconnect, because the log is the source of truth and memory never is.
 */

describe.runIf(DB_TESTS_ENABLED)('the document lifecycle, against Postgres', () => {
  let verifyPool: Pool;

  beforeAll(async () => {
    await seedTenants();
    verifyPool = adminPool();
  });

  afterAll(async () => {
    await verifyPool.end();
  });

  beforeEach(async () => {
    await clearContent();
  });

  const harnesses: LiveHarness[] = [];
  const clients: TestClient[] = [];

  function track(harness: LiveHarness): LiveHarness {
    harnesses.push(harness);
    return harness;
  }

  /** How many snapshots Alpha's document has, read as an owner that can see them all. */
  async function snapshotCount(): Promise<number> {
    const { rows } = await verifyPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM content_snapshot s JOIN content_doc d USING (doc_id)
       WHERE d.tenant_id = $1 AND d.item_id = $2`,
      [TENANTS.alpha.tenantId, TENANTS.alpha.itemId],
    );

    return Number(rows[0]?.count ?? '0');
  }

  function open(url: string, itemId: string, token = 'as-first-principal'): TestClient {
    const client = connectTestClient(url, itemId, token);
    clients.push(client);
    return client;
  }

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.close();
    }
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  });

  it('converges two live clients through the resident document', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha));
    const alice = open(harness.url, TENANTS.alpha.itemId);
    const bella = open(harness.url, TENANTS.alpha.itemId);
    await Promise.all([alice.ready, bella.ready]);

    typeParagraph(alice.doc, 'Hello from the first editor.');
    typeParagraph(bella.doc, 'And from the second.');

    await until(
      () =>
        textOf(alice.doc) === textOf(bella.doc) &&
        textOf(alice.doc).includes('first editor') &&
        textOf(alice.doc).includes('the second'),
      'both clients to converge',
    );
  });

  it('publishes searchable text on a stateless REST write, not on the resident cadence', async () => {
    // The regression this pins (found live 2026-08-21, importing 10k notes through nixctl): the
    // REST update path applied the resident snapshot cadence, and a snapshot is what publishes a
    // document's searchable text and link edges. A body written once over HTTP - seq 1, cadence
    // 5 here, 200 in production - therefore never published: no session, no idle clock, no
    // eviction ever owed it a snapshot. The stateless path's request end is its detach, so every
    // accepted REST update publishes immediately.
    const harness = track(await startLiveServer(TENANTS.alpha));
    const base = harness.url.replace('ws://', 'http://');

    // Text and a reference, because a snapshot publishes both derived tables and this is the one
    // end-to-end pin of the stateless path: a change that split the two writes must fail here.
    const authored = new Y.Doc();
    prosemirrorJSONToYXmlFragment(
      nixSchema,
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'imported by rest and searchable ' },
              {
                type: 'reference',
                attrs: { kind: 'item', targetId: TENANTS.alpha.targetItemId, label: 'A title' },
              },
            ],
          },
        ],
      },
      authored.getXmlFragment('default'),
    );
    const response = await fetch(`${base}/documents/${TENANTS.alpha.itemId}/updates`, {
      method: 'POST',
      headers: { authorization: 'Bearer anyone', 'content-type': 'application/json' },
      body: JSON.stringify({
        update: Buffer.from(Y.encodeStateAsUpdate(authored)).toString('base64'),
        clientId: 'rest-import',
      }),
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as { seq: string; snapshotWritten: boolean };
    // Seq 1 against a cadence of 5: the cadence alone would not have published this.
    expect(body.seq).toBe('1');
    expect(body.snapshotWritten).toBe(true);

    const { rows } = await verifyPool.query<{ matches: boolean }>(
      `SELECT body_vector @@ plainto_tsquery('english', 'imported by rest') AS matches
       FROM item_search
       WHERE tenant_id = $1 AND item_id = $2`,
      [TENANTS.alpha.tenantId, TENANTS.alpha.itemId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.matches).toBe(true);

    const links = await verifyPool.query<{ target_item_id: string; occurrences: number }>(
      `SELECT target_item_id, occurrences FROM item_link
       WHERE tenant_id = $1 AND source_item_id = $2`,
      [TENANTS.alpha.tenantId, TENANTS.alpha.itemId],
    );
    expect(links.rows).toEqual([{ target_item_id: TENANTS.alpha.targetItemId, occurrences: 1 }]);
  });

  it('shows a REST write to the editors already in the document', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha));
    const alice = open(harness.url, TENANTS.alpha.itemId);
    await alice.ready;
    typeParagraph(alice.doc, 'Typed in the editor.');
    await until(
      async () => (await countUpdates(verifyPool, TENANTS.alpha)) >= 1,
      'the editor flush',
    );

    const authored = new Y.Doc();
    typeParagraph(authored, 'Written over REST.');
    const response = await fetch(
      `${harness.url.replace('ws://', 'http://')}/documents/${TENANTS.alpha.itemId}/updates`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer anyone', 'content-type': 'application/json' },
        body: JSON.stringify({
          update: Buffer.from(Y.encodeStateAsUpdate(authored)).toString('base64'),
          clientId: 'rest-writer',
        }),
      },
    );
    expect(response.status).toBe(202);

    await until(
      () => textOf(alice.doc).includes('Written over REST.'),
      'the open editor to receive the REST write',
    );
  });

  it('returns a retained checkpoint and its live tail after covered updates are pruned', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha));
    const url = `${harness.url.replace('ws://', 'http://')}/documents/${TENANTS.alpha.itemId}/updates`;
    const authored = new Y.Doc();
    typeParagraph(authored, 'Retained checkpoint.');
    const checkpoint = Buffer.from(Y.encodeStateAsUpdate(authored)).toString('base64');
    const written = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer anyone', 'content-type': 'application/json' },
      body: JSON.stringify({ update: checkpoint, clientId: 'checkpoint-writer' }),
    });
    expect(written.status).toBe(202);
    await verifyPool.query(
      `DELETE FROM content_update WHERE tenant_id = $1 AND doc_id IN (SELECT doc_id FROM content_doc WHERE tenant_id = $1 AND item_id = $2)`,
      [TENANTS.alpha.tenantId, TENANTS.alpha.itemId],
    );

    const alice = open(harness.url, TENANTS.alpha.itemId);
    await alice.ready;
    typeParagraph(alice.doc, 'Live tail.');
    await until(
      async () => (await countUpdates(verifyPool, TENANTS.alpha)) === 1,
      'the tail to become durable',
    );
    const response = await fetch(url, { headers: { authorization: 'Bearer anyone' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      checkpoint: { seq: '1', update: checkpoint },
      headSeq: '2',
      canWrite: true,
      updates: [{ seq: '2' }],
    });
    const tail = await fetch(`${url}?after=1`, { headers: { authorization: 'Bearer anyone' } });
    expect(tail.status).toBe(200);
    expect(await tail.json()).toMatchObject({ headSeq: '2', updates: [{ seq: '2' }] });
  });

  it('starts an opted-in HTTP download after its checkpoint while preserving the legacy page', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha));
    const url = `${harness.url.replace('ws://', 'http://')}/documents/${TENANTS.alpha.itemId}/updates`;
    const authored = new Y.Doc();
    typeParagraph(authored, 'Checkpoint with its covered update retained.');
    const checkpoint = Buffer.from(Y.encodeStateAsUpdate(authored)).toString('base64');
    const written = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer anyone', 'content-type': 'application/json' },
      body: JSON.stringify({ update: checkpoint, clientId: 'checkpoint-writer' }),
    });
    expect(written.status).toBe(202);

    const alice = open(harness.url, TENANTS.alpha.itemId);
    await alice.ready;
    typeParagraph(alice.doc, 'Live tail.');
    await until(
      async () => (await countUpdates(verifyPool, TENANTS.alpha)) === 2,
      'the uncovered tail to become durable',
    );

    const legacy = await fetch(url, { headers: { authorization: 'Bearer anyone' } });
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).toMatchObject({
      checkpoint: { seq: '1', update: checkpoint },
      headSeq: '2',
      canWrite: true,
      updates: [{ seq: '1' }, { seq: '2' }],
      hasMore: false,
    });

    const download = await fetch(`${url}?after=0&fromCheckpoint=true`, {
      headers: { authorization: 'Bearer as-reader' },
    });
    expect(download.status).toBe(200);
    expect(await download.json()).toMatchObject({
      checkpoint: { seq: '1', update: checkpoint },
      headSeq: '2',
      canWrite: false,
      updates: [{ seq: '2' }],
      hasMore: false,
    });

    const next = await fetch(`${url}?after=1&fromCheckpoint=true`, {
      headers: { authorization: 'Bearer anyone' },
    });
    expect(next.status).toBe(200);
    const nextPage: unknown = await next.json();
    expect(nextPage).toMatchObject({ headSeq: '2', canWrite: true, updates: [{ seq: '2' }] });
    expect(nextPage).not.toHaveProperty('checkpoint');
  });

  it('refuses queued HTTP edits for a replaced body without changing its durable bytes', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha));
    const url = `${harness.url.replace('ws://', 'http://')}/documents/${TENANTS.alpha.itemId}/updates`;
    const authored = new Y.Doc();
    typeParagraph(authored, 'Original body.');
    const original = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer anyone', 'content-type': 'application/json' },
      body: JSON.stringify({
        update: Buffer.from(Y.encodeStateAsUpdate(authored)).toString('base64'),
        clientId: 'original-writer',
      }),
    });
    expect(original.status).toBe(202);
    const opened = await fetch(url, { headers: { authorization: 'Bearer anyone' } });
    expect(opened.status).toBe(200);
    const oldBody = (await opened.json()) as { docId: string };

    await verifyPool.query('DELETE FROM content_doc WHERE tenant_id = $1 AND item_id = $2', [
      TENANTS.alpha.tenantId,
      TENANTS.alpha.itemId,
    ]);
    const replacement = new Y.Doc();
    typeParagraph(replacement, 'Replacement body.');
    const replaced = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer anyone', 'content-type': 'application/json' },
      body: JSON.stringify({
        update: Buffer.from(Y.encodeStateAsUpdate(replacement)).toString('base64'),
        clientId: 'replacement-writer',
      }),
    });
    expect(replaced.status).toBe(202);
    const before = await fetch(url, { headers: { authorization: 'Bearer anyone' } });
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as { docId: string };
    expect(beforeBody.docId).not.toBe(oldBody.docId);

    typeParagraph(authored, 'Pending offline edits.');
    const refused = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer anyone', 'content-type': 'application/json' },
      body: JSON.stringify({
        update: Buffer.from(Y.encodeStateAsUpdate(authored)).toString('base64'),
        clientId: 'offline-writer',
        expectedDocId: oldBody.docId,
      }),
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'document_changed' });
    expect(await countUpdates(verifyPool, TENANTS.alpha)).toBe(1);
    const after = await fetch(url, { headers: { authorization: 'Bearer anyone' } });
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual(beforeBody);

    typeParagraph(replacement, 'Edits for the replacement.');
    const accepted = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer anyone', 'content-type': 'application/json' },
      body: JSON.stringify({
        update: Buffer.from(Y.encodeStateAsUpdate(replacement)).toString('base64'),
        clientId: 'replacement-writer',
        expectedDocId: beforeBody.docId.toUpperCase(),
      }),
    });
    expect(accepted.status).toBe(202);
    expect(await countUpdates(verifyPool, TENANTS.alpha)).toBe(2);
  });

  it('keeps a write another process logged while the document was resident', async () => {
    // The resident session holds the document in memory and snapshots that memory. A write that
    // reaches the log by any other route - another instance, or a REST request racing a load -
    // takes a sequence the session never saw. Its next flush moves the head past that sequence,
    // and a snapshot labelled with the new head but built without the foreign update would make
    // every later load skip it: the update stays in the log and vanishes from the document.
    const harness = track(await startLiveServer(TENANTS.alpha));
    const alice = open(harness.url, TENANTS.alpha.itemId);
    await alice.ready;
    typeParagraph(alice.doc, 'Before the foreign write.');
    await until(
      async () => (await countUpdates(verifyPool, TENANTS.alpha)) >= 1,
      'the first flush',
    );

    const foreign = new Y.Doc();
    typeParagraph(foreign, 'Logged by someone else.');
    const pool = collabPool();
    try {
      const scope = { tenantId: TENANTS.alpha.tenantId, principalId: TENANTS.alpha.principalId };
      await withTenantScope(pool, scope, async (sql) => {
        const doc = await openDocument(
          sql,
          scope.tenantId,
          TENANTS.alpha.itemId,
          TENANTS.alpha.workspaceId,
          () => {
            throw new Error('The document already exists.');
          },
        );
        if (doc === null) throw new Error('The document is not visible.');
        const applied = await applyUpdate(sql, {
          tenantId: scope.tenantId,
          doc,
          updateBytes: Y.encodeStateAsUpdate(foreign),
          actorId: scope.principalId,
          clientId: 'another-process',
          snapshotEvery: 1_000,
        });
        expect(applied.ok).toBe(true);
      });
    } finally {
      await pool.end();
    }

    typeParagraph(alice.doc, 'After the foreign write.');
    await until(
      async () => (await countUpdates(verifyPool, TENANTS.alpha)) >= 3,
      'the second flush',
    );
    alice.close();
    await until(() => harness.registry.size === 0, 'the idle sweep to evict');

    const reader = open(harness.url, TENANTS.alpha.itemId);
    await reader.ready;
    await until(
      () => textOf(reader.doc).includes('After the foreign write.'),
      'the reload to catch up',
    );
    expect(textOf(reader.doc)).toContain('Logged by someone else.');
  });

  it('flushes one batch that advances the head once, and says so to Core once', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha));
    const alice = open(harness.url, TENANTS.alpha.itemId);
    await alice.ready;

    typeParagraph(alice.doc, 'One.');
    typeParagraph(alice.doc, 'Two.');
    typeParagraph(alice.doc, 'Three.');

    await until(
      async () => (await countUpdates(verifyPool, TENANTS.alpha)) > 0,
      'the flush to land',
    );

    const { rows } = await verifyPool.query<{ head_seq: string; count: string }>(
      `SELECT d.head_seq::text AS head_seq,
              (SELECT count(*) FROM content_update u WHERE u.doc_id = d.doc_id)::text AS count
       FROM content_doc d
       WHERE d.tenant_id = $1 AND d.item_id = $2`,
      [TENANTS.alpha.tenantId, TENANTS.alpha.itemId],
    );

    // The head advanced by exactly the rows written: batching changed how often the row
    // lock is taken, never the log's shape.
    expect(rows[0]?.head_seq).toBe(rows[0]?.count);
    expect(harness.flushes.length).toBeGreaterThan(0);
  });

  it('records each principal as the actor of their own updates, batching notwithstanding', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha));
    const first = open(harness.url, TENANTS.alpha.itemId, 'as-first-principal');
    const second = open(harness.url, TENANTS.alpha.itemId, 'as-second-principal');
    await Promise.all([first.ready, second.ready]);

    typeParagraph(first.doc, 'Signed by the first.');
    await until(
      async () => (await countUpdates(verifyPool, TENANTS.alpha)) >= 1,
      'the first flush',
    );
    typeParagraph(second.doc, 'Signed by the second.');
    await until(
      async () => (await countUpdates(verifyPool, TENANTS.alpha)) >= 2,
      'the second flush',
    );

    const { rows } = await verifyPool.query<{ actor_id: string }>(
      `SELECT DISTINCT u.actor_id
       FROM content_update u JOIN content_doc d USING (doc_id)
       WHERE d.tenant_id = $1 AND d.item_id = $2`,
      [TENANTS.alpha.tenantId, TENANTS.alpha.itemId],
    );

    const actors = rows.map((row) => row.actor_id).sort();
    expect(actors).toEqual([TENANTS.alpha.principalId, SECOND_PRINCIPAL].sort());
  });

  it('recovers everything for a fresh client after the writer is gone', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha));
    const alice = open(harness.url, TENANTS.alpha.itemId);
    await alice.ready;

    typeParagraph(alice.doc, 'Written before the crash.');
    await until(
      async () => (await countUpdates(verifyPool, TENANTS.alpha)) > 0,
      'the flush to land',
    );
    alice.close();

    const successor = open(harness.url, TENANTS.alpha.itemId);
    await successor.ready;

    // Sync step 1 is the recovery mechanism: the fresh client announces an empty state
    // vector and receives everything the log holds.
    await until(
      () => textOf(successor.doc).includes('Written before the crash.'),
      'the successor to catch up',
    );
  });

  it('drains an idle document: flushed, snapshotted, unloaded - and reloadable', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha));
    const alice = open(harness.url, TENANTS.alpha.itemId);
    await alice.ready;

    for (let index = 0; index < 6; index += 1) {
      typeParagraph(alice.doc, `Paragraph ${String(index)}.`);
    }
    await until(
      async () => (await countUpdates(verifyPool, TENANTS.alpha)) >= 6,
      'the flush to land',
    );
    alice.close();

    await until(() => harness.registry.size === 0, 'the idle sweep to evict');

    const { rows } = await verifyPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM content_snapshot s JOIN content_doc d USING (doc_id)
       WHERE d.tenant_id = $1 AND d.item_id = $2`,
      [TENANTS.alpha.tenantId, TENANTS.alpha.itemId],
    );
    expect(Number(rows[0]?.count ?? '0')).toBeGreaterThan(0);

    // Unloaded is not gone: the next reader loads from the snapshot it just wrote.
    const reader = open(harness.url, TENANTS.alpha.itemId);
    await reader.ready;
    await until(() => textOf(reader.doc).includes('Paragraph 5.'), 'the reload to catch up');
  });

  it('snapshots when the last reader leaves, without waiting for the idle sweep', async () => {
    // The snapshot is what publishes a document's link edges and its searchable text, so closing
    // the tab has to be enough - a backlinks panel that stays empty for five minutes after
    // somebody writes a link reads as broken rather than as behind.
    //
    // This exists because the first attempt did not work and nothing said so. `detach` asked for
    // the snapshot through `scheduleFlush(0)`, which returns immediately when the pending queue is
    // empty - and by the time the last tab closes, the 500ms timer has almost always drained it.
    // The request was made, the code read as correct, and the snapshot never happened.
    const harness = track(await startLiveServer(TENANTS.alpha));
    const alice = open(harness.url, TENANTS.alpha.itemId);
    await alice.ready;

    typeParagraph(alice.doc, 'A paragraph worth publishing.');
    await until(
      async () => (await countUpdates(verifyPool, TENANTS.alpha)) >= 1,
      'the flush to land',
    );

    // The queue is drained and the cadence is nowhere near due: `snapshotEvery` and the interval
    // are both far above one update. Only the detach can produce a snapshot from here.
    const before = await snapshotCount();
    expect(before).toBe(0);

    alice.close();

    await until(async () => (await snapshotCount()) > 0, 'the detach snapshot to land');

    // And the document is still resident - this is not the eviction path, which happens minutes
    // later and would have produced the same row.
    expect(harness.registry.size).toBeGreaterThan(0);
  });

  it('cancels a drain when a socket reattaches mid-way', async () => {
    const pool = collabPool();
    try {
      const scope = { tenantId: TENANTS.alpha.tenantId, principalId: TENANTS.alpha.principalId };
      const docRow = await withTenantScope(pool, scope, (sql) =>
        openDocument(
          sql,
          scope.tenantId,
          TENANTS.alpha.itemId,
          TENANTS.alpha.workspaceId,
          () => TENANTS.alpha.docId,
        ),
      );
      if (docRow === null) {
        throw new Error('The seeded item has no document body.');
      }

      const session = await DocumentSession.load(TENANTS.alpha.itemId, docRow, scope, {
        pool,
        config: FAST,
      });

      const socket = fakeSocketSession(TENANTS.alpha);
      session.attach(socket);

      // A drain with a socket still attached must decline to unload: the state diagram's
      // reconnect-cancels edge, in its simplest form.
      expect(await session.drain()).toBe(false);
      expect(session.state).toBe('active');

      session.detach(socket);
      expect(await session.drain()).toBe(true);
      expect(session.state).toBe('unloaded');
    } finally {
      await pool.end();
    }
  });

  it('keeps a batch whose append failed and writes it once the database is back', async () => {
    // The flush timer is nobody's caller. Its rejection used to go unhandled, which ends a Node
    // 22 process - every resident document with it - and the batch it had already taken off the
    // queue was gone either way: on every screen, in no log.
    const pool = collabPool();
    const outage = { on: false };
    const flaky = new Proxy(pool, {
      get(target, property) {
        if (property === 'connect' && outage.on) {
          return () => Promise.reject(new Error('The database is unavailable.'));
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
    const logged: string[] = [];
    try {
      const scope = { tenantId: TENANTS.alpha.tenantId, principalId: TENANTS.alpha.principalId };
      const docRow = await withTenantScope(pool, scope, (sql) =>
        openDocument(
          sql,
          scope.tenantId,
          TENANTS.alpha.itemId,
          TENANTS.alpha.workspaceId,
          () => TENANTS.alpha.docId,
        ),
      );
      if (docRow === null) {
        throw new Error('The seeded item has no document body.');
      }

      const session = await DocumentSession.load(TENANTS.alpha.itemId, docRow, scope, {
        pool: flaky,
        config: { ...FAST, flushMs: 20 },
        log: (message) => {
          logged.push(message);
        },
      });
      const socket = fakeSocketSession(TENANTS.alpha);
      session.attach(socket);

      outage.on = true;
      const edit = new Y.Doc();
      typeParagraph(edit, 'Typed during the outage.');
      session.handleMessage(socket, updateFrame(Y.encodeStateAsUpdate(edit)));

      await until(() => logged.some((line) => line.includes('Could not flush')), 'a failed flush');
      expect(await countUpdates(verifyPool, TENANTS.alpha)).toBe(0);

      outage.on = false;
      await until(
        async () => (await countUpdates(verifyPool, TENANTS.alpha)) === 1,
        'the retry to land the batch',
      );

      session.detach(socket);
      expect(await session.drain()).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it('closes a socket that has fallen too far behind, and keeps serving the rest', async () => {
    const pool = collabPool();
    try {
      const session = await loadAlpha(pool);
      const writer = fakeSocketSession(TENANTS.alpha);
      const stalled = fakeSocketSession(TENANTS.alpha);
      session.attach(writer);
      session.attach(stalled);
      (stalled.socket as unknown as { bufferedAmount: number }).bufferedAmount =
        LIMITS.socketBufferedBytes + 1;

      const edit = new Y.Doc();
      typeParagraph(edit, 'Broadcast to a reader that stopped reading.');
      session.handleMessage(writer, updateFrame(Y.encodeStateAsUpdate(edit)));

      expect(stalled.closedWith.map((close) => close.code)).toEqual([CLOSE_CODES.tooSlow]);
      expect(stalled.terminated.value).toBe(true);
      expect(stalled.sent).toHaveLength(0);
      expect(session.socketCount).toBe(1);

      session.detach(writer);
      expect(await session.drain()).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it('relays presence within its size and rate, and drops the excess', async () => {
    const pool = collabPool();
    try {
      // A clock that never moves: every message below lands in the same one-second budget.
      const session = await loadAlpha(pool, () => 1_000_000);
      const sender = fakeSocketSession(TENANTS.alpha);
      const watcher = fakeSocketSession(TENANTS.alpha);
      session.attach(sender);
      session.attach(watcher);

      const local = new awarenessProtocol.Awareness(new Y.Doc());
      const presence = (state: Record<string, unknown>): Uint8Array => {
        local.setLocalState(state);
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(local, [local.clientID]),
        );
        return encoding.toUint8Array(encoder);
      };

      const isPresence = (frame: Uint8Array): boolean =>
        decoding.readVarUint(decoding.createDecoder(frame)) === MESSAGE_AWARENESS;

      session.handleMessage(sender, presence({ note: 'x'.repeat(LIMITS.awarenessBytes) }));
      await new Promise((settle) => setTimeout(settle, 80));
      expect(watcher.sent.filter(isPresence)).toHaveLength(0);

      for (let index = 1; index <= LIMITS.awarenessPerSecond + 5; index += 1) {
        session.handleMessage(sender, presence({ cursor: index }));
      }
      await new Promise((settle) => setTimeout(settle, 80));

      const seen = new awarenessProtocol.Awareness(new Y.Doc());
      for (const frame of watcher.sent) {
        const decoder = decoding.createDecoder(frame);
        if (decoding.readVarUint(decoder) === MESSAGE_AWARENESS) {
          awarenessProtocol.applyAwarenessUpdate(seen, decoding.readVarUint8Array(decoder), null);
        }
      }
      // The oversized state never arrived, and the last state relayed is the last one in budget.
      expect(seen.getStates().get(local.clientID)).toEqual({
        cursor: LIMITS.awarenessPerSecond,
      });

      session.detach(sender);
      session.detach(watcher);
      expect(await session.drain()).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it('lets go of a sealed document whose final flush failed, instead of retrying it forever', async () => {
    // Sealing removes the document from the registry before draining it. A drain that failed used
    // to leave the session alive anyway - its retry timer re-arming against the database for the
    // life of the process, its memory and its mirror counted nowhere, its lock never released.
    const pool = collabPool();
    const outage = { on: false };
    let attempts = 0;
    const flaky = new Proxy(pool, {
      get(target, property) {
        if (property === 'connect' && outage.on) {
          return () => {
            attempts += 1;
            return Promise.reject(new Error('The database is unavailable.'));
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
    const locks = await connectDocumentLocks({
      databaseUrl: TEST_DATABASE_URL,
      onSessionLost: () => undefined,
    });
    const registry = createDocumentRegistry({
      pool: flaky,
      locks,
      config: { ...FAST, flushMs: 20, idleEvictMs: 3_600_000 },
    });
    try {
      const socket = fakeSocketSession(TENANTS.alpha);
      expect(await registry.join(socket)).toMatchObject({ ok: true });
      outage.on = true;
      const edit = new Y.Doc();
      typeParagraph(edit, 'Pending when the save began.');
      registry.handleMessage(socket, updateFrame(Y.encodeStateAsUpdate(edit)));

      await expect(registry.sealItems([TENANTS.alpha.itemId])).rejects.toThrow();
      expect(registry.size).toBe(0);

      attempts = 0;
      await new Promise((settle) => setTimeout(settle, 300));
      expect(attempts).toBe(0);
    } finally {
      outage.on = false;
      await registry.shutdown();
      await locks.close();
      await pool.end();
    }
  });

  it('holds each socket to its own presence identities, a few at most', async () => {
    const pool = collabPool();
    try {
      const session = await loadAlpha(pool);
      const first = fakeSocketSession(TENANTS.alpha);
      const second = fakeSocketSession(TENANTS.alpha);
      const watcher = fakeSocketSession(TENANTS.alpha);
      session.attach(first);
      session.attach(second);
      session.attach(watcher);

      const presence = (states: Record<number, Record<string, unknown>>): Uint8Array => {
        const inner = encoding.createEncoder();
        const entries = Object.entries(states);
        encoding.writeVarUint(inner, entries.length);
        for (const [clientId, state] of entries) {
          encoding.writeVarUint(inner, Number(clientId));
          encoding.writeVarUint(inner, 1);
          encoding.writeVarString(inner, JSON.stringify(state));
        }
        const outer = encoding.createEncoder();
        encoding.writeVarUint(outer, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(outer, encoding.toUint8Array(inner));
        return encoding.toUint8Array(outer);
      };
      const relayed = async (): Promise<Map<number, unknown>> => {
        await new Promise((settle) => setTimeout(settle, 80));
        const seen = new awarenessProtocol.Awareness(new Y.Doc());
        for (const frame of watcher.sent) {
          const decoder = decoding.createDecoder(frame);
          if (decoding.readVarUint(decoder) === MESSAGE_AWARENESS) {
            awarenessProtocol.applyAwarenessUpdate(seen, decoding.readVarUint8Array(decoder), null);
          }
        }
        return seen.getStates();
      };

      session.handleMessage(first, presence({ 101: { name: 'first' } }));
      // Somebody else's identity, and more identities than one socket may hold: both dropped.
      session.handleMessage(second, presence({ 101: { name: 'impostor' } }));
      const many = Object.fromEntries(
        Array.from({ length: LIMITS.awarenessClientsPerSocket + 1 }, (_, index) => [
          200 + index,
          { name: 'flood' },
        ]),
      );
      session.handleMessage(second, presence(many));

      const states = await relayed();
      expect(states.get(101)).toEqual({ name: 'first' });
      expect(Object.keys(many).filter((id) => states.has(Number(id)))).toEqual([]);

      for (const socket of [first, second, watcher]) session.detach(socket);
      expect(await session.drain()).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it('gives up the mirror when the last editor leaves, and judges without one near capacity', async () => {
    const pool = collabPool();
    try {
      const session = await loadAlpha(pool);
      const socket = fakeSocketSession(TENANTS.alpha);
      session.attach(socket);
      const edit = new Y.Doc();
      typeParagraph(edit, 'Judged against the mirror.');
      session.handleMessage(socket, updateFrame(Y.encodeStateAsUpdate(edit)));
      const withMirror = session.estimatedBytes;

      session.detach(socket);
      expect(session.estimatedBytes).toBeLessThan(withMirror);
      expect(await session.drain()).toBe(true);

      // A registry that refuses the mirror's reservation still gets every update judged.
      let calls = 0;
      const refusing = await loadAlpha(pool, undefined, () => {
        calls += 1;
        return calls > 1;
      });
      const writer = fakeSocketSession(TENANTS.alpha);
      refusing.attach(writer);
      const next = new Y.Doc();
      typeParagraph(next, 'Judged against a throwaway copy.');
      refusing.handleMessage(writer, updateFrame(Y.encodeStateAsUpdate(next)));
      expect(writer.closedWith).toEqual([]);
      expect(writer.sent.some((frame) => frame[0] === MESSAGE_NOTICE)).toBe(false);
      refusing.detach(writer);
      expect(await refusing.drain()).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it('snapshots the log as it stands, not edits that arrived while it was being written', async () => {
    // A snapshot labelled seq N is a claim about the log up to N. Edits that reach the resident
    // document while an append is in flight are not in the log yet - and if they never get there,
    // a snapshot that already holds them is content no replay of the log can produce.
    const pool = collabPool();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reachedAppend: () => void = () => undefined;
    const appending = new Promise<void>((resolve) => {
      reachedAppend = resolve;
    });
    let holding = true;
    const slow = new Proxy(pool, {
      get(target, property) {
        if (property === 'connect') {
          return async () => {
            const client = await target.connect();
            return new Proxy(client, {
              get(inner, key) {
                if (key === 'query') {
                  return async (text: unknown, values?: unknown) => {
                    if (
                      holding &&
                      typeof text === 'string' &&
                      text.includes('INSERT INTO content_update')
                    ) {
                      holding = false;
                      reachedAppend();
                      await held;
                    }
                    return await inner.query(text as string, values as unknown[]);
                  };
                }
                const value: unknown = Reflect.get(inner, key);
                return typeof value === 'function' ? (value as () => unknown).bind(inner) : value;
              },
            });
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
    try {
      const scope = { tenantId: TENANTS.alpha.tenantId, principalId: TENANTS.alpha.principalId };
      const docRow = await withTenantScope(pool, scope, (sql) =>
        openDocument(
          sql,
          scope.tenantId,
          TENANTS.alpha.itemId,
          TENANTS.alpha.workspaceId,
          () => TENANTS.alpha.docId,
        ),
      );
      if (docRow === null) throw new Error('The seeded item has no document body.');
      const session = await DocumentSession.load(TENANTS.alpha.itemId, docRow, scope, {
        pool: slow,
        config: { ...FAST, flushMs: 10, snapshotEvery: 1 },
      });
      const socket = fakeSocketSession(TENANTS.alpha);
      session.attach(socket);

      const first = new Y.Doc();
      typeParagraph(first, 'In the log at seq one.');
      session.handleMessage(socket, updateFrame(Y.encodeStateAsUpdate(first)));
      await appending;
      const second = new Y.Doc();
      typeParagraph(second, 'Arrived during the append.');
      session.handleMessage(socket, updateFrame(Y.encodeStateAsUpdate(second)));
      release();

      const snapshots = async () =>
        (
          await verifyPool.query<{ seq: string; yjs_state: Buffer }>(
            `SELECT s.seq::text AS seq, s.yjs_state
             FROM content_snapshot s JOIN content_doc d USING (doc_id)
             WHERE d.tenant_id = $1 AND d.item_id = $2 ORDER BY s.seq`,
            [TENANTS.alpha.tenantId, TENANTS.alpha.itemId],
          )
        ).rows.map((row) => {
          const state = new Y.Doc();
          Y.applyUpdate(state, new Uint8Array(row.yjs_state));
          return { seq: row.seq, text: textOf(state) };
        });
      await until(
        async () => (await snapshots()).some((snapshot) => snapshot.seq === '2'),
        'a snapshot once both are in the log',
      );

      // Whichever snapshots were taken, none describes more than the log up to its own seq: the
      // second edit appears only from seq 2, and seq 2 holds both.
      for (const snapshot of await snapshots()) {
        if (snapshot.seq === '1') {
          expect(snapshot.text).not.toContain('Arrived during the append.');
        }
        if (snapshot.seq === '2') {
          expect(snapshot.text).toContain('In the log at seq one.');
          expect(snapshot.text).toContain('Arrived during the append.');
        }
      }

      session.detach(socket);
      expect(await session.drain()).toBe(true);
    } finally {
      release();
      await pool.end();
    }
  });

  it("holds every socket's unsent bytes together under one bound, cutting off the slowest", async () => {
    const pool = collabPool();
    const locks = await connectDocumentLocks({
      databaseUrl: TEST_DATABASE_URL,
      onSessionLost: () => undefined,
    });
    const registry = createDocumentRegistry({
      pool,
      locks,
      config: { ...FAST, maxBufferedBytes: 100, backlogSweepMs: 20 },
    });
    try {
      const slowest = fakeSocketSession(TENANTS.alpha);
      const slow = fakeSocketSession(TENANTS.alpha);
      const keeping = fakeSocketSession(TENANTS.alpha);
      for (const socket of [slowest, slow, keeping]) {
        expect(await registry.join(socket)).toMatchObject({ ok: true });
      }
      const backlog = (socket: FakeSocketSession, bytes: number): void => {
        (socket.socket as unknown as { bufferedAmount: number }).bufferedAmount = bytes;
      };
      // 150 together against a budget of 100: cutting off the 80 alone brings it under.
      backlog(slowest, 80);
      backlog(slow, 60);
      backlog(keeping, 10);

      await until(() => slowest.terminated.value, 'the slowest socket to be cut off');
      await new Promise((settle) => setTimeout(settle, 60));
      expect(slowest.closedWith.map((close) => close.code)).toEqual([CLOSE_CODES.tooSlow]);
      expect(slow.terminated.value).toBe(false);
      expect(keeping.terminated.value).toBe(false);
    } finally {
      await registry.shutdown();
      await locks.close();
      await pool.end();
    }
  });

  it('refuses the whole load, loudly, when the server is at document capacity', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha, { maxDocs: 0 }));

    const joined = await harness.registry.join(fakeSocketSession(TENANTS.alpha));

    expect(joined).toMatchObject({ ok: false, closeCode: 4413 });
  });

  it('reserves a document slot across concurrent cold loads', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha, { maxDocs: 1 }));
    const first = fakeSocketSession(TENANTS.alpha);
    const second = { ...fakeSocketSession(TENANTS.alpha), itemId: TENANTS.alpha.targetItemId };

    const answers = await Promise.all([
      harness.registry.join(first),
      harness.registry.join(second),
    ]);

    expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
    expect(answers.filter((answer) => !answer.ok && answer.closeCode === 4413)).toHaveLength(1);
    expect(harness.registry.size).toBe(1);
  });

  it('reserves the document ceiling in bytes across concurrent cold loads', async () => {
    const harness = track(
      await startLiveServer(TENANTS.alpha, {
        maxDocs: 2,
        maxResidentBytes: LIMITS.documentBytes,
      }),
    );
    const first = fakeSocketSession(TENANTS.alpha);
    const second = { ...fakeSocketSession(TENANTS.alpha), itemId: TENANTS.alpha.targetItemId };

    const answers = await Promise.all([
      harness.registry.join(first),
      harness.registry.join(second),
    ]);

    expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
    expect(answers.filter((answer) => !answer.ok && answer.closeCode === 4413)).toHaveLength(1);
  });

  it('refuses live aggregate growth before it can cross the resident-byte wall', async () => {
    const maximumResidentBytes = 64 * 1024;
    const harness = track(
      await startLiveServer(TENANTS.alpha, {
        maxResidentBytes: maximumResidentBytes,
        flushMs: 60_000,
      }),
    );
    const first = fakeSocketSession(TENANTS.alpha);
    const second = fakeSocketSession(TENANTS.alpha, { principalId: SECOND_PRINCIPAL });
    expect((await harness.registry.join(first)).ok).toBe(true);
    expect((await harness.registry.join(second)).ok).toBe(true);

    function paragraphFrame(text: string): Uint8Array {
      const document = new Y.Doc();
      try {
        typeParagraph(document, text);
        return updateFrame(Y.encodeStateAsUpdate(document));
      } finally {
        document.destroy();
      }
    }

    // Each accepted update contributes both its encoded Yjs state and its pending log bytes.
    // Either edit fits alone; accepting both would cross the one process-wide wall. Delivering
    // the independent writer frames directly makes this a capacity test rather than a test of
    // whether two browser-side Yjs providers happened to finish their initial sync first.
    const beforeGrowth = harness.registry.residentBytes;
    harness.registry.handleMessage(first, paragraphFrame(`First ${'a'.repeat(20_000)}`));
    expect(first.closedWith).toEqual([]);
    expect(harness.registry.residentBytes).toBeGreaterThan(beforeGrowth);
    expect(harness.registry.residentBytes).toBeLessThan(maximumResidentBytes);

    harness.registry.handleMessage(second, paragraphFrame(`Second ${'b'.repeat(20_000)}`));

    expect(second.closedWith).toEqual([
      {
        code: 4413,
        reason: 'This server is at its resident-memory capacity. Retry shortly.',
      },
    ]);
    expect(harness.registry.residentBytes).toBeLessThanOrEqual(maximumResidentBytes);

    await harness.registry.flushItems([TENANTS.alpha.itemId]);
    expect(await countUpdates(verifyPool, TENANTS.alpha)).toBe(1);
  });

  it('cancels a matching cold load during draft save and lets a newly authorized reconnect load', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha));
    const stale = fakeSocketSession(TENANTS.alpha);
    const joining = harness.registry.join(stale);

    await harness.registry.sealItems([TENANTS.alpha.itemId]);
    const refused = await joining;
    const reconnected = await harness.registry.join(fakeSocketSession(TENANTS.alpha));

    expect(refused).toMatchObject({ ok: false, closeCode: 4404 });
    expect(reconnected.ok).toBe(true);
  });

  it('refuses a document another instance owns, instead of serving it twice', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha));
    const alice = open(harness.url, TENANTS.alpha.itemId);
    await alice.ready;

    const rivalPool = collabPool();
    const rivalLocks = await connectDocumentLocks({
      databaseUrl: TEST_DATABASE_URL,
      onSessionLost: () => undefined,
    });
    const rival = createDocumentRegistry({ pool: rivalPool, locks: rivalLocks, config: FAST });

    try {
      const joined = await rival.join(fakeSocketSession(TENANTS.alpha));
      expect(joined).toMatchObject({ ok: false, closeCode: 4423 });
    } finally {
      await rival.shutdown();
      await rivalLocks.close();
      await rivalPool.end();
    }
  });

  it('holds a burst from several clients: convergence, batched flushes, bounded memory', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha, { snapshotEvery: 100 }));
    const writers = [
      open(harness.url, TENANTS.alpha.itemId, 'as-first-principal'),
      open(harness.url, TENANTS.alpha.itemId, 'as-second-principal'),
      open(harness.url, TENANTS.alpha.itemId, 'as-first-principal'),
    ];
    await Promise.all(writers.map((writer) => writer.ready));

    const PER_WRITER = 60;
    for (let round = 0; round < PER_WRITER; round += 1) {
      for (const [index, writer] of writers.entries()) {
        typeParagraph(writer.doc, `Round ${String(round)} from writer ${String(index)}.`);
      }
      if (round % 10 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    }

    const total = PER_WRITER * writers.length;
    await until(
      async () => (await countUpdates(verifyPool, TENANTS.alpha)) >= total,
      'every update to land',
      10_000,
    );
    await until(
      () =>
        writers.every(
          (writer) =>
            textOf(writer.doc) === textOf(writers[0]?.doc ?? writer.doc) &&
            textOf(writer.doc).includes(`Round ${String(PER_WRITER - 1)} from writer 2.`),
        ),
      'all writers to converge',
      10_000,
    );

    // Batching is the point of the resident server: the log holds every update, but the
    // flush count - each one a head_seq row lock - stays well under one per update.
    expect(harness.flushes.length).toBeLessThan(total / 2);
  }, 30_000);

  it('broadcasts presence between clients and never writes a byte of it to the log', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha));
    const alice = open(harness.url, TENANTS.alpha.itemId);
    const bella = open(harness.url, TENANTS.alpha.itemId, 'as-second-principal');
    await Promise.all([alice.ready, bella.ready]);

    alice.awareness.setLocalStateField('user', { name: 'Alice', color: 'var(--c)' });

    await until(() => {
      for (const state of bella.awareness.getStates().values()) {
        if ((state as { user?: { name?: string } }).user?.name === 'Alice') {
          return true;
        }
      }
      return false;
    }, "Alice's presence to reach Bella");

    // Presence is a fact about now: whatever moved over the wire, the durable log holds
    // nothing - awareness is never persisted, and an idle drain must not change that.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await countUpdates(verifyPool, TENANTS.alpha)).toBe(0);
  });

  it('lets one person edit at a time when collaboration is off, and hands over when they leave', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha));
    const alice = open(harness.url, TENANTS.alpha.itemId, 'solo-first');
    expect((await alice.ready).mode).toBe('write');
    const bella = open(harness.url, TENANTS.alpha.itemId, 'solo-second');
    expect((await bella.ready).mode).toBe('read');
    await until(
      () => bella.notices.some((notice) => notice.code === 'editing_elsewhere'),
      'Bella to hear someone else is editing',
    );

    alice.close();
    await until(
      () => bella.notices.some((notice) => notice.code === 'editable'),
      'Bella to be handed the document',
    );
    // Her sync reply while she was still a reader was refused; nothing after the handover is.
    const refusedBefore = bella.notices.filter((notice) => notice.code === 'read_only').length;
    typeParagraph(bella.doc, 'Bella edits now.');

    const again = open(harness.url, TENANTS.alpha.itemId, 'solo-first');
    expect((await again.ready).mode).toBe('read');
    await until(() => textOf(again.doc).includes('Bella edits now.'), "Bella's edit to be kept");
    expect(bella.notices.filter((notice) => notice.code === 'read_only')).toHaveLength(
      refusedBefore,
    );
  });

  it('drops a departed client from everyone else’s roster', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha));
    const alice = open(harness.url, TENANTS.alpha.itemId);
    const bella = open(harness.url, TENANTS.alpha.itemId, 'as-second-principal');
    await Promise.all([alice.ready, bella.ready]);

    alice.awareness.setLocalStateField('user', { name: 'Alice', color: 'var(--c)' });
    const aliceId = alice.doc.clientID;
    await until(() => bella.awareness.getStates().has(aliceId), "Alice's presence to arrive");

    alice.close();

    await until(
      () => !bella.awareness.getStates().has(aliceId),
      "Alice's departure to reach Bella",
    );
  });

  it('flushes what is pending when the server shuts down, not never', async () => {
    const harness = track(await startLiveServer(TENANTS.alpha, { flushMs: 60_000 }));
    const alice = open(harness.url, TENANTS.alpha.itemId);
    await alice.ready;

    typeParagraph(alice.doc, 'Typed moments before the rollout.');
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Nothing has flushed - the window is a minute - so the shutdown drain is the only
    // thing standing between this edit and the crash-loss window.
    expect(await countUpdates(verifyPool, TENANTS.alpha)).toBe(0);
    await harness.close();

    expect(await countUpdates(verifyPool, TENANTS.alpha)).toBeGreaterThan(0);
  });
});

/** Alpha's document, resident in a session of its own: no registry, no sockets, no server. */
async function loadAlpha(
  pool: Pool,
  now?: () => number,
  resizeResident?: () => boolean,
): Promise<DocumentSession> {
  const scope = { tenantId: TENANTS.alpha.tenantId, principalId: TENANTS.alpha.principalId };
  const docRow = await withTenantScope(pool, scope, (sql) =>
    openDocument(
      sql,
      scope.tenantId,
      TENANTS.alpha.itemId,
      TENANTS.alpha.workspaceId,
      () => TENANTS.alpha.docId,
    ),
  );
  if (docRow === null) {
    throw new Error('The seeded item has no document body.');
  }
  return DocumentSession.load(TENANTS.alpha.itemId, docRow, scope, {
    pool,
    config: FAST,
    now,
    resizeResident,
  });
}
