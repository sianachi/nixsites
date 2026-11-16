import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';

import { createMirrorPendingSink } from '../../offline/mirror-body-cache';

const workspaceId = 'w1';
const scope = (itemId: string, kind = 'note'): string =>
  JSON.stringify(['me', workspaceId, itemId, kind]);

function typed(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('note').insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

/** A mirror stand-in: `local-1` is a note created offline that has since been aliased. */
function fakeMirror(options: { locked?: boolean; known?: string[]; maxBytes?: number } = {}) {
  const queued: { itemId: string; clientId: string; update: Uint8Array }[] = [];
  const aliases = new Map<string, string>();
  const known = new Set(options.known ?? ['local-1', 'server-1']);
  return {
    queued,
    aliases,
    store: {
      // Like the mirror: an aliased temporary id reads as the server's item.
      readItems: ([itemId = '']: string[]) =>
        Promise.resolve(
          known.has(itemId)
            ? [{ id: aliases.get(itemId) ?? itemId, locked: options.locked === true } as never]
            : [],
        ),
      enqueueBodyUpdate: (
        _w: string,
        itemId: string,
        pending: { clientId: string; update: Uint8Array },
      ) => {
        if (pending.update.byteLength > (options.maxBytes ?? Infinity))
          return Promise.reject(new Error('Body update exceeds the synchronization limit'));
        queued.push({ itemId, clientId: pending.clientId, update: pending.update });
        return Promise.resolve();
      },
    },
  };
}

describe('the shell pending sink', () => {
  it('queues an offline edit under the temporary id, then under the server id once aliased', async () => {
    const mirror = fakeMirror();
    const sink = createMirrorPendingSink(
      () => mirror.store,
      () => 'me',
      1,
    );

    expect(await sink(scope('local-1'), typed('first'))).toBe(true);
    await vi.waitFor(() => {
      expect(mirror.queued).toHaveLength(1);
    });
    mirror.aliases.set('local-1', 'server-1');
    expect(await sink(scope('local-1'), typed('second'))).toBe(true);
    await vi.waitFor(() => {
      expect(mirror.queued).toHaveLength(2);
    });

    expect(mirror.queued.map((entry) => entry.itemId)).toEqual(['local-1', 'server-1']);
    expect(new Set(mirror.queued.map((entry) => entry.clientId)).size).toBe(2);
  });

  it('queues a burst of typing as one update that holds all of it', async () => {
    const mirror = fakeMirror();
    const sink = createMirrorPendingSink(
      () => mirror.store,
      () => 'me',
      20,
    );
    const doc = new Y.Doc();
    const updates: Uint8Array[] = [];
    doc.on('update', (update: Uint8Array) => updates.push(update));
    for (const letter of 'typed') doc.getText('note').insert(doc.getText('note').length, letter);
    for (const update of updates) expect(await sink(scope('server-1'), update)).toBe(true);
    await vi.waitFor(() => {
      expect(mirror.queued).toHaveLength(1);
    });
    const replayed = new Y.Doc();
    Y.applyUpdate(replayed, mirror.queued[0]?.update ?? new Uint8Array());
    expect(replayed.getText('note').toJSON()).toBe('typed');
  });

  it('queues the parts one by one when the burst is too large as a whole', async () => {
    const part = typed('x');
    const mirror = fakeMirror({ maxBytes: part.byteLength });
    const sink = createMirrorPendingSink(
      () => mirror.store,
      () => 'me',
      20,
    );
    await sink(scope('server-1'), part);
    await sink(scope('server-1'), typed('y'));
    await vi.waitFor(() => {
      expect(mirror.queued).toHaveLength(2);
    });
  });

  it('queues nothing for locked bodies, other accounts, other kinds, unknown items or no mirror', async () => {
    const locked = fakeMirror({ locked: true });
    const open = fakeMirror();
    const as = (mirror: ReturnType<typeof fakeMirror> | null, subject: string) =>
      createMirrorPendingSink(
        () => mirror?.store ?? null,
        () => subject,
      );

    expect(await as(locked, 'me')(scope('local-1'), typed('x'))).toBe(false);
    expect(await as(open, 'other')(scope('local-1'), typed('x'))).toBe(false);
    expect(await as(open, 'me')(scope('local-1', 'canvas'), typed('x'))).toBe(false);
    expect(await as(open, 'me')(scope('missing'), typed('x'))).toBe(false);
    expect(await as(null, 'me')(scope('local-1'), typed('x'))).toBe(false);
    expect([...locked.queued, ...open.queued]).toEqual([]);
  });
});
