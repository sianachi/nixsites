import { getSchema } from '@tiptap/core';
import type { Node as ProseMirrorNode, Schema } from '@tiptap/pm/model';

import { nixExtensions } from './extensions.js';

/**
 * The version stored documents are validated against.
 *
 * **Bump this only when the node or mark set changes in a way an older build cannot
 * read.** It is written onto `content_doc.schema_version` and checked by the
 * collaboration service before an update is accepted, so a bump is a commitment to
 * migrate every stored document past it. Adding a block is such a change; changing how
 * one renders is not.
 *
 * **Bumping it is three things, not one** (ADR-0024): raise this number, add every new node
 * and mark to `NODE_MIN_VERSION` / `MARK_MIN_VERSION` in `versions.ts` so a document's own
 * pin is enforced rather than assumed, and run `pnpm --filter @nix/collab migrate-documents`
 * at deploy to raise the stored pins. Between the deploy and that job, documents sit at the
 * old pin and every write is held to the old node set, which is correct and uneventful.
 *
 * Version 2 added composition (columns), collapsible sections, references, the two computed
 * blocks, token-named colour and the comment mark - all at once, because each bump costs a
 * corpus-wide pin rewrite and a lockout window for tabs left open across a deploy.
 *
 * Version 6 added a Mermaid code block's captured picture (`codeBlock.renderFileId` and
 * `renderSourceHash`, ADR-0063).
 *
 * Version 7 added an embedded note's remembered view (`itemBlock.view`) and the suggestion
 * (track-changes) marks and block attribute.
 */
export const SCHEMA_VERSION = 7;

/**
 * The ProseMirror schema, derived from the extension list.
 *
 * Derived rather than hand-written so there is exactly one definition. A schema declared
 * separately from the extensions that build the editor is a schema that drifts, and the
 * failure it produces is the worst kind: documents that save on one side and refuse to
 * open on the other.
 *
 * Built once at module load. It is immutable, and constructing it per validation would
 * be the collaboration service's hottest allocation.
 */
export const nixSchema: Schema = getSchema(nixExtensions);

/** An empty document: one paragraph, which is what an editor needs to place a cursor. */
export function emptyDocument(): ProseMirrorNode {
  return nixSchema.node('doc', null, [nixSchema.node('paragraph')]);
}

/**
 * Parses a document from its JSON representation, returning why it failed rather than
 * throwing.
 *
 * A `Result` rather than an exception because a document that does not fit the schema is
 * an expected outcome on a validation path - a client can send anything - and not a bug.
 * The collaboration service calls this on every update it is asked to store.
 */
export function parseDocument(json: unknown): ParseResult {
  if (typeof json !== 'object' || json === null) {
    return { ok: false, error: 'The document is not an object.' };
  }

  try {
    const document = nixSchema.nodeFromJSON(json);
    document.check();
    return { ok: true, document };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export type ParseResult =
  | { readonly ok: true; readonly document: ProseMirrorNode }
  | { readonly ok: false; readonly error: string };

/**
 * Counts the nodes in a document, for the size limits the collaboration service applies
 * after a merge.
 *
 * Counted rather than estimated from the byte length, because the cost that matters is
 * the one the browser pays rendering the tree, and a megabyte of one paragraph and a
 * megabyte of a hundred thousand empty ones are not the same document.
 */
export function countNodes(document: ProseMirrorNode): number {
  let total = 0;
  document.descendants(() => {
    total += 1;
    return true;
  });

  return total + 1;
}
