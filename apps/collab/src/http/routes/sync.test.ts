import { SCHEMA_VERSION, nixSchema } from '@nix/editor-schema';
import type { Pool } from 'pg';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';

import type { Authorizer, ItemAuthorization } from '../../auth/authorize.ts';
import type { ContentDocRow, SnapshotRow, UpdateRow } from '../../db/documents.ts';
import { withTenantScope } from '../../db/tenant-scope.ts';
import { LIMITS, RateWindow } from '../../documents/limits.ts';
import { FRAGMENT_NAME } from '../../documents/service.ts';
import {
  type DocumentSyncRefusal,
  SYNC_LIMITS,
  syncDocument,
  type DocumentSyncResult,
} from '../../documents/sync.ts';
import { createSessionAuthenticator } from '../../ws/session-auth.ts';
import { createServer } from '../server.ts';

const ITEM = 'c1000000-0000-4000-8000-000000000031';
const DOC = 'c1000000-0000-4000-8000-000000000041';
const OTHER = 'c1000000-0000-4000-8000-000000000051';
const GRANTED: ItemAuthorization = {
  tenantId: 'c1000000-0000-4000-8000-000000000001',
  principalId: 'c1000000-0000-4000-8000-000000000021',
  workspaceId: 'c1000000-0000-4000-8000-000000000011',
  canWrite: true,
  bodyKind: 'note',
};
const apps: ReturnType<typeof createServer>[] = [];
const documents: Y.Doc[] = [];
afterEach(async () => {
  for (const doc of documents.splice(0)) doc.destroy();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function note(text: string): Y.Doc {
  const doc = new Y.Doc();
  documents.push(doc);
  prosemirrorJSONToYXmlFragment(
    nixSchema,
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
    doc.getXmlFragment(FRAGMENT_NAME),
  );
  return doc;
}

function empty(): Y.Doc {
  const doc = new Y.Doc();
  documents.push(doc);
  return doc;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Transactional I/O fake; real service code replays, validates and appends actual Yjs bytes. */
function database(initial: Y.Doc) {
  let committed = {
    doc: {
      doc_id: DOC,
      item_id: ITEM,
      workspace_id: GRANTED.workspaceId,
      schema_version: SCHEMA_VERSION,
      head_seq: '1',
    } satisfies ContentDocRow,
    updates: [] as UpdateRow[],
    snapshots: [
      { seq: '1', yjs_state: Buffer.from(Y.encodeStateAsUpdate(initial)) },
    ] as SnapshotRow[],
    text: '',
  };
  let transaction = committed;
  const statements: string[] = [];
  let locked = false;
  let failCommit = false;
  let released = 0;

  function query(text: string, values: readonly unknown[] = []) {
    statements.push(text);
    let rows: Record<string, unknown>[] = [];
    if (text === 'BEGIN') {
      transaction = {
        doc: { ...committed.doc },
        updates: [...committed.updates],
        snapshots: [...committed.snapshots],
        text: committed.text,
      };
    } else if (text === 'COMMIT') {
      if (failCommit) throw new Error('commit failed');
      committed = transaction;
    } else if (text === 'ROLLBACK') {
      transaction = committed;
    } else if (text.startsWith('SET LOCAL') || text.includes('pg_advisory_xact_lock')) {
      // Transaction, Core topology guard and the chunk-write lock are I/O boundaries.
    } else if (text.includes('AS newer')) {
      rows = [{ newer: false }];
    } else if (text.includes('item_chunk')) {
      // Passage chunks are derived state; this fake does not keep them.
    } else if (text.includes('FROM item_closure AS edge')) {
      rows = locked ? [{ item_id: ITEM }] : [];
    } else if (text.includes('FROM content_doc')) {
      rows = values[1] === ITEM ? [{ ...transaction.doc }] : [];
    } else if (text.includes('FROM content_snapshot')) {
      rows = transaction.snapshots
        .filter((row) => BigInt(row.seq) <= BigInt(String(values[2])))
        .sort((a, b) => Number(BigInt(b.seq) - BigInt(a.seq)))
        .slice(0, 1);
    } else if (text.includes('FROM content_update')) {
      rows = transaction.updates
        .filter((row) => BigInt(row.seq) > BigInt(String(values[2])))
        .slice(0, Number(values[3]));
    } else if (text.startsWith('UPDATE content_doc')) {
      transaction.doc.head_seq = (BigInt(transaction.doc.head_seq) + 1n).toString();
      rows = [{ head_seq: transaction.doc.head_seq }];
    } else if (text.startsWith('INSERT INTO content_update')) {
      if (!(values[3] instanceof Buffer)) throw new Error('Expected encoded update bytes.');
      transaction.updates.push({
        seq: String(values[1]),
        update_bytes: values[3],
        actor_id: String(values[4]),
        client_id: String(values[5]),
        created_at: new Date(0),
      });
    } else if (text.startsWith('INSERT INTO content_snapshot')) {
      if (!(values[3] instanceof Buffer)) throw new Error('Expected encoded snapshot bytes.');
      transaction.snapshots.push({ seq: String(values[1]), yjs_state: values[3] });
    } else if (text.startsWith('INSERT INTO item_search')) {
      transaction.text = String(values[3]);
    } else if (!text.startsWith('DELETE FROM item_link')) {
      throw new Error(`Unexpected database query: ${text}`);
    }
    return Promise.resolve({ rows, rowCount: rows.length });
  }
  const pool = {
    connect: () =>
      Promise.resolve({
        query,
        release: () => {
          released += 1;
        },
      }),
  } as unknown as Pool;
  return {
    pool,
    statements,
    get committed() {
      return committed;
    },
    get released() {
      return released;
    },
    lock() {
      locked = true;
    },
    failCommit() {
      failCommit = true;
    },
  };
}

function setup(
  options: {
    authorize?: Authorizer['authorize'];
    db?: ReturnType<typeof database>;
    rateWindow?: RateWindow;
  } = {},
) {
  const db = options.db ?? database(note('Server text'));
  let refreshed = 0;
  const sessions = createSessionAuthenticator({
    tokens: { validate: () => Promise.resolve({ subject: 'subject', expiresAt: null }) },
    authorizer: { authorize: options.authorize ?? (() => Promise.resolve(GRANTED)) },
  });
  const app = createServer({
    pool: db.pool,
    sessions,
    core: {
      getItem: () => Promise.resolve(null),
      listChildren: () => Promise.resolve(null),
      getSchema: () => Promise.resolve(null),
      getViews: () => Promise.resolve(null),
      listComments: () => Promise.resolve(null),
    },
    internalSecret: 'test-internal-secret',
    ...(options.rateWindow === undefined ? {} : { rateWindow: options.rateWindow }),
    hub: {
      join: () => Promise.reject(new Error('Unexpected socket join.')),
      handleMessage: () => undefined,
      leave: () => undefined,
      refresh: () => {
        expect(db.statements.at(-1)).toBe('COMMIT');
        refreshed += 1;
        return Promise.resolve();
      },
    },
  });
  apps.push(app);
  return {
    db,
    sessions,
    get refreshed() {
      return refreshed;
    },
    post: (docs: unknown, headers = { authorization: 'Bearer native-device' }) =>
      app.inject({
        method: 'POST',
        url: '/documents/sync',
        headers,
        payload: { documents: docs },
      }),
  };
}

function request(updates?: { clientId: string; update: string }[]) {
  return {
    itemId: ITEM,
    stateVector: base64(Y.encodeStateVector(empty())),
    ...(updates === undefined ? {} : { expectedDocId: DOC, updates }),
  };
}

function firstResult(
  response: Awaited<ReturnType<ReturnType<typeof setup>['post']>>,
): DocumentSyncResult {
  const result = response.json<{ documents: DocumentSyncResult[] }>().documents[0];
  if (result === undefined) throw new Error('Missing document result.');
  return result;
}

describe('native batch document synchronization', () => {
  it('returns a Yjs delta that reconstructs the retained server checkpoint', async () => {
    const test = setup();
    const response = await test.post([request()]);
    expect(response.statusCode).toBe(200);
    const result = firstResult(response);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('Sync failed.');
    const client = empty();
    Y.applyUpdate(client, Buffer.from(result.update, 'base64'));
    expect(client.getXmlFragment(FRAGMENT_NAME).toJSON()).toContain('Server text');
    expect(base64(Y.encodeStateVector(client))).toBe(result.stateVector);
    expect(result.acknowledgedClientIds).toEqual([]);
    expect(test.db.released).toBe(1);
    expect(
      test.db.statements.find((sql) => sql.includes('pg_advisory_xact_lock_shared')),
    ).toBeDefined();
  });

  it('acknowledges pending updates and refreshes residents after their commit', async () => {
    const test = setup();
    const pending = {
      clientId: 'queued-1',
      update: base64(Y.encodeStateAsUpdate(note('Offline text'))),
    };
    const response = await test.post([request([pending])]);
    const result = firstResult(response);
    expect(result).toMatchObject({
      status: 'ok',
      headSeq: '2',
      acknowledgedClientIds: ['queued-1'],
    });
    expect(test.db.committed.updates).toHaveLength(1);
    expect(test.db.committed.text).toContain('Offline text');
    expect(test.refreshed).toBe(1);
  });

  it('writes one snapshot per document however many updates it carries', async () => {
    const test = setup();
    const updates = ['one', 'two', 'three'].map((clientId) => ({
      clientId,
      update: base64(Y.encodeStateAsUpdate(note(clientId))),
    }));
    expect(firstResult(await test.post([request(updates)])).status).toBe('ok');
    expect(test.db.committed.updates).toHaveLength(3);
    // The fixture's checkpoint plus exactly one for the batch.
    expect(test.db.committed.snapshots).toHaveLength(2);
  });

  it('limits a principal to a bounded number of authorized documents per window', async () => {
    let now = 0;
    const rateWindow = new RateWindow(() => now);
    let authorizations = 0;
    const test = setup({
      rateWindow,
      authorize: () => {
        authorizations += 1;
        return Promise.resolve(GRANTED);
      },
    });
    for (let index = 0; index < LIMITS.updatesPerWindow; index += 1) {
      rateWindow.exceeded(GRANTED.principalId, 'documents-sync');
    }
    const limited = firstResult(await test.post([request()]));
    expect(limited).toMatchObject({ status: 'rejected', code: 'rate_limited' });
    now = LIMITS.windowMs;
    expect(firstResult(await test.post([request()])).status).toBe('ok');
    expect(authorizations).toBe(2);
  });

  it('replays the entire retained checkpoint tail beyond one update page', async () => {
    const initial = note('Retained base');
    const db = database(initial);
    for (let index = 1; index <= 501; index += 1) {
      const before = Y.encodeStateVector(initial);
      initial.getMap('tail').set('last', index);
      db.committed.updates.push({
        seq: String(index + 1),
        update_bytes: Buffer.from(Y.encodeStateAsUpdate(initial, before)),
        actor_id: GRANTED.principalId,
        client_id: 'remote',
        created_at: new Date(0),
      });
    }
    db.committed.doc.head_seq = '502';
    const result = firstResult(await setup({ db }).post([request()]));
    if (result.status !== 'ok') throw new Error('Sync failed.');
    const client = empty();
    Y.applyUpdate(client, Buffer.from(result.update, 'base64'));
    expect(client.getXmlFragment(FRAGMENT_NAME).toJSON()).toContain('Retained base');
    expect(client.getMap('tail').get('last')).toBe(501);
    expect(result.headSeq).toBe('502');
  });

  it('converges when the same pending update is retried after a lost response', async () => {
    const test = setup();
    const pending = {
      clientId: 'retry',
      update: base64(Y.encodeStateAsUpdate(note('Offline retry'))),
    };
    const first = firstResult(await test.post([request([pending])]));
    const second = firstResult(await test.post([request([pending])]));
    if (first.status !== 'ok' || second.status !== 'ok') throw new Error('Sync failed.');
    expect(first.update).toBe(second.update);
    expect(second.acknowledgedClientIds).toEqual(['retry']);
    expect(test.db.committed.doc.head_seq).toBe('3');
  });

  it('rolls back uploaded updates when the bounded response cannot include their acknowledgement', async () => {
    const db = database(note('Server text'));
    await expect(
      withTenantScope(db.pool, GRANTED, (sql) =>
        syncDocument(sql, {
          document: {
            itemId: ITEM,
            expectedDocId: DOC,
            stateVector: Y.encodeStateVector(empty()),
            updates: [{ clientId: 'pending', update: Y.encodeStateAsUpdate(note('Offline')) }],
          },
          ...GRANTED,
          newDocId: () => DOC,
          responseBytesAvailable: 1,
        }),
      ),
    ).rejects.toMatchObject({
      result: { itemId: ITEM, status: 'rejected', code: 'response_too_large' },
    } satisfies Partial<DocumentSyncRefusal>);
    expect(db.committed.updates).toEqual([]);
    expect(db.statements.at(-1)).toBe('ROLLBACK');
  });

  it('rolls back earlier updates when a later merged body fails schema validation', async () => {
    const initial = note('Server text');
    const test = setup({ db: database(initial) });
    const valid = Y.encodeStateAsUpdate(note('Valid text'));
    Y.applyUpdate(initial, valid);
    const before = Y.encodeStateVector(initial);
    const fragment = initial.getXmlFragment(FRAGMENT_NAME);
    fragment.delete(0, fragment.length);
    const invalid = Y.encodeStateAsUpdate(initial, before);
    const response = await test.post([
      request([
        { clientId: 'valid', update: base64(valid) },
        { clientId: 'invalid', update: base64(invalid) },
      ]),
    ]);
    expect(firstResult(response)).toEqual({
      itemId: ITEM,
      status: 'rejected',
      code: 'document_does_not_parse',
    });
    expect(test.db.committed.doc.head_seq).toBe('1');
    expect(test.db.committed.updates).toEqual([]);
    expect(test.db.statements.at(-1)).toBe('ROLLBACK');
    expect(test.refreshed).toBe(0);
  });

  it('returns no acknowledgement when COMMIT fails', async () => {
    const test = setup();
    test.db.failCommit();
    const response = await test.post([
      request([{ clientId: 'pending', update: base64(Y.encodeStateAsUpdate(note('Unsaved'))) }]),
    ]);
    expect(firstResult(response)).toEqual({
      itemId: ITEM,
      status: 'unavailable',
      code: 'persistence_unavailable',
    });
    expect(test.db.committed.updates).toEqual([]);
    expect(test.refreshed).toBe(0);
  });

  it('refuses stale document identity without appending or revealing the new body', async () => {
    const test = setup();
    const response = await test.post([{ ...request(), expectedDocId: OTHER }]);
    expect(firstResult(response)).toEqual({
      itemId: ITEM,
      status: 'rejected',
      code: 'document_changed',
    });
    expect(test.db.statements.some((sql) => sql.includes('FROM content_snapshot'))).toBe(false);
  });

  it('withholds password ancestry bodies even if Core grants the unlocked caller access', async () => {
    const test = setup();
    test.db.lock();
    const response = await test.post([request()]);
    expect(firstResult(response)).toEqual({ itemId: ITEM, status: 'forbidden' });
    expect(test.db.statements.some((sql) => sql.includes('FROM content_doc'))).toBe(false);
  });

  it('uses the same generic refusal for inaccessible and locked items and preserves outages', async () => {
    const test = setup({
      authorize: (_token, itemId) => Promise.resolve(itemId === ITEM ? null : 'locked'),
    });
    const response = await test.post([request(), { ...request(), itemId: OTHER }]);
    expect(response.json()).toEqual({
      documents: [
        { itemId: ITEM, status: 'forbidden' },
        { itemId: OTHER, status: 'forbidden' },
      ],
    });
    expect(test.db.statements).toEqual([]);
    const outage = setup({ authorize: () => Promise.resolve('unavailable') });
    expect(firstResult(await outage.post([request()]))).toEqual({
      itemId: ITEM,
      status: 'unavailable',
      code: 'authorization_unavailable',
    });
  });

  it('rechecks revocation even when this credential has a cached authorization', async () => {
    let granted = true;
    const test = setup({ authorize: () => Promise.resolve(granted ? GRANTED : null) });
    expect((await test.sessions.authenticate('native-device', ITEM)).ok).toBe(true);
    granted = false;
    expect(firstResult(await test.post([request()]))).toEqual({
      itemId: ITEM,
      status: 'forbidden',
    });
    expect(test.db.statements).toEqual([]);
  });

  it('bounds batches and rejects duplicate items before any database work', async () => {
    const test = setup();
    expect((await test.post([request(), request()])).statusCode).toBe(400);
    expect(
      (await test.post(Array.from({ length: SYNC_LIMITS.documents + 1 }, () => request())))
        .statusCode,
    ).toBe(400);
    expect((await test.post([{ ...request(), stateVector: '!!!=' }])).statusCode).toBe(400);
    expect(test.db.statements).toEqual([]);
  });

  it('requires a body identity for writes and enforces read-only authorization', async () => {
    const update = { clientId: 'pending', update: base64(Y.encodeStateAsUpdate(note('Offline'))) };
    const test = setup();
    expect(firstResult(await test.post([{ ...request(), updates: [update] }]))).toEqual({
      itemId: ITEM,
      status: 'rejected',
      code: 'expected_doc_id_required',
    });
    const reader = setup({ authorize: () => Promise.resolve({ ...GRANTED, canWrite: false }) });
    expect(firstResult(await reader.post([request([update])]))).toEqual({
      itemId: ITEM,
      status: 'rejected',
      code: 'read_only',
    });
    expect(firstResult(await reader.post([request()])).status).toBe('ok');
  });
});
