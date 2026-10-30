/**
 * A block-level diff over two ProseMirror documents, reduced to plaintext first.
 *
 * The history sidebar never diffs a document at the character level (character-level diffing is out of scope); it diffs the top-level blocks as plain strings, which is
 * cheap, has no dependency on ProseMirror's own transform machinery, and reads the way a person
 * skimming two revisions of a note actually thinks about the change: "this paragraph is new",
 * "this one moved", not "these twelve characters changed".
 */

/** A ProseMirror node, read loosely - only the shape this module cares about. */
interface ProseMirrorNode {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly attrs?: Record<string, unknown>;
  readonly content?: readonly unknown[];
}

function asNode(value: unknown): ProseMirrorNode | null {
  return typeof value === 'object' && value !== null ? value : null;
}

function nodeType(node: ProseMirrorNode): string {
  return typeof node.type === 'string' ? node.type : '';
}

function childNodes(node: ProseMirrorNode): readonly ProseMirrorNode[] {
  if (!Array.isArray(node.content)) return [];
  const nodes: ProseMirrorNode[] = [];
  for (const child of node.content) {
    const asChild = asNode(child);
    if (asChild !== null) nodes.push(asChild);
  }
  return nodes;
}

/**
 * Node types whose own content is inline (text, marks, hard breaks) rather than further blocks.
 * Their children are joined with no separator, since ProseMirror already puts any needed spacing
 * inside the text runs themselves.
 */
const INLINE_CONTAINER_TYPES = new Set([
  'paragraph',
  'heading',
  'tableCell',
  'tableHeader',
  'codeBlock',
]);

/**
 * Flattens one node - and everything under it - to plaintext.
 *
 * Text and hard breaks are the leaves. A node whose content is inline (a paragraph, a heading, a
 * table cell) joins its children directly. Everything else is a block container - a list item, a
 * blockquote, a callout, a whole list - and its children are themselves blocks, so they join on
 * newlines and empty children drop out rather than leaving a blank line for every list marker.
 */
function nodeText(node: ProseMirrorNode): string {
  const type = nodeType(node);
  if (type === 'text') return typeof node.text === 'string' ? node.text : '';
  if (type === 'hardBreak') return '\n';

  const children = childNodes(node);
  if (children.length === 0) return '';

  const parts = children.map(nodeText);
  if (INLINE_CONTAINER_TYPES.has(type)) return parts.join('');
  return parts.filter((part) => part.length > 0).join('\n');
}

/** One table row, its cells joined by tabs. */
function tableRowText(row: ProseMirrorNode): string {
  return childNodes(row)
    .map((cell) => nodeText(cell))
    .join('\t');
}

/** A table, flattened to one block: rows joined by newlines, cells within a row by tabs. */
function tableText(table: ProseMirrorNode): string {
  return childNodes(table)
    .filter((row) => nodeType(row) === 'tableRow')
    .map(tableRowText)
    .join('\n');
}

/** An image, flattened to its alt text, or a placeholder when it has none. */
function imageText(image: ProseMirrorNode): string {
  const alt = image.attrs?.alt;
  return typeof alt === 'string' && alt.trim().length > 0 ? alt : '[image]';
}

function topLevelBlockText(node: ProseMirrorNode): string {
  const type = nodeType(node);
  if (type === 'table') return tableText(node);
  if (type === 'image') return imageText(node);
  return nodeText(node);
}

/**
 * Flattens a document's top-level blocks to plaintext, one entry per block, in document order.
 *
 * `doc` is a ProseMirror JSON document (`{ type: 'doc', content: [...] }`); anything without a
 * usable `content` array flattens to no blocks at all rather than throwing, since a caller may
 * pass a document that failed to load.
 */
export function blockTexts(doc: unknown): readonly string[] {
  const node = asNode(doc);
  if (node === null) return [];
  return childNodes(node).map(topLevelBlockText);
}

/** One entry in a block diff. `before`/`after` carry the block's text for every kind but 'same'. */
export interface DiffEntry {
  readonly kind: 'same' | 'added' | 'removed' | 'changed';
  readonly before?: string;
  readonly after?: string;
}

type RawEntry =
  | { readonly kind: 'same'; readonly text: string }
  | { readonly kind: 'added'; readonly text: string }
  | { readonly kind: 'removed'; readonly text: string };

