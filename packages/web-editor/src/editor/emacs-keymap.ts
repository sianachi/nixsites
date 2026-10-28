import { Extension } from '@tiptap/core';
import type { Schema, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import { Transform, type Mapping } from '@tiptap/pm/transform';
import type { EditorView } from '@tiptap/pm/view';
import { redo, undo, ySyncPluginKey } from 'y-prosemirror';

import { useKeyboardModeStore } from './keyboard-mode-store';
import {
  hasModifier,
  joinWithNext,
  mapSaved,
  MODIFIER_KEYS,
  replayStroke,
  restorePosition,
  rewriteText,
  savePosition,
  strokeOf,
  type KeyStroke,
  type SavedPosition,
} from './preset-support';
import {
  adjacentLine,
  edgeLine,
  findInLine,
  firstNonBlank,
  lineAt,
  lineText,
  nextGrapheme,
  nextWordEnd,
  nthLine,
  paragraphTarget,
  previousGrapheme,
  previousWordStart,
  searchExpression,
  searchFrom,
  words,
  type Line,
} from './text-motions';

/**
 * Emacs basics: the movement, mark, kill-ring, search and macro keys people's fingers already know.
 *
 * **Explicit on every platform.** macOS gives a text field a few Emacs chords of its own, but they
 * are partial, and Windows and Linux have none - there Ctrl+F is find and Ctrl+P is print. Every
 * chord below is implemented here against ProseMirror positions, so it does the same thing
 * everywhere and inside any block. While this preset is on, those chords mean their Emacs
 * meaning, which is the point of choosing it; the browser keeps the few it never lets a page
 * have (Ctrl+N, Ctrl+W and Ctrl+T on Windows and Linux).
 *
 * **Lines.** Ctrl+A/E work on the text block, like Emacs's logical lines. Ctrl+N/P move by the line
 * as displayed, which is what Emacs does by default, by asking the browser to move a collapsed
 * selection one line and reading back where it landed. An empty block is a blank line, for
 * Alt+{ and Alt+}.
 *
 * **The mark.** Ctrl+Space sets it at the caret and every motion after that extends the region from
 * it, until Ctrl+G, an edit, or a click deactivates it. Each mark set (and each jump: Alt+<, Alt+>,
 * a search, Alt+G G) is pushed onto this editor's mark ring, which Ctrl+U Ctrl+Space walks back.
 *
 * **The kill ring** is shared by every editor on the page and lives only in memory. A kill keeps
 * the killed content as a slice, formatting included, and consecutive kills append into one entry,
 * so Ctrl+K Ctrl+K Ctrl+K takes a line, its break and the next line together. Ctrl+Y yanks the
 * latest; Alt+Y straight after replaces it with the one before.
 *
 * **Prefixes and the minibuffer.** Ctrl+X, Ctrl+U, Alt+<digit>, Alt+G and Alt+Z wait for the
 * next key, and I-search, query replace and goto-line read text, in the status line under the
 * note. Those keys are taken here before any keymap sees them, so Ctrl+G always quits.
 *
 * **Undo** is the collaborative, client-local history, the same one Mod+Z uses.
 */

type Prefix =
  | 'C-x'
  | 'C-x r'
  | 'C-x r s'
  | 'C-x r i'
  | 'C-x r SPC'
  | 'C-x r j'
  | 'M-g'
  | 'M-z'
  /** After C-x z, another z repeats again. */
  | 'repeat'
  /** After C-x e, another e runs the macro again. */
  | 'macro';

type Prompt =
  | {
      readonly kind: 'search';
      readonly forward: boolean;
      readonly text: string;
      /** Where the search started, where Ctrl+G returns to. */
      readonly origin: number;
      readonly failing: boolean;
      readonly wrapped: boolean;
    }
  | { readonly kind: 'replace-from'; readonly text: string }
  | { readonly kind: 'replace-to'; readonly from: string; readonly text: string }
  | {
      readonly kind: 'replacing';
      readonly from: string;
      readonly to: string;
      readonly match: { readonly from: number; readonly to: number };
      readonly replaced: number;
    }
  | { readonly kind: 'goto'; readonly text: string };

/** Ctrl+U's universal argument (4, 16, ...) or the digits typed after it or with Alt. */
interface Argument {
  readonly value: number;
  readonly digits: string;
}

interface EmacsState {
  /** The active mark, mapped through every edit; null when no region is being made. */
  readonly mark: number | null;
  /** The previous command was a kill, so the next one appends to the same ring entry. */
  readonly lastKill: boolean;
  /** What the previous command yanked, so Alt+Y can swap it. */
  readonly yank: { readonly from: number; readonly to: number; readonly index: number } | null;
  readonly prefix: Prefix | null;
  readonly argument: Argument | null;
  readonly prompt: Prompt | null;
  /** One line of feedback for the status line, cleared by the next key. */
  readonly message: string;
  /** A keyboard macro is being defined. */
  readonly recording: boolean;
  /** Earlier marks, newest first. */
  readonly markRing: readonly SavedPosition[];
  /** Positions saved with Ctrl+X R Space, by register name. */
  readonly points: ReadonlyMap<string, SavedPosition>;
}

type EmacsMeta = Partial<EmacsState>;

export const emacsKeymapKey = new PluginKey<EmacsState>('nixEmacsKeymap');

const INITIAL: EmacsState = {
  mark: null,
  lastKill: false,
  yank: null,
  prefix: null,
  argument: null,
  prompt: null,
  message: '',
  recording: false,
  markRing: [],
  points: new Map(),
};
const RING_SIZE = 60;
const MARK_RING_SIZE = 16;
/** Larger arguments are almost always a slip, and each step is a real command. */
const MAX_ARGUMENT = 9999;
/** The most keys one macro run replays, so a large argument cannot freeze the page. */
const MAX_REPLAYED_KEYS = 50_000;

const ring: Slice[] = [];
/** Text saved with Ctrl+X R S, shared by every editor on the page like the kill ring. */
const textRegisters = new Map<string, Slice>();
let lastSearchText = '';
let lastCommand: {
  readonly action: Action;
  readonly count: number;
  readonly universal: boolean;
} | null = null;
let macro: readonly KeyStroke[] | null = null;
let recorded: KeyStroke[] = [];
let replaying = false;
/** Set when a command cannot do what it was asked, which ends a running macro as in Emacs. */
let failed = false;

function current(state: EditorState): EmacsState {
  return emacsKeymapKey.getState(state) ?? INITIAL;
}

/** The kill ring's entries, newest first; exposed for tests and nothing else. */
export function emacsKillRing(): readonly Slice[] {
  return ring;
}

/**
 * Updates this preset's state, with the caret moved when `selection` is given. A command that is
 * not a kill or a yank ends the kill and yank sequence unless it `keepsSequence`, as a prefix or
 * a cleared message does.
 */
function dispatch(
  view: EditorView,
  meta: EmacsMeta,
  selection?: TextSelection,
  keepsSequence = false,
): void {
  const state = current(view.state);
  const full = keepsSequence ? { lastKill: state.lastKill, yank: state.yank, ...meta } : meta;
  const transaction = view.state.tr.setMeta(emacsKeymapKey, full);
  if (selection !== undefined) transaction.setSelection(selection).scrollIntoView();
  view.dispatch(transaction);
}

/** Read through a call, since a replayed key sets it where the compiler cannot see. */
function hasFailed(): boolean {
  return failed;
}

function fail(view: EditorView, message = ''): boolean {
  failed = true;
  if (message !== '') dispatch(view, { message }, undefined, true);
  return true;
}

/** Joins two slices as if the second had been typed straight after the first. */
function appendSlices(schema: Schema, first: Slice, second: Slice): Slice {
  try {
    const empty = schema.topNodeType.createAndFill();
    if (empty === null) return second;
    const transform = new Transform(empty);
    transform.replace(1, 1, first);
    const middle = transform.mapping.map(1, 1);
    transform.replace(middle, middle, second);
    return transform.doc.slice(transform.mapping.map(1, -1), transform.mapping.map(1, 1));
  } catch {
    // A pair the schema cannot place side by side keeps the newer kill rather than losing both.
    return second;
  }
}

/** A backward kill (Alt+Backspace) goes in front of the entry it appends to. */
function pushKill(schema: Schema, slice: Slice, append: boolean, backward = false): void {
  const latest = ring[0];
  if (append && latest !== undefined) {
    ring[0] = backward ? appendSlices(schema, slice, latest) : appendSlices(schema, latest, slice);
    return;
  }
  ring.unshift(slice);
  ring.length = Math.min(ring.length, RING_SIZE);
}

function head(state: EditorState): number | null {
  const { selection } = state;
  return selection instanceof TextSelection ? selection.head : null;
}

function withPushedMark(state: EditorState, pos: number): readonly SavedPosition[] {
  return [savePosition(state, pos), ...current(state).markRing].slice(0, MARK_RING_SIZE);
}

/** Moves the caret, extending the region from the mark when one is active. */
function moveTo(view: EditorView, target: number, pushMarkFrom?: number): void {
  const { mark } = current(view.state);
  const selection =
    mark === null
      ? TextSelection.create(view.state.doc, target)
      : TextSelection.create(view.state.doc, mark, target);
  view.dispatch(
    view.state.tr
      .setSelection(selection)
      .setMeta(emacsKeymapKey, {
        mark,
        ...(pushMarkFrom === undefined
          ? {}
          : { markRing: withPushedMark(view.state, pushMarkFrom) }),
      })
      .scrollIntoView(),
  );
}

type Locate = (state: EditorState, from: number, line: Line) => number | null;

/** A motion; a jump also pushes where it started onto the mark ring. */
function motion(locate: Locate, jump = false): (view: EditorView) => boolean {
  return (view) => {
    const from = head(view.state);
    const line = from === null ? null : lineAt(view.state.doc, from);
    if (from === null || line === null) return false;
    const target = locate(view.state, from, line);
    // Emacs signals at either end of the note, which is also what ends a running macro.
    if (target === null) return fail(view);
    moveTo(view, target, jump ? from : undefined);
    return true;
  };
}

const forwardChar: Locate = (state, from, line) => {
  const offset = from - line.start;
  if (offset < line.size) return line.start + nextGrapheme(line, offset);
  return adjacentLine(state.doc, line, 1)?.start ?? null;
};

const backwardChar: Locate = (state, from, line) => {
  const offset = from - line.start;
  if (offset > 0) return line.start + previousGrapheme(line, offset);
  const previous = adjacentLine(state.doc, line, -1);
  return previous === null ? null : previous.start + previous.size;
};

/** Alt+F: to the end of the next word, across blocks. */
const forwardWord: Locate = (state, from, line) => {
  let search = line;
  let after = from - line.start;
  for (;;) {
    const end = nextWordEnd(search, after);
    if (end !== null) return search.start + end;
    const next = adjacentLine(state.doc, search, 1);
    if (next === null) return search.start + search.size;
    search = next;
    after = -1;
  }
};

/** Alt+B: to the start of the previous word, across blocks. */
const backwardWord: Locate = (state, from, line) => {
  let search = line;
  let before = from - line.start;
  for (;;) {
    const start = previousWordStart(search, before);
    if (start !== null) return search.start + start;
    const previous = adjacentLine(state.doc, search, -1);
    if (previous === null) return search.start;
    search = previous;
    before = previous.size + 1;
  }
};

const lineStart: Locate = (_state, _from, line) => line.start;
const lineEnd: Locate = (_state, _from, line) => line.start + line.size;
const indentation: Locate = (_state, _from, line) => line.start + firstNonBlank(line);
const documentStart: Locate = (state) => edgeLine(state.doc, 1)?.start ?? null;
const documentEnd: Locate = (state) => {
  const last = edgeLine(state.doc, -1);
  return last === null ? null : last.start + last.size;
};

/** Alt+} and Alt+{: to the empty block after or before the paragraph, or the note's edge. */
function paragraphMotion(direction: 1 | -1): Locate {
  return (state, _from, line) => {
    const found = paragraphTarget(state.doc, line, direction, 1);
    return found.end ? found.line.start + found.line.size : found.line.start + found.offset;
  };
}

/**
 * Ctrl+N/P: one displayed line down or up. The browser knows where a wrapped line breaks and
 * ProseMirror does not, so a collapsed DOM selection is moved with `Selection.modify` and read
 * back. Without it (a non-browser test environment), the next or previous block at the same column.
 */
function lineMove(direction: 1 | -1): (view: EditorView) => boolean {
  return (view) => {
    const from = head(view.state);
    const line = from === null ? null : lineAt(view.state.doc, from);
    if (from === null || line === null) return false;
    const selection = view.dom.ownerDocument.getSelection();
    if (selection !== null && typeof selection.modify === 'function' && view.hasFocus()) {
      try {
        const { node, offset } = view.domAtPos(from);
        selection.collapse(node, offset);
        selection.modify('move', direction === 1 ? 'forward' : 'backward', 'line');
        if (selection.focusNode !== null) {
          const target = view.posAtDOM(selection.focusNode, selection.focusOffset);
          if (lineAt(view.state.doc, target) !== null) {
            moveTo(view, target);
            return true;
          }
        }
      } catch {
        // A position the DOM cannot express falls back to block movement below.
      }
    }
    const next = adjacentLine(view.state.doc, line, direction);
    if (next === null) return fail(view);
    moveTo(view, next.start + Math.min(from - line.start, next.size));
    return true;
  };
}

/** Removes [from, to), records it in the kill ring, and leaves the caret at `from`. */
function kill(view: EditorView, from: number, to: number, backward = false): boolean {
  if (to <= from) return true;
  const { state } = view;
  const { lastKill } = current(state);
  pushKill(state.schema, state.doc.slice(from, to), lastKill, backward);
  view.dispatch(
    state.tr
      .delete(from, to)
      .setMeta(emacsKeymapKey, { mark: null, lastKill: true })
      .scrollIntoView(),
  );
  return true;
}

/** Ctrl+K: the rest of the block, or the break after it when only blanks are left. */
function killLine(view: EditorView): boolean {
  const from = head(view.state);
  const line = from === null ? null : lineAt(view.state.doc, from);
  if (from === null || line === null) return false;
  const rest = lineText(line, from - line.start);
  if (/[^\t ]/u.test(rest)) return kill(view, from, line.start + line.size);
  const next = adjacentLine(view.state.doc, line, 1);
  return kill(view, from, next === null ? line.start + line.size : next.start);
}

/** Alt+D: to the end of the next word. */
function killWord(view: EditorView): boolean {
  const from = head(view.state);
  const line = from === null ? null : lineAt(view.state.doc, from);
  if (from === null || line === null) return false;
  const to = forwardWord(view.state, from, line);
  return to === null ? true : kill(view, from, to);
}

/** Alt+Backspace: back to the start of the previous word. */
function backwardKillWord(view: EditorView): boolean {
  const to = head(view.state);
  const line = to === null ? null : lineAt(view.state.doc, to);
  if (to === null || line === null) return false;
  const from = backwardWord(view.state, to, line);
  return from === null ? true : kill(view, from, to, true);
}

/** The region: mark to caret, or a selection made some other way. */
function region(state: EditorState): { readonly from: number; readonly to: number } | null {
  const { mark } = current(state);
  const caret = head(state);
  if (mark !== null && caret !== null) {
    return { from: Math.min(mark, caret), to: Math.max(mark, caret) };
  }
  return state.selection.empty ? null : { from: state.selection.from, to: state.selection.to };
}

/** Ctrl+W. */
function killRegion(view: EditorView): boolean {
  const range = region(view.state);
  return range === null ? true : kill(view, range.from, range.to);
}

/** Alt+W: copy the region into the kill ring and deactivate the mark. */
function copyRegion(view: EditorView): boolean {
  const range = region(view.state);
  if (range === null) return true;
  pushKill(view.state.schema, view.state.doc.slice(range.from, range.to), false);
  const caret = head(view.state) ?? range.to;
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.create(view.state.doc, caret))
      .setMeta(emacsKeymapKey, { mark: null }),
  );
  return true;
}

