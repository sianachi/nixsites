/**
 * Writing an imported note's body to the collaboration service.
 *
 * The body is the one thing Core's REST API does not carry - it lives in the collaboration service
 * as a Yjs update log - so this is the import dialog's one direct call outside `@nix/api-client`,
 * the same standing the export dialog's archive request has. The write builds the document state
 * the same way the CLI's import does: the item was created moments ago, its log is provably
 * empty, so the full state *is* the delta and no catch-up read is needed. This must never be used
 * for an item that may have been edited - the editor's own collab binding owns that path.
 *
 * The whole body of this function is inside one `try`, deliberately: the run loop calls it once
 * per note with no guard of its own, so "never a throw" has to be true of the document build and
 * the encode, not just of the fetch. A throw from the Yjs binding is a bug, so it is logged as
 * one - and still reported as this note's refusal rather than ending the run.
 */

import { nixSchema } from '@nix/editor-schema';
import { updateYFragment } from 'y-prosemirror';
import * as Y from 'yjs';

/** The Yjs fragment a note's prose binds to; must match the collaboration service's own. */
const FRAGMENT = 'default';

/**
 * How long one write may take before it is abandoned. Without a deadline, a single stalled
 * request pins the whole run - the same lesson the CLI's body seam already wrote down.
 */
const WRITE_TIMEOUT_MS = 30_000;

export type BodyWriteOutcome =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface BodyWriteRequest {
  readonly itemId: string;
  /** A validated ProseMirror document in JSON form, from the plan. */
  readonly doc: unknown;
  readonly token: string;
  readonly signal?: AbortSignal;
  readonly baseUrl?: string;
  readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

/** Writes a fresh item's body as one update. Returns every failure as words, never a throw. */
export async function writeImportedBody(request: BodyWriteRequest): Promise<BodyWriteOutcome> {
  const { itemId, doc, token, signal, baseUrl = '/collab', fetchImpl = globalThis.fetch } = request;

  try {
    const ydoc = new Y.Doc();
    let update: Uint8Array;
    try {
      const node = nixSchema.nodeFromJSON(doc);
      // Fresh binding metadata: empty maps mean updateYFragment writes the whole document, which
      // for an empty fragment is exactly the one update the import owes.
      const meta = { mapping: new Map(), isOMark: new Map() };
      ydoc.transact(() => {
        updateYFragment(ydoc, ydoc.getXmlFragment(FRAGMENT), node, meta);
      });
      update = Y.encodeStateAsUpdate(ydoc);
    } finally {
      ydoc.destroy();
    }

    const deadline = AbortSignal.timeout(WRITE_TIMEOUT_MS);
    const response = await fetchImpl(`${baseUrl}/documents/${itemId}/updates`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        update: toBase64(update),
        clientId: `web-import-${crypto.randomUUID()}`,
      }),
      signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
    });

    if (!response.ok) {
      return { ok: false, error: await refusal(response) };
    }
    return { ok: true };
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'TimeoutError') {
      return { ok: false, error: 'The body write timed out.' };
    }
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      return { ok: false, error: 'The import was cancelled.' };
    }
    if (cause instanceof TypeError) {
      return { ok: false, error: 'The body could not be written. Check your connection.' };
    }
    // A document that was validated by the plan and still cannot be encoded is a bug, not a
    // network condition; say so where a developer will see it, and on the row where a person will.
    console.error(`Import body write failed for item ${itemId}:`, cause);
    return {
      ok: false,
      error: `The body could not be prepared: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

/** The service's own words where it gave them, and a plain sentence where it did not. */
async function refusal(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === 'string' && body.detail.length > 0) {
      return body.detail;
    }
  } catch {
    // Falls through to the generic sentence below.
  }
  return `The body write was refused (${String(response.status)}).`;
}

/** btoa takes a byte string; chunked so a large body does not blow the argument limit. */
function toBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let start = 0; start < bytes.length; start += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunkSize));
  }
  return btoa(binary);
}
