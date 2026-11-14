import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fromByteArray } from '@nix/sync-core/base64';
import * as Y from 'yjs';
import type { BodySyncSuccess, MirrorItem } from '@nix/sync-core/mirror';
import { openSqliteMirror, type SqliteMirrorStore } from './mirror.js';
import { createNodeSqliteDriver } from './testing/node-driver.js';

const workspace = '00000000-0000-4000-8000-000000000001';
const itemId = '00000000-0000-4000-8000-000000000002';
const docId = '00000000-0000-4000-8000-000000000003';
const secondId = '00000000-0000-4000-8000-000000000004';
const operationId = '00000000-0000-4000-8000-000000000005';
const canonicalId = '00000000-0000-4000-8000-000000000006';
const scope = { serverOrigin: 'http://core.test', tenantId: 'tenant', principalId: 'alice' };
const serverTime = '2026-10-13T12:00:00Z';
const directories: string[] = [];
const stores: SqliteMirrorStore[] = [];

function item(patch: Partial<MirrorItem> = {}): MirrorItem {
  return {
    id: itemId,
    workspaceId: workspace,
    parentId: null,
    computedProperties: null,
    type: 'prose',
    title: 'Original',
    seq: 1,
    revision: '1',
    lifecycleState: 'active',
    properties: {},
    schema: null,
    views: null,
    recurrence: null,
    noDelete: false,
    noChildren: false,
    managedBy: null,
    createdAt: serverTime,
    updatedAt: null,
    canWrite: true,
    locked: false,
    canPersistBody: true,
    metadataExpiresAt: null,
    bodyDocId: docId,
    bodyHeadSeq: '0',
    file: null,
    ...patch,
  };
}

async function setup(): Promise<{
  store: SqliteMirrorStore;
  reopen: () => Promise<SqliteMirrorStore>;
  driver: ReturnType<typeof createNodeSqliteDriver>;
  path: string;
}> {
  const directory = mkdtempSync(join(tmpdir(), 'nix-mirror-test-'));
  directories.push(directory);
  const path = join(directory, 'mirror.sqlite');
  const driver = createNodeSqliteDriver(path);
  const reopen = async () => {
    const store = await openSqliteMirror({ driver, scope });
    stores.push(store);
    return store;
  };
  return { store: await reopen(), reopen, driver, path };
}

async function snapshot(
  store: SqliteMirrorStore,
  items: MirrorItem[],
  boundary = '1',
): Promise<void> {
  await store.applySnapshotPage(
    workspace,
    { boundary, nextCursor: null, complete: true, resync: false, items, serverTime },
    true,
  );
}

