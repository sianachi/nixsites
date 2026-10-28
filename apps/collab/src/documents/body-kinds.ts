import {
  BASE_SCHEMA_VERSION,
  countNodes,
  nixSchema,
  requiredSchemaVersion,
} from '@nix/editor-schema';
import {
  SHEET_ITEM_TYPE,
  SHEET_LIMITS,
  checkSheetDocument,
  readCells,
  sheetSnapshot,
} from '@nix/sheet';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import * as Y from 'yjs';

import { LIMITS } from './limits.ts';
import { extractCanvasItemLinks, extractItemLinks } from './links.ts';

/** What one measurement of a merged document says about it. */
export interface Measurement {
  readonly nodes: number;
  readonly bytes: number;

  /**
   * The lowest schema version a build must speak to open this document, which is never
   * above `SCHEMA_VERSION` for a document this build produced and may be below it for one
   * using nothing new.
   */
  readonly schemaVersion: number;
}

/**
 * How one kind of body is validated and materialised.
 *
 * `item.type` says how an item's own body is drawn - a note's prose, a canvas's scene -
 * and this is where that fact touches the collaboration service. Everything else here
 * (the log, the transport, auth, tenancy, rate limits) is body-agnostic on purpose; the
 * only operations that must know what the bytes mean are "is the merged document one this
 * build could open again" and "what goes in the snapshot for search and previews". Those
 * two are what a strategy carries.
 */
export interface BodyKindStrategy {
  readonly kind: string;

  /** The ceilings a merged document must fit inside, in this kind's own unit of "node". */
  readonly ceilings: { readonly nodes: number; readonly bytes: number };

  /**
   * Measures a state as this kind of document: element count, serialised size, and the
   * lowest schema version a build must speak to open it - or null when the state does not
   * parse as this kind at all.
   *
   * `schemaVersion` is part of the measurement rather than a second method because both
   * facts are wanted at the same moment, on every accepted update, by the same caller - not
   * because one walk answers both: `noteStrategy` walks the document twice, once for
   * `countNodes` and once for `requiredSchemaVersion`. Fusing them saves about 0.2ms on an
   * 18,000-node document and is not worth the API change while `JSON.stringify` below is
   * two thirds of this method's cost. A kind whose content is not versioned by
   * `SCHEMA_VERSION` reports the base version, which is the honest answer: nothing in it can
   * require a newer build.
   */
  measure(state: Y.Doc): Measurement | null;

  /**
   * Why {@link measure} returned null, in the words the parser used.
   *
   * **Called only on the refusal path**, so it costs nothing when an update is accepted - which
   * is why it can afford to re-run the parse rather than have `measure` carry a reason it almost
   * never needs.
   *
   * This exists because `document_does_not_parse` was a black box. The refusal a client sees is
   * deliberately vague - two failure modes mean the same thing to it - but the *operator* log
   * inherited that vagueness, so a document that would not save gave nobody anything to work
   * from. The parser knows exactly which node or which content rule failed; this is what stops
   * that being thrown away.
   */
  explain?(state: Y.Doc): string | null;

  /**
   * Puts a state back over this kind's structural floor, in place, returning whether it did.
   *
   * **Deliberately narrow: the floor, and nothing else.** This is not a repair of arbitrary
   * invalid documents, and must never become one - guessing at what a broken document meant is
   * how a service loses somebody's work while reporting success. It answers exactly one fault,
   * the one the schema states as a minimum rather than as a rule about content: a prose document
   * must hold at least one block, and a state holding none is not a document anyone wrote, it is
   * a state a client can reach and then cannot get out of.
   *
   * A kind whose empty state is legitimate does not implement this. An empty canvas is a canvas,
   * and an empty sheet is a sheet; neither has a floor to fall through, which is why prose is
   * the only implementation and why this is optional rather than a no-op every kind carries.
   *
   * Called only after {@link measure} has already returned null, and the caller re-measures
   * afterwards - a repair that does not produce a parsing document is not honoured. So an
   * implementation may be optimistic; it may not be trusted.
   */
  repair?(state: Y.Doc): boolean;

