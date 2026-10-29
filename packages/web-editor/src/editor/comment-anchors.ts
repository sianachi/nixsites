import type { CommentThread } from '@nix/api-client';
import { Extension, type Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from 'y-prosemirror';
import * as Y from 'yjs';
import { create } from 'zustand';

import type { SuggestionEntry } from './suggesting';

/**
 * Comment threads drawn on the text they were made on.
 *
 * Threads live in Core (`note_comment`), anchored by Yjs relative positions, which follow the
 * words through concurrent edits. This file decodes those anchors into highlights, publishes the
 * thread list and the document's suggestions into a store the comments pane reads, and captures
 * a selection as an anchor. The network side (loading, watching, re-anchoring) is in
 * `use-comment-sync.ts`.
 */

/** A selection, encoded the way Core stores it. */
export interface CapturedAnchor {
  readonly start: string;
  readonly end: string;
  readonly quote: string;
}

/** What the comments pane can ask the editor to do. */
export interface CommentsEditorHandle {
  readonly editable: boolean;
  readonly jumpTo: (position: number) => void;
  readonly accept: (suggestionId: string) => void;
  readonly reject: (suggestionId: string) => void;
}

export interface ItemComments {
  readonly threads: readonly CommentThread[];
  readonly revision: number;
  readonly status: 'loading' | 'ready' | 'error';
  /** The server's reason when `status` is `error` (for example `comments.forbidden`). */
  readonly errorCode: string | null;
  /** The server's own words for the refusal (the lock message on a 423). */
  readonly errorDetail: string | null;
  /** The body has synced, so anchors can be trusted to decode; before then nothing is drawn. */
  readonly ready: boolean;
  /** Whether the viewer may comment, as the server last said; null until the first answer. */
  readonly canComment: boolean | null;
  readonly activeThreadId: string | null;
  /** Threads whose anchor no longer resolves to text. */
  readonly detached: readonly string[];
  readonly suggestions: readonly SuggestionEntry[];
  /** A selection the Comment button captured, waiting for its text in the pane. */
  readonly draft: CapturedAnchor | null;
  /** Counts Comment button presses, so the note page opens the pane on each. */
  readonly openRequest: number;
  readonly editor: CommentsEditorHandle | null;
  /** Re-reads the threads now; set by the sync hook. */
  readonly refresh: () => void;
}

const EMPTY: ItemComments = {
  threads: [],
  revision: -1,
  status: 'loading',
  errorCode: null,
  errorDetail: null,
  ready: false,
  canComment: null,
  activeThreadId: null,
  detached: [],
  suggestions: [],
  draft: null,
  openRequest: 0,
  editor: null,
  refresh: () => undefined,
};

interface CommentsStore {
  readonly items: Readonly<Record<string, ItemComments>>;
}

export const useCommentsStore = create<CommentsStore>(() => ({ items: {} }));

export function patchComments(itemId: string, patch: Partial<ItemComments>): void {
  useCommentsStore.setState((state) => ({
    items: { ...state.items, [itemId]: { ...(state.items[itemId] ?? EMPTY), ...patch } },
  }));
}

/** Forgets a note's entry once nothing shows it any more. */
export function dropComments(itemId: string): void {
  useCommentsStore.setState((state) => {
    const { [itemId]: _gone, ...items } = state.items;
    return { items };
  });
}

export function readComments(itemId: string): ItemComments {
  return useCommentsStore.getState().items[itemId] ?? EMPTY;
}

export function useItemComments(itemId: string | null): ItemComments {
  return useCommentsStore((state) => (itemId === null ? EMPTY : (state.items[itemId] ?? EMPTY)));
}

/** Asks the note page to open the comments pane, with `anchor` as the draft's place (or none). */
export function requestComment(itemId: string, anchor: CapturedAnchor | null): void {
  patchComments(itemId, { draft: anchor, openRequest: readComments(itemId).openRequest + 1 });
}

const MAX_QUOTE = 1000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function binding(state: EditorState) {
  const sync = ySyncPluginKey.getState(state) as
    | {
        binding?: {
          doc: Y.Doc;
          type: Y.XmlFragment;
          mapping: Map<Y.AbstractType<unknown>, unknown>;
        } | null;
      }
    | undefined;
  return sync?.binding ?? null;
}

/** Encodes `[from, to)` as relative positions, or null when the document is not bound yet. */
export function encodeRange(
  state: EditorState,
  from: number,
  to: number,
): { start: string; end: string } | null {
  const bound = binding(state);
  if (bound === null) return null;
  const encode = (position: number): string =>
    bytesToBase64(
      Y.encodeRelativePosition(
        absolutePositionToRelativePosition(
          position,
          bound.type,
          bound.mapping as never,
        ) as Y.RelativePosition,
      ),
    );
  return { start: encode(from), end: encode(to) };
}

/** The current selection as an anchor, or null for a caret or an unbound document. */
export function captureAnchor(view: EditorView): CapturedAnchor | null {
  const { from, to, empty } = view.state.selection;
  if (empty) return null;
  const range = encodeRange(view.state, from, to);
  if (range === null) return null;
  const quote = view.state.doc.textBetween(from, to, ' ', ' ').trim().slice(0, MAX_QUOTE);
  return quote.length === 0 ? null : { ...range, quote };
}

/** Where an encoded position sits in the document now, or null when it no longer resolves. */
function decode(
  state: EditorState,
  encoded: string,
  doc: ProseMirrorNode = state.doc,
): number | null {
  const bound = binding(state);
  if (bound === null) return null;
  try {
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    const position = relativePositionToAbsolutePosition(
      bound.doc,
      bound.type,
      Y.decodeRelativePosition(bytes),
      bound.mapping as never,
    );
    return position === null ? null : Math.min(position, doc.content.size);
  } catch {
    return null;
  }
}

/** A thread's range in the document, or null when it is detached. Page-level threads are skipped. */
export function threadRange(
  state: EditorState,
  thread: CommentThread,
  doc: ProseMirrorNode = state.doc,
): { from: number; to: number } | null {
  if (thread.anchorStart === null || thread.anchorEnd === null) return null;
  const from = decode(state, thread.anchorStart, doc);
  const to = decode(state, thread.anchorEnd, doc);
  return from === null || to === null || from >= to ? null : { from, to };
}

/** Whether the thread is attached to text at all (a page-level thread is not). */
export function isAnchoredThread(thread: CommentThread): boolean {
  return thread.quote !== null || thread.anchorStart !== null;
}

/**
 * A block's text the way a selection is quoted: `captureAnchor` reads the same projection, so a
 * quote taken from inline code, a mention or a hard break is found again. Every leaf is one
 * space, so a string offset is a block offset.
 */
function blockQuoteText(block: ProseMirrorNode): string {
  return block.textBetween(0, block.content.size, ' ', ' ');
}

/**
 * Where `quote` occurs in the document, when it occurs exactly once; a repeated phrase is
 * ambiguous, so it stays detached rather than guessing. The search runs over the same text
 * `captureAnchor` quotes (blocks joined by one space), so a quote that spans paragraphs is found.
 */
export function findQuote(
  doc: ProseMirrorNode,
  quote: string,
): { from: number; to: number } | null {
  // Each text block with the offset its text starts at in the joined string.
  const blocks: { pos: number; start: number; length: number }[] = [];
  let text = '';
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const block = blockQuoteText(node);
    blocks.push({
      pos: pos + 1,
      start: text.length + (blocks.length > 0 ? 1 : 0),
      length: block.length,
    });
    text += (blocks.length > 1 ? ' ' : '') + block;
    return false;
  });
  const first = text.indexOf(quote);
  if (first < 0 || quote.length === 0 || text.indexOf(quote, first + 1) >= 0) return null;
  const end = first + quote.length;
  const from = blocks.find((block) => first < block.start + block.length);
  const to = blocks.find((block) => end > block.start && end <= block.start + block.length);
  return from === undefined || to === undefined
    ? null
    : { from: from.pos + first - from.start, to: to.pos + end - to.start };
}

