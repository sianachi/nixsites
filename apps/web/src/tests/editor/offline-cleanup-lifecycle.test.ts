import 'fake-indexeddb/auto';
import * as Y from 'yjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as bodyCache from '../../lib/body-cache';
import * as drafts from '../../lib/draft-journal';

const ALICE = 'cleanup-alice';
const BOB = 'cleanup-bob';

function scope(subject: string, itemId: string): string {
  const value = bodyCache.documentScope(subject, 'workspace', itemId, 'note');
  if (value === undefined) throw new Error('The test note has no storage scope.');
  return value;
}

function update(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('body').insert(0, text);
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes;
}

async function saveNote(subject: string, itemId: string, text: string): Promise<void> {
  const noteScope = scope(subject, itemId);
  const bytes = update(text);
  await bodyCache.writeBodyCache({
    scope: noteScope,
    docId: `doc-${itemId}`,
    schemaVersion: 1,
    savedAt: Date.now(),
    update: bytes,
  });
  await drafts.writeDraft({
    id: `draft-${itemId}`,
    scope: noteScope,
    docId: `doc-${itemId}`,
    revision: 1,
    update: bytes,
  });
}

async function expectSavedNote(subject: string, itemId: string, text: string): Promise<void> {
  const noteScope = scope(subject, itemId);
  const saved = await bodyCache.readBodyCache(noteScope);
  expect(saved).not.toBeNull();
  if (saved === null) throw new Error('The saved note was erased.');
  const doc = new Y.Doc();
  Y.applyUpdate(doc, saved.update);
  expect(doc.getText('body').toJSON()).toBe(text);
  doc.destroy();
  const pending = await drafts.readDrafts(noteScope);
  expect(pending).toHaveLength(1);
  const draft = new Y.Doc();
  for (const record of pending) Y.applyUpdate(draft, record.update);
  expect(draft.getText('body').toJSON()).toBe(text);
  draft.destroy();
}

/** Hold only a new module realm's connection callbacks, leaving existing connections usable. */
function delayCleanupConnections(): {
  readonly pending: () => number;
  readonly release: () => void;
} {
  const waiting: (() => void)[] = [];
  const databases = new Set(['nix-document-cache', 'nix-pending-drafts']);
  const open = indexedDB.open.bind(indexedDB);
  const spy = vi.spyOn(indexedDB, 'open').mockImplementation((name, version) => {
    const request = open(name, version);
    if (!databases.delete(name)) return request;
    const proxy = new Proxy(request, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        return value;
      },
      set(target, property, value: unknown) {
        if (property === 'onsuccess' && typeof value === 'function') {
          target.onsuccess = (event) => {
            waiting.push(() => {
              Reflect.apply(value, proxy, [event]);
            });
          };
          return true;
        }
        return Reflect.set(target, property, value, target);
      },
    });
    return proxy;
  });
  return {
    pending: () => waiting.length,
    release: () => {
      spy.mockRestore();
      for (const resume of waiting.splice(0)) resume();
    },
  };
}

beforeEach(async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    get length() {
      return values.size;
    },
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null,
  });
  await bodyCache.clearBodyCache();
  await drafts.clearDrafts();
  await bodyCache.openBodyCache(ALICE);
  await saveNote(ALICE, 'old-alice', 'Old Alice note');
});