function response(doc: Y.Doc, acknowledgedClientIds: string[] = []): BodySyncSuccess {
  return {
    itemId,
    status: 'ok',
    docId,
    headSeq: '1',
    schemaVersion: 1,
    canWrite: true,
    update: fromByteArray(Y.encodeStateAsUpdate(doc)),
    stateVector: fromByteArray(Y.encodeStateVector(doc)),
    acknowledgedClientIds,
  };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('SQLite mirror with real SQLite', () => {
  it('stages incomplete snapshots, resumes them after reopen and retains the published cursor until completion', async () => {
    const setupResult = await setup();
    let store = setupResult.store;
    await snapshot(store, [item()]);
    await store.applySnapshotPage(
      workspace,
      {
        boundary: '2',
        nextCursor: itemId,
        complete: false,
        resync: false,
        items: [item({ title: 'Updated' })],
        serverTime,
      },
      true,
    );
    expect((await store.listItems(workspace)).map((row) => row.title)).toEqual(['Original']);
    expect(await store.getCheckpoint(workspace)).toEqual({
      cursor: '1',
      snapshot: { boundary: '2', nextCursor: itemId },
      sealed: false,
    });
    await store.close();
    store = await setupResult.reopen();
    await store.applySnapshotPage(
      workspace,
      {
        boundary: '2',
        nextCursor: null,
        complete: true,
        resync: false,
        items: [item({ id: secondId, title: 'Second' })],
        serverTime,
      },
      false,
    );
    expect((await store.listItems(workspace)).map((row) => row.title)).toEqual([
      'Second',
      'Updated',
    ]);
    expect(await store.getCheckpoint(workspace)).toEqual({
      cursor: '2',
      snapshot: null,
      sealed: false,
    });
    await store.applySnapshotPage(
      workspace,
      { boundary: '3', nextCursor: null, complete: false, resync: true, items: [], serverTime },
      true,
    );
    expect((await store.listItems(workspace)).map((row) => row.title)).toEqual([
      'Second',
      'Updated',
    ]);
    expect((await store.getCheckpoint(workspace)).cursor).toBe('2');
  });

  it("keeps an item's settings across a reopen", async () => {
    const setupResult = await setup();
    const settings = { comments: true, suggesting: false, reviewStates: false, fullWidth: true };
    await snapshot(setupResult.store, [item({ settings })]);
    await setupResult.store.close();
    const store = await setupResult.reopen();
    expect((await store.listItems(workspace))[0]?.settings).toEqual(settings);
  });

  it('rolls back both item changes and cursor advancement on a real SQLite trigger failure', async () => {
    const { store, driver } = await setup();
    await snapshot(store, [item()]);
    const connection = driver.open();
    await connection.execute(
      "CREATE TRIGGER fail_cursor BEFORE UPDATE ON mirror_checkpoint BEGIN SELECT RAISE(ABORT, 'interrupted checkpoint'); END",
    );
    connection.close();
    await expect(
      store.applyChangesPage(workspace, {
        cursor: '2',
        hasMore: false,
        resync: false,
        items: [item({ title: 'Uncommitted' })],
        serverTime,
      }),
    ).rejects.toThrow('interrupted checkpoint');
    expect((await store.listItems(workspace)).map((row) => row.title)).toEqual(['Original']);
    expect((await store.getCheckpoint(workspace)).cursor).toBe('1');
  });

  it('merges acknowledged local updates into confirmed state and keeps newer pending edits across reopen', async () => {
    const setupResult = await setup();
    let store = setupResult.store;
    await snapshot(store, [item()]);
    const server = new Y.Doc();
    const local = new Y.Doc();
    try {
      await store.commitBodySync(workspace, response(server));
      local.getText('content').insert(0, 'first');
      const first = Y.encodeStateAsUpdate(local);
      const firstVector = Y.encodeStateVector(local);
      await store.enqueueBodyUpdate(workspace, itemId, { clientId: 'first', update: first });
      local.getText('content').insert(5, ' second');
      await store.enqueueBodyUpdate(workspace, itemId, {
        clientId: 'second',
        update: Y.encodeStateAsUpdate(local, firstVector),
      });
      expect((await store.searchItems(workspace, 'second')).map((row) => row.id)).toEqual([itemId]);
      await store.commitBodySync(workspace, response(server, ['first']));
      await store.close();
      store = await setupResult.reopen();
      const body = await store.readBody(workspace, itemId);
      expect(body?.pending.map((pending) => pending.clientId)).toEqual(['second']);
      const restored = new Y.Doc();
      try {
        if (!body?.confirmedUpdate) throw new Error('Expected a persisted full body');
        Y.applyUpdate(restored, body.confirmedUpdate);
        expect(restored.getText('content').toJSON()).toBe('first');
        for (const pending of body.pending) Y.applyUpdate(restored, pending.update);
        expect(restored.getText('content').toJSON()).toBe('first second');
      } finally {
        restored.destroy();
      }
    } finally {
      server.destroy();
      local.destroy();
    }
  });

  it('excludes protected bodies and removes expired descendants, drafts, conflicts and search data', async () => {
    const { store } = await setup();
    await snapshot(store, [item(), item({ id: secondId, parentId: itemId, title: 'Child' })]);
    const doc = new Y.Doc();
    try {
      doc.getText('content').insert(0, 'privatephrase');
      await store.enqueueBodyUpdate(workspace, secondId, {
        clientId: 'draft',
        update: Y.encodeStateAsUpdate(doc),
      });
      await store.enqueue(workspace, {
        operationId,
        itemId: secondId,
        kind: 'rename',
        expectedRevision: '1',
        payload: { title: 'Queued' },
      });
      await store.applyChangesPage(workspace, {
        cursor: '2',
        hasMore: false,
        resync: false,
        items: [item({ canPersistBody: false, bodyDocId: null, locked: true })],
        serverTime,
      });
      await expect(
        store.enqueueBodyUpdate(workspace, itemId, {
          clientId: 'denied',
          update: Y.encodeStateAsUpdate(doc),
        }),
      ).rejects.toThrow('not admitted');
      expect((await store.readBody(workspace, itemId))?.confirmedUpdate).toBeNull();
      await store.applyChangesPage(workspace, {
        cursor: '3',
        hasMore: false,
        resync: false,
        items: [item({ metadataExpiresAt: '2000-01-01T00:00:00Z' })],
        serverTime,
      });
      expect(await store.listItems(workspace)).toEqual([]);
      expect(await store.listOutbox(workspace)).toEqual([]);
      expect(await store.searchItems(workspace, 'privatephrase')).toEqual([]);
    } finally {
      doc.destroy();
    }
  });

  it('remaps offline creates and pending document updates, and projects queued titles into reads and search', async () => {
    const { store } = await setup();
    const local = new Y.Doc();
    try {
      await store.enqueue(workspace, {
        operationId,
        itemId,
        kind: 'create',
        payload: { type: 'prose', title: 'PreviousTitle', parentId: null },
      });
      local.getText('content').insert(0, 'offline capture');
      await store.enqueueBodyUpdate(workspace, itemId, {
        clientId: 'capture',
        update: Y.encodeStateAsUpdate(local),
      });
      expect(await store.knownItemIds(workspace)).toEqual([]);
      await store.enqueue(workspace, {
        operationId: secondId,
        itemId,
        kind: 'rename',
        expectedRevision: '0',
        payload: { title: 'Renamed' },
      });
      expect((await store.searchItems(workspace, 'Renamed')).map((row) => row.title)).toEqual([
        'Renamed',
      ]);
      expect(await store.searchItems(workspace, 'PreviousTitle')).toEqual([]);
      expect((await store.readBody(workspace, itemId))?.item.title).toBe('Renamed');
      await store.recordReplayResult(workspace, {
        operationId,
        status: 'applied',
        itemId: canonicalId,
        revision: '9',
        item: item({ id: canonicalId, bodyDocId: null, title: 'Capture', revision: '9' }),
        code: null,
      });
      expect(await store.resolveItemId(workspace, itemId)).toBe(canonicalId);
      expect(await store.peekOutbox(workspace)).toMatchObject({
        itemId: canonicalId,
        expectedRevision: '9',
      });
      expect(
        (await store.readBody(workspace, canonicalId))?.pending.map((pending) => pending.clientId),
      ).toEqual(['capture']);
      const empty = new Y.Doc();
      try {
        await store.commitBodySync(workspace, { ...response(empty), itemId: canonicalId });
        expect((await store.readBody(workspace, canonicalId))?.pending).toHaveLength(1);
        await store.commitBodySync(workspace, {
          ...response(empty, ['capture']),
          itemId: canonicalId,
        });
        expect((await store.readBody(workspace, canonicalId))?.pending).toEqual([]);
      } finally {
        empty.destroy();
      }
    } finally {
      local.destroy();
    }
  });

  it('persists resync sealing and fails closed for mirror-off and account wipe', async () => {
    const setupResult = await setup();
    let store = setupResult.store;
    await snapshot(store, [item()]);
    await store.sealWorkspace(workspace);
    expect(await store.listItems(workspace)).toEqual([]);
    expect(await store.searchItems(workspace, 'Original')).toEqual([]);
    expect(await store.readBody(workspace, itemId)).toBeNull();
    expect(await store.knownItemIds(workspace)).toEqual([itemId]);
    await store.close();
    store = await setupResult.reopen();
    expect((await store.getCheckpoint(workspace)).sealed).toBe(true);
    expect(await store.listItems(workspace)).toEqual([]);
    await store.unsealWorkspace(workspace);
    expect(await store.listItems(workspace)).toHaveLength(1);
    const off = store.setSetting(`mirrorOff:${workspace}`, 'true');
    await expect(store.listItems(workspace)).rejects.toThrow('no longer authorized');
    await off;
    await expect(
      store.applyChangesPage(workspace, {
        cursor: '2',
        hasMore: false,
        resync: false,
        items: [item()],
        serverTime,
      }),
    ).rejects.toThrow('no longer authorized');
    await store.setSetting(`mirrorOff:${workspace}`, null);
    expect(await store.listItems(workspace)).toEqual([]);
    const wipe = store.wipe();
    await expect(store.getSetting('theme')).rejects.toThrow('no longer authorized');
    await wipe;
    expect(existsSync(setupResult.path)).toBe(false);
    await store.wipe();
  });

  it('rejects account scope reuse and preserves recovery when the server replaces a document', async () => {
    const { store, driver } = await setup();
    await snapshot(store, [item()]);
    await expect(
      openSqliteMirror({ driver, scope: { ...scope, serverOrigin: 'http://other-core.test' } }),
    ).rejects.toThrow('another account');
    const doc = new Y.Doc();
    try {
      doc.getText('content').insert(0, 'recoverable draft');
      await store.enqueueBodyUpdate(workspace, itemId, {
        clientId: 'draft',
        update: Y.encodeStateAsUpdate(doc),
      });
      await store.applyChangesPage(workspace, {
        cursor: '2',
        hasMore: false,
        resync: false,
        items: [item({ bodyDocId: secondId })],
        serverTime,
      });
      expect((await store.readBody(workspace, itemId))?.pending).toEqual([]);
      const conflicts = await store.listConflicts(workspace);
      expect(conflicts).toMatchObject([{ kind: 'body', code: 'document_changed' }]);
      const recovery = await store.readConflictRecovery(workspace, `body:${itemId}`);
      expect(recovery).not.toBeNull();
      await store.applyChangesPage(workspace, {
        cursor: '3',
        hasMore: false,
        resync: false,
        items: [item({ bodyDocId: null, canPersistBody: false, locked: true })],
        serverTime,
      });
      expect(await store.listConflicts(workspace)).toEqual([]);
      expect(await store.readConflictRecovery(workspace, `body:${itemId}`)).toBeNull();
    } finally {
      doc.destroy();
    }
  });

  it('dismisses a conflict together with its recovery data', async () => {
    const { store } = await setup();
    await snapshot(store, [item()]);
    const doc = new Y.Doc();
    try {
      doc.getText('content').insert(0, 'recoverable draft');
      await store.enqueueBodyUpdate(workspace, itemId, {
        clientId: 'draft',
        update: Y.encodeStateAsUpdate(doc),
      });
      await store.applyChangesPage(workspace, {
        cursor: '2',
        hasMore: false,
        resync: false,
        items: [item({ bodyDocId: secondId })],
        serverTime,
      });
      expect(await store.listConflicts(workspace)).toHaveLength(1);
      await store.dismissConflict(workspace, `body:${itemId}`);
      expect(await store.listConflicts(workspace)).toEqual([]);
      expect(await store.readConflictRecovery(workspace, `body:${itemId}`)).toBeNull();
    } finally {
      doc.destroy();
    }
  });

  it('makes pending update retries idempotent and preserves the newest confirmed head', async () => {
    const { store } = await setup();
    await snapshot(store, [item()]);
    const local = new Y.Doc();
    try {
      local.getText('content').insert(0, 'Capture');
      const update = Y.encodeStateAsUpdate(local);
      await store.enqueueBodyUpdate(workspace, itemId, { clientId: 'retry', update });
      await store.enqueueBodyUpdate(workspace, itemId, { clientId: 'retry', update });
      expect((await store.readBody(workspace, itemId))?.pending).toHaveLength(1);
      local.getText('content').insert(7, ' changed');
      await expect(
        store.enqueueBodyUpdate(workspace, itemId, {
          clientId: 'retry',
          update: Y.encodeStateAsUpdate(local),
        }),
      ).rejects.toThrow('different content');
      await store.commitBodySync(workspace, { ...response(local), headSeq: '100' });
      await store.commitBodySync(workspace, { ...response(local), headSeq: '9' });
      expect((await store.readBody(workspace, itemId))?.item.bodyHeadSeq).toBe('100');
      const items = await store.readItems([itemId]);
      expect(items.map((row) => row.id)).toEqual([itemId]);
    } finally {
      local.destroy();
    }
  });

  it('does not repeatedly notify when expiry checks remove nothing', async () => {
    const { store } = await setup();
    await snapshot(store, [item()]);
    const notifications: string[] = [];
    const unsubscribe = store.subscribe(() => {
      notifications.push('changed');
    });
    await store.purgeExpired(workspace, Date.now());
    await store.purgeExpired(workspace, Date.now());
    expect(notifications).toEqual([]);
    unsubscribe();
  });
});