function insertAt(view: EditorView, from: number, to: number, slice: Slice, index: number): void {
  const transaction = view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to));
  transaction.replaceSelection(slice);
  const start = transaction.mapping.map(from, -1);
  const end = transaction.selection.head;
  transaction.setMeta(emacsKeymapKey, { mark: null, yank: { from: start, to: end, index } });
  view.dispatch(transaction.scrollIntoView());
}

/** Ctrl+Y. */
function yank(view: EditorView): boolean {
  const latest = ring[0];
  const caret = head(view.state);
  if (latest === undefined || caret === null) return true;
  insertAt(view, caret, caret, latest, 0);
  return true;
}

/** Alt+Y, straight after a yank: swap what was yanked for the next older kill. */
function yankPop(view: EditorView): boolean {
  const { yank: last } = current(view.state);
  if (last === null || ring.length < 2) return true;
  const index = (last.index + 1) % ring.length;
  const slice = ring[index];
  if (slice !== undefined) insertAt(view, last.from, last.to, slice, index);
  return true;
}

/** Ctrl+Space: set the mark here, or deactivate it when it is already here. */
function setMark(view: EditorView): boolean {
  const caret = head(view.state);
  if (caret === null) return false;
  const { mark } = current(view.state);
  const again = mark === caret;
  dispatch(
    view,
    {
      mark: again ? null : caret,
      ...(again ? {} : { markRing: withPushedMark(view.state, caret) }),
      message: again ? 'Mark deactivated' : 'Mark set',
    },
    TextSelection.create(view.state.doc, caret),
  );
  return true;
}

