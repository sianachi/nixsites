import { Extension, type Editor } from '@tiptap/core';
import { GapCursor } from '@tiptap/pm/gapcursor';
import { Fragment, Slice, type Node as ProseMirrorNode, type Schema } from '@tiptap/pm/model';
import {
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { redo, undo, ySyncPluginKey } from 'y-prosemirror';

import {
  hasModifier,
  isChangeOrigin,
  joinWithNext,
  mapSaved,
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
  firstNonBlank,
  lastCharacter,
  lineAt,
  lineText,
  nextGrapheme,
  nextWordStart,
  previousGrapheme,
  previousWordStart,
  words,
  findInLine,
  nthLine,
  paragraphTarget,
  searchExpression,
  searchFrom,
  type FindKey,
  type Line,
} from './text-motions';
import { isTextObject, textObjectRange, type Range, type TextObject } from './vim-objects';

/**
 * Vim basics: a bounded modal preset over a rich, collaborative document.
 *
 * **The cursor sits on a character.** In Normal and Visual mode the caret position `p` means "the
 * character that starts at `p`", drawn as a block. So it never rests after a block's last
 * character, `e` and `$` land on the last character of a word or block, `a` appends after the
 * character under the cursor, and Escape from Insert steps back one character - each as in Vim.
 *
 * **Lines are text blocks.** `j`/`k` move between paragraphs, headings, list items and code
 * blocks, keeping the column; `w`/`b`/`e` continue into the next or previous block; `dd`, `yy`,
 * `cc` and Visual Line take whole blocks; `{`/`}` and `ip` treat empty blocks as blank lines.
 * Arrow keys keep their native, visual-line behaviour.
 *
 * **Commands** follow Vim's grammar: `[count]["x][count] operator [count] motion`, a doubled
 * operator for a whole line, an operator and a text object, or a single action. Typed keys
 * accumulate in `pending` until they form one. `:`, `/` and `?` open a command line, typed into
 * the status line, that Enter runs.
 *
 * **Registers** are shared by every editor on the page, like Vim's. Each holds a ProseMirror
 * slice, so a yanked heading, link or mention pastes back as itself. `"+` and `"*` are the system
 * clipboard, as plain text. Macros (`q`, `@`) are kept apart from the registers.
 *
 * **Undo** is the collaborative, client-local history the toolbar and Mod+Z use, so `u` never
 * undoes a colleague's edit. Mode changes and cursor moves are kept out of it.
 *
 * What is deliberately absent - uppercase (file) marks, appending to a register, Visual Block, `p`
 * over a Visual selection, `*`/`#`, search highlighting and most `:` commands - is disclosed in
 * Settings, next to the keys that are here.
 */

export type VimMode = 'normal' | 'insert' | 'visual' | 'visual-line';

interface VimMotionState {
  readonly enabled: boolean;
  readonly mode: VimMode;
  /** Keys typed toward a command that is not complete yet: a count, an operator, a `g`. */
  readonly pending: string;
  /** Visual mode's fixed end and moving cursor, mapped through every edit. */
  readonly anchor: number | null;
  readonly head: number | null;
  /** The `:`, `/` or `?` line being typed, with its first character; null when none is open. */
  readonly commandLine: string | null;
  /** One line of feedback for the status line, cleared by the next key. */
  readonly message: string;
  /** The register a macro is being recorded into. */
  readonly recording: string | null;
  /** Where the current Insert began, so `.` can repeat the text typed there. */
  readonly insertStart: number | null;
  readonly marks: ReadonlyMap<string, SavedPosition>;
}

type VimMotionMeta = Partial<VimMotionState>;

interface VimMotionsOptions {
  readonly isApplePlatform: boolean;
}

export const vimMotionsKey = new PluginKey<VimMotionState>('nixVimMotions');

const navigatorPlatform: unknown = Reflect.get(navigator, 'platform');
const defaultIsApplePlatform =
  typeof navigatorPlatform === 'string' && /Mac|iP(hone|[oa]d)/.test(navigatorPlatform);

/** Larger counts are almost always a slip, and each step is a real document walk. */
const MAX_COUNT = 9999;
/** A macro that runs itself, directly or through another, stops here rather than never. */
const MAX_REPLAY_DEPTH = 10;
/** The most keys one top-level `@` replays, so `9999@a` cannot freeze the page. */
const MAX_REPLAYED_KEYS = 50_000;

const INITIAL: VimMotionState = {
  enabled: false,
  mode: 'insert',
  pending: '',
  anchor: null,
  head: null,
  commandLine: null,
  message: '',
  recording: null,
  insertStart: null,
  marks: new Map(),
};

interface Saved {
  readonly slice: Slice;
  readonly linewise: boolean;
}

const registers = new Map<string, Saved>();
const macros = new Map<string, readonly KeyStroke[]>();
let recorded: KeyStroke[] = [];
let lastMacro: string | null = null;
let replayDepth = 0;
let replayedKeys = 0;
let lastFind: { readonly key: FindKey; readonly char: string } | null = null;
let lastSearch: { readonly pattern: string; readonly forward: boolean } | null = null;
let lastChange: { readonly command: Command; readonly insertion: Slice | null } | null = null;
/** Set when a command cannot do what it was asked, which ends a running macro as in Vim. */
let failed = false;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function current(state: EditorState): VimMotionState {
  return vimMotionsKey.getState(state) ?? INITIAL;
}

function isVisual(mode: VimMode): boolean {
  return mode === 'visual' || mode === 'visual-line';
}

/** Mode and cursor bookkeeping never belongs in the undo history. */
function dispatch(view: EditorView, meta: VimMotionMeta, selection?: Selection): void {
  let transaction = view.state.tr.setMeta(vimMotionsKey, meta).setMeta('addToHistory', false);
  if (selection !== undefined && !selection.eq(view.state.selection)) {
    transaction = transaction.setSelection(selection).scrollIntoView();
  }
  view.dispatch(transaction);
}

/** A command that could not run: it clears what was typed and ends a running macro. */
function fail(view: EditorView, message = ''): void {
  failed = true;
  dispatch(view, { pending: '', message });
}

function inTextControl(event: Event): boolean {
  const target = event.target;
  if (!(target instanceof Element)) {
    return true;
  }
  return (
    target.closest(
      'button, input, textarea, select, [contenteditable="false"], [role="separator"]',
    ) === null
  );
}

function isLegacyCompositionKey(event: KeyboardEvent): boolean {
  const keyCode: unknown = Reflect.get(event, 'keyCode');
  return keyCode === 229;
}

// ---------------------------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------------------------

/** A text position for the selection's head, finding the nearest text block for a rich selection. */
function textHead(state: EditorState): number | null {
  const { selection } = state;
  if (selection instanceof TextSelection) {
    return selection.head;
  }
  const found =
    Selection.findFrom(selection.$head, 1, true) ?? Selection.findFrom(selection.$head, -1, true);
  return found instanceof TextSelection ? found.head : null;
}

/** Where the Normal-mode block cursor is: the head, kept on a character. */
function normalCursor(state: EditorState): number | null {
  const head = textHead(state);
  if (head === null) return null;
  const line = lineAt(state.doc, head);
  if (line === null) return null;
  return line.start + Math.min(head - line.start, lastCharacter(line));
}

function caretAt(doc: ProseMirrorNode, pos: number): TextSelection {
  return TextSelection.create(doc, pos);
}

/** The caret Insert mode starts from when there is no text caret: a gap cursor at the end. */
function insertFallback(state: EditorState): Selection | null {
  const head = textHead(state);
  if (head !== null) return caretAt(state.doc, head);
  return state.doc.childCount === 0
    ? null
    : new GapCursor(state.doc.resolve(state.doc.content.size));
}

function firstWordOrStart(line: Line): number {
  return line.size === 0 ? 0 : (nextWordStart(line, -1) ?? 0);
}

function lastWordOrStart(line: Line): number {
  return line.size === 0 ? 0 : (previousWordStart(line, line.size + 1) ?? 0);
}

function markPosition(state: EditorState, name: string): number | null {
  const saved = current(state).marks.get(name);
  if (saved === undefined) return null;
  return restorePosition(state, saved);
}

function withMark(
  state: EditorState,
  name: string,
  pos: number,
): ReadonlyMap<string, SavedPosition> {
  const marks = new Map(current(state).marks);
  marks.set(name, savePosition(state, pos));
  return marks;
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

type SimpleMotion =
  | 'h'
  | 'l'
  | 'j'
  | 'k'
  | 'w'
  | 'b'
  | 'e'
  | '0'
  | '^'
  | '$'
  | 'gg'
  | 'G'
  | '{'
  | '}'
  | ';'
  | ','
  | 'n'
  | 'N';
/** `f`, `t`, `F` or `T` and the character to find. */
type FindMotion = `${FindKey}${string}`;
/** `` ` `` or `'` and a mark's name. */
type MarkMotion = `${'`' | "'"}${string}`;
type Motion = SimpleMotion | FindMotion | MarkMotion;
type Operator = 'd' | 'c' | 'y' | '>' | '<';
/** What Visual mode applies to its selection: the operators, plus `~` and `J`. */
type VisualOperator = Operator | '~' | 'J';
type Action = 'i' | 'a' | 'I' | 'A' | 'o' | 'O' | 'p' | 'P' | 'u' | 'v' | 'V' | '~' | 'J';
type Register = string | null;

type Command =
  | { readonly kind: 'motion'; readonly motion: Motion; readonly count: number | null }
  | {
      readonly kind: 'operator';
      readonly operator: Operator;
      readonly motion: Motion;
      readonly count: number | null;
      readonly register: Register;
    }
  | {
      readonly kind: 'object-operator';
      readonly operator: Operator;
      readonly object: TextObject;
      readonly register: Register;
    }
  | {
      readonly kind: 'line-operator';
      readonly operator: Operator;
      readonly count: number;
      readonly register: Register;
    }
  | {
      readonly kind: 'visual-operator';
      readonly operator: VisualOperator;
      readonly count: number;
      readonly register: Register;
    }
  | { readonly kind: 'visual-object'; readonly object: TextObject }
  | {
      readonly kind: 'action';
      readonly action: Action;
      readonly count: number;
      readonly register: Register;
    }
  | { readonly kind: 'replace'; readonly char: string; readonly count: number }
  | { readonly kind: 'mark'; readonly name: string }
  | { readonly kind: 'record'; readonly name: string }
  | { readonly kind: 'replay'; readonly name: string; readonly count: number }
  | { readonly kind: 'repeat'; readonly count: number | null }
  | { readonly kind: 'command-line'; readonly type: ':' | '/' | '?' };

type Parsed = Command | 'incomplete' | 'invalid';

const SIMPLE_MOTIONS = new Set<string>([
  'h',
  'l',
  'j',
  'k',
  'w',
  'b',
  'e',
  '0',
  '^',
  '$',
  'G',
  '{',
  '}',
  ';',
  ',',
  'n',
  'N',
]);
/** Motions that are jumps: each leaves the previous-context mark (`` ` `` and `'`) behind. */
const JUMPS = new Set<string>(['gg', 'G', '{', '}', 'n', 'N']);
const OPERATORS = new Set<string>(['d', 'c', 'y', '>', '<']);
const ACTIONS = new Set<string>(['i', 'a', 'I', 'A', 'o', 'O', 'p', 'P', 'u', 'v', 'V', '~', 'J']);
/** Shorthands Vim defines in terms of an operator and a motion. */
const SHORTHANDS: Readonly<Record<string, readonly [Operator, Motion]>> = {
  x: ['d', 'l'],
  X: ['d', 'h'],
  D: ['d', '$'],
  C: ['c', '$'],
  s: ['c', 'l'],
};
/** Shorthands for an operator on whole lines. */
const LINE_SHORTHANDS: Readonly<Record<string, Operator>> = { S: 'c', Y: 'y' };
const REGISTER_NAME = /^[a-z0-9"_+*]$/;
const MARK_NAME = /^[a-z]$/;

function multiply(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return Math.min(MAX_COUNT, (a ?? 1) * (b ?? 1));
}

/** Reads Vim's command grammar from the keys typed so far. */
function parse(keys: string, visual: boolean): Parsed {
  let i = 0;
  const readCount = (): number | null => {
    let digits = '';
    while (i < keys.length) {
      const char = keys.charAt(i);
      if (!/[0-9]/.test(char) || (digits === '' && char === '0')) break;
      digits += char;
      i += 1;
    }
    return digits === '' ? null : Math.min(MAX_COUNT, Number(digits));
  };
  const readMotion = (): Motion | 'incomplete' | 'invalid' => {
    const char = keys.charAt(i);
    const left = keys.length - i;
    if (char === 'g') {
      if (left < 2) return 'incomplete';
      return keys.charAt(i + 1) === 'g' && left === 2 ? 'gg' : 'invalid';
    }
    if (char !== '' && "fFtT`'".includes(char)) {
      if (left < 2) return 'incomplete';
      if (left > 2) return 'invalid';
      const argument = keys.charAt(i + 1);
      if (char !== '`' && char !== "'") return `${char as FindKey}${argument}`;
      // `` `` `` and `''` both name the previous-context mark.
      if (argument === '`' || argument === "'") return `${char}\``;
      return MARK_NAME.test(argument) ? `${char}${argument}` : 'invalid';
    }
    return SIMPLE_MOTIONS.has(char) && left === 1 ? (char as Motion) : 'invalid';
  };
  const readObject = (): TextObject | 'incomplete' | 'invalid' => {
    if (i + 1 >= keys.length) return 'incomplete';
    const object = keys.slice(i, i + 2);
    return i + 2 === keys.length && isTextObject(object) ? object : 'invalid';
  };
  const isSearch = (): boolean => {
    const char = keys.charAt(i);
    return (char === '/' || char === '?') && i + 1 === keys.length;
  };

  const before = readCount();
  if (i >= keys.length) return 'incomplete';
  let register: Register = null;
  let count = before;
  if (keys.charAt(i) === '"') {
    if (i + 1 >= keys.length) return 'incomplete';
    register = keys.charAt(i + 1);
    if (!REGISTER_NAME.test(register)) return 'invalid';
    i += 2;
    count = multiply(before, readCount());
    if (i >= keys.length) return 'incomplete';
  }
  const char = keys.charAt(i);
  const last = i + 1 === keys.length;

  if (isSearch()) return { kind: 'command-line', type: char as '/' | '?' };

  if (visual) {
    if (last) {
      if (char === ':') return { kind: 'command-line', type: ':' };
      const operator = char === 'x' ? 'd' : char === 's' ? 'c' : char;
      if (OPERATORS.has(operator) || operator === '~' || operator === 'J') {
        return {
          kind: 'visual-operator',
          operator: operator as VisualOperator,
          count: count ?? 1,
          register,
        };
      }
      if (char === 'v' || char === 'V' || char === 'o') {
        return { kind: 'action', action: char, count: 1, register };
      }
    }
    if (char === 'i' || char === 'a') {
      const object = readObject();
      return object === 'incomplete' || object === 'invalid'
        ? object
        : { kind: 'visual-object', object };
    }
    const motion = readMotion();
    return motion === 'incomplete' || motion === 'invalid'
      ? motion
      : { kind: 'motion', motion, count };
  }

  if (last && char === '.') return { kind: 'repeat', count };
  if (last && char === ':' && register === null) return { kind: 'command-line', type: ':' };

  if (char === 'r' || char === 'm' || char === 'q' || char === '@') {
    if (last) return 'incomplete';
    if (i + 2 !== keys.length) return 'invalid';
    const argument = keys.charAt(i + 1);
    if (char === 'r') return { kind: 'replace', char: argument, count: count ?? 1 };
    if (char === '@') {
      return /^[a-z@]$/.test(argument)
        ? { kind: 'replay', name: argument, count: count ?? 1 }
        : 'invalid';
    }
    if (!MARK_NAME.test(argument)) return 'invalid';
    return char === 'm' ? { kind: 'mark', name: argument } : { kind: 'record', name: argument };
  }

  const shorthand = SHORTHANDS[char];
  if (shorthand !== undefined) {
    return last
      ? { kind: 'operator', operator: shorthand[0], motion: shorthand[1], count, register }
      : 'invalid';
  }
  const lineShorthand = LINE_SHORTHANDS[char];
  if (lineShorthand !== undefined) {
    return last
      ? { kind: 'line-operator', operator: lineShorthand, count: count ?? 1, register }
      : 'invalid';
  }

  if (OPERATORS.has(char)) {
    const operator = char as Operator;
    i += 1;
    const inner = readCount();
    if (i >= keys.length) return 'incomplete';
    const next = keys.charAt(i);
    const total = multiply(count, inner);
    if (next === char) {
      return i + 1 === keys.length
        ? { kind: 'line-operator', operator, count: total ?? 1, register }
        : 'invalid';
    }
    if (next === 'i' || next === 'a') {
      const object = readObject();
      return object === 'incomplete' || object === 'invalid'
        ? object
        : { kind: 'object-operator', operator, object, register };
    }
    if (isSearch()) return { kind: 'command-line', type: next as '/' | '?' };
    const motion = readMotion();
    if (motion === 'incomplete' || motion === 'invalid') return motion;
    return { kind: 'operator', operator, motion, count: total, register };
  }

  if (ACTIONS.has(char)) {
    return last
      ? { kind: 'action', action: char as Action, count: count ?? 1, register }
      : 'invalid';
  }

  const motion = readMotion();
  if (motion === 'incomplete' || motion === 'invalid') return motion;
  return { kind: 'motion', motion, count };
}

interface Target {
  readonly pos: number;
  /** The motion takes whole lines when an operator applies it (`j`, `k`, `gg`, `G`). */
  readonly linewise: boolean;
  /** The character under the target is part of an operator's range (`e`, `$`). */
  readonly inclusive: boolean;
  /** A note for the status line, such as a search that wrapped around. */
  readonly note?: string;
}

function reverseFind(key: FindKey): FindKey {
  const reversed = { f: 'F', F: 'f', t: 'T', T: 't' } as const;
  return reversed[key];
}

/**
 * Where a motion goes from `from`. `forOperator` is Vim's operator-pending mode, where `l` may
 * reach the end of the block and `w` stops at the end of the block rather than crossing it.
 */
function motionTarget(
  state: EditorState,
  from: number,
  motion: Motion,
  count: number | null,
  forOperator: boolean,
): Target | null {
  const { doc } = state;
  const origin = lineAt(doc, from);
  if (origin === null) return null;
  let line: Line = origin;
  let offset = from - line.start;
  const times = count ?? 1;
  const at = (inclusive: boolean, linewise = false): Target => ({
    pos: line.start + offset,
    inclusive,
    linewise,
  });

  switch (motion) {
    case 'h':
      for (let step = 0; step < times && offset > 0; step += 1) {
        offset = previousGrapheme(line, offset);
      }
      return at(false);
    case 'l': {
      const limit = forOperator ? line.size : lastCharacter(line);
      for (let step = 0; step < times && offset < limit; step += 1) {
        offset = Math.min(limit, nextGrapheme(line, offset));
      }
      return at(false);
    }
    case 'j':
    case 'k': {
      const column = offset;
      for (let step = 0; step < times; step += 1) {
        const next = adjacentLine(doc, line, motion === 'j' ? 1 : -1);
        if (next === null) break;
        line = next;
      }
      offset = Math.min(column, lastCharacter(line));
      return at(false, true);
    }
    case 'w':
      for (let step = 0; step < times; step += 1) {
        const next = nextWordStart(line, offset);
        if (next !== null) {
          offset = next;
          continue;
        }
        if (forOperator) {
          offset = line.size;
          break;
        }
        const following = adjacentLine(doc, line, 1);
        if (following === null) {
          offset = lastCharacter(line);
          break;
        }
        line = following;
        offset = firstWordOrStart(line);
      }
      return at(false);
    case 'b':
      for (let step = 0; step < times; step += 1) {
        const previous = previousWordStart(line, offset);
        if (previous !== null) {
          offset = previous;
          continue;
        }
        const preceding = adjacentLine(doc, line, -1);
        if (preceding === null) {
          offset = 0;
          break;
        }
        line = preceding;
        offset = lastWordOrStart(line);
      }
      return at(false);
    case 'e':
      for (let step = 0; step < times; step += 1) {
        let found: number | null = null;
        let search: Line | null = line;
        let after = offset;
        while (search !== null && found === null) {
          for (const word of words(search)) {
            // Cheap rejection first: a word whose last code unit is behind the cursor cannot hold
            // a target, and measuring each one's last grapheme would make `e` linear in graphemes.
            if (word.end - 1 <= after) continue;
            const last = previousGrapheme(search, word.end);
            if (last > after) {
              found = last;
              break;
            }
          }
          if (found === null) {
            search = adjacentLine(doc, search, 1);
            after = -1;
          }
        }
        if (found === null || search === null) break;
        line = search;
        offset = found;
      }
      return at(true);
    case '0':
      offset = 0;
      return at(false);
    case '^':
      offset = firstNonBlank(line);
      return at(false);
    case '$':
      for (let step = 1; step < times; step += 1) {
        const next = adjacentLine(doc, line, 1);
        if (next === null) break;
        line = next;
      }
      offset = lastCharacter(line);
      return at(true);
    case 'gg':
    case 'G': {
      const found = count === null ? edgeLine(doc, motion === 'gg' ? 1 : -1) : nthLine(doc, count);
      if (found === null) return null;
      line = found;
      offset = firstNonBlank(line);
      return at(false, true);
    }
    case '{':
    case '}': {
      const found = paragraphTarget(doc, line, motion === '}' ? 1 : -1, times);
      line = found.line;
      offset = found.offset;
      return at(found.end);
    }
    case ';':
    case ',': {
      if (lastFind === null) return null;
      const key = motion === ';' ? lastFind.key : reverseFind(lastFind.key);
      const found = findInLine(line, offset, key, lastFind.char, times, true);
      if (found === null) return null;
      offset = found;
      return at(key === 'f' || key === 't');
    }
    case 'n':
    case 'N': {
      if (lastSearch === null) return null;
      const forward = motion === 'n' ? lastSearch.forward : !lastSearch.forward;
      const expression = searchExpression(lastSearch.pattern);
      let pos = from;
      let wrapped = false;
      for (let step = 0; step < times; step += 1) {
        const found = searchFrom(doc, pos, expression, forward);
        if (found === null) return null;
        pos = found.pos;
        wrapped ||= found.wrapped;
      }
      const note = !wrapped
        ? undefined
        : forward
          ? 'Search hit the bottom, continuing at the top'
          : 'Search hit the top, continuing at the bottom';
      return { pos, linewise: false, inclusive: false, ...(note === undefined ? {} : { note }) };
    }
    default: {
      const kind = motion.charAt(0);
      if (kind === '`' || kind === "'") {
        const pos = markPosition(state, motion.charAt(1));
        const target = pos === null ? null : lineAt(doc, pos);
        if (pos === null || target === null) return null;
        return kind === '`'
          ? { pos, linewise: false, inclusive: false }
          : { pos: target.start + firstNonBlank(target), linewise: true, inclusive: false };
      }
      const key = kind as FindKey;
      lastFind = { key, char: motion.slice(1) };
      const found = findInLine(line, offset, key, lastFind.char, times, false);
      if (found === null) return null;
      offset = found;
      return at(key === 'f' || key === 't');
    }
  }
}

function isJump(motion: Motion): boolean {
  return JUMPS.has(motion) || motion.startsWith('`') || motion.startsWith("'");
}

/** Why a motion found nowhere to go, for the status line. */
function motionFailure(motion: Motion): string {
  if (motion === 'n' || motion === 'N') {
    return lastSearch === null
      ? 'No previous search pattern'
      : `Pattern not found: ${lastSearch.pattern}`;
  }
  return motion.startsWith('`') || motion.startsWith("'") ? 'Mark not set' : '';
}

/** The end of the character at `pos`, for an inclusive motion or a Visual selection. */
function characterEnd(doc: ProseMirrorNode, pos: number): number {
  const line = lineAt(doc, pos);
  return line === null ? pos : line.start + nextGrapheme(line, pos - line.start);
}

function visualSelection(
  doc: ProseMirrorNode,
  anchor: number,
  head: number,
  linewise: boolean,
): TextSelection {
  if (linewise) {
    const anchorLine = lineAt(doc, anchor);
    const headLine = lineAt(doc, head);
    if (anchorLine !== null && headLine !== null) {
      return head >= anchor
        ? TextSelection.create(doc, anchorLine.start, headLine.start + headLine.size)
        : TextSelection.create(doc, anchorLine.start + anchorLine.size, headLine.start);
    }
  }
  return head >= anchor
    ? TextSelection.create(doc, anchor, characterEnd(doc, head))
    : TextSelection.create(doc, characterEnd(doc, anchor), head);
}

/** The block-level range for whole lines from `first` to `last`, inclusive. */
function lineRange(first: Line, last: Line): { readonly from: number; readonly to: number } {
  return { from: first.start - 1, to: last.start + last.size + 1 };
}

function normalCaretIn(doc: ProseMirrorNode, near: number): TextSelection | null {
  const bounded = Math.max(0, Math.min(doc.content.size, near));
  const found =
    Selection.findFrom(doc.resolve(bounded), 1, true) ??
    Selection.findFrom(doc.resolve(bounded), -1, true);
  if (!(found instanceof TextSelection)) return null;
  const line = lineAt(doc, found.head);
  return line === null ? null : caretAt(doc, line.start + firstNonBlank(line));
}

/** Clamps a caret onto a character, as Normal mode requires after an edit. */
function onCharacter(doc: ProseMirrorNode, pos: number): TextSelection {
  const line = lineAt(doc, pos);
  if (line === null) return caretAt(doc, pos);
  return caretAt(doc, line.start + Math.min(pos - line.start, lastCharacter(line)));
}

function finish(
  view: EditorView,
  transaction: Transaction,
  meta: VimMotionMeta,
  selection: Selection | null,
): void {
  transaction.setMeta(vimMotionsKey, { pending: '', anchor: null, head: null, ...meta });
  if (selection !== null) transaction.setSelection(selection);
  view.dispatch(transaction.scrollIntoView());
}

/** The lines a range touches, first to last in document order. */
function rangeLines(doc: ProseMirrorNode, range: Range): readonly [Line, Line] | null {
  if (range.linewise) {
    return range.first.start <= range.last.start
      ? [range.first, range.last]
      : [range.last, range.first];
  }
  const first = lineAt(doc, range.from);
  const last = lineAt(doc, Math.max(range.from, range.to));
  return first === null || last === null ? null : [first, last];
}

/** How many joins put `first` to `last` on one line; Visual `J` on one line still joins one. */
function joinsBetween(doc: ProseMirrorNode, first: Line, last: Line): number {
  let joins = 0;
  for (
    let line: Line | null = first;
    line !== null && line.start < last.start;
    line = adjacentLine(doc, line, 1)
  ) {
    joins += 1;
  }
  return Math.max(1, joins);
}

// ---------------------------------------------------------------------------------------------
// Registers
// ---------------------------------------------------------------------------------------------

function clipboard(): Clipboard | undefined {
  const value: unknown = Reflect.get(navigator, 'clipboard');
  return typeof value === 'object' && value !== null ? (value as Clipboard) : undefined;
}

function plainText(saved: Saved): string {
  const { content } = saved.slice;
  return content.textBetween(0, content.size, '\n', '') + (saved.linewise ? '\n' : '');
}

/** Deletes and yanks fill the unnamed register too; a yank also fills `"0`; `"_` keeps nothing. */
function storeRegister(name: Register, saved: Saved, yank: boolean): void {
  if (name === '_') return;
  registers.set('"', saved);
  if (name === null || name === '"') {
    if (yank) registers.set('0', saved);
    return;
  }
  if (name === '+' || name === '*') {
    void clipboard()
      ?.writeText(plainText(saved))
      .catch(() => undefined);
    return;
  }
  registers.set(name, saved);
}

/** Clipboard text as a register: one line pastes into the line, more paste as paragraphs. */
function savedFromText(schema: Schema, text: string): Saved | null {
  if (text === '') return null;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length === 1) {
    return { slice: new Slice(Fragment.from(schema.text(text)), 0, 0), linewise: false };
  }
  if (lines.at(-1) === '') lines.pop();
  const paragraphs = lines.map((line) =>
    schema.nodes.paragraph?.create(null, line === '' ? null : schema.text(line)),
  );
  return {
    slice: new Slice(Fragment.fromArray(paragraphs.filter((node) => node !== undefined)), 0, 0),
    linewise: true,
  };
}

/** Applies d, c or y to a range and leaves the editor in the mode Vim would. */
function applyOperator(
  view: EditorView,
  operator: 'd' | 'c' | 'y',
  range: Range,
  register: Register,
): void {
  const { state } = view;
  const { doc } = state;
  const transaction = state.tr;

  if (!range.linewise) {
    const { from, to } = range;
    if (to > from)
      storeRegister(register, { slice: doc.slice(from, to), linewise: false }, operator === 'y');
    if (operator === 'y') {
      finish(
        view,
        transaction.setMeta('addToHistory', false),
        { mode: 'normal' },
        onCharacter(doc, from),
      );
      return;
    }
    transaction.delete(from, to);
    if (operator === 'c') {
      finish(view, transaction, { mode: 'insert' }, caretAt(transaction.doc, from));
      return;
    }
    finish(view, transaction, { mode: 'normal' }, onCharacter(transaction.doc, from));
    return;
  }

  const [first, last] =
    range.first.start <= range.last.start ? [range.first, range.last] : [range.last, range.first];
  const blocks = lineRange(first, last);
  storeRegister(
    register,
    { slice: doc.slice(blocks.from, blocks.to), linewise: true },
    operator === 'y',
  );

  if (operator === 'y') {
    finish(
      view,
      transaction.setMeta('addToHistory', false),
      { mode: 'normal' },
      caretAt(doc, first.start + firstNonBlank(first)),
    );
    return;
  }
  if (operator === 'c') {
    // Joining the lines into the first one keeps its type: changing a heading leaves a heading.
    transaction.delete(first.start, last.start + last.size);
    finish(view, transaction, { mode: 'insert' }, caretAt(transaction.doc, first.start));
    return;
  }
  transaction.deleteRange(blocks.from, blocks.to);
  if (transaction.doc.eq(doc)) {
    // The document's only lines cannot be removed outright; emptying them is the closest edit.
    transaction.delete(first.start, last.start + last.size);
  }
  finish(view, transaction, { mode: 'normal' }, normalCaretIn(transaction.doc, blocks.from));
}

function paste(view: EditorView, after: boolean, count: number, register: Register): void {
  if (register === '+' || register === '*') {
    const board = clipboard();
    if (board === undefined) {
      fail(view, 'The clipboard is not available here');
      return;
    }
    dispatch(view, { pending: '' });
    board.readText().then(
      (text) => {
        // The note may have closed or turned read-only while the clipboard was being read.
        if (!view.isDestroyed && view.editable)
          pasteSaved(view, savedFromText(view.state.schema, text), after, count);
      },
      () => {
        if (!view.isDestroyed) fail(view, 'The clipboard is not available here');
      },
    );
    return;
  }
  pasteSaved(view, registers.get(register ?? '"') ?? null, after, count);
}

function pasteSaved(view: EditorView, saved: Saved | null, after: boolean, count: number): void {
  const cursor = normalCursor(view.state);
  if (saved === null || cursor === null) {
    fail(view);
    return;
  }
  const { doc } = view.state;
  const line = lineAt(doc, cursor);
  if (line === null) return;
  const transaction = view.state.tr;

  if (saved.linewise) {
    const at = after ? line.start + line.size + 1 : line.start - 1;
    for (let step = 0; step < count; step += 1) {
      transaction.replace(at, at, saved.slice);
    }
    finish(view, transaction, { mode: 'normal' }, normalCaretIn(transaction.doc, at));
    return;
  }

  let at = after && line.size > 0 ? characterEnd(doc, cursor) : cursor;
  for (let step = 0; step < count; step += 1) {
    const before = transaction.steps.length;
    transaction.replace(at, at, saved.slice);
    at = transaction.mapping.slice(before).map(at, 1);
  }
  const landed = lineAt(transaction.doc, at);
  const last = landed === null ? at : landed.start + previousGrapheme(landed, at - landed.start);
  finish(view, transaction, { mode: 'normal' }, onCharacter(transaction.doc, last));
}

// ---------------------------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------------------------

function toggleCase(text: string): string {
  return Array.from(text, (char) => {
    const upper = char.toUpperCase();
    return char === upper ? char.toLowerCase() : upper;
  }).join('');
}

/** The end of `count` characters from `cursor`, or null when the block ends first. */
function charactersEnd(line: Line, cursor: number, count: number, partial: boolean): number | null {
  let offset = cursor - line.start;
  for (let step = 0; step < count; step += 1) {
    if (offset >= line.size) return partial && step > 0 ? line.start + offset : null;
    offset = nextGrapheme(line, offset);
  }
  return line.start + offset;
}

function toggleCharacters(view: EditorView, cursor: number, line: Line, count: number): void {
  const end = charactersEnd(line, cursor, count, true);
  if (end === null) {
    fail(view);
    return;
  }
  const transaction = view.state.tr;
  rewriteText(transaction, cursor, end, toggleCase);
  finish(
    view,
    transaction,
    { mode: 'normal' },
    onCharacter(transaction.doc, transaction.mapping.map(end)),
  );
}

/** `r`: each of `count` characters becomes `char`; Vim refuses when the block is too short. */
function replaceCharacters(view: EditorView, char: string, count: number): void {
  const cursor = normalCursor(view.state);
  const line = cursor === null ? null : lineAt(view.state.doc, cursor);
  const end = cursor === null || line === null ? null : charactersEnd(line, cursor, count, false);
  if (cursor === null || end === null) {
    fail(view);
    return;
  }
  const transaction = view.state.tr;
  rewriteText(transaction, cursor, end, (text) =>
    char.repeat(Array.from(graphemeSegmenter.segment(text)).length),
  );
  const mapped = transaction.mapping.map(end);
  finish(view, transaction, { mode: 'normal' }, onCharacter(transaction.doc, mapped - char.length));
}

/** `J`: joins the next `joins` lines onto this one with one space, as Vim does. */
function joinLines(view: EditorView, first: Line, joins: number): void {
  const transaction = view.state.tr;
  let at = first.start;
  let joined = false;
  for (let step = 0; step < joins; step += 1) {
    const line = lineAt(transaction.doc, at);
    const end = line === null ? null : joinWithNext(transaction, line);
    if (end === null) break;
    at = end;
    joined = true;
  }
  if (!joined) {
    fail(view);
    return;
  }
  finish(view, transaction, { mode: 'normal' }, onCharacter(transaction.doc, at));
}

const LIST_ITEMS = new Set(['listItem', 'taskItem']);

/**
 * `>` and `<` on list items: a rich document indents by nesting, so each step sinks or lifts the
 * lines' items. `<` stops at the outermost level rather than turning items into paragraphs.
 */
function indentLines(
  view: EditorView,
  editor: Editor,
  first: Line,
  last: Line,
  deeper: boolean,
  times: number,
): void {
  const $first = view.state.doc.resolve(first.start);
  let name: string | null = null;
  let nesting = 0;
  for (let depth = $first.depth; depth > 0; depth -= 1) {
    const type = $first.node(depth).type.name;
    if (LIST_ITEMS.has(type)) {
      name ??= type;
      nesting += 1;
    }
  }
  if (name === null) {
    fail(view, 'Only list items indent');
    return;
  }
  dispatch(view, { pending: '', mode: 'normal', anchor: null, head: null });
  editor.commands.setTextSelection({ from: first.start, to: last.start + last.size });
  let moved = false;
  for (let step = 0; step < times; step += 1) {
    if (!deeper && nesting - step <= 1) break;
    const done = deeper ? editor.commands.sinkListItem(name) : editor.commands.liftListItem(name);
    if (!done) break;
    moved = true;
  }
  const line = lineAt(view.state.doc, view.state.selection.from);
  dispatch(
    view,
    {},
    line === null ? undefined : caretAt(view.state.doc, line.start + firstNonBlank(line)),
  );
  if (!moved) failed = true;
}

function applyRange(
  view: EditorView,
  editor: Editor,
  operator: VisualOperator,
  range: Range,
  register: Register,
  count: number,
): void {
  if (operator === 'd' || operator === 'c' || operator === 'y') {
    applyOperator(view, operator, range, register);
    return;
  }
  const { doc } = view.state;
  const lines = rangeLines(doc, range);
  if (lines === null) return;
  const [first, last] = lines;
  if (operator === '>' || operator === '<') {
    indentLines(view, editor, first, last, operator === '>', count);
    return;
  }
  if (operator === 'J') {
    joinLines(view, first, joinsBetween(doc, first, last));
    return;
  }
  const from = range.linewise ? first.start : range.from;
  const to = range.linewise ? last.start + last.size : range.to;
  const transaction = view.state.tr;
  rewriteText(transaction, from, to, toggleCase);
  finish(view, transaction, { mode: 'normal' }, onCharacter(transaction.doc, from));
}

/** `o` and `O`: a new line below or above, made by the same Enter the editor already has. */
function openLine(view: EditorView, editor: Editor, below: boolean): void {
  const cursor = normalCursor(view.state);
  const line = cursor === null ? null : lineAt(view.state.doc, cursor);
  if (line === null) {
    dispatch(view, { pending: '' });
    return;
  }
  const code = line.node.type.spec.code === true;
  dispatch(
    view,
    { mode: 'insert', pending: '' },
    caretAt(view.state.doc, below ? line.start + line.size : line.start),
  );
  editor.commands.keyboardShortcut('Enter');
  if (below || code) {
    if (!below) dispatch(view, {}, caretAt(view.state.doc, line.start));
    return;
  }
  // Enter at the start of a block leaves the caret in the original, now second, block.
  const moved = lineAt(view.state.doc, view.state.selection.head);
  const opened = moved === null ? null : adjacentLine(view.state.doc, moved, -1);
  if (opened !== null) dispatch(view, {}, caretAt(view.state.doc, opened.start + opened.size));
}

function enterInsert(view: EditorView, selection: Selection | null): void {
  const safe = selection ?? insertFallback(view.state);
  dispatch(
    view,
    safe === null ? { pending: '' } : { mode: 'insert', pending: '' },
    safe ?? undefined,
  );
}

/** Escape from Insert: Vim steps back onto the last character typed, and `.` keeps the text. */
function leaveInsert(view: EditorView): void {
  const { state } = view;
  const vim = current(state);
  const head = textHead(state);
  if (vim.insertStart !== null && head !== null && head >= vim.insertStart && lastChange !== null) {
    lastChange = { ...lastChange, insertion: state.doc.slice(vim.insertStart, head) };
  }
  const line = head === null ? null : lineAt(state.doc, head);
  const back =
    head === null || line === null
      ? undefined
      : caretAt(state.doc, line.start + previousGrapheme(line, head - line.start));
  dispatch(view, { mode: 'normal', pending: '', insertStart: null }, back);
}

function runAction(
  view: EditorView,
  editor: Editor,
  action: Action,
  count: number,
  register: Register,
): void {
  const { state } = view;
  const vim = current(state);
  const cursor = isVisual(vim.mode) ? vim.head : normalCursor(state);
  const line = cursor === null ? null : lineAt(state.doc, cursor);

  switch (action) {
    case 'i':
      enterInsert(view, cursor === null ? null : caretAt(state.doc, cursor));
      return;
    case 'a':
      enterInsert(
        view,
        cursor === null || line === null
          ? null
          : caretAt(state.doc, line.size === 0 ? cursor : characterEnd(state.doc, cursor)),
      );
      return;
    case 'I':
      enterInsert(
        view,
        line === null ? null : caretAt(state.doc, line.start + firstNonBlank(line)),
      );
      return;
    case 'A':
      enterInsert(view, line === null ? null : caretAt(state.doc, line.start + line.size));
      return;
    case 'o':
    case 'O':
      if (isVisual(vim.mode)) {
        // Visual `o` swaps the selection's ends, so the other one moves.
        if (vim.anchor === null || vim.head === null) return;
        dispatch(
          view,
          { pending: '', anchor: vim.head, head: vim.anchor },
          visualSelection(state.doc, vim.head, vim.anchor, vim.mode === 'visual-line'),
        );
        return;
      }
      openLine(view, editor, action === 'o');
      return;
    case 'p':
    case 'P':
      paste(view, action === 'p', count, register);
      return;
    case 'u':
      dispatch(view, { pending: '' });
      for (let step = 0; step < count; step += 1) {
        if (!undo(view.state)) break;
      }
      settleAfterHistory(view);
      return;
    case '~':
      if (cursor === null || line === null || line.size === 0) {
        fail(view);
        return;
      }
      toggleCharacters(view, cursor, line, count);
      return;
    case 'J':
      if (line === null) return;
      joinLines(view, line, Math.max(1, count - 1));
      return;
    case 'v':
    case 'V': {
      const wanted: VimMode = action === 'v' ? 'visual' : 'visual-line';
      if (vim.mode === wanted && vim.head !== null) {
        dispatch(
          view,
          { mode: 'normal', pending: '', anchor: null, head: null },
          onCharacter(state.doc, vim.head),
        );
        return;
      }
      if (cursor === null) return;
      const anchor = isVisual(vim.mode) && vim.anchor !== null ? vim.anchor : cursor;
      dispatch(
        view,
        { mode: wanted, pending: '', anchor, head: cursor },
        visualSelection(state.doc, anchor, cursor, wanted === 'visual-line'),
      );
      return;
    }
  }
}

/** After undo or redo, Normal mode's cursor goes back onto a character. */
function settleAfterHistory(view: EditorView): void {
  const head = textHead(view.state);
  if (head !== null) dispatch(view, {}, onCharacter(view.state.doc, head));
}

function runCommand(view: EditorView, editor: Editor, command: Command): void {
  const { state } = view;
  const vim = current(state);

  switch (command.kind) {
    case 'action':
      runAction(view, editor, command.action, command.count, command.register);
      return;
    case 'replace':
      replaceCharacters(view, command.char, command.count);
      return;
    case 'mark': {
      const cursor = normalCursor(state);
      if (cursor === null) return;
      dispatch(view, { pending: '', marks: withMark(state, command.name, cursor) });
      return;
    }
    case 'record':
      recorded = [];
      dispatch(view, { pending: '', recording: command.name });
      return;
    case 'replay':
      replayMacro(view, command.name, command.count);
      return;
    case 'repeat':
    case 'command-line':
      return;
    case 'visual-operator': {
      if (vim.anchor === null || vim.head === null) return;
      if (vim.mode === 'visual-line') {
        const first = lineAt(state.doc, vim.anchor);
        const last = lineAt(state.doc, vim.head);
        if (first !== null && last !== null) {
          applyRange(
            view,
            editor,
            command.operator,
            { linewise: true, first, last },
            command.register,
            command.count,
          );
        }
        return;
      }
      const from = Math.min(vim.anchor, vim.head);
      const to = characterEnd(state.doc, Math.max(vim.anchor, vim.head));
      applyRange(
        view,
        editor,
        command.operator,
        { linewise: false, from, to },
        command.register,
        command.count,
      );
      return;
    }
    case 'visual-object': {
      const range = vim.head === null ? null : textObjectRange(state.doc, vim.head, command.object);
      if (range === null || (!range.linewise && range.to <= range.from)) {
        fail(view);
        return;
      }
      if (range.linewise) {
        const anchor = range.first.start;
        const head = range.last.start;
        dispatch(
          view,
          { mode: 'visual-line', pending: '', anchor, head },
          visualSelection(state.doc, anchor, head, true),
        );
        return;
      }
      const end = lineAt(state.doc, range.to);
      const head =
        end === null ? range.to - 1 : end.start + previousGrapheme(end, range.to - end.start);
      dispatch(
        view,
        { mode: 'visual', pending: '', anchor: range.from, head },
        visualSelection(state.doc, range.from, head, false),
      );
      return;
    }
    case 'object-operator': {
      const cursor = normalCursor(state);
      const range = cursor === null ? null : textObjectRange(state.doc, cursor, command.object);
      if (
        range === null ||
        (!range.linewise && range.to <= range.from && command.operator !== 'c')
      ) {
        fail(view);
        return;
      }
      applyRange(view, editor, command.operator, range, command.register, 1);
      return;
    }
    case 'line-operator': {
      const cursor = normalCursor(state);
      const first = cursor === null ? null : lineAt(state.doc, cursor);
      if (cursor === null || first === null) return;
      const below = motionTarget(state, cursor, 'j', command.count - 1, true);
      const last =
        (below === null || command.count <= 1 ? first : lineAt(state.doc, below.pos)) ?? first;
      if (command.operator === '>' || command.operator === '<') {
        // `3>>` shifts three lines once, where Visual `3>` shifts the selection three times.
        indentLines(view, editor, first, last, command.operator === '>', 1);
        return;
      }
      applyOperator(view, command.operator, { linewise: true, first, last }, command.register);
      return;
    }
    case 'motion':
    case 'operator':
      break;
  }

  const visual = isVisual(vim.mode);
  const from = visual ? vim.head : normalCursor(state);
  if (from === null) return;

  if (command.kind === 'motion') {
    const target = motionTarget(state, from, command.motion, command.count, false);
    if (target === null) {
      fail(view, motionFailure(command.motion));
      return;
    }
    // Vim beeps when a motion cannot move, which is also what ends a running macro.
    if (target.pos === from && !['0', '^', '$', 'gg', 'G'].includes(command.motion)) failed = true;
    const meta: VimMotionMeta = {
      pending: '',
      message: target.note ?? '',
      ...(isJump(command.motion) && target.pos !== from
        ? { marks: withMark(state, '`', from) }
        : {}),
    };
    if (visual && vim.anchor !== null) {
      dispatch(
        view,
        { ...meta, head: target.pos },
        visualSelection(state.doc, vim.anchor, target.pos, vim.mode === 'visual-line'),
      );
      return;
    }
    dispatch(view, meta, caretAt(state.doc, target.pos));
    return;
  }

  // `cw` changes to the end of the word, as `ce` would: Vim's long-standing special case.
  const motion = command.operator === 'c' && command.motion === 'w' ? 'e' : command.motion;
  const target = motionTarget(state, from, motion, command.count, true);
  if (target === null) {
    fail(view, motionFailure(motion));
    return;
  }
  if (target.linewise) {
    const first = lineAt(state.doc, from);
    const last = lineAt(state.doc, target.pos);
    if (first !== null && last !== null) {
      applyRange(
        view,
        editor,
        command.operator,
        { linewise: true, first, last },
        command.register,
        1,
      );
    }
    return;
  }
  const start = Math.min(from, target.pos);
  let end = target.inclusive
    ? characterEnd(state.doc, Math.max(from, target.pos))
    : Math.max(from, target.pos);
  // An exclusive motion that ends at the start of a later line stops at the end of the line
  // before it, so `d}` or `d/x` never joins the line it stops on. Starting at or before the first
  // non-blank, it takes whole lines instead (Vim's exclusive-linewise rule).
  const endLine = target.inclusive ? null : lineAt(state.doc, end);
  if (endLine !== null && end === endLine.start && endLine.start > start) {
    const previous = adjacentLine(state.doc, endLine, -1);
    const startLine = lineAt(state.doc, start);
    if (previous !== null && startLine !== null && previous.start >= startLine.start) {
      if (start - startLine.start <= firstNonBlank(startLine)) {
        applyRange(
          view,
          editor,
          command.operator,
          { linewise: true, first: startLine, last: previous },
          command.register,
          1,
        );
        return;
      }
      end = previous.start + previous.size;
    }
  }
  applyRange(
    view,
    editor,
    command.operator,
    { linewise: false, from: start, to: end },
    command.register,
    1,
  );
}

// ---------------------------------------------------------------------------------------------
// Repeat, macros and the command line
// ---------------------------------------------------------------------------------------------

function isChange(command: Command): boolean {
  switch (command.kind) {
    case 'operator':
    case 'object-operator':
    case 'line-operator':
      return command.operator !== 'y';
    case 'action':
      return 'iaIAoOpP~J'.includes(command.action);
    case 'replace':
      return true;
    default:
      return false;
  }
}

function withCount(command: Command, count: number): Command {
  switch (command.kind) {
    case 'operator':
    case 'line-operator':
    case 'action':
    case 'replace':
      return { ...command, count };
    default:
      return command;
  }
}

/** Runs a command, remembering a change for `.` and where its Insert begins. */
function execute(view: EditorView, editor: Editor, command: Command): void {
  if (command.kind === 'repeat') {
    repeatChange(view, editor, command.count);
    return;
  }
  const change = isChange(command) && !isVisual(current(view.state).mode);
  if (change) lastChange = { command, insertion: null };
  runCommand(view, editor, command);
  if (change && current(view.state).mode === 'insert') {
    dispatch(view, { insertStart: textHead(view.state) });
  }
}

/** `.`: the last change again, with the text its Insert typed; a count replaces the original one. */
function repeatChange(view: EditorView, editor: Editor, count: number | null): void {
  const change = lastChange;
  if (change === null) {
    fail(view);
    return;
  }
  const command = count === null ? change.command : withCount(change.command, count);
  lastChange = { command, insertion: change.insertion };
  runCommand(view, editor, command);
  if (current(view.state).mode !== 'insert') return;
  if (change.insertion !== null && change.insertion.size > 0) {
    view.dispatch(view.state.tr.replaceSelection(change.insertion).scrollIntoView());
  }
  leaveInsert(view);
}

/**
 * `@a` replays the keys recorded into `a`, `count` times; `@@` the macro run last. Like Vim, a
 * key that fails (a motion with nowhere to go, a search with no match) ends the replay.
 */
function replayMacro(view: EditorView, name: string, count: number): void {
  const register = name === '@' ? lastMacro : name;
  const strokes = register === null ? undefined : macros.get(register);
  if (strokes === undefined || replayDepth >= MAX_REPLAY_DEPTH) {
    fail(view);
    return;
  }
  lastMacro = register;
  dispatch(view, { pending: '' });
  if (replayDepth === 0) {
    failed = false;
    replayedKeys = 0;
  }
  replayDepth += 1;
  try {
    for (let step = 0; step < count && !failed; step += 1) {
      for (const stroke of strokes) {
        replayedKeys += 1;
        if (replayedKeys > MAX_REPLAYED_KEYS) failed = true;
        if (failed || view.isDestroyed) break;
        replayStroke(view, stroke, current(view.state).mode === 'insert');
      }
    }
  } finally {
    replayDepth -= 1;
  }
}

function documentLines(doc: ProseMirrorNode): Line[] {
  const lines: Line[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    lines.push({ node, start: pos + 1, size: node.content.size });
    return false;
  });
  return lines;
}

/** Splits `s/pattern/replacement/flags` on its delimiter; `\` escapes the delimiter. */
function parseSubstitute(
  body: string,
): { readonly pattern: string; readonly replacement: string; readonly flags: string } | null {
  const rest = body.startsWith('substitute') ? body.slice(10) : body.slice(1);
  const delimiter = rest.charAt(0);
  if (!body.startsWith('s') || delimiter === '' || /[\w\s\\"|]/.test(delimiter)) return null;
  const parts: string[] = [];
  let part = '';
  for (let index = 1; index < rest.length; index += 1) {
    const char = rest.charAt(index);
    if (char === '\\' && index + 1 < rest.length) {
      const next = rest.charAt(index + 1);
      part += next === delimiter ? next : char + next;
      index += 1;
    } else if (char === delimiter && parts.length < 2) {
      parts.push(part);
      part = '';
    } else {
      part += char;
    }
  }
  parts.push(part);
  return { pattern: parts[0] ?? '', replacement: parts[1] ?? '', flags: parts[2] ?? '' };
}

/** Vim's replacement syntax: `&` is the match, `\1`-`\9` its groups, `\x` a literal `x`. */
function expandReplacement(replacement: string, match: RegExpMatchArray): string {
  return replacement.replace(
    /\\(\d)|\\(.)|&/g,
    (_whole, group: string | undefined, escaped: string | undefined) => {
      if (group !== undefined) return match[Number(group)] ?? '';
      return escaped ?? match[0];
    },
  );
}

function substitute(
  view: EditorView,
  lines: readonly Line[],
  pattern: string,
  replacement: string,
  flags: string,
): void {
  const source = pattern === '' ? lastSearch?.pattern : pattern;
  if (source === undefined) {
    fail(view, 'No previous search pattern');
    return;
  }
  lastSearch = { pattern: source, forward: lastSearch?.forward ?? true };
  const expression = searchExpression(
    source,
    flags.includes('i') ? true : flags.includes('I') ? false : undefined,
  );
  const transaction = view.state.tr;
  let replaced = 0;
  let touched = 0;
  let lastLine: Line | null = null;
  // Last line first, last match first, so no edit moves a position still to be used.
  for (const line of [...lines].reverse()) {
    const found = Array.from(lineText(line).matchAll(expression));
    const chosen = flags.includes('g') ? found : found.slice(0, 1);
    for (const match of chosen.reverse()) {
      const from = line.start + match.index;
      const to = from + match[0].length;
      const value = expandReplacement(replacement, match);
      if (value === '') transaction.delete(from, to);
      else transaction.insertText(value, from, to);
      replaced += 1;
    }
    if (chosen.length > 0) {
      touched += 1;
      lastLine ??= line;
    }
  }
  if (lastLine === null) {
    fail(view, `Pattern not found: ${source}`);
    return;
  }
  const landed = lineAt(transaction.doc, transaction.mapping.map(lastLine.start));
  finish(
    view,
    transaction,
    {
      mode: 'normal',
      message:
        replaced > 1
          ? `${String(replaced)} substitutions on ${String(touched)} ${touched === 1 ? 'line' : 'lines'}`
          : '',
    },
    landed === null ? null : caretAt(transaction.doc, landed.start + firstNonBlank(landed)),
  );
}

/**
 * The `:` commands: a line number, `s` over the current line, `%` or the Visual lines, undo and
 * redo. `:w` and `:q` only say that notes save as you type.
 */
function runEx(view: EditorView, editor: Editor, input: string): void {
  const { state } = view;
  const text = input.trim();
  if (text === '') return;
  const range = text.startsWith('%') ? '%' : text.startsWith("'<,'>") ? 'visual' : '';
  const body = text.slice(range === '%' ? 1 : range === 'visual' ? 5 : 0).trim();

  if (/^\d+$/.test(body)) {
    const cursor = normalCursor(state);
    const line = nthLine(state.doc, Number(body)) ?? edgeLine(state.doc, -1);
    if (line === null) return;
    dispatch(
      view,
      { pending: '', ...(cursor === null ? {} : { marks: withMark(state, '`', cursor) }) },
      caretAt(state.doc, line.start + firstNonBlank(line)),
    );
    return;
  }

  const parsed = parseSubstitute(body);
  if (parsed !== null) {
    let lines: Line[] = [];
    if (range === '%') lines = documentLines(state.doc);
    else {
      const startPos = range === 'visual' ? markPosition(state, '<') : normalCursor(state);
      const endPos = range === 'visual' ? markPosition(state, '>') : startPos;
      const first = startPos === null ? null : lineAt(state.doc, startPos);
      const last = endPos === null ? null : lineAt(state.doc, endPos);
      for (
        let line: Line | null = first;
        line !== null && last !== null && line.start <= last.start;
        line = adjacentLine(state.doc, line, 1)
      ) {
        lines.push(line);
      }
    }
    substitute(view, lines, parsed.pattern, parsed.replacement, parsed.flags);
    return;
  }

  switch (body) {
    case 'w':
    case 'write':
    case 'wa':
    case 'wq':
    case 'x':
    case 'q':
    case 'q!':
    case 'qa':
    case 'wq!':
      dispatch(view, { message: 'Notes save as you type' });
      return;
    case 'noh':
    case 'nohlsearch':
      return;
    case 'u':
    case 'undo':
      runAction(view, editor, 'u', 1, null);
      return;
    case 'red':
    case 'redo':
      redo(view.state);
      settleAfterHistory(view);
      return;
    default:
      fail(view, `Not an editor command: ${body}`);
  }
}

function submitCommandLine(view: EditorView, editor: Editor, line: string, prefix: string): void {
  const type = line.charAt(0);
  const body = line.slice(1);
  if (type === ':') {
    dispatch(view, { commandLine: null, pending: '' });
    runEx(view, editor, body);
    return;
  }
  dispatch(view, { commandLine: null });
  const forward = type === '/';
  if (body !== '') lastSearch = { pattern: body, forward };
  else if (lastSearch !== null) lastSearch = { ...lastSearch, forward };
  else {
    fail(view, 'No previous search pattern');
    return;
  }
  // A search is `n` once its pattern is the last one, with whatever operator was typed before it.
  const parsed = parse(`${prefix}n`, isVisual(current(view.state).mode));
  if (typeof parsed === 'object') execute(view, editor, parsed);
  else fail(view);
}

function handleCommandLineKey(
  view: EditorView,
  editor: Editor,
  event: KeyboardEvent,
  line: string,
): boolean {
  if (hasModifier(event)) return false;
  switch (event.key) {
    case 'Escape':
      dispatch(view, { commandLine: null, pending: '' });
      return true;
    case 'Enter':
      submitCommandLine(view, editor, line, current(view.state).pending);
      return true;
    case 'Backspace':
      dispatch(
        view,
        line.length > 1 ? { commandLine: line.slice(0, -1) } : { commandLine: null, pending: '' },
      );
      return true;
  }
  if (event.key.length === 1) dispatch(view, { commandLine: line + event.key });
  return true;
}

const nativeNavigationKeys = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

function isDestructiveShortcut(event: KeyboardEvent, isApplePlatform: boolean): boolean {
  return (
    event.key === 'Backspace' ||
    event.key === 'Delete' ||
    event.key === 'Enter' ||
    (isApplePlatform &&
      ((event.ctrlKey && (event.key === 'h' || event.key === 'd')) ||
        (event.altKey && event.key === 'd')))
  );
}

function handleCommandKey(view: EditorView, editor: Editor, event: KeyboardEvent): boolean {
  const vim = current(view.state);

  if (event.key === 'Escape') {
    if (isVisual(vim.mode) && vim.head !== null) {
      dispatch(
        view,
        { mode: 'normal', pending: '', anchor: null, head: null },
        onCharacter(view.state.doc, vim.head),
      );
    } else if (vim.pending !== '') {
      dispatch(view, { pending: '' });
    }
    return true;
  }

  if (event.key.length !== 1) {
    // Normal mode never inserts or deletes by itself. Arrows and Tab were let through earlier.
    if (vim.pending !== '') dispatch(view, { pending: '' });
    return event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Enter';
  }

  if (vim.recording !== null && vim.pending === '' && event.key === 'q') {
    macros.set(vim.recording, recorded);
    recorded = [];
    dispatch(view, { recording: null });
    return true;
  }

  const parsed = parse(vim.pending + event.key, isVisual(vim.mode));
  if (parsed === 'incomplete') {
    dispatch(view, { pending: vim.pending + event.key });
    return true;
  }
  if (parsed === 'invalid') {
    fail(view);
    return true;
  }
  if (parsed.kind === 'command-line') {
    if (parsed.type === ':' && isVisual(vim.mode) && vim.anchor !== null && vim.head !== null) {
      // `:` from Visual runs over its lines, named by the `'<` and `'>` marks as in Vim.
      const { state } = view;
      const marks = new Map(vim.marks);
      marks.set('<', savePosition(state, Math.min(vim.anchor, vim.head)));
      marks.set('>', savePosition(state, Math.max(vim.anchor, vim.head)));
      dispatch(
        view,
        { mode: 'normal', pending: '', anchor: null, head: null, marks, commandLine: ":'<,'>" },
        onCharacter(state.doc, vim.head),
      );
      return true;
    }
    dispatch(view, { commandLine: parsed.type, ...(parsed.type === ':' ? { pending: '' } : {}) });
    return true;
  }
  execute(view, editor, parsed);
  return true;
}

function cursorDecorations(state: EditorState): DecorationSet | null {
  const vim = current(state);
  if (!vim.enabled || vim.mode !== 'normal') return null;
  const cursor = normalCursor(state);
  const line = cursor === null ? null : lineAt(state.doc, cursor);
  if (cursor === null || line === null) return null;
  if (line.size === 0) {
    return DecorationSet.create(state.doc, [
      Decoration.widget(
        cursor,
        () => {
          const block = document.createElement('span');
          block.className = 'nix-vim-cursor';
          block.setAttribute('aria-hidden', 'true');
          block.textContent = ' ';
          return block;
        },
        { key: 'nix-vim-cursor', side: 1, ignoreSelection: true },
      ),
    ]);
  }
  return DecorationSet.create(state.doc, [
    Decoration.inline(cursor, characterEnd(state.doc, cursor), { class: 'nix-vim-cursor' }),
  ]);
}

function vimPlugin(editor: Editor, isApplePlatform: boolean): Plugin<VimMotionState> {
  return new Plugin<VimMotionState>({
    key: vimMotionsKey,
    state: {
      init: () => INITIAL,
      apply(transaction, value) {
        let next = value;
        if (transaction.docChanged) {
          const { mapping } = transaction;
          if (value.anchor !== null && value.head !== null) {
            next = { ...next, anchor: mapping.map(value.anchor), head: mapping.map(value.head) };
          }
          if (value.insertStart !== null) {
            // A rebuilt collaborative document has no mapping to follow; `.` then repeats no text.
            next = {
              ...next,
              insertStart: isChangeOrigin(transaction) ? null : mapping.map(value.insertStart, -1),
            };
          }
          if ([...value.marks.values()].some((saved) => 'pos' in saved)) {
            next = {
              ...next,
              marks: new Map(
                Array.from(value.marks, ([name, saved]) => [name, mapSaved(saved, mapping)]),
              ),
            };
          }
        }
        const meta: unknown = transaction.getMeta(vimMotionsKey);
        if (typeof meta === 'object' && meta !== null) {
          return { ...next, ...(meta as VimMotionMeta) };
        }
        // A click, a toolbar command or any other outside selection change abandons a half-typed
        // command and leaves Visual mode, the way a mouse click does in Vim. A colleague's edit
        // also restores this editor's selection, and must not count as this person moving it.
        if (
          transaction.getMeta(ySyncPluginKey) === undefined &&
          transaction.selectionSet &&
          (next.pending !== '' || next.commandLine !== null || isVisual(next.mode))
        ) {
          return {
            ...next,
            pending: '',
            commandLine: null,
            mode: isVisual(next.mode) ? 'normal' : next.mode,
            anchor: null,
            head: null,
          };
        }
        return next;
      },
    },
    props: {
      decorations: cursorDecorations,
      attributes(state): Record<string, string> {
        const vim = current(state);
        return vim.enabled && vim.mode !== 'insert' ? { class: 'nix-vim-command' } : {};
      },
      handleKeyDown(view, event) {
        const vim = current(view.state);
        if (
          !vim.enabled ||
          event.isComposing ||
          view.composing ||
          isLegacyCompositionKey(event) ||
          !inTextControl(event)
        ) {
          return false;
        }
        if (vim.message !== '') dispatch(view, { message: '' });
        if (vim.recording !== null && replayDepth === 0) {
          // The q that ends a recording is not part of it.
          const stops =
            vim.mode !== 'insert' &&
            vim.commandLine === null &&
            vim.pending === '' &&
            event.key === 'q' &&
            !hasModifier(event);
          if (!stops) recorded.push(strokeOf(event));
        }
        if (vim.mode === 'insert') {
          if (event.key !== 'Escape') {
            return false;
          }
          leaveInsert(view);
          return true;
        }
        if (vim.commandLine !== null) {
          return handleCommandLineKey(view, editor, event, vim.commandLine);
        }
        if (hasModifier(event)) {
          if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'r') {
            // Ctrl+R is redo in Vim and reload in a browser on Windows and Linux; Vim wins here.
            dispatch(view, { pending: '' });
            redo(view.state);
            settleAfterHistory(view);
            return true;
          }
          if (vim.pending !== '') {
            dispatch(view, { pending: '' });
          }
          return isDestructiveShortcut(event, isApplePlatform);
        }
        return handleCommandKey(view, editor, event);
      },
      handleTextInput(view) {
        const vim = current(view.state);
        return vim.enabled && vim.mode !== 'insert';
      },
      handlePaste(view) {
        const vim = current(view.state);
        return vim.enabled && vim.mode !== 'insert';
      },
      handleDrop(view, _event, _slice, moved) {
        const vim = current(view.state);
        return vim.enabled && vim.mode !== 'insert' && !moved;
      },
      handleDOMEvents: {
        blur(view) {
          const vim = current(view.state);
          if (vim.pending !== '' || vim.commandLine !== null) {
            dispatch(view, { pending: '', commandLine: null });
          }
          return false;
        },
        keydown(view, event) {
          const vim = current(view.state);
          // Returning true from a raw DOM handler skips ProseMirror's rich-node keymaps. Leaving
          // the event uncancelled preserves native focus traversal and caret navigation.
          return (
            vim.enabled &&
            vim.mode !== 'insert' &&
            (event.key === 'Tab' ||
              (!event.metaKey &&
                !event.ctrlKey &&
                !event.altKey &&
                nativeNavigationKeys.has(event.key))) &&
            inTextControl(event)
          );
        },
        cut(view, event) {
          const vim = current(view.state);
          if (vim.enabled && vim.mode !== 'insert' && inTextControl(event)) {
            event.preventDefault();
            return true;
          }
          return false;
        },
        beforeinput(view, event) {
          const vim = current(view.state);
          if (vim.enabled && vim.mode !== 'insert' && inTextControl(event)) {
            event.preventDefault();
            return true;
          }
          return false;
        },
      },
    },
  });
}

export function vimMode(state: EditorState): VimMode {
  return current(state).mode;
}

export function vimStatusMode(state: EditorState): VimMode | null {
  const vim = current(state);
  return vim.enabled ? vim.mode : null;
}

/** The keys typed toward a command that is not complete yet, for the status line. */
export function vimPendingKeys(state: EditorState): string {
  return current(state).pending;
}

export interface VimStatus {
  readonly mode: VimMode;
  /** What is being typed: a partial command, or the `:`, `/` or `?` command line. */
  readonly keys: string;
  readonly message: string;
  readonly recording: string | null;
}

/** Everything the status line shows, or null when Vim basics is off. */
export function vimStatus(state: EditorState): VimStatus | null {
  const vim = current(state);
  if (!vim.enabled) return null;
  return {
    mode: vim.mode,
    keys: vim.pending + (vim.commandLine ?? ''),
    message: vim.message,
    recording: vim.recording,
  };
}

/** How the status line names a mode. */
export function vimModeLabel(mode: VimMode): string {
  return mode === 'visual-line' ? 'visual line' : mode;
}

export function setVimEnabled(view: EditorView, enabled: boolean): void {
  const next: VimMode = enabled ? 'normal' : 'insert';
  const vim = current(view.state);
  if (
    vim.enabled !== enabled ||
    vim.mode !== next ||
    vim.pending !== '' ||
    vim.anchor !== null ||
    vim.commandLine !== null ||
    vim.recording !== null
  ) {
    dispatch(view, {
      enabled,
      mode: next,
      pending: '',
      anchor: null,
      head: null,
      commandLine: null,
      message: '',
      recording: null,
      insertStart: null,
    });
  }
}

/** A bounded modal preset: exact supported keys are disclosed in Settings. */
export const VimMotions = Extension.create<VimMotionsOptions>({
  name: 'vimMotions',
  priority: 900,
  addOptions() {
    return { isApplePlatform: defaultIsApplePlatform };
  },
  addProseMirrorPlugins() {
    return [vimPlugin(this.editor, this.options.isApplePlatform)];
  },
});
