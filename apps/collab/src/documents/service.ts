import { SCHEMA_VERSION, nixSchema } from '@nix/editor-schema';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';

import {
  appendUpdate,
  createDoc,
  findDocByItem,
  replaceItemLinks,
  snapshotAtOrBefore,
  updatesAfter,
  clearItemChunks,
  writeItemChunks,
  writeItemSearchText,
  writeSnapshot,
  type ContentDocRow,
} from '../db/documents.ts';
import { stateAt } from '../db/history.ts';
import type { ScopedQuery } from '../db/tenant-scope.ts';
import { FRAGMENT_NAME, noteStrategy, type BodyKindStrategy } from './body-kinds.ts';
import { chunkNote } from './chunks.ts';
import { LIMITS, type Rejection, rejection } from './limits.ts';
import { boundSearchText } from './links.ts';

export { FRAGMENT_NAME };

/** How many updates one catch-up returns. A client that is further behind asks again. */
export const CATCH_UP_LIMIT = 500;

export interface AppendResult {
  readonly seq: bigint;
  readonly snapshotWritten: boolean;
}

export type Appended = { ok: true; value: AppendResult } | { ok: false; error: Rejection };

/**
 * Loads a document's state by replaying its log from the newest snapshot.
 *
 * **A snapshot is an optimisation and never a source of truth.** Deleting every snapshot in
 * the database costs replay time and loses nothing, which is the property that lets the
 * snapshot cadence change - or a bad snapshot be discarded - without a migration.
 */
export async function loadDocument(
  sql: ScopedQuery,
  tenantId: string,
  doc: ContentDocRow,
): Promise<Y.Doc> {
  const head = BigInt(doc.head_seq);
  const state = new Y.Doc();

  const snapshot = await snapshotAtOrBefore(sql, tenantId, doc.doc_id, head);
  let from = 0n;

  if (snapshot !== null) {
    Y.applyUpdate(state, new Uint8Array(snapshot.yjs_state));
    from = BigInt(snapshot.seq);
  }

  // Replayed in pages rather than in one query, so a document with a long log since its
  // last snapshot cannot be the thing that decides this process's memory ceiling.
  for (;;) {
    const page = await updatesAfter(sql, tenantId, doc.doc_id, from, CATCH_UP_LIMIT);
    if (page.length === 0) {
      break;
    }

    Y.transact(state, () => {
      for (const row of page) {
        Y.applyUpdate(state, new Uint8Array(row.update_bytes));
      }
    });

    const last = page[page.length - 1];
    if (last === undefined) {
      break;
    }

    from = BigInt(last.seq);
  }

  return state;
}

/**
 * Finds an item's document body, creating it on first use.
 *
 * Returns null when the item is not visible to this tenant - which the caller has already
 * established it is, through Core, so this is the belt to that braces.
 */
export async function openDocument(
  sql: ScopedQuery,
  tenantId: string,
  itemId: string,
  workspaceId: string,
  newDocId: () => string,
): Promise<ContentDocRow | null> {
  const existing = await findDocByItem(sql, tenantId, itemId);
  if (existing !== null) {
    return existing.workspace_id === workspaceId ? existing : null;
  }

  await createDoc(sql, {
    docId: newDocId(),
    tenantId,
    itemId,
    workspaceId,
    schemaVersion: SCHEMA_VERSION,
  });

  // Re-read rather than trusting the identifier just minted: the insert may have done
  // nothing because another request created the document first, and that request's
  // identifier is the one everybody else will use.
  const opened = await findDocByItem(sql, tenantId, itemId);
  // Creating the body may have waited behind a workspace transfer. Its metadata trigger
  // follows the item's new containment; the authorization supplied by this caller does not.
  // Require a fresh Core authorization before exposing or writing the transferred body.
  return opened?.workspace_id === workspaceId ? opened : null;
}

/**
 * Applies an update, checks what it produced, and stores it if the result is a document.
 *
 * **Validation happens by applying, not by inspecting.** A Yjs update is a set of
 * operations, not a document, so the only honest question is what the document becomes once
 * they are merged - and that question is asked against a throwaway copy, so a rejected
 * update leaves nothing behind.
 *
 * The checks, in the order that makes the cheapest refusal first:
 *
 * 1. the payload fits the update ceiling, which matches the column's own CHECK;
 * 2. it decodes as a Yjs update at all;
 * 3. the merged document still parses against `SCHEMA_VERSION`'s node and mark set;
 * 4. it needs no version above the one the document is pinned to;
 * 5. the merged document is under the node and byte ceilings.
 *
 * Rate backpressure is applied by the caller, before any of this, because it is the one
 * refusal that should not cost a database round trip.
 */