export const commentAnchorsKey = new PluginKey<Computed | null>('nixCommentAnchors');

const HIGHLIGHT = 'bg-accent/15 rounded-sm cursor-pointer';
const HIGHLIGHT_ACTIVE = 'bg-accent/35 rounded-sm cursor-pointer';

export interface Computed {
  readonly threads: readonly CommentThread[];
  readonly activeThreadId: string | null;
  readonly ranges: ReadonlyMap<string, { from: number; to: number }>;
  readonly detached: readonly string[];
  readonly decorations: DecorationSet;
}

/** Decodes every open anchored thread from Yjs. */
function computeFromYjs(
  state: EditorState,
  doc: ProseMirrorNode,
  threads: readonly CommentThread[],
  activeThreadId: string | null,
): Computed {
  const ranges = new Map<string, { from: number; to: number }>();
  const detached: string[] = [];
  const decorations: Decoration[] = [];
  for (const thread of threads) {
    // Resolved threads are not drawn, and a resolved one that lost its text is not worth fixing.
    if (!isAnchoredThread(thread) || thread.resolvedAt !== null) continue;
    const range = threadRange(state, thread, doc);
    if (range === null) {
      detached.push(thread.id);
      continue;
    }
    ranges.set(thread.id, range);
    decorations.push(
      Decoration.inline(
        range.from,
        range.to,
        {
          class: thread.id === activeThreadId ? HIGHLIGHT_ACTIVE : HIGHLIGHT,
          'data-comment-thread': thread.id,
        },
        { threadId: thread.id },
      ),
    );
  }
  return {
    threads,
    activeThreadId,
    ranges,
    detached,
    decorations: DecorationSet.create(doc, decorations),
  };
}

