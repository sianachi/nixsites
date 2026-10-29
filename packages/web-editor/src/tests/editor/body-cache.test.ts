import 'fake-indexeddb/auto';
import * as Y from 'yjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearBodyCache,
  bodyCacheAdmits,
  bodyCacheAccountAdmits,
  bodyCacheFenceVersion,
  discardBodyCache,
  documentScope,
  listBodyCacheScopes,
  onBodyForgetting,
  type BodyForgetting,
  openBodyCache,
  pruneBodyCache,
  sealItemBodies,
  sealBodyCache,
  reopenRefusedItemBodies,
  readBodyCache,
  writeBodyCache,
  type BodyCacheRecord,
} from '@nix/web-foundation/lib/body-cache';
import { frecencyScores, recordPick } from '@nix/web-foundation/lib/frecency';
import { readDismissals, rememberDismissal } from '@nix/web-foundation/lib/suggestion-dismissals';
import { memoryStorage } from '@nix/web-foundation/testing/memory-storage';

const ADA = 'subject-ada';
const BO = 'subject-bo';

function scope(subject: string, item: string, workspace = 'workspace-1'): string {
  const value = documentScope(subject, workspace, item, 'note');
  if (value === undefined) throw new Error('No scope.');
  return value;
}

function record(forScope: string, savedAt = Date.now(), bytes = 4): BodyCacheRecord {
  return {
    scope: forScope,
    docId: `doc-${forScope}`,
    schemaVersion: 1,
    savedAt,
    update: bytes === 4 ? Y.encodeStateAsUpdate(new Y.Doc()) : new Uint8Array(bytes),
  };
}

/** The marker naming who the store belongs to lives in localStorage, shared by every tab. */
beforeEach(async () => {
  vi.stubGlobal('localStorage', memoryStorage());
  await clearBodyCache();
  await openBodyCache(ADA);
});