export async function applyUpdate(
  sql: ScopedQuery,
  input: {
    tenantId: string;
    doc: ContentDocRow;
    updateBytes: Uint8Array;
    actorId: string;
    clientId: string;
    snapshotEvery: number;
    strategy?: BodyKindStrategy;
  },
): Promise<Appended> {
  const strategy = input.strategy ?? noteStrategy;
  if (input.updateBytes.byteLength > LIMITS.updateBytes) {
    return {
      ok: false,
      error: rejection(
        'update_too_large',
        `An update may be at most ${String(LIMITS.updateBytes)} bytes; this one is ` +
          `${String(input.updateBytes.byteLength)}.`,
      ),
    };
  }

  // Newer than this build, not merely different. A document pinned *below* this build is the
  // normal state of every document between a schema bump and the pin migration that follows
  // it, and it is perfectly writable: the node set only ever widens, so a build that speaks
  // version N can read everything version N-1 could. An exact-inequality check here would
  // have made the first bump a corpus-wide outage - every existing document read-only on this
  // path until the migration finished - which is a far worse failure than the one it guarded
  // against. What actually keeps the pin honest is the check further down, on what the merged
  // document turns out to need.
  if (input.doc.schema_version > SCHEMA_VERSION) {
    return {
      ok: false,
      error: rejection(
        'schema_version_mismatch',
        `This document was written against schema version ${String(input.doc.schema_version)}; ` +
          `this build speaks version ${String(SCHEMA_VERSION)}. Refusing to write rather than ` +
          'reinterpreting the document.',
      ),
    };
  }

  const state = await loadDocument(sql, input.tenantId, input.doc);

  try {
    Y.applyUpdate(state, input.updateBytes);
  } catch (cause) {
    return {
      ok: false,
      error: rejection(
        'update_unreadable',
        cause instanceof Error ? cause.message : 'The payload is not a Yjs update.',
      ),
    };
  }

  const verdict = checkMergedDocument(state, { strategy, pin: input.doc.schema_version });
  if (verdict !== null) {
    return { ok: false, error: verdict };
  }

  const seq = await appendUpdate(sql, {
    tenantId: input.tenantId,
    docId: input.doc.doc_id,
    updateBytes: input.updateBytes,
    actorId: input.actorId,
    clientId: input.clientId,
  });

  // The log was read before the row lock that allocated `seq`. A writer that committed between
  // the two took a lower sequence this state never saw, and the snapshot below is labelled `seq`:
  // without those updates it would make every later load start past them. The lock is held now,
  // so everything below `seq` is committed and visible; re-applying what the load already had is
  // a no-op.
  await applyLoggedBetween(
    sql,
    input.tenantId,
    input.doc.doc_id,
    state,
    BigInt(input.doc.head_seq),
    seq,
  );

  const snapshotWritten = await maybeSnapshot(sql, {
    tenantId: input.tenantId,
    docId: input.doc.doc_id,
    itemId: input.doc.item_id,
    seq,
    state,
    snapshotEvery: input.snapshotEvery,
    strategy,
  });

  return { ok: true, value: { seq, snapshotWritten } };
}

/** Applies the logged updates with `after < seq < before` to `state`, page by page. */
async function applyLoggedBetween(
  sql: ScopedQuery,
  tenantId: string,
  docId: string,
  state: Y.Doc,
  after: bigint,
  before: bigint,
): Promise<void> {
  let from = after;
  while (from < before - 1n) {
    const page = (await updatesAfter(sql, tenantId, docId, from, CATCH_UP_LIMIT)).filter(
      (row) => BigInt(row.seq) < before,
    );
    if (page.length === 0) {
      return;
    }
    Y.transact(state, () => {
      for (const row of page) {
        Y.applyUpdate(state, new Uint8Array(row.update_bytes));
      }
    });
    const last = page[page.length - 1];
    if (last === undefined) {
      return;
    }
    from = BigInt(last.seq);
  }
}

/**
 * Replaces the live document with the state it held at `seq`, as one new revision.
 *
 * **A restore is a write, not a rewind.** It never touches the log or a prior snapshot - the
 * state at `seq` is reconstructed by {@link stateAt}, poured into the *live* document inside
 * one transaction, and the transaction's own diff is applied through exactly the path a REST
 * update takes. That is what makes a restore ordinary to everything downstream: search,
 * backlinks and every connected editor see it as an edit from `actorId`, because it is one -
 * concretely, a very large one. History itself is unaffected; the revision this produces is
 * simply the newest entry in it, and the state being restored *from* remains exactly as
 * reachable as it was before.
 *
 * **Keep it that way: clients depend on it.** Browsers keep a local copy of bodies they have
 * opened and reconcile it with the live document on every open (ADR-0053). That is safe only
 * because no path rewinds a document under the same `docId`; one that did - a backup restore, a
 * purge - would have every stale copy push the removed content back. Such an operation must give
 * the document a new `docId` so clients halt instead.
 *
 * Only a note's prose fragment has a defined "content" to pour a reconstruction into - a
 * canvas's elements and a sheet's cells are addressed by key, not replaced wholesale, and
 * neither strategy implements the floor {@link BodyKindStrategy.repair} relies on for the same
 * reason. Restoring either is refused with `history_state_unavailable` rather than attempted,
 * which is honest: there is no fragment here for the old content to replace.
 */