/**
 * A local edit reaches Yjs only after the transaction is applied, so decoding anchors during the
 * apply would read the document one edit behind. Local edits therefore map the ranges through the
 * transaction; Yjs is read again only for changes it originated (`ySyncPluginKey`), a refresh, or
 * new threads.
 */
function mapComputed(value: Computed, tr: Transaction): Computed {
  const ranges = new Map<string, { from: number; to: number }>();
  const detached = [...value.detached];
  for (const [id, range] of value.ranges) {
    const from = tr.mapping.map(range.from, 1);
    const to = tr.mapping.map(range.to, -1);
    if (from < to) ranges.set(id, { from, to });
    else detached.push(id);
  }
  return {
    ...value,
    ranges,
    detached,
    decorations: value.decorations.map(tr.mapping, tr.doc),
  };
}

function commentsPlugin(getItemId: () => string | null): Plugin<Computed | null> {
  return new Plugin<Computed | null>({
    key: commentAnchorsKey,
    state: {
      init: () => null,
      apply: (tr, value, old, state) => {
        const itemId = getItemId();
        if (itemId === null) return null;
        const { threads, activeThreadId, ready } = readComments(itemId);
        if (!ready) return null;
        const fromYjs =
          value === null ||
          value.threads !== threads ||
          value.activeThreadId !== activeThreadId ||
          tr.getMeta(commentAnchorsKey) !== undefined ||
          tr.getMeta(ySyncPluginKey) !== undefined;
        // `old` carries the Yjs binding: plugins after this one are not in `state` yet.
        if (fromYjs) return computeFromYjs(old, state.doc, threads, activeThreadId);
        return tr.docChanged ? mapComputed(value, tr) : value;
      },
    },
    props: {
      decorations: (state) => commentAnchorsKey.getState(state)?.decorations ?? null,
      handleClick: (view, position) => {
        const itemId = getItemId();
        const hit = commentAnchorsKey.getState(view.state)?.decorations.find(position, position)[0];
        const threadId = (hit?.spec as { threadId?: string } | undefined)?.threadId;
        if (itemId === null || threadId === undefined) return false;
        patchComments(itemId, { activeThreadId: threadId });
        return false;
      },
    },
    view: (view) => {
      let lastActive: string | null = null;
      const nudge = (): void => {
        if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(commentAnchorsKey, 'refresh'));
      };
      let lastThreads: readonly CommentThread[] | null = null;
      let lastReady = false;
      const unsubscribe = useCommentsStore.subscribe(() => {
        const itemId = getItemId();
        if (itemId === null) return;
        const current = readComments(itemId);
        // Only what the highlights depend on: not the suggestions or the draft.
        if (
          current.threads !== lastThreads ||
          current.ready !== lastReady ||
          current.activeThreadId !== lastActive
        ) {
          lastThreads = current.threads;
          lastReady = current.ready;
          queueMicrotask(nudge);
        }
      });
      return {
        update: () => {
          const itemId = getItemId();
          const computed = commentAnchorsKey.getState(view.state);
          if (itemId === null || computed === null || computed === undefined) return;
          const current = readComments(itemId);
          if (
            computed.detached.length !== current.detached.length ||
            computed.detached.some((id, index) => id !== current.detached[index])
          ) {
            patchComments(itemId, { detached: computed.detached });
          }
          if (current.activeThreadId !== lastActive) {
            lastActive = current.activeThreadId;
            const range = lastActive === null ? undefined : computed.ranges.get(lastActive);
            if (range !== undefined) {
              const dom = view.domAtPos(range.from).node;
              const element = dom instanceof Element ? dom : dom.parentElement;
              element?.scrollIntoView({ block: 'nearest' });
            }
          }
        },
        destroy: unsubscribe,
      };
    },
  });
}

/** Tells the editor's plugin which note's threads to draw. */
export function bindCommentItem(editor: Editor, itemId: string): void {
  editor.storage.commentAnchors.itemId = itemId;
}

declare module '@tiptap/core' {
  interface Storage {
    commentAnchors: { itemId: string | null };
  }
}

export const CommentAnchors = Extension.create<Record<string, never>, { itemId: string | null }>({
  name: 'commentAnchors',

  addStorage() {
    return { itemId: null };
  },

  addProseMirrorPlugins() {
    return [commentsPlugin(() => this.storage.itemId)];
  },
});

/** The handle the pane uses to act on the editor. */
export function editorHandle(editor: Editor): CommentsEditorHandle {
  return {
    editable: editor.isEditable,
    jumpTo: (position) => {
      editor.chain().focus().setTextSelection(position).scrollIntoView().run();
    },
    accept: (id) => {
      editor.chain().focus(undefined, { scrollIntoView: false }).acceptSuggestion(id).run();
    },
    reject: (id) => {
      editor.chain().focus(undefined, { scrollIntoView: false }).rejectSuggestion(id).run();
    },
  };
}
