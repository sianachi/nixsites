import type { BodyCacheRecord, BodyCacheStore } from '@nix/web-foundation/lib/body-cache';
import type { SqliteMirrorStore } from '@nix/sync-sqlite';
import * as Y from 'yjs';
import { z } from 'zod';

/**
 * The shell's body cache: confirmed note state from the synced copy first, then the browser's own
 * cache. Reads only. The editor's confirmed snapshots still go to the browser cache, and the sync
 * pass refreshes the mirror, so nothing here writes to the mirror, which is also how a locked body
 * is kept out of it: the mirror never holds one and this store never reads one.
 */

const scopeSchema = z.tuple([z.string(), z.string(), z.string(), z.string()]);

export function createMirrorBodyCache(
  store: () => Pick<SqliteMirrorStore, 'readBody'> | null,
  fallback: BodyCacheStore,
  subject: () => string | undefined,
): BodyCacheStore {
  async function fromMirror(scope: string): Promise<BodyCacheRecord | null> {
    const parsed = scopeSchema.safeParse(JSON.parse(scope));
    const mirror = store();
    if (!parsed.success || mirror === null) return null;
    const [who, workspaceId, itemId, kind] = parsed.data;
    if (kind !== 'note' || who !== subject()) return null;
    const body = await mirror.readBody(workspaceId, itemId);
    if (
      body === null ||
      body.item.locked ||
      body.docId === null ||
      body.schemaVersion === null ||
      body.confirmedUpdate === null
    )
      return null;
    return {
      scope,
      docId: body.docId,
      schemaVersion: body.schemaVersion,
      ...(body.headSeq === null ? {} : { serverSeq: body.headSeq }),
      savedAt: 0,
      update: body.confirmedUpdate,
    };
  }

  return {
    async read(scope) {
      const [mirrored, local] = await Promise.all([
        fromMirror(scope).catch(() => null),
        fallback.read(scope),
      ]);
      if (mirrored === null) return local;
      if (local?.docId !== mirrored.docId || local.schemaVersion !== mirrored.schemaVersion)
        return mirrored;
      // The same server document, so both are confirmed state and their union is safe.
      return {
        ...mirrored,
        savedAt: local.savedAt,
        update: Y.mergeUpdates([mirrored.update, local.update]),
      };
    },
    write: (record, admitted) => fallback.write(record, admitted),
    discard: (scope) => fallback.discard(scope),
    ...(fallback.seal === undefined ? {} : { seal: fallback.seal.bind(fallback) }),
  };
}

/**
 * Queues a note edit made while the collaboration socket was not live, so the next sync pass
 * sends it. A note created offline is still under its temporary id here; the mirror carries the
 * pending update over to the server's id when the create replays. Locked bodies are never queued.
 */
export function createMirrorPendingSink(
  store: () => Pick<SqliteMirrorStore, 'readBody' | 'enqueueBodyUpdate' | 'resolveItemId'> | null,
  subject: () => string | undefined,
): (scope: string, update: Uint8Array) => Promise<boolean> {
  return async (scope, update) => {
    const parsed = scopeSchema.safeParse(JSON.parse(scope));
    const mirror = store();
    if (!parsed.success || mirror === null) return false;
    const [who, workspaceId, itemId, kind] = parsed.data;
    if (kind !== 'note' || who !== subject()) return false;
    const resolved = await mirror.resolveItemId(workspaceId, itemId);
    const body = await mirror.readBody(workspaceId, resolved);
    if (body === null || body.item.locked) return false;
    await mirror.enqueueBodyUpdate(workspaceId, resolved, {
      clientId: crypto.randomUUID(),
      update,
    });
    return true;
  };
}