describe('the document body store', () => {
  it('reads back what it wrote, for the same scope only', async () => {
    await writeBodyCache(record(scope(ADA, 'a')));

    expect((await readBodyCache(scope(ADA, 'a')))?.docId).toBe(`doc-${scope(ADA, 'a')}`);
    expect(await readBodyCache(scope(ADA, 'b'))).toBeNull();
  });

  it('merges same-document snapshots so an older background writer cannot erase confirmed edits', async () => {
    const doc = new Y.Doc();
    doc.getText('body').insert(0, 'Base');
    const older = Y.encodeStateAsUpdate(doc);
    doc.getText('body').insert(4, ' newer edit');
    const forScope = scope(ADA, 'concurrent');
    await writeBodyCache({
      ...record(forScope),
      docId: 'same-doc',
      update: Y.encodeStateAsUpdate(doc),
    });
    await writeBodyCache({ ...record(forScope), docId: 'same-doc', update: older });
    const saved = await readBodyCache(forScope);
    const reopened = new Y.Doc();
    if (saved !== null) Y.applyUpdate(reopened, saved.update);
    expect(reopened.getText('body').toJSON()).toBe('Base newer edit');
    doc.destroy();
    reopened.destroy();
  });

  it('keeps the whole downloaded corpus beyond the former 200-note bound', async () => {
    const now = Date.now();
    for (let index = 0; index <= 250; index += 1) {
      await writeBodyCache(record(scope(ADA, `item-${String(index)}`), now - 250 + index));
    }

    expect(await readBodyCache(scope(ADA, 'item-0'))).not.toBeNull();
    expect(await readBodyCache(scope(ADA, 'item-1'))).not.toBeNull();
    expect(await readBodyCache(scope(ADA, 'item-250'))).not.toBeNull();
  });

  it('preserves the highest confirmed sequence across older and socket snapshot writers', async () => {
    const original = record(scope(ADA, 'cursor'));
    await writeBodyCache({ ...original, serverSeq: '9007199254740993' });
    await writeBodyCache({ ...original, serverSeq: '9007199254740992' });
    await writeBodyCache(original);

    expect((await readBodyCache(original.scope))?.serverSeq).toBe('9007199254740993');

    await writeBodyCache({ ...original, docId: 'replacement' });
    expect((await readBodyCache(original.scope))?.serverSeq).toBeUndefined();
  });

  it('refuses a body larger than the per-document limit', async () => {
    await expect(
      writeBodyCache(record(scope(ADA, 'huge'), Date.now(), 8 * 1024 * 1024 + 1)),
    ).rejects.toThrow('offline storage limit');

    expect(await readBodyCache(scope(ADA, 'huge'))).toBeNull();
  });

  it('keeps offline copies until an explicit access or account lifecycle change', async () => {
    await writeBodyCache(record(scope(ADA, 'old'), Date.now() - 90 * 24 * 60 * 60 * 1000));

    expect(await readBodyCache(scope(ADA, 'old'))).not.toBeNull();
    await pruneBodyCache(ADA, ['workspace-1']);
    expect(await readBodyCache(scope(ADA, 'old'))).not.toBeNull();
  });

  it('is closed after sign-out: nothing to read, and a late write is refused', async () => {
    await writeBodyCache(record(scope(ADA, 'a')));
    await clearBodyCache();

    // An editor still mounted in this or another tab tries to put its copy back.
    await writeBodyCache(record(scope(ADA, 'late')));
    await openBodyCache(ADA);

    expect(await readBodyCache(scope(ADA, 'a'))).toBeNull();
    expect(await readBodyCache(scope(ADA, 'late'))).toBeNull();
  });

  it('never serves or keeps one person’s copies for the next person to sign in', async () => {
    await writeBodyCache(record(scope(ADA, 'a')));
    await openBodyCache(BO);

    await writeBodyCache(record(scope(ADA, 'b')));
    expect(await readBodyCache(scope(ADA, 'a'))).toBeNull();
    expect(await readBodyCache(scope(ADA, 'b'))).toBeNull();

    // Ada signing back in finds nothing of hers either: the store was cleared for Bo.
    await openBodyCache(ADA);
    expect(await readBodyCache(scope(ADA, 'a'))).toBeNull();
  });

  it('forgets pick history and dismissed suggestions when a different person signs in', async () => {
    recordPick('select:w1:status', 'Done');
    rememberDismissal('mention:w1:item-1');

    await openBodyCache(BO);

    expect(frecencyScores('select:w1:status').size).toBe(0);
    expect(readDismissals().size).toBe(0);
  });

  it('keeps pick history when the same person opens the store again', async () => {
    recordPick('slash', 'heading');

    await openBodyCache(ADA);

    expect(frecencyScores('slash').get('heading')).toBeGreaterThan(0);
  });

  it('prunes copies in workspaces the person can no longer reach', async () => {
    await writeBodyCache(record(scope(ADA, 'kept', 'workspace-1')));
    await writeBodyCache(record(scope(ADA, 'gone', 'workspace-2')));

    await pruneBodyCache(ADA, ['workspace-1']);

    expect(await readBodyCache(scope(ADA, 'kept', 'workspace-1'))).not.toBeNull();
    expect(await readBodyCache(scope(ADA, 'gone', 'workspace-2'))).toBeNull();
  });

  it('removes every copy of a locked item and refuses new ones, leaving other items alone', async () => {
    const note = scope(ADA, 'locked-item');
    const canvas = documentScope(ADA, 'workspace-1', 'locked-item', 'canvas') ?? '';
    const neighbour = scope(ADA, 'locked-item-2');
    await writeBodyCache(record(note));
    await writeBodyCache(record(canvas));
    await writeBodyCache(record(neighbour));

    await sealItemBodies(ADA, 'workspace-1', 'locked-item');
    // The editor that was showing it writes its copy as it closes, after the seal.
    await writeBodyCache(record(note));

    expect(await readBodyCache(note)).toBeNull();
    expect(await readBodyCache(canvas)).toBeNull();
    expect(await readBodyCache(neighbour)).not.toBeNull();
  });

  it('shares a known refusal with another module realm and keeps it closed after reload', async () => {
    const refused = scope(ADA, 'refused-shared');
    await writeBodyCache(record(refused));
    await sealBodyCache(refused);
    vi.resetModules();
    const anotherTab = await import('@nix/web-foundation/lib/body-cache');

    expect(anotherTab.bodyCacheAdmits(refused)).toBe(false);
    await anotherTab.writeBodyCache(record(refused));
    expect(await anotherTab.readBodyCache(refused)).toBeNull();
    await anotherTab.openBodyCache(ADA);
    expect(anotherTab.bodyCacheAdmits(refused)).toBe(false);
  });

  it('keeps ordinary replacement discards recacheable', async () => {
    const replaced = scope(ADA, 'replaceable');
    await writeBodyCache(record(replaced));
    await discardBodyCache(replaced);
    await writeBodyCache({ ...record(replaced), docId: 'replacement' });

    expect(bodyCacheAdmits(replaced)).toBe(true);
    expect((await readBodyCache(replaced))?.docId).toBe('replacement');
  });

  it('closes all cache admission if shared refusal storage is full', async () => {
    const storage = localStorage;
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('Quota exceeded');
    });

    await sealBodyCache(scope(ADA, 'quota-refusal'));

    expect(bodyCacheAdmits(scope(ADA, 'quota-refusal'))).toBe(false);
    expect(bodyCacheAdmits(scope(ADA, 'another-item'))).toBe(false);
    expect(bodyCacheAccountAdmits(ADA)).toBe(true);
  });

  it('fails closed without throwing when shared fence storage cannot be read', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('Storage is blocked');
    });

    expect(bodyCacheFenceVersion(scope(ADA, 'blocked-storage'))).toBe('storage-unavailable');
    expect(bodyCacheAdmits(scope(ADA, 'blocked-storage'))).toBe(false);
  });

  it('retains an older installation’s draft owner when quota closes cache admission', async () => {
    localStorage.removeItem('nix.draft.owner');
    const storage = localStorage;
    const setItem = storage.setItem.bind(storage);
    vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
      if (
        key.startsWith('nix.body-cache.sealed-item.') ||
        (key === 'nix.draft.owner' && storage.getItem('nix.body-cache.subject') !== null)
      )
        throw new Error('Quota exceeded');
      setItem(key, value);
    });
    await expect(openBodyCache(ADA)).rejects.toThrow('Quota exceeded');
    await sealBodyCache(scope(ADA, 'upgrade-quota'));

    expect(bodyCacheAdmits(scope(ADA, 'upgrade-quota'))).toBe(false);
    expect(bodyCacheAccountAdmits(ADA)).toBe(true);
    await openBodyCache(ADA);
    expect(bodyCacheAdmits(scope(ADA, 'another-item'))).toBe(false);
  });

  it('reopens only a refused item after trusted authorization and preserves its fence generation', async () => {
    const refused = scope(ADA, 'reauthorized');
    const locked = scope(ADA, 'still-locked');
    const beforeRefusal = bodyCacheFenceVersion(refused);
    await sealBodyCache(refused);
    await sealBodyCache(locked, 'locked');
    reopenRefusedItemBodies(ADA, 'workspace-1', 'reauthorized');
    reopenRefusedItemBodies(ADA, 'workspace-1', 'still-locked');

    expect(bodyCacheAdmits(refused)).toBe(true);
    expect(bodyCacheFenceVersion(refused)).not.toBe(beforeRefusal);
    expect(bodyCacheAdmits(locked)).toBe(false);
    await writeBodyCache(record(refused), () => bodyCacheFenceVersion(refused) === beforeRefusal);
    expect(await readBodyCache(refused)).toBeNull();
    await writeBodyCache(record(refused));
    expect(await readBodyCache(refused)).not.toBeNull();
  });

  it('stays closed where the browser offers no storage to record whose it is', async () => {
    vi.stubGlobal('localStorage', undefined);
    await openBodyCache(ADA);
    await writeBodyCache(record(scope(ADA, 'a')));

    vi.stubGlobal('localStorage', memoryStorage());
    await openBodyCache(ADA);
    expect(await readBodyCache(scope(ADA, 'a'))).toBeNull();
  });

  it('scopes a copy to the signed-in person and workspace, and has none without them', () => {
    expect(documentScope('person', 'workspace', 'item', 'note')).toBe(
      JSON.stringify(['person', 'workspace', 'item', 'note']),
    );
    expect(documentScope(undefined, 'workspace', 'item', 'note')).toBeUndefined();
    expect(documentScope('person', undefined, 'item', 'note')).toBeUndefined();
  });
});