  /**
   * What the snapshot stores beside the Yjs state, so search and previews can read the
   * document without a Yjs runtime. The JSON lands in the snapshot's materialised-body
   * column; the plaintext feeds search.
   */
  materialize(state: Y.Doc): { json: unknown; plaintext: string };

  /**
   * Which other items this body refers to, and how many times each.
   *
   * Takes what {@link materialize} already produced rather than the `Y.Doc`, because the caller
   * has it and re-deriving a typed document to walk it would parse the whole thing twice on a
   * path that runs on every snapshot.
   *
   * Optional, like {@link explain}, and for the same kind of reason: a body kind that cannot hold
   * a reference has nothing to say here, and an implementation returning an empty map on every
   * call is a worse answer than not claiming to answer. Prose edges come from document nodes;
   * canvas edges come from scene elements. That difference is exactly why this is a member of the
   * strategy and not a function the caller applies to every body kind alike.
   */
  extractLinks?(json: unknown, sourceItemId: string): ReadonlyMap<string, number>;
}

/**
 * The Yjs fragment the prose editor binds to. One name, agreed by both sides; a mismatch
 * would produce two documents that merge cleanly and share no text.
 */
export const FRAGMENT_NAME = 'default';

/** The Yjs map a canvas scene lives in, keyed by element identifier. */
export const CANVAS_ELEMENTS = 'elements';

/** How many elements one canvas may hold. The browser renders every one of them. */
const CANVAS_ELEMENT_CEILING = 10_000;

/**
 * Prose: the ProseMirror document in the shared XML fragment, validated by parsing.
 *
 * Two failures are folded together on purpose: a fragment holding a node this build has
 * never heard of throws while being read, and a fragment whose shape breaks the content
 * rules fails `check()`. Both mean the same thing - the merge would produce something
 * that cannot be opened - and neither is worth distinguishing in a refusal.
 */
export const noteStrategy: BodyKindStrategy = {
  kind: 'note',
  ceilings: { nodes: LIMITS.documentNodes, bytes: LIMITS.documentBytes },

  measure(state: Y.Doc): Measurement | null {
    const document = readProse(state);
    if (document === null) {
      return null;
    }
    return {
      nodes: countNodes(document),
      bytes: Buffer.byteLength(JSON.stringify(document.toJSON())),
      schemaVersion: requiredSchemaVersion(document),
    };
  },

  explain(state: Y.Doc): string | null {
    return explainProse(state);
  },

  /**
   * The floor is `block+`: one empty paragraph, which is what `emptyDocument` in
   * `@nix/editor-schema` already means by an empty note, and what the editor needs to place a
   * cursor. The repaired state is therefore the same document a brand-new note starts as.
   *
   * Only a fragment with no children at all is answered. A fragment that still holds something is
   * a document with a content fault - a node this build does not know, a block where an inline
   * belongs - and adding a paragraph beside it would not make it parse; it would only make the
   * refusal harder to read.
   */
  repair(state: Y.Doc): boolean {
    const fragment = state.getXmlFragment(FRAGMENT_NAME);
    if (fragment.length > 0) {
      return false;
    }
    fragment.insert(0, [new Y.XmlElement('paragraph')]);
    return true;
  },

  materialize(state: Y.Doc): { json: unknown; plaintext: string } {
    const document = readProse(state);
    return {
      json: document?.toJSON() ?? null,
      // No leaf-text argument: passing one overrides every node's own `leafText`, which is how
      // a reference contributes the title it points at. With one, a document whose only mention
      // of a topic is a link to it was unfindable by that topic.
      plaintext: document === null ? '' : document.textBetween(0, document.content.size, '\n'),
    };
  },

  extractLinks(json: unknown, sourceItemId: string): ReadonlyMap<string, number> {
    return extractItemLinks(json, sourceItemId);
  },
};