/** Ctrl+U Ctrl+Space: back to the last mark, which moves to the end of the ring. */
function popMark(view: EditorView): boolean {
  const { markRing } = current(view.state);
  const [latest, ...rest] = markRing;
  const target = latest === undefined ? null : restorePosition(view.state, latest);
  if (latest === undefined || target === null) return fail(view, 'No mark set in this note');
  dispatch(
    view,
    { mark: null, markRing: [...rest, latest] },
    TextSelection.create(view.state.doc, target),
  );
  return true;
}

/** Ctrl+X Ctrl+X: swap the caret and the mark, making the region between them active. */
function exchangePointAndMark(view: EditorView): boolean {
  const caret = head(view.state);
  const { markRing } = current(view.state);
  const [latest, ...rest] = markRing;
  const target = latest === undefined ? null : restorePosition(view.state, latest);
  if (caret === null || latest === undefined || target === null) {
    return fail(view, 'No mark set in this note');
  }
  dispatch(
    view,
    { mark: caret, markRing: [savePosition(view.state, caret), ...rest] },
    TextSelection.create(view.state.doc, caret, target),
  );
  return true;
}

/** Ctrl+X H: the whole note as the region, caret at the start. */
function markWholeNote(view: EditorView): boolean {
  const first = edgeLine(view.state.doc, 1);
  const last = edgeLine(view.state.doc, -1);
  const caret = head(view.state);
  if (first === null || last === null) return true;
  const start = first.start;
  const end = last.start + last.size;
  dispatch(
    view,
    {
      mark: end,
      ...(caret === null ? {} : { markRing: withPushedMark(view.state, caret) }),
    },
    TextSelection.create(view.state.doc, end, start),
  );
  return true;
}

/** Ctrl+G: deactivate the mark and collapse the region onto the caret. */
function keyboardQuit(view: EditorView): boolean {
  const caret = head(view.state);
  const transaction = view.state.tr.setMeta(emacsKeymapKey, { mark: null });
  if (caret !== null) transaction.setSelection(TextSelection.create(view.state.doc, caret));
  view.dispatch(transaction);
  return true;
}

/** Ctrl+D: delete the next character, joining the next block at the end of this one. */
function deleteChar(view: EditorView): boolean {
  const { selection } = view.state;
  if (!selection.empty) {
    view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
    return true;
  }
  const from = head(view.state);
  const line = from === null ? null : lineAt(view.state.doc, from);
  if (from === null || line === null) return false;
  const to = forwardChar(view.state, from, line);
  if (to === null) return fail(view);
  if (to > from) view.dispatch(view.state.tr.delete(from, to).scrollIntoView());
  return true;
}

// ---------------------------------------------------------------------------------------------
// Words, case and whitespace
// ---------------------------------------------------------------------------------------------

function upcase(text: string): string {
  return text.toUpperCase();
}

function downcase(text: string): string {
  return text.toLowerCase();
}