describe('what derived holders are told', () => {
  it('lists one workspace’s copies newest first, without reading their bodies', async () => {
    const now = Date.now();
    await writeBodyCache(record(scope(ADA, 'older'), now - 2_000));
    await writeBodyCache(record(scope(ADA, 'newer'), now - 1_000));
    await writeBodyCache(record(scope(ADA, 'elsewhere', 'workspace-2'), now));

    expect(await listBodyCacheScopes(ADA, 'workspace-1', 10)).toEqual([
      scope(ADA, 'newer'),
      scope(ADA, 'older'),
    ]);
    expect(await listBodyCacheScopes(ADA, 'workspace-1', 1)).toEqual([scope(ADA, 'newer')]);
    expect(await listBodyCacheScopes(BO, 'workspace-1', 10)).toEqual([]);
  });

  it('announces every forgetting before it touches the disk', async () => {
    const heard: BodyForgetting['kind'][] = [];
    const stop = onBodyForgetting((forgetting) => {
      heard.push(forgetting.kind);
    });

    await discardBodyCache(scope(ADA, 'a'));
    await sealItemBodies(ADA, 'workspace-1', 'b');
    await pruneBodyCache(ADA, ['workspace-1']);
    await clearBodyCache();
    stop();
    await clearBodyCache();

    expect(heard).toEqual(['scope', 'item', 'unreachable', 'everything']);
  });

  it('notifies derived holders when another tab seals an item', () => {
    const item = JSON.stringify([ADA, 'workspace-1', 'other-tab-refusal']);
    const key = `nix.body-cache.sealed-item.${item}`;
    localStorage.setItem(key, '1');
    const heard: BodyForgetting[] = [];
    const stop = onBodyForgetting((forgetting) => {
      heard.push(forgetting);
    });

    window.dispatchEvent(new StorageEvent('storage', { key, newValue: '1' }));

    expect(heard).toEqual([{ kind: 'item', prefix: `${item.slice(0, -1)},`, sealed: true }]);
    expect(bodyCacheAdmits(scope(ADA, 'other-tab-refusal'))).toBe(false);
    stop();
  });
});
