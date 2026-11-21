import type { BodyCacheRecord, BodyCacheStore } from '@nix/web-foundation/lib/body-cache';
import {
  acknowledgeDrafts,
  listDraftScopes,
  readDrafts,
  type DraftRecord,
} from '@nix/web-foundation/lib/draft-journal';
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
 * Queues note edits made while the collaboration socket was not live, so the next sync pass sends
 * them. A burst of typing is gathered for `delayMs` and queued as one update: queued one per
 * keystroke, each would cost a read of the whole note over the shell's bridge and its own slot in
 * the 64 updates a pass sends per note. The editor's draft journal holds every keystroke
 * meanwhile, so a burst lost with the page is replayed when the note is reopened. A note created
 * offline is addressed by its temporary id until the create replays; the mirror resolves it.
 * Locked bodies are never queued.
 */
export function createMirrorPendingSink(
  store: () => Pick<SqliteMirrorStore, 'readItems' | 'enqueueBodyUpdate'> | null,
  subject: () => string | undefined,
  delayMs = 1000,
): (scope: string, update: Uint8Array) => Promise<boolean> {
  const bursts = new Map<string, Uint8Array[]>();

  async function flush(scope: string, workspaceId: string, itemId: string): Promise<void> {
    const updates = bursts.get(scope) ?? [];
    bursts.delete(scope);
    const mirror = store();
    // Re-read: the create may have replayed (a new id) or the body been locked during the burst.
    const item = (await mirror?.readItems([itemId]))?.[0];
    if (mirror === null || item === undefined || item.locked || updates.length === 0) return;
    const queue = (update: Uint8Array): Promise<void> =>
      mirror.enqueueBodyUpdate(workspaceId, item.id, { clientId: crypto.randomUUID(), update });
    try {
      await queue(Y.mergeUpdates(updates));
    } catch {
      // Too large as one update: each part is tried alone, and one failing does not stop the rest.
      for (const update of updates) await queue(update).catch(() => undefined);
    }
  }

  return async (scope, update) => {
    const parsed = scopeSchema.safeParse(JSON.parse(scope));
    const mirror = store();
    if (!parsed.success || mirror === null) return false;
    const [who, workspaceId, itemId, kind] = parsed.data;
    if (kind !== 'note' || who !== subject()) return false;
    const burst = bursts.get(scope);
    if (burst !== undefined) {
      burst.push(update);
      return true;
    }
    // Held before the check below, so edits arriving while it runs join this burst.
    bursts.set(scope, [update]);
    const item = (await mirror.readItems([itemId]).catch(() => []))[0];
    if (item === undefined || item.locked) {
      bursts.delete(scope);
      return false;
    }
    setTimeout(() => {
      void flush(scope, workspaceId, itemId).catch(() => undefined);
    }, delayMs);
    return true;
  };
}

/** Whether applying `draft` on top of `confirmed` changes nothing: the server already has every edit in it. */
function covered(confirmed: Uint8Array, draft: Uint8Array): boolean {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, confirmed);
  const before = Y.encodeStateAsUpdate(doc);
  Y.applyUpdate(doc, draft);
  // An edit that waits on missing history is held aside by Yjs and does not show in the state.
  if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) return false;
  const after = Y.encodeStateAsUpdate(doc);
  return before.length === after.length && before.every((byte, index) => byte === after[index]);
}

export interface DraftJournalAccess {
  scopes: (subject: string) => Promise<string[]>;
  read: (scope: string) => Promise<DraftRecord[]>;
  acknowledge: (records: readonly DraftRecord[]) => Promise<void>;
}

/**
 * Clears the draft-journal entries a sync pass has since confirmed on the server. The journal keeps
 * every offline keystroke so a reopened note can replay it; once the mirror's confirmed state holds
 * an entry's edits, replaying it again is only a duplicate. An entry with anything newer stays, and
 * the journal's own revision check keeps a later edit from another tab.
 */
export async function acknowledgeMirroredDrafts(
  store: Pick<SqliteMirrorStore, 'readBody'>,
  subject: string,
  journal: DraftJournalAccess = {
    scopes: listDraftScopes,
    read: readDrafts,
    acknowledge: (records) => acknowledgeDrafts(records),
  },
): Promise<void> {
  for (const scope of await journal.scopes(subject)) {
    const parsed = scopeSchema.safeParse(JSON.parse(scope));
    if (!parsed.success || parsed.data[3] !== 'note') continue;
    const body = await store.readBody(parsed.data[1], parsed.data[2]);
    const confirmed = body?.confirmedUpdate;
    if (body === null || body.item.locked || body.docId === null || !confirmed) continue;
    const done = (await journal.read(scope)).filter(
      (record) =>
        (record.docId === undefined || record.docId === body.docId) &&
        covered(confirmed, record.update),
    );
    if (done.length > 0) await journal.acknowledge(done);
  }
}