/**
 * The classic longest-common-subsequence table, built once and walked backwards to recover which
 * blocks matched. `table[i][j]` is the LCS length of `before[i..]` and `after[j..]`.
 */
/**
 * Reads one cell of the LCS table. `noUncheckedIndexedAccess` cannot see that the loops below
 * only ever ask for cells the table was sized to hold, so this is where that is asserted - once,
 * with the same fallback (0) the table's own border cells already carry, rather than at every
 * call site.
 */
function tableAt(table: readonly (readonly number[])[], i: number, j: number): number {
  return table[i]?.[j] ?? 0;
}

function lcsTable(before: readonly string[], after: readonly string[]): number[][] {
  const rows = before.length + 1;
  const cols = after.length + 1;
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      const row = table[i];
      if (row === undefined) continue;
      row[j] =
        before[i] === after[j]
          ? tableAt(table, i + 1, j + 1) + 1
          : Math.max(tableAt(table, i + 1, j), tableAt(table, i, j + 1));
    }
  }
  return table;
}

/** Walks the LCS table to produce a same/added/removed sequence, matched blocks kept in order. */
function rawDiff(before: readonly string[], after: readonly string[]): readonly RawEntry[] {
  const table = lcsTable(before, after);
  const entries: RawEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    const beforeText = before[i];
    const afterText = after[j];
    if (beforeText === undefined || afterText === undefined) break;
    if (beforeText === afterText) {
      entries.push({ kind: 'same', text: beforeText });
      i += 1;
      j += 1;
    } else if (tableAt(table, i + 1, j) >= tableAt(table, i, j + 1)) {
      entries.push({ kind: 'removed', text: beforeText });
      i += 1;
    } else {
      entries.push({ kind: 'added', text: afterText });
      j += 1;
    }
  }
  while (i < before.length) {
    const beforeText = before[i];
    if (beforeText !== undefined) entries.push({ kind: 'removed', text: beforeText });
    i += 1;
  }
  while (j < after.length) {
    const afterText = after[j];
    if (afterText !== undefined) entries.push({ kind: 'added', text: afterText });
    j += 1;
  }
  return entries;
}

/** The minimum shared prefix or suffix, in characters, for a removed+added pair to be one edit. */
const CHANGED_MERGE_THRESHOLD = 12;

function sharedPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let length = 0;
  while (length < max && a[length] === b[length]) length += 1;
  return length;
}

function sharedSuffixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let length = 0;
  while (length < max && a.at(-1 - length) === b.at(-1 - length)) length += 1;
  return length;
}

/**
 * Collapses an adjacent removed-then-added pair into one 'changed' entry when the two texts share
 * a prefix or a suffix of at least `CHANGED_MERGE_THRESHOLD` characters - the signature of one
 * block being edited rather than one block disappearing and an unrelated one appearing in its
 * place. Pairs that share nothing that long are left as a removal next to an addition, which is
 * the honest way to show a paragraph replaced by an unrelated one.
 */
function collapseChanged(entries: readonly RawEntry[]): readonly DiffEntry[] {
  const result: DiffEntry[] = [];
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index];
    if (entry === undefined) break;
    const next = entries[index + 1];
    if (entry.kind === 'removed' && next?.kind === 'added') {
      const shared = Math.max(
        sharedPrefixLength(entry.text, next.text),
        sharedSuffixLength(entry.text, next.text),
      );
      if (shared >= CHANGED_MERGE_THRESHOLD) {
        result.push({ kind: 'changed', before: entry.text, after: next.text });
        index += 2;
        continue;
      }
    }
    if (entry.kind === 'same') {
      result.push({ kind: 'same', before: entry.text, after: entry.text });
    } else if (entry.kind === 'removed') {
      result.push({ kind: 'removed', before: entry.text });
    } else {
      result.push({ kind: 'added', after: entry.text });
    }
    index += 1;
  }
  return result;
}

/**
 * Diffs two sequences of block plaintext with an LCS, then collapses adjacent removed+added pairs
 * that are really one edited block into a single 'changed' entry (see `collapseChanged`).
 */
export function diffBlocks(
  before: readonly string[],
  after: readonly string[],
): readonly DiffEntry[] {
  return collapseChanged(rawDiff(before, after));
}
