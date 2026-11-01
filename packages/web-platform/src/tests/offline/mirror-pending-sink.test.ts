import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';

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
function fakeMirror(options: { locked?: boolean; known?: string[] } = {}) {
  const queued: { itemId: string; clientId: string }[] = [];
  const aliases = new Map<string, string>();
  const known = new Set(options.known ?? ['local-1', 'server-1']);
  return {
    queued,
    aliases,
    store: {
      resolveItemId: (_w: string, itemId: string) => Promise.resolve(aliases.get(itemId) ?? itemId),
      readBody: (_w: string, itemId: string) =>
        Promise.resolve(
          known.has(itemId) ? ({ item: { locked: options.locked === true } } as never) : null,
        ),
      enqueueBodyUpdate: (_w: string, itemId: string, pending: { clientId: string }) => {
        queued.push({ itemId, clientId: pending.clientId });
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
    );

    expect(await sink(scope('local-1'), typed('first'))).toBe(true);
    mirror.aliases.set('local-1', 'server-1');
    expect(await sink(scope('local-1'), typed('second'))).toBe(true);

    expect(mirror.queued.map((entry) => entry.itemId)).toEqual(['local-1', 'server-1']);
    expect(new Set(mirror.queued.map((entry) => entry.clientId)).size).toBe(2);
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