export async function restoreDocument(
  sql: ScopedQuery,
  input: {
    tenantId: string;
    doc: ContentDocRow;
    seq: number;
    actorId: string;
    clientId: string;
    strategy?: BodyKindStrategy;
  },
): Promise<Appended> {
  const strategy = input.strategy ?? noteStrategy;

  if (strategy.kind !== noteStrategy.kind) {
    return {
      ok: false,
      error: rejection(
        'history_state_unavailable',
        `Restoring is only supported for notes; this document is a ${strategy.kind}.`,
      ),
    };
  }

  const historical = await stateAt(sql, input.tenantId, input.doc.doc_id, input.seq);
  if (historical === null) {
    return {
      ok: false,
      error: rejection(
        'history_state_unavailable',
        `The state at sequence ${String(input.seq)} cannot be reconstructed: it is beyond ` +
          'the head, or its base has been pruned.',
      ),
    };
  }

  const materialized = strategy.materialize(historical);
  if (materialized.json === null || typeof materialized.json !== 'object') {
    // The historical state was accepted onto the log at the time it was written, so this is
    // not expected to happen - but a restore that produced an empty document because the old
    // state quietly failed to parse would be a worse failure than refusing outright.
    return {
      ok: false,
      error: rejection(
        'history_state_unavailable',
        `The state at sequence ${String(input.seq)} did not reconstruct as a document.`,
      ),
    };
  }

  const live = await loadDocument(sql, input.tenantId, input.doc);
  const beforeRestore = Y.encodeStateVector(live);

  // One transaction: the fragment's whole content goes out and the old content comes in
  // without the live document ever being observable half-emptied, by anything reading the
  // resident copy this transaction runs against or by whatever replays this diff elsewhere.
  Y.transact(live, () => {
    const fragment = live.getXmlFragment(FRAGMENT_NAME);
    fragment.delete(0, fragment.length);
    prosemirrorJSONToYXmlFragment(nixSchema, materialized.json, fragment);
  });

  // The diff since before the transaction, in Yjs's own portable form - it carries the
  // transaction's operations under `live`'s client id and clock, so it merges correctly
  // wherever it is applied next, which is the ordinary `applyUpdate` path immediately below.
  const restoreUpdate = Y.encodeStateAsUpdate(live, beforeRestore);

  return await applyUpdate(sql, {
    tenantId: input.tenantId,
    doc: input.doc,
    updateBytes: restoreUpdate,
    actorId: input.actorId,
    clientId: input.clientId,
    // Publish immediately, like every other REST write: a restore with no editor watching
    // must still reach search and backlinks the moment it lands, not on the next open.
    snapshotEvery: 1,
    strategy,
  });
}

/** What a merged document is checked against. */
export interface MergeCheck {
  readonly strategy?: BodyKindStrategy;

  /**
   * The document's stored `schema_version`. An update that would take the document past it is
   * refused, because the pin is what every *other* client was promised: a build that speaks
   * the pinned version was told this document is safe to open, and writing a newer node into
   * it would make that a lie. Defaults to `SCHEMA_VERSION`, which is the right answer for a
   * document judged outside the context of a stored row.
   */
  readonly pin?: number;

  /** Told why, when the merged document will not parse. For the operator log, not the client. */
  readonly diagnose?: (reason: string) => void;
}

/**
 * Whether the merged document is one this build would be able to open again, judged by
 * the body kind's own strategy.
 *
 * Returns the refusal, or null when it is fine.
 *
 */
export function checkMergedDocument(state: Y.Doc, against: MergeCheck = {}): Rejection | null {
  const strategy = against.strategy ?? noteStrategy;
  const pin = against.pin ?? SCHEMA_VERSION;

  const measured = strategy.measure(state);
  if (measured === null) {
    const diagnosis = strategy.explain?.(state) ?? null;
    if (diagnosis !== null) {
      against.diagnose?.(diagnosis);
    }

    return rejection(
      'document_does_not_parse',
      'Applying this update would produce a document the schema rejects.',
    );
  }

  if (measured.schemaVersion > pin) {
    return rejection(
      'document_above_schema_pin',
      `This update would need schema version ${String(measured.schemaVersion)} to open, and ` +
        `the document is pinned to ${String(pin)}. Refusing to write a document older ` +
        'clients have been told they can read. Run the document schema migration first.',
    );
  }

  if (measured.nodes > strategy.ceilings.nodes) {
    return rejection(
      'document_too_many_nodes',
      `A document may hold at most ${String(strategy.ceilings.nodes)} nodes; this one would ` +
        `hold ${String(measured.nodes)}.`,
    );
  }

  if (measured.bytes > strategy.ceilings.bytes) {
    return rejection(
      'document_too_large',
      `A document may be at most ${String(strategy.ceilings.bytes)} bytes; this one would be ` +
        `${String(measured.bytes)}.`,
    );
  }

  return null;
}