/**
 * Canvas: a scene of elements in a shared map, element-per-key, whole-element writes.
 *
 * The shape is the client's reconciliation contract - id, version and versionNonce are
 * what let two whole-element writes order deterministically - so the server refuses an
 * element missing them the same way it refuses prose the schema cannot open: the merge
 * would produce a document some client cannot reconcile.
 */
export const canvasStrategy: BodyKindStrategy = {
  kind: 'canvas',
  ceilings: { nodes: CANVAS_ELEMENT_CEILING, bytes: LIMITS.documentBytes },

  measure(state: Y.Doc): Measurement | null {
    const scene = readScene(state);
    if (scene === null) {
      return null;
    }
    return {
      nodes: Object.keys(scene).length,
      bytes: Buffer.byteLength(JSON.stringify(scene)),
      // A scene carries no ProseMirror nodes, so nothing in it can require a newer build.
      schemaVersion: BASE_SCHEMA_VERSION,
    };
  },

  materialize(state: Y.Doc): { json: unknown; plaintext: string } {
    const scene = readScene(state) ?? {};
    // The searchable text of a drawing is the words written on it: text elements and
    // labels. Geometry has nothing to say to a search index.
    const words: string[] = [];
    for (const element of Object.values(scene)) {
      const text = (element as { text?: unknown }).text;
      if (typeof text === 'string' && text.length > 0) {
        words.push(text);
      }
    }
    return { json: { elements: scene }, plaintext: words.join('\n') };
  },

  extractLinks(json: unknown, sourceItemId: string): ReadonlyMap<string, number> {
    return extractCanvasItemLinks(json, sourceItemId);
  },
};

/**
 * Sheet: a cell grid in a shared map, validated and evaluated by `@nix/sheet` - the same
 * engine the editor runs, so the value a client computed is the value the server checks.
 *
 * `measure` folds two failure modes into one null the way the other strategies do:
 * a structurally broken cell map, and cell content this build cannot finish evaluating
 * within its op budget. Both mean the merge would produce a document that cannot be
 * opened back up as a sheet - either literally, or because reopening it would spend the
 * same unbounded time computing it that got it refused here. The cell-count ceiling
 * itself is left to `judgeCandidate`'s shared over-ceiling handling (§17), matching
 * prose and canvas, rather than being enforced twice - `checkSheetDocument` is asked
 * with an unbounded cell count on purpose, so its own bound never doubles up with
 * `ceilings.nodes` below and produce a mismatched refusal for a document that grew.
 */
const SHEET_STRUCTURAL_LIMITS = { ...SHEET_LIMITS, maxCells: Number.MAX_SAFE_INTEGER };

export const sheetStrategy: BodyKindStrategy = {
  kind: SHEET_ITEM_TYPE,
  ceilings: { nodes: SHEET_LIMITS.maxCells, bytes: LIMITS.documentBytes },

  measure(state: Y.Doc): Measurement | null {
    if (checkSheetDocument(state, SHEET_STRUCTURAL_LIMITS) !== null) {
      return null;
    }
    const cells = readCells(state);
    return {
      nodes: cells.size,
      bytes: Buffer.byteLength(JSON.stringify(Object.fromEntries(cells))),
      // A cell grid carries no ProseMirror nodes; `@nix/sheet` versions its own content.
      schemaVersion: BASE_SCHEMA_VERSION,
    };
  },

  materialize(state: Y.Doc): { json: unknown; plaintext: string } {
    return sheetSnapshot(state);
  },
};

/**
 * Picks the strategy for a body kind, falling back to prose for kinds this build has
 * never heard of.
 *
 * The fallback is ADR-0009's rule holding at this seam: `item.type` is an open set and
 * must never gate behaviour it does not need to. An unknown kind behaves exactly as
 * every body behaved before kinds were dispatched at all - validated as prose - so
 * adding a kind is a feature, not a fork in what existing documents are allowed to do.
 */