/** Each word's first letter upper case and the rest lower, judged over the whole range. */
function capitalized(text: string): string {
  return text
    .toLowerCase()
    .replace(
      /(^|[^\p{L}\p{N}'])(\p{L})/gu,
      (_match, before: string, letter: string) => before + letter.toUpperCase(),
    );
}

/** Alt+U, Alt+L and Alt+C: the case of the text up to the end of the next word. */
function caseWord(transform: (text: string) => string): (view: EditorView) => boolean {
  return (view) => {
    const from = head(view.state);
    const line = from === null ? null : lineAt(view.state.doc, from);
    if (from === null || line === null) return false;
    const to = forwardWord(view.state, from, line);
    if (to === null || to <= from) return fail(view);
    rewriteRange(view, from, to, transform, to);
    return true;
  };
}

/** Ctrl+X Ctrl+U and Ctrl+X Ctrl+L: the case of the region. */
function caseRegion(view: EditorView, transform: (text: string) => string): boolean {
  const range = region(view.state);
  if (range === null) return fail(view, 'The mark is not set now, so there is no region');
  rewriteRange(view, range.from, range.to, transform, head(view.state) ?? range.to);
  return true;
}

function rewriteRange(
  view: EditorView,
  from: number,
  to: number,
  transform: (text: string) => string,
  caret: number,
): void {
  const { doc } = view.state;
  // A rewrite such as capitalising reads the whole range, so a word split by formatting stays whole.
  const whole = doc.textBetween(from, to, '\n', '￼');
  const rewritten = transform(whole);
  const transaction = view.state.tr;
  rewriteText(transaction, from, to, (text, offset) =>
    rewritten.length === whole.length
      ? rewritten.slice(offset, offset + text.length)
      : transform(text),
  );
  transaction.setSelection(TextSelection.create(transaction.doc, transaction.mapping.map(caret)));
  view.dispatch(transaction.setMeta(emacsKeymapKey, { mark: null }).scrollIntoView());
}

/** Ctrl+T: swap the characters around the caret, or the two before it at the end of a block. */
function transposeChars(view: EditorView): boolean {
  const caret = head(view.state);
  const line = caret === null ? null : lineAt(view.state.doc, caret);
  if (caret === null || line === null) return false;
  const offset = caret - line.start;
  if (offset === 0 || line.size < 2) return fail(view);
  const at = offset === line.size ? previousGrapheme(line, offset) : offset;
  const before = previousGrapheme(line, at);
  const after = nextGrapheme(line, at);
  return swap(view, line, [before, at], [at, after], after);
}

/** Alt+T: swap the word at or before the caret with the next one, in this block. */
function transposeWords(view: EditorView): boolean {
  const caret = head(view.state);
  const line = caret === null ? null : lineAt(view.state.doc, caret);
  if (caret === null || line === null) return false;
  const offset = caret - line.start;
  const all = [...words(line)];
  const inside = all.findIndex((word) => word.start < offset && offset < word.end);
  const second = inside === -1 ? all.findIndex((word) => word.start >= offset) : inside + 1;
  const first = all[second - 1];
  const next = all[second];
  if (first === undefined || next === undefined) return fail(view);
  return swap(view, line, [first.start, first.end], [next.start, next.end], next.end);
}

/** Swaps two ranges of a block, `left` before `right`, keeping their formatting. */
function swap(
  view: EditorView,
  line: Line,
  left: readonly [number, number],
  right: readonly [number, number],
  caretOffset: number,
): boolean {
  const { doc } = view.state;
  const leftSlice = doc.slice(line.start + left[0], line.start + left[1]);
  const rightSlice = doc.slice(line.start + right[0], line.start + right[1]);
  const transaction = view.state.tr;
  transaction.replace(line.start + right[0], line.start + right[1], leftSlice);
  transaction.replace(line.start + left[0], line.start + left[1], rightSlice);
  const caret = transaction.mapping.map(line.start + caretOffset);
  transaction.setSelection(TextSelection.create(transaction.doc, caret));
  view.dispatch(transaction.setMeta(emacsKeymapKey, { mark: null }).scrollIntoView());
  return true;
}

/** Alt+\ removes the blanks around the caret; Alt+Space leaves exactly one. */
function blanksAround(keep: string): (view: EditorView) => boolean {
  return (view) => {
    const caret = head(view.state);
    const line = caret === null ? null : lineAt(view.state.doc, caret);
    if (caret === null || line === null) return false;
    const text = lineText(line);
    let start = caret - line.start;
    let end = start;
    while (start > 0 && /[\t ]/.test(text.charAt(start - 1))) start -= 1;
    while (end < text.length && /[\t ]/.test(text.charAt(end))) end += 1;
    const transaction = view.state.tr;
    if (keep === '') transaction.delete(line.start + start, line.start + end);
    else transaction.insertText(keep, line.start + start, line.start + end);
    view.dispatch(transaction.setMeta(emacsKeymapKey, { mark: null }).scrollIntoView());
    return true;
  };
}

/** Alt+^: join this block onto the previous one with one space. */
function joinToPrevious(view: EditorView): boolean {
  const caret = head(view.state);
  const line = caret === null ? null : lineAt(view.state.doc, caret);
  const previous = line === null ? null : adjacentLine(view.state.doc, line, -1);
  if (previous === null) return fail(view);
  const transaction = view.state.tr;
  const at = joinWithNext(transaction, previous);
  if (at === null) return fail(view);
  transaction.setSelection(TextSelection.create(transaction.doc, at));
  view.dispatch(transaction.setMeta(emacsKeymapKey, { mark: null }).scrollIntoView());
  return true;
}

/** Alt+Z then a character: kill up to and including its next occurrence in the block. */
function zapToChar(view: EditorView, char: string, count: number): boolean {
  const caret = head(view.state);
  const line = caret === null ? null : lineAt(view.state.doc, caret);
  if (caret === null || line === null) return false;
  const found = findInLine(line, caret - line.start - 1, 'f', char, count, false);
  if (found === null) return fail(view, `Search failed: "${char}"`);
  return kill(view, caret, line.start + found + char.length);
}

// ---------------------------------------------------------------------------------------------
// Search, query replace and goto-line
// ---------------------------------------------------------------------------------------------

function literal(text: string): RegExp {
  return searchExpression(text, undefined, true);
}

function matchSelection(
  view: EditorView,
  match: { readonly pos: number; readonly end: number },
  forward: boolean,
): TextSelection {
  const { doc } = view.state;
  return forward
    ? TextSelection.create(doc, match.pos, match.end)
    : TextSelection.create(doc, match.end, match.pos);
}

/** Ctrl+S and Ctrl+R: start an incremental search at the caret. */
function startSearch(forward: boolean): (view: EditorView) => boolean {
  return (view) => {
    const caret = head(view.state);
    if (caret === null) return false;
    dispatch(
      view,
      {
        prompt: {
          kind: 'search',
          forward,
          text: '',
          origin: caret,
          failing: false,
          wrapped: false,
        },
        mark: null,
        argument: null,
      },
      TextSelection.create(view.state.doc, caret),
    );
    return true;
  };
}

type SearchPrompt = Extract<Prompt, { kind: 'search' }>;

/** Each key typed into the search finds the first match from where the search started. */
function setSearchText(view: EditorView, prompt: SearchPrompt, text: string): void {
  const { doc } = view.state;
  if (text === '') {
    dispatch(
      view,
      { prompt: { ...prompt, text, failing: false, wrapped: false } },
      TextSelection.create(doc, prompt.origin),
    );
    return;
  }
  const found = searchFrom(doc, prompt.origin, literal(text), prompt.forward, prompt.forward);
  if (found === null) {
    failed = true;
    dispatch(view, { prompt: { ...prompt, text, failing: true } });
    return;
  }
  dispatch(
    view,
    { prompt: { ...prompt, text, failing: false, wrapped: found.wrapped } },
    matchSelection(view, found, prompt.forward),
  );
}

/** Ctrl+S or Ctrl+R inside a search: the next match that way, or the last search when empty. */
function searchAgain(view: EditorView, prompt: SearchPrompt, forward: boolean): void {
  const text = prompt.text === '' ? lastSearchText : prompt.text;
  if (text === '') return;
  const found = searchFrom(view.state.doc, view.state.selection.from, literal(text), forward);
  if (found === null) {
    failed = true;
    dispatch(view, { prompt: { ...prompt, text, forward, failing: true } });
    return;
  }
  dispatch(
    view,
    {
      prompt: {
        ...prompt,
        text,
        forward,
        failing: false,
        wrapped: prompt.wrapped || found.wrapped,
      },
    },
    matchSelection(view, found, forward),
  );
}

/** Enter (or any key the search does not use): stay on the match, with a mark where it began. */
function endSearch(view: EditorView, prompt: SearchPrompt): void {
  if (prompt.text !== '') lastSearchText = prompt.text;
  const caret = view.state.selection.head;
  const moved = caret !== prompt.origin;
  dispatch(
    view,
    {
      prompt: null,
      ...(moved
        ? {
            markRing: withPushedMark(view.state, prompt.origin),
            message: 'Mark saved where search started',
          }
        : {}),
    },
    TextSelection.create(view.state.doc, caret),
  );
}

function cancelPrompt(view: EditorView, prompt: Prompt): void {
  const caret =
    prompt.kind === 'search'
      ? prompt.origin
      : prompt.kind === 'replacing'
        ? prompt.match.from
        : view.state.selection.head;
  dispatch(view, { prompt: null, message: 'Quit' }, TextSelection.create(view.state.doc, caret));
}

/** The next match for query replace, from `from` on; it never wraps past the end of the note. */
function nextReplaceMatch(view: EditorView, from: number, text: string) {
  const found = searchFrom(view.state.doc, from, literal(text), true, true);
  return found === null || found.wrapped ? null : found;
}

function finishReplace(view: EditorView, replaced: number, caret: number): void {
  dispatch(
    view,
    {
      prompt: null,
      message: `Replaced ${String(replaced)} occurrence${replaced === 1 ? '' : 's'}`,
    },
    TextSelection.create(view.state.doc, caret),
  );
}

function showReplaceMatch(
  view: EditorView,
  from: string,
  to: string,
  after: number,
  replaced: number,
): void {
  const found = nextReplaceMatch(view, after, from);
  if (found === null) {
    finishReplace(view, replaced, after);
    return;
  }
  dispatch(
    view,
    {
      prompt: { kind: 'replacing', from, to, match: { from: found.pos, to: found.end }, replaced },
    },
    TextSelection.create(view.state.doc, found.pos, found.end),
  );
}

type ReplacingPrompt = Extract<Prompt, { kind: 'replacing' }>;

/** Replaces the current match and returns where the search continues. */
function replaceMatch(view: EditorView, prompt: ReplacingPrompt): number {
  const transaction = view.state.tr;
  const { from, to } = prompt.match;
  if (prompt.to === '') transaction.delete(from, to);
  else transaction.insertText(prompt.to, from, to);
  view.dispatch(transaction.setMeta(emacsKeymapKey, { prompt }));
  return from + prompt.to.length;
}

/** y or Space replaces, n or Delete skips, ! replaces the rest, . replaces and stops, q stops. */
function replacingKey(view: EditorView, event: KeyboardEvent, prompt: ReplacingPrompt): boolean {
  const ctrlG = event.ctrlKey && event.key === 'g';
  if (ctrlG || event.key === 'Escape' || event.key === 'Enter' || event.key === 'q') {
    finishReplace(view, prompt.replaced, prompt.match.from);
    return true;
  }
  switch (event.key) {
    case 'y':
    case ' ': {
      const after = replaceMatch(view, prompt);
      showReplaceMatch(view, prompt.from, prompt.to, after, prompt.replaced + 1);
      return true;
    }
    case 'n':
    case 'Delete':
    case 'Backspace':
      showReplaceMatch(view, prompt.from, prompt.to, prompt.match.to, prompt.replaced);
      return true;
    case '.': {
      const after = replaceMatch(view, prompt);
      finishReplace(view, prompt.replaced + 1, after);
      return true;
    }
    case '!': {
      let replaced = prompt.replaced;
      let next: ReplacingPrompt | null = prompt;
      let after = prompt.match.from;
      while (next !== null) {
        after = replaceMatch(view, next);
        replaced += 1;
        const found = nextReplaceMatch(view, after, prompt.from);
        next =
          found === null
            ? null
            : { ...prompt, match: { from: found.pos, to: found.end }, replaced };
      }
      finishReplace(view, replaced, after);
      return true;
    }
    default:
      // Any other key ends query replace and then does what it does, as in Emacs.
      finishReplace(view, prompt.replaced, prompt.match.from);
      return false;
  }
}

function submitPrompt(
  view: EditorView,
  prompt: Exclude<Prompt, SearchPrompt | ReplacingPrompt>,
): void {
  const caret = head(view.state) ?? view.state.selection.from;
  switch (prompt.kind) {
    case 'replace-from':
      if (prompt.text === '') {
        dispatch(view, { prompt: null });
        return;
      }
      dispatch(view, { prompt: { kind: 'replace-to', from: prompt.text, text: '' } });
      return;
    case 'replace-to':
      showReplaceMatch(view, prompt.from, prompt.text, caret, 0);
      return;
    case 'goto': {
      const line = /^\d+$/.test(prompt.text) ? nthLine(view.state.doc, Number(prompt.text)) : null;
      if (line === null) {
        dispatch(view, { prompt: null });
        fail(view, 'Not a line number');
        return;
      }
      dispatch(
        view,
        { prompt: null, markRing: withPushedMark(view.state, caret) },
        TextSelection.create(view.state.doc, line.start),
      );
      return;
    }
  }
}

function promptKey(view: EditorView, event: KeyboardEvent, prompt: Prompt, name: string): boolean {
  if (prompt.kind === 'replacing') return replacingKey(view, event, prompt);
  const ctrl = event.ctrlKey && !event.altKey && !event.metaKey;
  if ((ctrl && name === 'g') || event.key === 'Escape') {
    cancelPrompt(view, prompt);
    return true;
  }
  const typed = !hasModifier(event) && event.key.length === 1;
  if (prompt.kind === 'search') {
    if (ctrl && (name === 's' || name === 'r')) {
      searchAgain(view, prompt, name === 's');
      return true;
    }
    if (event.key === 'Backspace') {
      setSearchText(view, prompt, prompt.text.slice(0, -1));
      return true;
    }
    if (typed) {
      setSearchText(view, prompt, prompt.text + event.key);
      return true;
    }
    endSearch(view, prompt);
    return event.key === 'Enter';
  }
  if (event.key === 'Enter') submitPrompt(view, prompt);
  else if (event.key === 'Backspace') {
    dispatch(view, { prompt: { ...prompt, text: prompt.text.slice(0, -1) } });
  } else if (typed) dispatch(view, { prompt: { ...prompt, text: prompt.text + event.key } });
  return true;
}

// ---------------------------------------------------------------------------------------------
// Prefixes, arguments, repeat, registers and macros
// ---------------------------------------------------------------------------------------------

/** A command with a numeric argument; `universal` is whether Ctrl+U or a digit came first. */
type Action = (view: EditorView, count: number, universal: boolean) => boolean;

/** A command that a numeric argument runs that many times. */
function times(command: (view: EditorView) => boolean): Action {
  return (view, count) => {
    for (let step = 0; step < count; step += 1) {
      if (!command(view)) return step > 0;
      if (failed) break;
    }
    return true;
  };
}

function argumentCount(argument: Argument | null): number {
  if (argument === null) return 1;
  return argument.digits === '' ? argument.value : Math.min(MAX_ARGUMENT, Number(argument.digits));
}

/** Takes the pending argument, clearing it, as a command that uses it does. */
function takeArgument(view: EditorView): { readonly count: number; readonly universal: boolean } {
  const { argument } = current(view.state);
  if (argument !== null) dispatch(view, { argument: null }, undefined, true);
  return { count: argumentCount(argument), universal: argument !== null };
}

/** Ctrl+X Z: the last command again, with a new argument when one is given. */
function repeatLast(view: EditorView): boolean {
  const last = lastCommand;
  if (last === null) return fail(view, 'No command to repeat');
  const { count, universal } = takeArgument(view);
  last.action(view, universal ? count : last.count, universal || last.universal);
  dispatch(view, { prefix: 'repeat' }, undefined, true);
  return true;
}

function startMacro(view: EditorView): boolean {
  if (current(view.state).recording) return fail(view, 'Already defining a keyboard macro');
  recorded = [];
  dispatch(view, { recording: true, message: 'Defining keyboard macro...' }, undefined, true);
  return true;
}

/** Ends the definition, dropping the `keys` keystrokes that ended it. */
function endMacro(view: EditorView, keys: number): boolean {
  if (!current(view.state).recording) return fail(view, 'Not defining a keyboard macro');
  macro = recorded.slice(0, Math.max(0, recorded.length - keys));
  recorded = [];
  dispatch(view, { recording: false, message: 'Keyboard macro defined' }, undefined, true);
  return true;
}

function isModal(state: EmacsState): boolean {
  return state.prompt !== null || state.prefix !== null || state.argument !== null;
}

/**
 * Runs the last macro `count` times. Like Emacs, a key that fails (a motion at the end of the
 * note, a search with no match) ends the run.
 */
function runMacro(view: EditorView, count: number): boolean {
  const keys = macro;
  if (keys === null) return fail(view, 'No keyboard macro defined');
  if (current(view.state).recording) return fail(view, 'Cannot run a macro while defining one');
  if (replaying) return fail(view);
  replaying = true;
  failed = false;
  let replayed = 0;
  try {
    for (let step = 0; step < count && !hasFailed(); step += 1) {
      for (const stroke of keys) {
        replayed += 1;
        if (replayed > MAX_REPLAYED_KEYS || hasFailed() || view.isDestroyed) break;
        replayStroke(view, stroke, !isModal(current(view.state)));
      }
    }
  } finally {
    replaying = false;
  }
  return true;
}

function copyToRegister(view: EditorView, name: string): boolean {
  const range = region(view.state);
  if (range === null) return fail(view, 'The mark is not set now, so there is no region');
  textRegisters.set(name, view.state.doc.slice(range.from, range.to));
  const caret = head(view.state) ?? range.to;
  dispatch(
    view,
    { mark: null, message: `Copied to register ${name}` },
    TextSelection.create(view.state.doc, caret),
  );
  return true;
}

/** Ctrl+X R I: the register's text, with the caret left before it as in Emacs. */
function insertRegister(view: EditorView, name: string): boolean {
  const slice = textRegisters.get(name);
  const caret = head(view.state);
  if (slice === undefined || caret === null) return fail(view, `Register ${name} has no text`);
  const transaction = view.state.tr.replace(caret, caret, slice);
  transaction.setSelection(TextSelection.create(transaction.doc, caret));
  view.dispatch(transaction.setMeta(emacsKeymapKey, { mark: null }).scrollIntoView());
  return true;
}

function pointToRegister(view: EditorView, name: string): boolean {
  const caret = head(view.state);
  if (caret === null) return false;
  const points = new Map(current(view.state).points);
  points.set(name, savePosition(view.state, caret));
  dispatch(view, { points, message: `Saved the caret to register ${name}` }, undefined, true);
  return true;
}

function jumpToRegister(view: EditorView, name: string): boolean {
  const saved = current(view.state).points.get(name);
  const target = saved === undefined ? null : restorePosition(view.state, saved);
  const caret = head(view.state);
  if (target === null) return fail(view, `Register ${name} has no position in this note`);
  dispatch(
    view,
    caret === null ? {} : { markRing: withPushedMark(view.state, caret) },
    TextSelection.create(view.state.doc, target),
  );
  return true;
}

/** How Emacs writes a key, for "C-x C-q is undefined". */
function describeKey(event: KeyboardEvent, name: string): string {
  const key = name === ' ' ? 'SPC' : name;
  return `${event.ctrlKey ? 'C-' : ''}${event.altKey || event.metaKey ? 'M-' : ''}${key}`;
}

const REGISTER_PREFIXES: Partial<Record<string, Prefix>> = {
  s: 'C-x r s',
  i: 'C-x r i',
  ' ': 'C-x r SPC',
  j: 'C-x r j',
};

function prefixKey(view: EditorView, event: KeyboardEvent, prefix: Prefix, name: string): boolean {
  const ctrl = event.ctrlKey && !event.altKey && !event.metaKey;
  const plain = !hasModifier(event);
  if (prefix === 'repeat' || prefix === 'macro') {
    const again = prefix === 'repeat' ? 'z' : 'e';
    if (plain && name === again) {
      if (prefix === 'repeat') repeatLast(view);
      else {
        runMacro(view, 1);
        dispatch(view, { prefix: 'macro' }, undefined, true);
      }
      return true;
    }
    // Any other key ends the repeat and then does what it does.
    dispatch(view, { prefix: null }, undefined, true);
    return false;
  }
  dispatch(view, { prefix: null }, undefined, true);
  if (ctrl && name === 'g') {
    dispatch(view, { argument: null, message: 'Quit' }, undefined, true);
    return true;
  }
  const undefinedKey = (): boolean =>
    fail(view, `${prefix} ${describeKey(event, name)} is undefined`);

  if (prefix === 'C-x') {
    if (ctrl) {
      switch (name) {
        case 'x':
          return exchangePointAndMark(view);
        case 's':
          dispatch(view, { message: 'Notes save as you type' }, undefined, true);
          return true;
        case 'u':
          return caseRegion(view, upcase);
        case 'l':
          return caseRegion(view, downcase);
      }
      return undefinedKey();
    }
    if (!plain) return undefinedKey();
    switch (name) {
      case 'h':
        return markWholeNote(view);
      case 'u':
        undo(view.state);
        return true;
      case 'z':
        return repeatLast(view);
      case '(':
        return startMacro(view);
      case ')':
        return endMacro(view, 2);
      case 'e': {
        const { count } = takeArgument(view);
        runMacro(view, count);
        dispatch(view, { prefix: 'macro' }, undefined, true);
        return true;
      }
      case 'r':
        dispatch(view, { prefix: 'C-x r' }, undefined, true);
        return true;
    }
    return undefinedKey();
  }
  if (prefix === 'C-x r') {
    const next = plain ? REGISTER_PREFIXES[name] : undefined;
    if (next === undefined) return undefinedKey();
    dispatch(view, { prefix: next }, undefined, true);
    return true;
  }
  if (prefix === 'M-g') {
    if (name !== 'g' || event.ctrlKey) return undefinedKey();
    takeArgument(view);
    dispatch(view, { prompt: { kind: 'goto', text: '' } }, undefined, true);
    return true;
  }
  // A register name or a character to zap to: one plain key.
  if (event.ctrlKey || event.metaKey || name.length !== 1) return undefinedKey();
  switch (prefix) {
    case 'M-z':
      return zapToChar(view, name, takeArgument(view).count);
    case 'C-x r s':
      return copyToRegister(view, name);
    case 'C-x r i':
      return insertRegister(view, name);
    case 'C-x r SPC':
      return pointToRegister(view, name);
    case 'C-x r j':
      return jumpToRegister(view, name);
  }
  return undefinedKey();
}

/** Digits and Ctrl+U extend the argument; a typed character is inserted that many times. */
function argumentKey(
  view: EditorView,
  event: KeyboardEvent,
  argument: Argument,
  name: string,
): boolean {
  if (event.ctrlKey && !event.altKey && !event.metaKey && name === 'u' && argument.digits === '') {
    dispatch(
      view,
      { argument: { ...argument, value: Math.min(MAX_ARGUMENT, argument.value * 4) } },
      undefined,
      true,
    );
    return true;
  }
  if (/^\d$/.test(name) && !event.ctrlKey && !event.metaKey) {
    dispatch(view, { argument: { ...argument, digits: argument.digits + name } }, undefined, true);
    return true;
  }
  if (!hasModifier(event) && event.key.length === 1) {
    const { count } = takeArgument(view);
    view.dispatch(view.state.tr.insertText(event.key.repeat(count)).scrollIntoView());
    return true;
  }
  // Anything else is a command, which takes the argument.
  return false;
}

/** The key as Emacs names it. macOS turns Option+key into a symbol, so Alt reads the physical key. */
function keyName(event: KeyboardEvent): string {
  if (event.altKey) {
    const letter = /^Key([A-Z])$/.exec(event.code)?.[1];
    if (letter !== undefined) return event.shiftKey ? letter : letter.toLowerCase();
    const digit = /^Digit(\d)$/.exec(event.code)?.[1];
    if (digit !== undefined && !event.shiftKey) return digit;
  }
  return event.key;
}

/** Keys taken before any keymap: inside a prefix, an argument or the minibuffer, and Alt+digits. */
function modalKey(view: EditorView, event: KeyboardEvent): boolean {
  const state = current(view.state);
  const name = keyName(event);
  if (state.prompt !== null) return promptKey(view, event, state.prompt, name);
  if (state.prefix !== null) return prefixKey(view, event, state.prefix, name);
  if (state.argument !== null) return argumentKey(view, event, state.argument, name);
  if (event.altKey && !event.ctrlKey && !event.metaKey && /^\d$/.test(name)) {
    dispatch(view, { argument: { value: 1, digits: name } }, undefined, true);
    return true;
  }
  return false;
}

function inTextControl(event: Event): boolean {
  const target = event.target;
  return (
    !(target instanceof Element) ||
    target.closest('button, input, textarea, select, [contenteditable="false"]') === null
  );
}

function mapPrompt(prompt: Prompt | null, mapping: Mapping): Prompt | null {
  if (prompt?.kind === 'search') return { ...prompt, origin: mapping.map(prompt.origin) };
  if (prompt?.kind === 'replacing') {
    return {
      ...prompt,
      match: { from: mapping.map(prompt.match.from, -1), to: mapping.map(prompt.match.to) },
    };
  }
  return prompt;
}

function emacsPlugin(): Plugin<EmacsState> {
  return new Plugin<EmacsState>({
    key: emacsKeymapKey,
    state: {
      init: () => INITIAL,
      apply(transaction, value) {
        const { mapping } = transaction;
        const mapped: EmacsState = transaction.docChanged
          ? {
              ...value,
              mark: value.mark === null ? null : mapping.map(value.mark),
              yank:
                value.yank === null
                  ? null
                  : {
                      from: mapping.map(value.yank.from, -1),
                      to: mapping.map(value.yank.to),
                      index: value.yank.index,
                    },
              prompt: mapPrompt(value.prompt, mapping),
              markRing: value.markRing.map((saved) => mapSaved(saved, mapping)),
              points: new Map(
                Array.from(value.points, ([name, saved]) => [name, mapSaved(saved, mapping)]),
              ),
            }
          : value;
        const meta: unknown = transaction.getMeta(emacsKeymapKey);
        if (typeof meta === 'object' && meta !== null) {
          const update = meta as EmacsMeta;
          return {
            ...mapped,
            ...update,
            lastKill: update.lastKill ?? false,
            yank: update.yank ?? null,
          };
        }
        // A colleague's edit moves nothing of this person's.
        if (transaction.getMeta(ySyncPluginKey) !== undefined) return mapped;
        // Typing, a click or any other command ends the region, the kill/yank sequence, a half-typed
        // prefix and the minibuffer.
        if (transaction.docChanged || transaction.selectionSet) {
          return {
            ...mapped,
            mark: null,
            lastKill: false,
            yank: null,
            prefix: null,
            argument: null,
            prompt: null,
          };
        }
        return mapped;
      },
    },
    props: {
      handleDOMEvents: {
        keydown(view, event) {
          if (
            useKeyboardModeStore.getState().mode !== 'emacs' ||
            !view.editable ||
            event.isComposing ||
            view.composing ||
            MODIFIER_KEYS.has(event.key) ||
            !inTextControl(event)
          ) {
            return false;
          }
          const state = current(view.state);
          if (state.recording && !replaying) recorded.push(strokeOf(event));
          if (state.message !== '') dispatch(view, { message: '' }, undefined, true);
          if (!modalKey(view, event)) return false;
          event.preventDefault();
          return true;
        },
        blur(view) {
          const state = current(view.state);
          if (state.prompt?.kind === 'search') endSearch(view, state.prompt);
          else if (isModal(state)) {
            dispatch(view, { prefix: null, argument: null, prompt: null }, undefined, true);
          }
          return false;
        },
      },
    },
  });
}

export interface EmacsStatus {
  /** What is being typed: a prefix, an argument, or a minibuffer prompt and its text. */
  readonly keys: string;
  readonly message: string;
  readonly recording: boolean;
}

const PREFIX_PROMPTS: Readonly<Record<Prefix, string>> = {
  'C-x': 'C-x-',
  'C-x r': 'C-x r-',
  'C-x r s': 'Copy to register: ',
  'C-x r i': 'Insert register: ',
  'C-x r SPC': 'Point to register: ',
  'C-x r j': 'Jump to register: ',
  'M-g': 'M-g-',
  'M-z': 'Zap to char: ',
  repeat: '',
  macro: '',
};

function promptLine(prompt: Prompt): string {
  switch (prompt.kind) {
    case 'search':
      return `${prompt.failing ? 'Failing ' : ''}${prompt.wrapped ? 'Wrapped ' : ''}I-search${prompt.forward ? '' : ' backward'}: ${prompt.text}`;
    case 'replace-from':
      return `Query replace: ${prompt.text}`;
    case 'replace-to':
      return `Query replace ${prompt.from} with: ${prompt.text}`;
    case 'replacing':
      return `Query replacing ${prompt.from} with ${prompt.to}: (y, n, !, ., q)`;
    case 'goto':
      return `Goto line: ${prompt.text}`;
  }
}

/** Everything the status line shows while Emacs basics is on. */
export function emacsStatus(state: EditorState): EmacsStatus {
  const emacs = current(state);
  const argument =
    emacs.argument === null
      ? ''
      : `C-u ${emacs.argument.digits === '' ? String(emacs.argument.value) : emacs.argument.digits}-`;
  return {
    keys:
      emacs.prompt !== null
        ? promptLine(emacs.prompt)
        : emacs.prefix !== null
          ? PREFIX_PROMPTS[emacs.prefix]
          : argument,
    message: emacs.message,
    recording: emacs.recording,
  };
}

export const EmacsKeymap = Extension.create({
  name: 'emacsKeymap',
  // Above the platform keymap (Ctrl+A select-all, Ctrl+B bold on Windows and Linux) and the
  // collaborative history keys, so a chord this preset owns always means its Emacs meaning.
  priority: 1100,

  addProseMirrorPlugins() {
    return [emacsPlugin()];
  },

  addKeyboardShortcuts() {
    const active = (): boolean => useKeyboardModeStore.getState().mode === 'emacs';
    /** A command that takes the numeric argument and that Ctrl+X Z can repeat. */
    const run =
      (action: Action, repeatable = true) =>
      (): boolean => {
        if (!active()) return false;
        const view = this.editor.view;
        if (!replaying) failed = false;
        const { count, universal } = takeArgument(view);
        const done = action(view, count, universal);
        if (done && repeatable) lastCommand = { action, count, universal };
        return done;
      };
    const bind = (command: (view: EditorView) => boolean) => run(times(command));
    /** A key that starts a prefix or a prompt, leaving any argument for the command it leads to. */
    const start = (command: (view: EditorView) => boolean) => (): boolean =>
      active() && command(this.editor.view);
    const prefix = (value: Prefix) =>
      start((view) => {
        dispatch(view, { prefix: value }, undefined, true);
        return true;
      });
    const undoLocal = (view: EditorView): boolean => {
      undo(view.state);
      return true;
    };
    const redoLocal = (view: EditorView): boolean => {
      redo(view.state);
      return true;
    };
    const universalArgument = start((view) => {
      dispatch(view, { argument: { value: 4, digits: '' } }, undefined, true);
      return true;
    });
    const queryReplace = start((view) => {
      dispatch(
        view,
        { prompt: { kind: 'replace-from', text: '' }, argument: null },
        undefined,
        true,
      );
      return true;
    });
    const openLine = (view: EditorView): boolean => {
      const caret = head(view.state);
      if (caret === null) return false;
      // The editor's own Enter, so a list gains an item and a code block a line break.
      this.editor.commands.keyboardShortcut('Enter');
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, Math.min(caret, view.state.doc.content.size)),
        ),
      );
      return true;
    };
    const macroKey = start((view) =>
      current(view.state).recording ? endMacro(view, 1) : runMacro(view, takeArgument(view).count),
    );

    return {
      'Ctrl-f': bind(motion(forwardChar)),
      'Ctrl-b': bind(motion(backwardChar)),
      'Alt-f': bind(motion(forwardWord)),
      'Alt-b': bind(motion(backwardWord)),
      'Ctrl-a': bind(motion(lineStart)),
      'Ctrl-e': bind(motion(lineEnd)),
      'Alt-m': bind(motion(indentation)),
      'Ctrl-n': bind(lineMove(1)),
      'Ctrl-p': bind(lineMove(-1)),
      'Alt-}': bind(motion(paragraphMotion(1))),
      'Alt-{': bind(motion(paragraphMotion(-1))),
      'Alt-Shift-]': bind(motion(paragraphMotion(1))),
      'Alt-Shift-[': bind(motion(paragraphMotion(-1))),
      'Alt-<': bind(motion(documentStart, true)),
      'Alt->': bind(motion(documentEnd, true)),
      // macOS reports Option+Shift+, as a symbol; ProseMirror matches it by the physical key.
      'Alt-Shift-,': bind(motion(documentStart, true)),
      'Alt-Shift-.': bind(motion(documentEnd, true)),
      'Ctrl-d': bind(deleteChar),
      'Ctrl-k': bind(killLine),
      'Alt-d': bind(killWord),
      'Alt-Backspace': bind(backwardKillWord),
      'Ctrl-w': bind(killRegion),
      'Alt-w': bind(copyRegion),
      'Ctrl-y': bind(yank),
      'Alt-y': bind(yankPop),
      'Alt-u': bind(caseWord(upcase)),
      'Alt-l': bind(caseWord(downcase)),
      'Alt-c': bind(caseWord(capitalized)),
      'Ctrl-t': bind(transposeChars),
      'Alt-t': bind(transposeWords),
      'Alt-\\': bind(blanksAround('')),
      'Alt-Space': bind(blanksAround(' ')),
      'Ctrl-o': bind(openLine),
      'Alt-^': bind(joinToPrevious),
      'Alt-Shift-6': bind(joinToPrevious),
      'Ctrl-Space': run((view, _count, universal) => (universal ? popMark(view) : setMark(view))),
      'Ctrl-g': bind(keyboardQuit),
      'Ctrl-/': bind(undoLocal),
      'Ctrl-_': bind(undoLocal),
      'Ctrl-?': bind(redoLocal),
      'Ctrl-u': universalArgument,
      'Ctrl-x': prefix('C-x'),
      'Alt-g': prefix('M-g'),
      'Alt-z': prefix('M-z'),
      'Ctrl-s': start(startSearch(true)),
      'Ctrl-r': start(startSearch(false)),
      'Alt-%': queryReplace,
      'Alt-Shift-5': queryReplace,
      F3: start(startMacro),
      F4: macroKey,
    };
  },
});