/**
 * Writes a snapshot when the sequence crosses the cadence.
 *
 * The plaintext and the ProseMirror JSON are stored alongside the Yjs state because search
 * and previews need the document without a Yjs runtime - and because a materialisation that
 * only one process can read is not much of a materialisation.
 */
async function maybeSnapshot(
  sql: ScopedQuery,
  input: {
    tenantId: string;
    docId: string;
    itemId: string;
    seq: bigint;
    state: Y.Doc;
    snapshotEvery: number;
    strategy: BodyKindStrategy;
  },
): Promise<boolean> {
  if (input.snapshotEvery <= 0 || input.seq % BigInt(input.snapshotEvery) !== 0n) {
    return false;
  }

  return await writeSnapshotNow(sql, input);
}

/**
 * Materialises and writes a snapshot at a sequence, cadence already decided, along with the two
 * things derived from the same materialisation: the item's outgoing link edges and its searchable
 * text.
 *
 * Exported for the resident-document path, whose cadence is richer than "every N": it also
 * snapshots on a activity timer and on eviction, and those decisions live with the session
 * rather than being restated here.
 *
 * **All three writes share the caller's transaction, deliberately.** A snapshot whose edges did
 * not land would leave the backlinks panel describing a document that no longer says what it
 * claims - and unlike the snapshot itself, nothing downstream re-derives an edge on read. Landing
 * together or not at all is what makes "derived, and rebuildable" true rather than aspirational.
 *
 * **Extraction is bounded by the same ceiling the snapshot is.** A document too large to store is
 * returned from before any of this, so the walk never runs on a document the service already
 * declined to materialise.
 */
export async function writeSnapshotNow(
  sql: ScopedQuery,
  input: {
    tenantId: string;
    docId: string;
    itemId: string;
    seq: bigint;
    state: Y.Doc;
    strategy?: BodyKindStrategy;
  },
): Promise<boolean> {
  const encoded = Y.encodeStateAsUpdate(input.state);
  if (encoded.byteLength > LIMITS.snapshotBytes) {
    // The update itself was accepted and is in the log, which is the source of truth. A
    // snapshot too large to store costs replay time and nothing else, so this is a missed
    // optimisation rather than a failure, and the request must not fail because of it.
    return false;
  }

  const strategy = input.strategy ?? noteStrategy;

  // The materialised column is named for prose - it predates body kinds - but it holds
  // whatever the body kind materialises: a ProseMirror document for a note, a scene for a
  // canvas. Renaming it is a migration this deliberately does not require.
  const materialized = strategy.materialize(input.state);

  await writeSnapshot(sql, {
    tenantId: input.tenantId,
    docId: input.docId,
    seq: input.seq,
    yjsState: encoded,
    prosemirrorJson: materialized.json,
    plaintext: materialized.plaintext,
  });

  await writeItemSearchText(sql, {
    tenantId: input.tenantId,
    itemId: input.itemId,
    seq: input.seq,
    text: boundSearchText(materialized.plaintext),
  });

  if (strategy === noteStrategy) {
    const chunks = chunkNote(materialized.json);
    const chunkTarget = { tenantId: input.tenantId, itemId: input.itemId, seq: input.seq };
    if (chunks === null) await clearItemChunks(sql, chunkTarget);
    else await writeItemChunks(sql, { ...chunkTarget, chunks });
  }

  // A body kind that cannot hold a reference does not implement extraction, and a document that
  // held links and no longer does still needs its edges cleared - so the empty map is written,
  // not skipped. Only a kind that can never produce an edge at all is passed over entirely.
  if (strategy.extractLinks !== undefined) {
    await replaceItemLinks(sql, {
      tenantId: input.tenantId,
      sourceItemId: input.itemId,
      seq: input.seq,
      links: strategy.extractLinks(materialized.json, input.itemId),
    });
  }

  return true;
}

/** The schema this build validates against, for the health endpoint to report. */
export function describeSchema(): { version: number; nodes: number; marks: number } {
  return {
    version: SCHEMA_VERSION,
    nodes: Object.keys(nixSchema.nodes).length,
    marks: Object.keys(nixSchema.marks).length,
  };
}