export function strategyFor(bodyKind: string): BodyKindStrategy {
  if (bodyKind === canvasStrategy.kind) {
    return canvasStrategy;
  }
  if (bodyKind === sheetStrategy.kind) {
    return sheetStrategy;
  }
  return noteStrategy;
}

function readProse(state: Y.Doc): ProseMirrorNode | null {
  try {
    const document = yXmlFragmentToProseMirrorRootNode(
      state.getXmlFragment(FRAGMENT_NAME),
      nixSchema,
    );
    document.check();
    return document;
  } catch {
    return null;
  }
}

/**
 * The same parse, kept for its exception.
 *
 * A second walk rather than threading the error out of {@link readProse}: this runs only when an
 * update has already been refused, and keeping the accepted path free of a reason nobody reads is
 * worth one duplicated call on the path that is already going to disappoint somebody.
 *
 * The shape of the document is reported alongside the message, because the message alone often is
 * not enough - "Invalid content for node doc" says which rule broke and not what broke it.
 */
function explainProse(state: Y.Doc): string | null {
  // **The shape is read before the parse, and the parse is why.**
  // `yXmlFragmentToProseMirrorRootNode` does not leave the fragment alone: a node the schema does
  // not know is *dropped from the Yjs document itself* by the time the conversion throws. So a
  // description taken afterwards reports every failure as an empty fragment - which is the one
  // reading that hides what happened. Found by this diagnostic misreporting its own test.
  const shape = describeFragment(state);

  try {
    const document = yXmlFragmentToProseMirrorRootNode(
      state.getXmlFragment(FRAGMENT_NAME),
      nixSchema,
    );
    document.check();
    return null;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return `${message} (fragment held: ${shape})`;
  }
}

/**
 * The top level of the stored fragment, named.
 *
 * Deliberately shallow and deliberately capped: this goes in an operator log, and a document's
 * whole outline is neither readable there nor something to be writing to disk on every refusal.
 * The node names at the root are almost always enough to see what is wrong - an empty fragment, a
 * name this build does not know, a text node where a block belongs.
 */
function describeFragment(state: Y.Doc): string {
  try {
    const children = state.getXmlFragment(FRAGMENT_NAME).toArray();
    if (children.length === 0) {
      // Two different things wearing one answer, and worth saying so: an unknown node is dropped
      // rather than refused, so a fragment full of them looks exactly like one that was empty all
      // along - and the two want opposite fixes. A caller that can hand over an unparsed document
      // gets the precise answer; one that cannot gets this.
      return 'nothing - either the client sent an empty document, or everything in it was dropped as unknown';
    }

    const shown = children.slice(0, 8).map((child) => {
      const name = (child as { nodeName?: unknown }).nodeName;
      return typeof name === 'string' ? name : 'text';
    });

    return children.length > shown.length
      ? `${shown.join(', ')}, and ${String(children.length - shown.length)} more`
      : shown.join(', ');
  } catch {
    return 'unreadable';
  }
}

function readScene(state: Y.Doc): Record<string, unknown> | null {
  try {
    const scene = state.getMap(CANVAS_ELEMENTS).toJSON() as Record<string, unknown>;
    for (const [id, element] of Object.entries(scene)) {
      if (typeof element !== 'object' || element === null) {
        return null;
      }
      const candidate = element as {
        id?: unknown;
        type?: unknown;
        version?: unknown;
        versionNonce?: unknown;
      };
      if (
        candidate.id !== id ||
        id.length === 0 ||
        typeof candidate.type !== 'string' ||
        candidate.type.length === 0 ||
        typeof candidate.version !== 'number' ||
        !Number.isSafeInteger(candidate.version) ||
        candidate.version < 0 ||
        typeof candidate.versionNonce !== 'number' ||
        !Number.isSafeInteger(candidate.versionNonce) ||
        candidate.versionNonce < 0
      ) {
        return null;
      }
    }
    return scene;
  } catch {
    return null;
  }
}