describe('offline cleanup lifecycle', () => {
  it('initializes a legacy account epoch without removing its saved body or journal', async () => {
    localStorage.removeItem(`nix.body-cache.epoch.${JSON.stringify(ALICE)}`);
    localStorage.removeItem(`nix.draft.epoch.${JSON.stringify(ALICE)}`);
    localStorage.removeItem('nix.draft.owner');
    expect(bodyCache.bodyCacheAccountEpoch(ALICE)).toBeNull();

    await bodyCache.openBodyCache(ALICE);

    expect(bodyCache.bodyCacheAccountEpoch(ALICE)).not.toBeNull();
    expect(bodyCache.bodyCacheDraftEpoch(ALICE)).not.toBeNull();
    await expectSavedNote(ALICE, 'old-alice', 'Old Alice note');
  });

  it('seals denied account bodies while preserving queued owner drafts through trusted readmission', async () => {
    const noteScope = scope(ALICE, 'old-alice');
    const epoch = bodyCache.bodyCacheAccountEpoch(ALICE);
    const journal = drafts.createDraftJournal(noteScope, () => undefined);
    await journal.read();
    const sealing = bodyCache.sealAccountBodies(ALICE, epoch);

    expect(bodyCache.bodyCacheAdmits(noteScope)).toBe(false);
    expect(bodyCache.bodyCacheAccountAdmits(ALICE)).toBe(true);
    await sealing;
    expect(await bodyCache.readBodyCache(noteScope)).toBeNull();
    expect(await drafts.readDrafts(noteScope)).toHaveLength(1);
    await bodyCache.openBodyCache(ALICE);
    expect(bodyCache.bodyCacheAdmits(noteScope)).toBe(false);

    journal.append(update('Queued during account denial'));
    const reopening = bodyCache.openBodyCache(ALICE, { reauthorized: true });
    await journal.snapshot();
    await reopening;

    expect(bodyCache.bodyCacheAccountEpoch(ALICE)).not.toBe(epoch);
    expect(bodyCache.bodyCacheCleanupCurrent(ALICE, epoch)).toBe(false);
    expect(bodyCache.bodyCacheAdmits(noteScope)).toBe(true);
    const pending = await drafts.readDrafts(noteScope);
    expect(pending).toHaveLength(2);
    const restored = new Y.Doc();
    for (const record of pending) Y.applyUpdate(restored, record.update);
    expect(restored.getText('body').toJSON()).toContain('Queued during account denial');
    restored.destroy();
  });

  it.each([
    { operation: 'seal', subject: BOB },
    { operation: 'prune', subject: BOB },
    { operation: 'discard', subject: BOB },
    { operation: 'seal', subject: ALICE },
    { operation: 'prune', subject: ALICE },
    { operation: 'discard', subject: ALICE },
  ])(
    'preserves $subject after a delayed $operation from an earlier account lifecycle',
    async ({ operation, subject }) => {
      vi.resetModules();
      const otherBodyCache = await import('../../lib/body-cache');
      const gate = delayCleanupConnections();
      const work =
        operation === 'seal'
          ? otherBodyCache.sealItemBodies(ALICE, 'workspace', 'old-alice')
          : operation === 'prune'
            ? otherBodyCache.pruneBodyCache(ALICE, [])
            : otherBodyCache.discardBodyCache(scope(ALICE, 'old-alice'));
      const cleanup = Promise.allSettled([work]);
      try {
        await vi.waitFor(() => {
          expect(gate.pending()).toBe(1);
        });
        await bodyCache.openBodyCache(BOB);
        if (subject === ALICE) await bodyCache.openBodyCache(ALICE);
        await saveNote(subject, 'old-alice', 'Fresh lifecycle note');
        gate.release();
        await cleanup;

        await expectSavedNote(subject, 'old-alice', 'Fresh lifecycle note');
        expect(bodyCache.bodyCacheAdmits(scope(subject, 'old-alice'))).toBe(true);
      } finally {
        gate.release();
      }
    },
  );

  it('keeps a newly admitted account’s bodies and drafts during delayed cleanup', async () => {
    vi.resetModules();
    const otherBodyCache = await import('../../lib/body-cache');
    const otherDrafts = await import('../../lib/draft-journal');
    const gate = delayCleanupConnections();
    const cleanup = Promise.all([
      otherBodyCache.clearBodyCache(ALICE),
      otherDrafts.clearDrafts(ALICE),
    ]);
    try {
      await vi.waitFor(() => {
        expect(gate.pending()).toBe(2);
      });
      await bodyCache.openBodyCache(BOB);
      await saveNote(BOB, 'fresh-bob', 'Fresh Bob note');
      gate.release();
      await cleanup;

      await expectSavedNote(BOB, 'fresh-bob', 'Fresh Bob note');
      expect(bodyCache.bodyCacheAccountAdmits(BOB)).toBe(true);
    } finally {
      gate.release();
    }
  });

  it('cancels an old cleanup after signing back into the same account and retains its fresh notes', async () => {
    const previousEpoch = bodyCache.bodyCacheAccountEpoch(ALICE);
    vi.resetModules();
    const otherBodyCache = await import('../../lib/body-cache');
    const otherDrafts = await import('../../lib/draft-journal');
    const gate = delayCleanupConnections();
    const cleanup = Promise.allSettled([
      otherBodyCache.clearBodyCache(ALICE),
      otherDrafts.clearDrafts(ALICE),
    ]);
    try {
      await vi.waitFor(() => {
        expect(gate.pending()).toBe(2);
      });
      await bodyCache.openBodyCache(BOB);
      await bodyCache.openBodyCache(ALICE);
      await saveNote(ALICE, 'fresh-alice', 'Fresh Alice note');
      expect(bodyCache.bodyCacheAccountEpoch(ALICE)).not.toBe(previousEpoch);
      expect(bodyCache.bodyCacheCleanupCurrent(ALICE, previousEpoch)).toBe(false);
      gate.release();
      const results = await cleanup;

      expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
      await expectSavedNote(ALICE, 'fresh-alice', 'Fresh Alice note');
      expect(bodyCache.bodyCacheAccountAdmits(ALICE)).toBe(true);
    } finally {
      gate.release();
    }
  });
});
