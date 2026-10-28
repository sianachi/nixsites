import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

import { adjacentLine, lineAt, lineText, type Line } from './text-motions';

/**
 * Vim's text objects, as pure functions of the document. Like the motions in `vim-motions.ts`,
 * each works on text blocks as lines: a quote or bracket pair is found within one block (a whole
 * code block counts as one), and a paragraph is a run of non-empty blocks between empty ones.
 */

export type Range =
  | { readonly linewise: false; readonly from: number; readonly to: number }
  | { readonly linewise: true; readonly first: Line; readonly last: Line };

const OBJECT_KEYS = [
  'w',
  '"',
  "'",
  '`',
  '(',
  ')',
  'b',
  '[',
  ']',
  '{',
  '}',
  'B',
  '<',
  '>',
  'p',
] as const;
type ObjectKey = (typeof OBJECT_KEYS)[number];
export type TextObject = `${'i' | 'a'}${ObjectKey}`;

export function isTextObject(keys: string): keys is TextObject {
  return (
    keys.length === 2 &&
    (keys.startsWith('i') || keys.startsWith('a')) &&
    (OBJECT_KEYS as readonly string[]).includes(keys.charAt(1))
  );
}

const BRACKETS: Readonly<Record<string, readonly [string, string]>> = {
  '(': ['(', ')'],
  ')': ['(', ')'],
  b: ['(', ')'],
  '[': ['[', ']'],
  ']': ['[', ']'],
  '{': ['{', '}'],
  '}': ['{', '}'],
  B: ['{', '}'],
  '<': ['<', '>'],
  '>': ['<', '>'],
};

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

interface Run {
  readonly start: number;
  readonly end: number;
  readonly kind: 'word' | 'blank' | 'other';
}

/** The block as runs of word, blank and other characters: what `iw` takes as one word. */
function runs(line: Line): Run[] {
  const out: Run[] = [];
  for (const segment of wordSegmenter.segment(lineText(line))) {
    const kind =
      segment.isWordLike === true ? 'word' : /^\s+$/u.test(segment.segment) ? 'blank' : 'other';
    const end = segment.index + segment.segment.length;
    const last = out.at(-1);
    if (last?.kind === kind) out[out.length - 1] = { ...last, end };
    else out.push({ start: segment.index, end, kind });
  }
  return out;
}

function wordObject(line: Line, offset: number, around: boolean): [number, number] | null {
  const all = runs(line);
  const index = all.findIndex((run) => offset < run.end);
  const run = all[index];
  if (run === undefined) return null;
  if (!around) return [run.start, run.end];
  const next = all[index + 1];
  const previous = all[index - 1];
  if (run.kind === 'blank') return [run.start, next?.end ?? run.end];
  // `aw` takes the blanks after the word, or the ones before it when nothing follows.
  if (next?.kind === 'blank') return [run.start, next.end];
  if (previous?.kind === 'blank') return [previous.start, run.end];
  return [run.start, run.end];
}

/** Widens [from, to) by the blanks after it, or before it when there are none after. */
function withBlanks(text: string, from: number, to: number): [number, number] {
  let end = to;
  while (end < text.length && /[\t ]/.test(text.charAt(end))) end += 1;
  if (end > to) return [from, end];
  let start = from;
  while (start > 0 && /[\t ]/.test(text.charAt(start - 1))) start -= 1;
  return [start, to];
}

function quoteObject(
  line: Line,
  offset: number,
  quote: string,
  around: boolean,
): [number, number] | null {
  const text = lineText(line);
  const quotes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charAt(index) === quote && text.charAt(index - 1) !== '\\') quotes.push(index);
  }
  // Quotes pair up from the start of the block, as in Vim; the first pair not behind the cursor wins.
  for (let index = 0; index + 1 < quotes.length; index += 2) {
    const open = quotes[index] ?? 0;
    const close = quotes[index + 1] ?? 0;
    if (close < offset) continue;
    return around ? withBlanks(text, open, close + 1) : [open + 1, close];
  }
  return null;
}

function bracketObject(
  line: Line,
  offset: number,
  [open, close]: readonly [string, string],
  around: boolean,
): [number, number] | null {
  const text = lineText(line);
  let depth = 0;
  let start = -1;
  for (let index = Math.min(offset, text.length - 1); index >= 0; index -= 1) {
    const char = text.charAt(index);
    if (char === close && index !== offset) depth += 1;
    else if (char === open) {
      if (depth === 0) {
        start = index;
        break;
      }
      depth -= 1;
    }
  }
  if (start === -1) return null;
  depth = 0;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === open) depth += 1;
    else if (char === close) {
      if (depth === 0) return around ? [start, index + 1] : [start + 1, index];
      depth -= 1;
    }
  }
  return null;
}

/** `ip` is the run of blocks that are all empty or all not; `ap` adds the next run of the other kind. */
function paragraphObject(
  doc: ProseMirrorNode,
  line: Line,
  around: boolean,
): { readonly first: Line; readonly last: Line } {
  const empty = line.size === 0;
  const extend = (from: Line, direction: 1 | -1, same: boolean): Line => {
    let edge = from;
    for (
      let next = adjacentLine(doc, edge, direction);
      next !== null && (next.size === 0) === (same ? empty : !empty);
      next = adjacentLine(doc, next, direction)
    ) {
      edge = next;
    }
    return edge;
  };
  const first = extend(line, -1, true);
  const last = extend(line, 1, true);
  if (!around) return { first, last };
  const after = extend(last, 1, false);
  return after.start !== last.start
    ? { first, last: after }
    : { first: extend(first, -1, false), last };
}

/** The range a text object covers around `pos`, or null when there is none (no enclosing pair). */
export function textObjectRange(
  doc: ProseMirrorNode,
  pos: number,
  object: TextObject,
): Range | null {
  const line = lineAt(doc, pos);
  if (line === null) return null;
  const around = object.startsWith('a');
  const key = object.charAt(1);
  if (key === 'p') return { linewise: true, ...paragraphObject(doc, line, around) };
  const offset = pos - line.start;
  const bracket = BRACKETS[key];
  const span =
    key === 'w'
      ? wordObject(line, offset, around)
      : bracket === undefined
        ? quoteObject(line, offset, key, around)
        : bracketObject(line, offset, bracket, around);
  return span === null
    ? null
    : { linewise: false, from: line.start + span[0], to: line.start + span[1] };
}
