import { Extension, type Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { ySyncPluginKey } from 'y-prosemirror';

import { announce } from '@nix/web-foundation/a11y/announcer';
import { completePhrase, NgramModel } from '@nix/web-foundation/lib/suggest/ngram';
import { learnBody, libraryModels } from './phrase-library';
import { findTrigger as findReferenceTrigger } from './reference-menu';
import { findSlashTrigger } from './slash-menu';
import { vimStatusMode } from './vim-motions';

/**
 * Phrase suggestions drawn as muted text at the caret, accepted with Right Arrow.
 *
 * **A decoration, never content.** The suggestion is a ProseMirror widget: it is drawn into the
 * page and is not in the document, so it never reaches the Yjs fragment, never syncs to a
 * colleague, never lands in the body cache or an export, and undo knows nothing of it. Only
 * accepting it writes anything, and that write is plain text inserted by an ordinary transaction -
 * exactly what typing the same characters would have produced.
 *
 * **When one is drawn.** After `IDLE_MS` without a local edit, at the end of a text block, in the
 * middle of a word or right after a space, and only when the model is confident (`ngram.ts` holds
 * the thresholds). Never in a code block or inline code, never while the `[[`/`@` or `/` pickers
 * have a trigger open, never in a read-only editor, in Vim Normal or Visual mode or during an IME
 * composition, and never after anything but typing - moving the caret, pasting, undoing or a
 * colleague's edit does not summon one. Any further edit, caret move or blur removes it.
 *
 * **Why Right Arrow, and only at the end of a block.** Tab is taken: it indents list items and
 * moves between table cells, and outside those it is how a keyboard leaves the editor - claiming
 * it, even only while a suggestion shows, would make Tab mean three things depending on a muted
 * glyph. Emacs basics binds the Ctrl and Alt movement, kill and yank chords, so no control chord
 * is free either. Right Arrow at the
 * very end of a block has one native meaning - step into the next block - and a suggestion is only
 * drawn there right after typing, which is the moment that step is least likely. That is the same
 * gesture shells and mail clients use for a completion. Vim Normal mode never shows a suggestion,
 * so its own `l` and arrow handling is untouched; in Insert mode Right Arrow accepts like anywhere
 * else.
 *
 * **Escape dismisses.** It is consumed (the innermost layer wins, as the pickers do) unless Vim is
 * on, where Escape also has to reach Vim to return to Normal mode - and Normal mode removes the
 * suggestion anyway.
 *
 * **What it learns from, and what it keeps.** This document's own text, rebuilt at most every
 * `REBUILD_MS` while writing, and the session's phrase library (`phrase-library.ts`) for the same
 * person and workspace. All in memory. When the editor closes, its text is handed to the library
 * only if the editor was allowed to keep a local copy of the body - the same rule the body cache
 * applies, so a locked body is never learned.
 *
 * **Not colour alone.** The ghost is muted, italic, and followed by a small Right Arrow keycap, so
 * it reads as "not yet written, and here is the key" without relying on the muted colour.
 *
 * **Screen readers.** The widget (keycap included) is `aria-hidden` and not editable, so it is
 * never read as part of the note; accepting one is announced through the shared live region as
 * "Inserted suggestion: ... Undo to remove.", so what was inserted, and how to take it back, is
 * heard.
 *
 * **Touch screens.** On a coarse pointer nothing is suggested until a hardware keyboard shows
 * itself by pressing a key an on-screen keyboard does not have (an arrow, Escape or Tab): without
 * one there is no Right Arrow to accept with, and a ghost nobody can accept is only noise.
 *
 * **Bounded learning.** The document's own model reads a window of at most `DOCUMENT_CHARS`
 * around the caret, and after the first build it is rebuilt in an idle callback, never inside the
 * pause that decides whether to draw a suggestion.
 */

/** How long typing has to pause before a suggestion is computed. */
export const IDLE_MS = 400;

/** How often, at most, the document's own model is rebuilt while it is being written. */
export const REBUILD_MS = 5_000;

/** How much of the block before the caret is read as context, in characters. */
const CONTEXT_CHARS = 160;

/**
 * The most of this document learned into its own model, in characters: a window around the caret,
 * which is where the phrases worth repeating are, and small enough that a rebuild is a few ms.
 */
export const DOCUMENT_CHARS = 30_000;

/** The document model's bound on distinct counts. */
const DOCUMENT_MODEL_ENTRIES = 20_000;

/**
 * The ghost's classes: the muted text role, and inert to the pointer and to selection so it cannot
 * be clicked into, dragged or copied as if it were text.
 */
export const GHOST_CLASS = 'pointer-events-none select-none text-muted italic';

/** The keycap drawn after the ghost: the accept key, upright, in the shortcut sheet's style. */
const KEYCAP_CLASS = 'ml-1 rounded-sm bg-surface px-1 font-body text-xs not-italic';

/** What the editor tells this extension each time it computes a suggestion. */
export interface GhostTextContext {
  /** The preference, and anything else that rules suggestions out (a stale copy, say). */
  readonly enabled: boolean;
  readonly subject?: string | undefined;
  readonly workspaceId?: string | undefined;
  /** This body's scope (`documentScope`), so the library can skip it and later learn it. */
  readonly scope?: string | undefined;
  /** Whether this body may be learned into the library on close: the body-cache permission. */
  readonly learnable: boolean;
}

/**
 * The extension's per-editor storage: the context, replaced by `setGhostTextContext` and read on
 * demand, so a preference change or a stale copy needs no editor rebuild.
 */
export interface GhostTextStorage {
  context: GhostTextContext;
}

declare module '@tiptap/core' {
  interface Storage {
    ghostText: GhostTextStorage;
  }
}

const NO_CONTEXT: GhostTextContext = { enabled: false, learnable: false };

/** Tells an editor's phrase suggestions what they need to know. Call from an effect. */
export function setGhostTextContext(editor: Editor, context: GhostTextContext): void {
  editor.storage.ghostText.context = context;
}

interface Suggestion {
  readonly pos: number;
  readonly text: string;
}

interface GhostState {
  readonly suggestion: Suggestion | null;
  /** Bumped by every local typing edit; the view schedules a suggestion when it moves. */
  readonly typed: number;
}

type GhostMeta =
  | { readonly kind: 'show'; readonly suggestion: Suggestion }
  | { readonly kind: 'clear' }
  | { readonly kind: 'accepted' };

export const ghostTextKey = new PluginKey<GhostState>('nixGhostText');

function readMeta(transaction: Transaction): GhostMeta | null {
  const raw: unknown = transaction.getMeta(ghostTextKey);
  return typeof raw === 'object' && raw !== null && 'kind' in raw ? (raw as GhostMeta) : null;
}

/** The suggestion currently drawn, if any. Exported for tests and for callers that need to know. */
export function currentGhostText(state: EditorState): string | null {
  return ghostTextKey.getState(state)?.suggestion?.text ?? null;
}

/**
 * The next plugin state. Exported only through the plugin; kept as a function so the rules read in
 * one place.
 */
function nextState(transaction: Transaction, value: GhostState, state: EditorState): GhostState {
  const meta = readMeta(transaction);
  if (meta?.kind === 'show') return { ...value, suggestion: meta.suggestion };
  if (meta?.kind === 'clear') return { ...value, suggestion: null };

  const head = state.selection.empty ? state.selection.head : null;

  if (transaction.docChanged) {
    // A colleague's edit (or this client's Yjs undo, which arrives the same way) moves the caret's
    // position without being typing. The suggestion survives it if it is still at the caret.
    if (transaction.getMeta(ySyncPluginKey) !== undefined) {
      if (value.suggestion === null) return value;
      const pos = transaction.mapping.map(value.suggestion.pos);
      return {
        ...value,
        suggestion: head === pos ? { ...value.suggestion, pos } : null,
      };
    }
    // A local edit. Typing schedules the next suggestion; accepting one, pasting, dropping or
    // cutting does not, and none of them keeps the old one.
    const typing =
      meta?.kind !== 'accepted' && transaction.getMeta('uiEvent') === undefined && head !== null;
    return { suggestion: null, typed: typing ? value.typed + 1 : value.typed };
  }

  if (transaction.selectionSet && value.suggestion !== null) {
    return head === value.suggestion.pos ? value : { ...value, suggestion: null };
  }
  return value;
}

/**
 * This document's text for its own model: the text blocks within a window of `DOCUMENT_CHARS`
 * around the caret, except code, and the caret's block only up to the word being typed - a
 * half-typed word learned as a word would be suggested back. With no caret (`caretBlockStart`
 * null) the window is centred on `caret`.
 *
 * Two passes: the first lists the blocks with their sizes and touches no text, the second reads
 * only those inside the window, so a very long note costs a walk of its block positions and a
 * bounded read.
 */
export function documentText(
  doc: ProseMirrorNode,
  caretBlockStart: number | null,
  caret: number,
): string {
  const blocks: { readonly node: ProseMirrorNode; readonly pos: number }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.spec.code !== true) blocks.push({ node, pos });
    return false;
  });

  // The block holding the caret, or the last one before it.
  let centre = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    if ((blocks[index]?.pos ?? 0) <= caret) centre = index;
  }

  // Grow outward from the caret's block, alternating sides, until the budget is spent.
  let first = centre;
  let last = centre;
  let length = (blocks[centre]?.node.content.size ?? 0) + 1;
  let before = true;
  while (length < DOCUMENT_CHARS && (first > 0 || last < blocks.length - 1)) {
    const next = before && first > 0 ? first - 1 : last < blocks.length - 1 ? last + 1 : first - 1;
    const size = (blocks[next]?.node.content.size ?? 0) + 1;
    if (length + size > DOCUMENT_CHARS) break;
    length += size;
    if (next < first) first = next;
    else last = next;
    before = !before;
  }

  const parts: string[] = [];
  for (let index = first; index <= last; index += 1) {
    const block = blocks[index];
    if (block === undefined) continue;
    const { node, pos } = block;
    const text =
      pos === caretBlockStart
        ? node
            .textBetween(0, Math.max(0, caret - pos - 1), '\n', '￼')
            .replace(/[\p{L}\p{N}'’]+$/u, '')
        : node.textBetween(0, node.content.size, '\n', '￼');
    parts.push(text, '\n');
  }
  return parts.join('');
}

/**
 * Whether Right Arrow can be pressed here: a fine pointer suggests a keyboard is to hand, and on a
 * coarse one a key no on-screen keyboard has must have been pressed first.
 */
function keyboardLikely(keyboardSeen: boolean): boolean {
  if (keyboardSeen || typeof globalThis.matchMedia !== 'function') return true;
  return !globalThis.matchMedia('(pointer: coarse)').matches;
}

/** Keys an on-screen keyboard does not send, so pressing one shows a hardware keyboard. */
const HARDWARE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape', 'Tab']);

/** Runs `work` when the browser is idle, or on the next task where it has no idle callback. */
function whenIdle(work: () => void): () => void {
  let done = false;
  const run = (): void => {
    done = true;
    work();
  };
  const request = globalThis.requestIdleCallback as typeof requestIdleCallback | undefined;
  const release = globalThis.cancelIdleCallback as typeof cancelIdleCallback | undefined;
  if (typeof request === 'function' && typeof release === 'function') {
    const handle = request(run, { timeout: 2_000 });
    return () => {
      if (!done) release(handle);
    };
  }
  const handle = setTimeout(run, 0);
  return () => {
    clearTimeout(handle);
  };
}

/** Whether the reference or slash picker has a trigger open in this text. */
function pickerOpen(before: string, truncated: boolean): boolean {
  return (
    findReferenceTrigger(before, truncated) !== null || findSlashTrigger(before, truncated) !== null
  );
}

function ghostElement(text: string): HTMLElement {
  const element = document.createElement('span');
  element.className = GHOST_CLASS;
  element.textContent = text;
  const keycap = document.createElement('kbd');
  keycap.className = KEYCAP_CLASS;
  keycap.textContent = '→';
  keycap.setAttribute('aria-hidden', 'true');
  element.append(keycap);
  element.setAttribute('aria-hidden', 'true');
  element.setAttribute('contenteditable', 'false');
  element.setAttribute('data-ghost-text', '');
  return element;
}

function ghostPlugin(context: () => GhostTextContext): Plugin<GhostState> {
  // Shared by the view and the props: one plugin instance per editor, so per-editor state.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let model: NgramModel | null = null;
  let modelDoc: ProseMirrorNode | null = null;
  let modelBuiltAt = 0;
  let cancelRebuild: (() => void) | null = null;
  let keyboardSeen = false;

  const cancel = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const build = (doc: ProseMirrorNode, caretBlockStart: number, caret: number): NgramModel => {
    const next = new NgramModel(DOCUMENT_MODEL_ENTRIES);
    next.train(documentText(doc, caretBlockStart, caret));
    model = next;
    modelDoc = doc;
    modelBuiltAt = Date.now();
    return next;
  };

  const dismiss = (view: EditorView): void => {
    if ((ghostTextKey.getState(view.state)?.suggestion ?? null) !== null) {
      view.dispatch(
        view.state.tr
          .setMeta(ghostTextKey, { kind: 'clear' } satisfies GhostMeta)
          .setMeta('addToHistory', false),
      );
    }
  };

  /**
   * The document's model. Built on the spot only the first time; after that a stale model keeps
   * answering while its replacement is built in an idle callback, so the rebuild never sits
   * inside the pause that decides whether to draw.
   */
  const documentModel = (
    state: EditorState,
    caretBlockStart: number,
    caret: number,
  ): NgramModel => {
    if (model === null) return build(state.doc, caretBlockStart, caret);
    if (
      cancelRebuild === null &&
      modelDoc !== state.doc &&
      Date.now() - modelBuiltAt >= REBUILD_MS
    ) {
      const { doc } = state;
      const progress = { finished: false };
      const cancelThis = whenIdle(() => {
        progress.finished = true;
        cancelRebuild = null;
        build(doc, caretBlockStart, caret);
      });
      // An idle callback can run at once (in a test, or a browser with nothing else to do).
      if (!progress.finished) cancelRebuild = cancelThis;
    }
    return model;
  };

  const suggest = (view: EditorView): void => {
    const settings = context();
    if (!settings.enabled || view.isDestroyed || !view.editable || view.composing) return;
    if (!keyboardLikely(keyboardSeen)) return;

    const { state } = view;
    const { selection } = state;
    if (!selection.empty) return;
    const $head = selection.$head;
    const block = $head.parent;
    if (!block.isTextblock || block.type.spec.code === true) return;
    // Only at the end of the block - see the module comment for why the accept key needs this.
    if ($head.parentOffset !== block.content.size) return;
    if ((state.storedMarks ?? $head.marks()).some((mark) => mark.type.spec.code === true)) return;
    const vim = vimStatusMode(state);
    if (vim !== null && vim !== 'insert') return;

    const start = Math.max(0, $head.parentOffset - CONTEXT_CHARS);
    const before = block.textBetween(start, $head.parentOffset, '\n', '￼');
    if (pickerOpen(before, start > 0)) return;

    const models = [documentModel(state, $head.before(), $head.pos)];
    if (settings.subject !== undefined && settings.workspaceId !== undefined) {
      models.push(...libraryModels(settings.subject, settings.workspaceId, settings.scope));
    }
    const completion = completePhrase(before, models);
    if (completion === null) return;

    view.dispatch(
      state.tr
        .setMeta(ghostTextKey, {
          kind: 'show',
          suggestion: { pos: selection.head, text: completion.text },
        } satisfies GhostMeta)
        .setMeta('addToHistory', false),
    );
  };

  return new Plugin<GhostState>({
    key: ghostTextKey,
    state: {
      init: () => ({ suggestion: null, typed: 0 }),
      apply: (transaction, value, _old, state) => nextState(transaction, value, state),
    },
    view(initial) {
      let seen = ghostTextKey.getState(initial.state)?.typed ?? 0;
      return {
        update(view) {
          const typed = ghostTextKey.getState(view.state)?.typed ?? 0;
          if (typed === seen) return;
          seen = typed;
          cancel();
          timer = setTimeout(() => {
            timer = undefined;
            suggest(view);
          }, IDLE_MS);
        },
        destroy() {
          cancel();
          cancelRebuild?.();
          cancelRebuild = null;
        },
      };
    },
    props: {
      decorations(state) {
        const suggestion = ghostTextKey.getState(state)?.suggestion ?? null;
        if (suggestion === null) return null;
        return DecorationSet.create(state.doc, [
          Decoration.widget(suggestion.pos, () => ghostElement(suggestion.text), {
            side: 1,
            key: `ghost:${suggestion.text}`,
            ignoreSelection: true,
          }),
        ]);
      },
      handleKeyDown(view, event) {
        if (HARDWARE_KEYS.has(event.key)) keyboardSeen = true;
        const suggestion = ghostTextKey.getState(view.state)?.suggestion ?? null;
        if (suggestion === null) return false;

        if (event.key === 'Escape') {
          dismiss(view);
          if (vimStatusMode(view.state) !== null) return false;
          event.stopPropagation();
          return true;
        }

        if (
          event.key === 'ArrowRight' &&
          !event.shiftKey &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.isComposing &&
          !view.composing &&
          view.editable
        ) {
          const { selection } = view.state;
          if (!selection.empty || selection.head !== suggestion.pos) return false;
          view.dispatch(
            view.state.tr
              .insertText(suggestion.text, suggestion.pos)
              .setMeta(ghostTextKey, { kind: 'accepted' } satisfies GhostMeta)
              .scrollIntoView(),
          );
          announce(`Inserted suggestion: ${suggestion.text.trim()}. Undo to remove.`);
          return true;
        }
        return false;
      },
      handleDOMEvents: {
        blur(view) {
          cancel();
          dismiss(view);
          return false;
        },
        compositionstart(view) {
          cancel();
          dismiss(view);
          return false;
        },
      },
    },
  });
}

export const GhostText = Extension.create<Record<string, never>, GhostTextStorage>({
  name: 'ghostText',
  // Above Vim basics (900), so Escape is seen here first and a visible suggestion is dismissed
  // before Vim leaves Insert mode; below Emacs basics (1100), whose chords this never claims.
  priority: 1000,

  addStorage() {
    return { context: NO_CONTEXT };
  },

  addProseMirrorPlugins() {
    return [ghostPlugin(() => this.storage.context)];
  },

  onDestroy() {
    // The note is closing: what it says joins the session library, if it may and if suggestions
    // are wanted at all - with them off there is no reason to hold anybody's text in memory. Read
    // here rather than in the plugin view's `destroy`, which also runs whenever a plugin is
    // registered.
    const settings = this.storage.context;
    if (settings.enabled && settings.learnable && settings.scope !== undefined) {
      // The same window the document's own model reads, centred where the person last wrote.
      const { state } = this.editor;
      learnBody(settings.scope, documentText(state.doc, null, state.selection.head));
    }
  },
});
