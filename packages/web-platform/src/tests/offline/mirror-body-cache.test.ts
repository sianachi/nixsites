import type { BodyCacheRecord, BodyCacheStore } from '@nix/web-foundation/lib/body-cache';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { acknowledgeMirroredDrafts, createMirrorBodyCache } from '../../offline/mirror-body-cache';

const scope = (kind: string) => JSON.stringify(['me', 'ws', 'item', kind]);
const update = (text: string): Uint8Array => {
  const doc = new Y.Doc();
  doc.getText('t').insert(0, text);
  return Y.encodeStateAsUpdate(doc);
};
const fallback = (record: BodyCacheRecord | null): BodyCacheStore => ({
  read: () => Promise.resolve(record),
  write: vi.fn(() => Promise.resolve()),
  discard: vi.fn(() => Promise.resolve()),
});
const body = (over: Record<string, unknown> = {}) => ({
  item: { locked: false },
  docId: 'doc',
  schemaVersion: 1,
  headSeq: '4',
  confirmedUpdate: update('a'),
  pending: [],
  ...over,
});
const cache = (read: unknown, local: BodyCacheRecord | null = null) =>
  createMirrorBodyCache(
    () => ({ readBody: () => Promise.resolve(read) }) as never,
    fallback(local),
    () => 'me',
  );

describe('mirror body cache', () => {
  it('reads confirmed note state from the mirror', async () => {
    const record = await cache(body()).read(scope('note'));
    expect(record).toMatchObject({ docId: 'doc', schemaVersion: 1, serverSeq: '4' });
  });

  it('never reads a locked body, an unsynced one, or another kind of document', async () => {
    expect(await cache(body({ item: { locked: true } })).read(scope('note'))).toBeNull();
    expect(await cache(body({ confirmedUpdate: null })).read(scope('note'))).toBeNull();
    expect(await cache(body()).read(scope('sheet'))).toBeNull();
    expect(
      await cache(body()).read(JSON.stringify(['someone-else', 'ws', 'item', 'note'])),
    ).toBeNull();
  });

  it('merges with the browser copy of the same document and falls back otherwise', async () => {
    const local: BodyCacheRecord = {
      scope: scope('note'),
      docId: 'doc',
      schemaVersion: 1,
      savedAt: 5,
      update: update('b'),
    };
    const merged = await cache(body(), local).read(scope('note'));
    const doc = new Y.Doc();
    Y.applyUpdate(doc, merged?.update ?? new Uint8Array());
    expect(doc.getText('t').toJSON()).toHaveLength(2);
    expect(await cache(null, local).read(scope('note'))).toBe(local);
  });
});

describe('acknowledgeMirroredDrafts', () => {
  const draft = (id: string, docId: string | undefined, bytes: Uint8Array) =>
    ({ id, scope: scope('note'), revision: 1, docId, update: bytes }) as never;
  const run = async (confirmed: Uint8Array | null, records: unknown[]) => {
    const acknowledge = vi.fn(() => Promise.resolve());
    await acknowledgeMirroredDrafts(
      {
        readBody: () =>
          Promise.resolve(confirmed === null ? null : body({ confirmedUpdate: confirmed })),
      } as never,
      'me',
      {
        scopes: () => Promise.resolve([scope('note'), scope('file')]),
        read: () => Promise.resolve(records as never),
        acknowledge,
      },
    );
    return acknowledge;
  };

  it('clears entries the confirmed state already holds and keeps newer ones', async () => {
    const doc = new Y.Doc();
    doc.getText('t').insert(0, 'ab');
    const first = Y.encodeStateAsUpdate(doc);
    doc.getText('t').insert(2, 'c');
    const newer = Y.encodeStateAsUpdate(doc);
    const old = draft('old', 'doc', first);
    const acknowledge = await run(first, [old, draft('new', 'doc', newer)]);
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith([old]);
  });

  it('keeps an entry that waits on missing history, one for another document and a missing body', async () => {
    const doc = new Y.Doc();
    doc.getText('t').insert(0, 'ab');
    const base = Y.encodeStateAsUpdate(doc);
    const sv = Y.encodeStateVector(doc);
    doc.getText('t').insert(2, 'c');
    const onlyC = Y.encodeStateAsUpdate(doc, sv);
    expect(await run(update('zz'), [draft('x', 'doc', onlyC)])).not.toHaveBeenCalled();
    expect(await run(base, [draft('y', 'other', base)])).not.toHaveBeenCalled();
    expect(await run(null, [draft('z', 'doc', base)])).not.toHaveBeenCalled();
  });
});
