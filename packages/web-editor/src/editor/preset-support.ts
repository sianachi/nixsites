import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { Mapping } from '@tiptap/pm/transform';
import type { EditorView } from '@tiptap/pm/view';
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from 'y-prosemirror';

import {
  adjacentLine,
  firstNonBlank,
  lineAt,
  lineText,
  nextGrapheme,
  previousGrapheme,
  type Line,
} from './text-motions';

/**
 * Editing machinery the Vim and Emacs presets share: positions that survive collaborative edits,
 * text rewritten in place, joined lines, and keystrokes recorded and replayed for macros.
 */

// ---------------------------------------------------------------------------------------------
// Saved positions
// ---------------------------------------------------------------------------------------------

/** A position that survives edits: a Yjs position in a collaborative document, else a mapped one. */
export type SavedPosition = { readonly pos: number } | { readonly relative: unknown };

interface SyncBinding {
  readonly type: Parameters<typeof absolutePositionToRelativePosition>[1];
  readonly doc: Parameters<typeof relativePositionToAbsolutePosition>[0];
  readonly binding: { readonly mapping: Parameters<typeof absolutePositionToRelativePosition>[2] };
}

function syncBinding(state: EditorState): SyncBinding | null {
  const value: unknown = ySyncPluginKey.getState(state);
  return typeof value === 'object' && value !== null && 'binding' in value
    ? (value as SyncBinding)
    : null;
}

/** A remote edit or an undo rebuilds a collaborative document, so a saved place there is a Yjs position. */
export function savePosition(state: EditorState, pos: number): SavedPosition {
  const sync = syncBinding(state);
  return sync === null
    ? { pos }
    : { relative: absolutePositionToRelativePosition(pos, sync.type, sync.binding.mapping) };
}

export function restorePosition(state: EditorState, saved: SavedPosition): number | null {
  let pos: number | null;
  if ('pos' in saved) pos = saved.pos;
  else {
    const sync = syncBinding(state);
    pos =
      sync === null
        ? null
        : relativePositionToAbsolutePosition(
            sync.doc,
            sync.type,
            saved.relative,
            sync.binding.mapping,
          );
  }
  return pos === null || pos > state.doc.content.size ? null : pos;
}

/** Follows an edit; a Yjs position needs no help. */
export function mapSaved(saved: SavedPosition, mapping: Mapping): SavedPosition {
  return 'pos' in saved ? { pos: mapping.map(saved.pos) } : saved;
}

/** Whether the transaction is y-prosemirror rebuilding the document for a remote edit or an undo. */
export function isChangeOrigin(transaction: Transaction): boolean {
  const meta: unknown = transaction.getMeta(ySyncPluginKey);
  return typeof meta === 'object' && meta !== null && Reflect.get(meta, 'isChangeOrigin') === true;
}

// ---------------------------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------------------------

/**
 * Rewrites the text between `from` and `to` piece by piece, keeping each piece's marks. `rewrite`
 * also gets the piece's offset from `from`, for a rewrite that depends on the whole range.
 */
export function rewriteText(
  transaction: Transaction,
  from: number,
  to: number,
  rewrite: (text: string, offset: number) => string,
): void {
  const pieces: { from: number; to: number; text: string; node: ProseMirrorNode }[] = [];
  transaction.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true;
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + node.nodeSize);
    pieces.push({
      from: start,
      to: end,
      text: (node.text ?? '').slice(start - pos, end - pos),
      node,
    });
    return false;
  });
  for (const piece of pieces.reverse()) {
    const next = rewrite(piece.text, piece.from - from);
    if (next !== piece.text && next !== '') {
      transaction.replaceWith(
        piece.from,
        piece.to,
        transaction.doc.type.schema.text(next, piece.node.marks),
      );
    }
  }
}

/**
 * Joins the next line onto `line` with one space, dropping its leading blanks, as Vim's `J` and
 * Emacs's `M-^` do. Returns where they meet, or null when the two cannot be joined.
 */
export function joinWithNext(transaction: Transaction, line: Line): number | null {
  const next = adjacentLine(transaction.doc, line, 1);
  if (next === null) return null;
  const end = line.start + line.size;
  const blanks = Math.min(firstNonBlank(next), next.size);
  const before = transaction.doc;
  transaction.delete(end, next.start + blanks);
  if (transaction.doc.eq(before)) return null;
  const endsBlank = line.size > 0 && /[\t ]/.test(lineText(line, line.size - 1, line.size));
  if (line.size > 0 && blanks < next.size && !endsBlank) transaction.insertText(' ', end);
  return end;
}

// ---------------------------------------------------------------------------------------------
// Keystrokes
// ---------------------------------------------------------------------------------------------

export interface KeyStroke {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/** Keys that only modify another; a macro or a prefix never treats them as a keystroke. */
export const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph']);

export function strokeOf(event: KeyboardEvent): KeyStroke {
  return {
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
  };
}

export function hasModifier(event: {
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}): boolean {
  return event.ctrlKey || event.metaKey || event.altKey;
}

/** Text typed by a replayed key, through the same input rules a real keystroke runs. */
function typeText(view: EditorView, text: string): void {
  const { from, to } = view.state.selection;
  const handled = view.someProp('handleTextInput', (handler) =>
    handler(view, from, to, text, () => view.state.tr.insertText(text, from, to)),
  );
  if (handled !== true) view.dispatch(view.state.tr.insertText(text, from, to).scrollIntoView());
}

/** A synthetic Backspace or Delete has no default action, so the plain deletion is done here. */
function deleteCharacter(view: EditorView, backward: boolean): void {
  const { selection, doc } = view.state;
  if (!selection.empty) {
    view.dispatch(view.state.tr.deleteSelection());
    return;
  }
  const line = lineAt(doc, selection.head);
  if (line === null) return;
  const offset = selection.head - line.start;
  if (backward ? offset === 0 : offset === line.size) return;
  const from = backward ? line.start + previousGrapheme(line, offset) : selection.head;
  const to = backward ? selection.head : line.start + nextGrapheme(line, offset);
  view.dispatch(view.state.tr.delete(from, to));
}

/**
 * Replays one recorded key. A synthetic event runs every key handler but has no default action,
 * so where the preset would let the browser type (`typesText`), the text is inserted here, and a
 * plain Backspace or Delete nobody handled is done here too.
 */
export function replayStroke(view: EditorView, stroke: KeyStroke, typesText: boolean): void {
  if (typesText && !hasModifier(stroke) && stroke.key.length === 1) {
    typeText(view, stroke.key);
    return;
  }
  const event = new KeyboardEvent('keydown', { ...stroke, bubbles: true, cancelable: true });
  view.dom.dispatchEvent(event);
  if (
    typesText &&
    !event.defaultPrevented &&
    !hasModifier(stroke) &&
    (stroke.key === 'Backspace' || stroke.key === 'Delete')
  ) {
    deleteCharacter(view, stroke.key === 'Backspace');
  }
}
