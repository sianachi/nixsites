import type { CommentThread } from '@nix/api-client';
import { Extension, type Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from 'y-prosemirror';
import * as Y from 'yjs';
import { create } from 'zustand';

import type { SuggestionEntry } from './suggesting';
import { mentionText } from './unlinked-mentions';

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
  /** The body has synced, so anchors can be trusted to decode; before then nothing is drawn. */
  readonly ready: boolean;
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
  ready: false,
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
function decode(state: EditorState, encoded: string): number | null {
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
    return position === null ? null : Math.min(position, state.doc.content.size);
  } catch {
    return null;
  }
}

/** A thread's range in the document, or null when it is detached. Page-level threads are skipped. */
export function threadRange(
  state: EditorState,
  thread: CommentThread,
): { from: number; to: number } | null {
  if (thread.anchorStart === null || thread.anchorEnd === null) return null;
  const from = decode(state, thread.anchorStart);
  const to = decode(state, thread.anchorEnd);
  return from === null || to === null || from >= to ? null : { from, to };
}

/** Whether the thread is attached to text at all (a page-level thread is not). */
export function isAnchoredThread(thread: CommentThread): boolean {
  return thread.quote !== null || thread.anchorStart !== null;
}

/**
 * The first place `quote` occurs inside a single block.
 *
 * shortcut: first occurrence of the quote; match surrounding context if repeated phrases
 * mis-anchor. A quote that spans blocks is never found and stays detached.
 */
export function findQuote(
  doc: ProseMirrorNode,
  quote: string,
): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (!node.isTextblock) return true;
    const index = mentionText(node).indexOf(quote);
    if (index >= 0) found = { from: pos + 1 + index, to: pos + 1 + index + quote.length };
    return false;
  });
  return found;
}

export const commentAnchorsKey = new PluginKey('nixCommentAnchors');

const HIGHLIGHT = 'bg-accent/15 rounded-sm cursor-pointer';
const HIGHLIGHT_ACTIVE = 'bg-accent/35 rounded-sm cursor-pointer';

interface Computed {
  readonly threads: readonly CommentThread[];
  readonly activeThreadId: string | null;
  readonly doc: ProseMirrorNode;
  readonly ranges: ReadonlyMap<string, { from: number; to: number }>;
  readonly detached: readonly string[];
  readonly decorations: DecorationSet;
}

function commentsPlugin(getItemId: () => string | null): Plugin {
  let cache: Computed | null = null;

  const compute = (state: EditorState): Computed | null => {
    const itemId = getItemId();
    if (itemId === null) return null;
    const { threads, activeThreadId, ready } = readComments(itemId);
    if (!ready) return null;
    if (cache?.threads === threads && cache.activeThreadId === activeThreadId) {
      if (cache.doc === state.doc) return cache;
    }
    const ranges = new Map<string, { from: number; to: number }>();
    const detached: string[] = [];
    const decorations: Decoration[] = [];
    for (const thread of threads) {
      // Resolved threads are not drawn, and a resolved one that lost its text is not worth fixing.
      if (!isAnchoredThread(thread) || thread.resolvedAt !== null) continue;
      const range = threadRange(state, thread);
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
    cache = {
      threads,
      activeThreadId,
      doc: state.doc,
      ranges,
      detached,
      decorations: DecorationSet.create(state.doc, decorations),
    };
    return cache;
  };

  return new Plugin({
    key: commentAnchorsKey,
    props: {
      decorations: (state) => compute(state)?.decorations ?? null,
      handleClick: (view, position) => {
        const itemId = getItemId();
        const hit = compute(view.state)?.decorations.find(position, position)[0];
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
          if (itemId === null) return;
          const computed = compute(view.state);
          if (computed === null) return;
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
