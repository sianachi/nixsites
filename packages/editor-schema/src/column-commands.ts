import { Extension } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import type { Node as PMNode, ResolvedPos, Schema } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state';

import { MAX_COLUMNS, readWidth } from './columns.js';

/**
 * The commands and the repair half of columns.
 *
 * `columns.ts` defines the two nodes and takes the permissive side of every trade - `column+`
 * rather than `column column+`, `block*` rather than `block+` - so that a CRDT merge can never
 * produce a document that refuses to open. This file is the other half it promised: the commands
 * that create and edit rows, and the `appendTransaction` normaliser that repairs the shapes the
 * schema deliberately lets through.
 *
 * **A separate extension, not part of `nixExtensions`, and in this package rather than in
 * `apps/web` (ADR-0032).** `nixExtensions` is the schema alone, which is what the collaboration
 * service builds to check that an update still parses. This file is editing behaviour - but it
 * is the editing behaviour that keeps a document in a shape the schema *deliberately permits and
 * the product cannot draw*, which is a property of the format, not of the interface over it.
 * `nixEditingExtensions` is the pairing, and `apps/web` adds its own `ColumnControls` on top for
 * everything that needs a browser.
 *
 * **Being DOM-free is a consequence, not the argument.** That these functions run in Node is
 * what makes the collaboration service the plausible future home for the repair: it already
 * builds this schema there, and repairing once server-side would beat repairing on whichever
 * client types next. It does not run it today because it validates rather than edits - no
 * transaction pipeline of its own, no way to broadcast a repair - and because the local-origin
 * gate below is a client's concept. That is the documented swap plan, not a claim that testing
 * in Node justifies the placement.
 */

/**
 * The smallest share of a column pair either side of a divider may be squeezed to.
 *
 * The same number `PaneDivider` uses for panes, for the same reason: below about a sixth of the
 * pair a column is narrower than a readable word, and a bound is also what makes the keyboard's
 * Home and End mean something.
 */
export const MIN_COLUMN_PAIR_SHARE = 0.15;

/** Two widths whose sum is within this of the target count as already normalised. */
const WIDTH_EPSILON = 0.001;

/**
 * A column's effective grow factor: its stated width, or `1` for an equal share.
 *
 * `1` because that is what the renderer's `flex-1` gives an unstated column, so arithmetic done
 * here agrees with what a reader actually sees.
 */
function effectiveWidth(column: PMNode): number {
  return readWidth(column.attrs.width) ?? 1;
}

/** Every column's effective grow factor, in order. */
export function columnGrowFactors(row: PMNode): number[] {
  const factors: number[] = [];
  row.forEach((column) => {
    factors.push(effectiveWidth(column));
  });
  return factors;
}

/**
 * The left column's share of the pair either side of divider `index`, in `[0, 1]`.
 *
 * The number a resize handle reports, expressed over the pair rather than the row so the value a
 * screen reader announces is about the two columns the handle actually moves.
 */
export function columnPairShare(row: PMNode, index: number): number {
  const factors = columnGrowFactors(row);
  const left = factors[index];
  const right = factors[index + 1];
  if (left === undefined || right === undefined || left + right <= 0) {
    return 0.5;
  }
  return left / (left + right);
}

/**
 * The row's widths after moving divider `index` so the left column takes `share` of its pair.
 *
 * Only the pair changes; every other column keeps its factor, which is the whole point of widths
 * living per column rather than as an array on the row - two people dragging two different
 * dividers each touch only their own pair. The result is then normalised so the factors sum to
 * the column count, keeping stored numbers near `1` instead of drifting with every drag.
 *
 * Returns `null` when `index` names no divider.
 */
export function resizedColumnWidths(row: PMNode, index: number, share: number): number[] | null {
  const factors = columnGrowFactors(row);
  const left = factors[index];
  const right = factors[index + 1];
  if (left === undefined || right === undefined) {
    return null;
  }

  const pair = left + right;
  const clamped = Math.min(1 - MIN_COLUMN_PAIR_SHARE, Math.max(MIN_COLUMN_PAIR_SHARE, share));
  factors[index] = pair * clamped;
  factors[index + 1] = pair - factors[index];

  const sum = factors.reduce((total, factor) => total + factor, 0);
  if (sum <= 0) {
    return factors.map(() => 1);
  }
  const scale = row.childCount / sum;
  return factors.map((factor) => factor * scale);
}

/** The names this file navigates by, read off a schema rather than repeated as literals. */
function columnTypes(schema: Schema): {
  columnBlock: PMNode['type'] | undefined;
  column: PMNode['type'] | undefined;
  paragraph: PMNode['type'] | undefined;
} {
  return {
    columnBlock: schema.nodes.columnBlock,
    column: schema.nodes.column,
    paragraph: schema.nodes.paragraph,
  };
}

/**
 * The depth of the innermost ancestor of `$pos` named `name`, or `null` when there is none.
 *
 * One ancestor walk rather than the four this file grew: every column operation begins by asking
 * where it is, and four copies of the same loop is four places for an off-by-one in the bound.
 * Depth zero is the document, which is nobody's ancestor of interest, so the walk stops above it.
 */
function ancestorDepth($pos: ResolvedPos, name: string): number | null {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === name) {
      return depth;
    }
  }
  return null;
}

/** A fresh column holding one empty paragraph, so the caret has somewhere to land. */
function emptyColumn(schema: Schema): PMNode | null {
  const { column, paragraph } = columnTypes(schema);
  if (column === undefined || paragraph === undefined) {
    return null;
  }
  return column.create(null, paragraph.create());
}

/**
 * Inserts a row of `count` columns at the selection, caret in the first.
 *
 * The count is clamped to `[2, MAX_COLUMNS]`: one column is ordinary flow - the repair below
 * unwraps exactly that shape - and past four, a column on a laptop is narrower than readable
 * prose. Refuses inside an existing row, because nested rows are a shape the drag interactions
 * cannot express either and a command should not mint what the interface cannot edit.
 */
export function insertColumnBlockTr(tr: Transaction, count: number, apply: boolean): boolean {
  const schema = tr.doc.type.schema;
  const { columnBlock } = columnTypes(schema);
  if (columnBlock === undefined) {
    return false;
  }
  if (ancestorDepth(tr.selection.$from, 'columnBlock') !== null) {
    return false;
  }

  const clamped = Math.min(MAX_COLUMNS, Math.max(2, Math.floor(count)));
  const columns: PMNode[] = [];
  for (let index = 0; index < clamped; index += 1) {
    const column = emptyColumn(schema);
    if (column === null) {
      return false;
    }
    columns.push(column);
  }

  if (!apply) {
    return true;
  }

  // The same shape as the table extension's insert: capture where the selection was, replace it
  // with the node, and let `TextSelection.near` walk forward to the first text position - which
  // is the first column's paragraph whether the row replaced an empty paragraph or split a full
  // one.
  const from = tr.selection.from;
  tr.replaceSelectionWith(columnBlock.create(null, columns));
  const caret = Math.min(from + 1, tr.doc.content.size);
  tr.setSelection(TextSelection.near(tr.doc.resolve(caret), 1));
  tr.scrollIntoView();
  return true;
}

/**
 * Adds a fresh column immediately after the caret's, up to `MAX_COLUMNS`.
 *
 * The new column states no width: an equal share of what is left is what a column added to a
 * hand-balanced row should take, and it is the one value that cannot fight a colleague's
 * concurrent resize of the others.
 */
export function addColumnAfterTr(tr: Transaction, apply: boolean): boolean {
  const $from = tr.selection.$from;
  const depth = ancestorDepth($from, 'column');
  if (depth === null) {
    return false;
  }
  const row = $from.node(depth - 1);
  if (row.type.name !== 'columnBlock' || row.childCount >= MAX_COLUMNS) {
    return false;
  }
  const column = emptyColumn(tr.doc.type.schema);
  if (column === null) {
    return false;
  }

  if (!apply) {
    return true;
  }

  const pos = $from.after(depth);
  tr.insert(pos, column);
  tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1), 1));
  tr.scrollIntoView();
  return true;
}

/** Whether a column holds nothing a reader would miss: no children, or one empty paragraph. */
function columnIsBlank(column: PMNode): boolean {
  if (column.childCount === 0) {
    return true;
  }
  if (column.childCount > 1) {
    return false;
  }
  const only = column.child(0);
  return only.type.name === 'paragraph' && only.content.size === 0;
}

/**
 * Removes the caret's column, carrying its content into a neighbour so nothing is lost.
 *
 * Content goes to the previous column's end - reading order - or the next column's start when
 * the first column is the one removed; a blank column simply goes. Removing the last column of
 * a row unwraps the row back into flow, which is the same repair the normaliser performs, done
 * eagerly because the person asked for it rather than a merge producing it.
 */
export function removeColumnTr(tr: Transaction, apply: boolean): boolean {
  const $from = tr.selection.$from;
  const depth = ancestorDepth($from, 'column');
  if (depth === null) {
    return false;
  }
  const row = $from.node(depth - 1);
  if (row.type.name !== 'columnBlock') {
    return false;
  }

  if (!apply) {
    return true;
  }

  if (row.childCount === 1) {
    return unwrapRow(tr, $from.before(depth - 1), row);
  }

  const column = $from.node(depth);
  const index = $from.index(depth - 1);
  const colFrom = $from.before(depth);
  const colTo = $from.after(depth);

  tr.delete(colFrom, colTo);

  if (!columnIsBlank(column)) {
    // After the deletion the previous column still ends at `colFrom`, so its content ends one
    // position inside that; when the first column went, the next one now *starts* at `colFrom`
    // and its content starts one position inside it.
    const insertAt = index > 0 ? colFrom - 1 : colFrom + 1;
    tr.insert(insertAt, column.content);
    tr.setSelection(TextSelection.near(tr.doc.resolve(insertAt), 1));
  } else {
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(colFrom - 1, 0)), -1));
  }
  tr.scrollIntoView();
  return true;
}

/**
 * Replaces the row at `pos` with the flow content of its columns.
 *
 * Used by both `removeColumnFromRow` (on the last column) and the repair (on a single-column row a
 * merge left behind). An entirely blank row becomes one empty paragraph rather than nothing,
 * because a document is `block+` and a caret needs a block to stand in.
 */
function unwrapRow(tr: Transaction, pos: number, row: PMNode): boolean {
  const schema = tr.doc.type.schema;
  const { paragraph } = columnTypes(schema);

  const parts: Fragment[] = [];
  row.forEach((column) => {
    if (!columnIsBlank(column)) {
      parts.push(column.content);
    }
  });

  if (parts.length === 0) {
    if (paragraph === undefined) {
      return false;
    }
    tr.replaceWith(pos, pos + row.nodeSize, paragraph.create());
    tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1), 1));
    tr.scrollIntoView();
    return true;
  }

  // Where the caret was, relative to the content that survives. The first column's content
  // starts two positions inside the row - one token for the row, one for the column - and the
  // same content starts at `pos` itself once unwrapped, so a caret inside the first column keeps
  // its exact spot. Deeper columns cannot be mapped this cheaply and fall back to `near`.
  let content = Fragment.empty;
  for (const part of parts) {
    content = content.append(part);
  }

  const head = tr.selection.head;
  const firstContentStart = pos + 2;
  const first = row.child(0);
  const inFirst = head >= firstContentStart && head <= firstContentStart + first.content.size;
  const desired = inFirst ? pos + (head - firstContentStart) : null;

  tr.replaceWith(pos, pos + row.nodeSize, content);
  const caret = desired ?? Math.min(pos + 1, tr.doc.content.size);
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(caret, tr.doc.content.size)), 1));
  tr.scrollIntoView();
  return true;
}

/**
 * Writes one width per column of the row at `pos`.
 *
 * The widths arrive as fractions - or `null` for an equal share - and are read through
 * `readWidth`, which is the same function the node's own `parseHTML` calls, so a junk number can
 * no more get in through a command than through a paste. Shared rather than restated: a second
 * copy of the predicate is a second answer to what a width is.
 */
export function setColumnWidthsTr(
  tr: Transaction,
  pos: number,
  widths: readonly (number | null)[],
  apply: boolean,
): boolean {
  const row = tr.doc.nodeAt(pos);
  if (row?.type.name !== 'columnBlock' || widths.length !== row.childCount) {
    return false;
  }

  if (!apply) {
    return true;
  }

  row.forEach((column, offset, index) => {
    const width = readWidth(widths[index]);
    // Compared against the raw attribute rather than its sanitised reading, so writing `null`
    // over a junk value is a change rather than a no-op - which is exactly the repair the
    // normaliser asks for on a document whose JSON was never parsed through `parseHTML`.
    if (column.attrs.width !== width) {
      tr.setNodeMarkup(pos + 1 + offset, undefined, { ...column.attrs, width });
    }
  });
  return true;
}

/**
 * Moves the caret's top-level block within its column into the previous or next column.
 *
 * The keyboard's half of drop-into-a-column: what a drag does with a pointer, Alt with an arrow
 * does from the caret. Moving left appends to the previous column - the block arrives after what
 * is already there, reading order - and moving right prepends to the next, so the block stays
 * adjacent to where it came from in both directions. The caret travels with the block.
 */
export function moveBlockToColumnTr(
  tr: Transaction,
  direction: 'previous' | 'next',
  apply: boolean,
): boolean {
  const $from = tr.selection.$from;
  const depth = ancestorDepth($from, 'column');
  if (depth === null || $from.depth < depth + 1) {
    return false;
  }
  const row = $from.node(depth - 1);
  if (row.type.name !== 'columnBlock') {
    return false;
  }

  const columnIndex = $from.index(depth - 1);
  const target = columnIndex + (direction === 'next' ? 1 : -1);
  if (target < 0 || target >= row.childCount) {
    return false;
  }

  if (!apply) {
    return true;
  }

  const blockDepth = depth + 1;
  const block = $from.node(blockDepth);
  const blockFrom = $from.before(blockDepth);
  const blockTo = blockFrom + block.nodeSize;
  const caretOffset = tr.selection.from - blockFrom;

  tr.delete(blockFrom, blockTo);

  // Both landing positions are computed against the document as it stands after the deletion.
  // The previous column's content still ends one position inside the source column's start; the
  // next column's content now starts one position past the source column's end, less what the
  // deletion removed.
  const insertAt =
    direction === 'previous' ? $from.before(depth) - 1 : $from.after(depth) + 1 - block.nodeSize;

  tr.insert(insertAt, block);
  const caret = Math.min(insertAt + caretOffset, tr.doc.content.size);
  tr.setSelection(TextSelection.near(tr.doc.resolve(caret), 1));
  tr.scrollIntoView();
  return true;
}

/** One repair the normaliser has found, at the position where it found it. */
type ColumnFault =
  | { readonly kind: 'unwrap'; readonly pos: number; readonly row: PMNode }
  | { readonly kind: 'nested'; readonly pos: number; readonly row: PMNode }
  | { readonly kind: 'refill'; readonly pos: number }
  | { readonly kind: 'widths'; readonly pos: number; readonly widths: readonly (number | null)[] };

/**
 * Told when a repair could not be made. A fault that keeps being found and never fixed is a
 * layout somebody is looking at that will never heal, re-attempted on every keystroke - the
 * definition of a silent fallback, which is what this exists to stop being one.
 */
export type ColumnRepairReporter = (report: {
  readonly reason: 'exhausted' | 'unwrap-failed' | 'refill-failed' | 'widths-failed';
  readonly fault: ColumnFault['kind'];
  readonly pos: number;
}) => void;

/**
 * Visits every node of `cur` that is not reference-identical to the node `old` held in its place.
 *
 * ProseMirror documents are persistent, so an edit rebuilds only the spine from the root to the
 * change: every untouched subtree is the *same object* in the old document and the new one.
 * Comparing by identity therefore turns "scan the document" into "scan what changed", which is
 * the difference between an O(document) walk on every keystroke and an O(depth + changed) one.
 *
 * The shape is prosemirror-tables' `changedDescendants`, which solves exactly this problem for
 * exactly this reason - its own `fixTables` runs on every transaction too. The three-child
 * lookahead absorbs a small insertion or deletion without giving up on the rest of the row.
 */
function changedDescendants(
  old: PMNode,
  cur: PMNode,
  offset: number,
  visit: (node: PMNode, pos: number) => void,
): void {
  const oldSize = old.childCount;
  const curSize = cur.childCount;

  outer: for (let index = 0, scanned = 0; index < curSize; index += 1) {
    const child = cur.child(index);

    for (let scan = scanned, end = Math.min(oldSize, index + 3); scan < end; scan += 1) {
      if (old.child(scan) === child) {
        scanned = scan + 1;
        offset += child.nodeSize;
        continue outer;
      }
    }

    visit(child, offset);

    const previous = scanned < oldSize ? old.child(scanned) : null;
    if (previous?.sameMarkup(child) === true) {
      changedDescendants(previous, child, offset + 1, visit);
    } else if (!child.isTextblock) {
      // A textblock's children are text and marks, and no fault lives in one. Skipping them is
      // what keeps a keystroke - which changes exactly one textblock - off the whole subtree.
      child.descendants((node, pos) => {
        if (node.isTextblock) {
          return false;
        }
        visit(node, offset + 1 + pos);
        return true;
      });
    }

    offset += child.nodeSize;
  }
}

/**
 * The first shape in the document the schema allows but the product does not want.
 *
 * First-only, because the caller reapplies until nothing is found: each repair changes the
 * positions after it, and rescanning a fresh document is simpler to get right than remapping a
 * list of stale ones. Documents are bounded by the node-count limit, repairs are rare, and one
 * extra scan is cheaper than one wrong position.
 *
 * `since` is the document as it was before the change. Given one, only what actually changed is
 * examined - see `changedDescendants` - so the common case, a keystroke into a healthy document,
 * costs a walk down the spine rather than a walk over the prose. Without one, the whole document
 * is scanned, which is what the repair loop's second and later passes do: after a repair there is
 * no old document those positions still describe.
 */
function findColumnFault(doc: PMNode, since?: PMNode): ColumnFault | null {
  // Collected into an array rather than a nullable local: a callback's assignment is invisible
  // to the narrowing, so `found === null` afterwards would read as always true.
  const found: ColumnFault[] = [];

  const inspect = (node: PMNode, pos: number, nesting: number): void => {
    if (found.length > 0 || node.type.name !== 'columnBlock') {
      return;
    }

    // A row inside a column. No command mints one - `insertColumnBlock` refuses inside a row -
    // but a paste or a merge can, and the product has no way to draw or edit it: the inner row's
    // dividers would resize columns inside a column whose own divider resizes them again. It is
    // unwrapped exactly like a one-column row, which puts its content back in the outer column.
    if (nesting > 0) {
      found.push({ kind: 'nested', pos, row: node });
      return;
    }

    if (node.childCount === 1) {
      found.push({ kind: 'unwrap', pos, row: node });
      return;
    }

    let offset = pos + 1;
    for (let index = 0; index < node.childCount; index += 1) {
      const column = node.child(index);
      if (column.childCount === 0) {
        found.push({ kind: 'refill', pos: offset });
        return;
      }
      offset += column.nodeSize;
    }

    const widths = normalisedRowWidths(node);
    if (widths !== null) {
      found.push({ kind: 'widths', pos, widths });
    }
  };

  if (since === undefined) {
    let nesting = 0;
    doc.descendants((node, pos) => {
      if (found.length > 0 || node.isTextblock) {
        return false;
      }
      inspect(node, pos, nesting);
      if (node.type.name !== 'columnBlock') {
        return true;
      }
      // Descending into a row only to find the fault in a *nested* one would report the inner
      // row while the outer is the one to unwrap; the check above catches it on the way in.
      nesting += 1;
      node.descendants((inner, innerPos) => {
        if (found.length > 0 || inner.isTextblock) {
          return false;
        }
        inspect(inner, pos + 1 + innerPos, nesting);
        return true;
      });
      nesting -= 1;
      return false;
    });
  } else {
    // The changed-node walk has no depth to hand, so nesting is asked of the position instead -
    // one resolve per changed row, and rows are a handful in any document.
    changedDescendants(since, doc, 0, (node, pos) => {
      inspect(node, pos, node.type.name === 'columnBlock' ? nestingAt(doc, pos) : 0);
    });
  }

  return found[0] ?? null;
}

/** How many rows of columns enclose the node at `pos`. */
function nestingAt(doc: PMNode, pos: number): number {
  const $pos = doc.resolve(pos);
  let nesting = 0;
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === 'columnBlock') {
      nesting += 1;
    }
  }
  return nesting;
}

/**
 * What the row's widths should be, or `null` when they are already right.
 *
 * Two repairs live here. A width that is not a positive finite number becomes an equal share -
 * the schema's `parseHTML` guards pasted HTML, but a JSON document arrives with its attributes
 * unread, so this is where junk actually gets caught. And a row whose columns all state widths
 * is rescaled so they sum to the column count, keeping the stored numbers near `1`: the render
 * normalises against the sum anyway, so this changes nothing a reader sees, but it stops the
 * numbers drifting arbitrarily large or small across many resizes and merges.
 *
 * A row with a mix of stated and equal-share columns is left alone: `null` means "an equal share
 * of what is left", and rescaling the stated ones would change what is left.
 *
 * **The healthy path allocates nothing.** It is reached for every row of every changed part of
 * the document, so the decision is taken over the row's children in one pass and an array is
 * built only once there is something to write.
 */
function normalisedRowWidths(row: PMNode): readonly (number | null)[] | null {
  let junk = false;
  let allStated = true;
  let sum = 0;

  for (let index = 0; index < row.childCount; index += 1) {
    const raw: unknown = row.child(index).attrs.width;
    const width = readWidth(raw);
    if (width === null) {
      allStated = false;
      if (raw !== null) {
        junk = true;
      }
    } else {
      sum += width;
    }
  }

  const drifted = allStated && sum > 0 && Math.abs(sum - row.childCount) > WIDTH_EPSILON;
  if (!junk && !drifted) {
    return null;
  }

  const scale = drifted ? row.childCount / sum : 1;
  const widths: (number | null)[] = [];
  for (let index = 0; index < row.childCount; index += 1) {
    const width = readWidth(row.child(index).attrs.width);
    widths.push(width === null ? null : width * scale);
  }
  return widths;
}

/**
 * How many repairs one transaction may make before the loop gives up and says so.
 *
 * Far above any real document - each pass fixes one fault, and a document with two hundred
 * malformed rows is not a document a person authored - so reaching it means a repair that does
 * not converge, which is a bug and is reported as one.
 */
const MAX_REPAIR_PASSES = 200;

/**
 * Repairs every invalid column structure in the transaction's document. Returns whether anything
 * needed repairing.
 *
 * The three repairs `columns.ts` promised when it took the permissive side of the schema trades:
 * a single-column row unwraps back into flow, an empty column is refilled with a paragraph so
 * there is somewhere to put the caret, and widths are renormalised. Each is applied against a
 * fresh scan of the document, and the caret is preserved - exactly where the fix is cheap
 * (`unwrap` of a first column, `refill` of the column the caret sits against), and by
 * `Selection.near` elsewhere.
 */
export function repairColumnsTr(
  tr: Transaction,
  since?: PMNode,
  onUnrepaired?: ColumnRepairReporter,
): boolean {
  let repaired = false;
  let previous = since;

  // Bounded, so a repair that fails to converge cannot hang the editor. The bound is not the
  // remedy, though - a fault that keeps being found and never fixed is a layout somebody is
  // looking at that will never heal, retried on every keystroke. Every way out of this loop
  // other than "nothing left to fix" is reported.
  for (let guard = 0; guard < MAX_REPAIR_PASSES; guard += 1) {
    const fault = findColumnFault(tr.doc, previous);
    // Only the first pass can compare against the document as it was: a repair rewrites the very
    // subtree the next pass has to look at, so from here on the scan is the full one. Repairs are
    // rare; a keystroke that finds nothing - the common case by orders of magnitude - never gets
    // past this first pass.
    previous = undefined;
    if (fault === null) {
      return repaired;
    }
    repaired = true;

    if (fault.kind === 'unwrap' || fault.kind === 'nested') {
      if (!unwrapRow(tr, fault.pos, fault.row)) {
        onUnrepaired?.({ reason: 'unwrap-failed', fault: fault.kind, pos: fault.pos });
        return repaired;
      }
      continue;
    }

    if (fault.kind === 'refill') {
      const { paragraph } = columnTypes(tr.doc.type.schema);
      if (paragraph === undefined) {
        onUnrepaired?.({ reason: 'refill-failed', fault: fault.kind, pos: fault.pos });
        return repaired;
      }
      const caretWasAgainstColumn =
        tr.selection.head >= fault.pos && tr.selection.head <= fault.pos + 1;
      tr.insert(fault.pos + 1, paragraph.create());
      if (caretWasAgainstColumn) {
        tr.setSelection(TextSelection.near(tr.doc.resolve(fault.pos + 2), 1));
      }
      continue;
    }

    // The one repair whose failure is invisible from the document: a refused write leaves the
    // same widths in place, so the next pass finds the same fault and the loop spins to its
    // bound. Checked rather than discarded, and reported when it refuses.
    if (!setColumnWidthsTr(tr, fault.pos, fault.widths, true)) {
      onUnrepaired?.({ reason: 'widths-failed', fault: fault.kind, pos: fault.pos });
      return repaired;
    }
  }

  // The bound was reached with a fault still standing.
  const remaining = findColumnFault(tr.doc);
  onUnrepaired?.({
    reason: 'exhausted',
    fault: remaining?.kind ?? 'unwrap',
    pos: remaining?.pos ?? 0,
  });
  return repaired;
}

const columnRepairKey = new PluginKey<RepairScanState>('columnRepair');

/**
 * y-prosemirror's sync plugin key, as the string a transaction's meta is filed under.
 *
 * A last resort, not the contract. `PluginKey('y-sync')` files its meta under `y-sync$`, and a
 * rename upstream would not fail anything here - it would make every remote change read as
 * local, which silently restores the storm the gate exists to prevent, in the form of one
 * inserted paragraph per open client. Nothing in this package can see that happen, which is why
 * `ColumnEditing.options.isRemote` exists and why `apps/web` - which owns the dependency -
 * passes `ySyncPluginKey` itself. This default is what an editor with no CRDT gets.
 */
const Y_SYNC_META = 'y-sync$';

/** What this extension can be told, by the one host that knows more than the schema does. */
export interface ColumnEditingOptions {
  /**
   * Whether a transaction arrived from a collaborator rather than from this client.
   *
   * The default reads y-prosemirror's meta by its string; a host that has the plugin key should
   * hand it over instead, so the coupling is a real reference rather than a literal.
   */
  readonly isRemote: (transaction: Transaction) => boolean;

  /** Told when a repair could not be made. */
  readonly onUnrepaired: ColumnRepairReporter;
}

/** Whether a batch of transactions contains anything this client did, as opposed to received. */
function hasLocalChange(
  transactions: readonly Transaction[],
  isRemote: (transaction: Transaction) => boolean,
): boolean {
  return transactions.some((transaction) => transaction.docChanged && !isRemote(transaction));
}

/**
 * The repair, run after a change this client made - typing, an undo, a command, or a local edit
 * that arrives in the same batch as a remote one.
 *
 * **Deliberately not on a purely remote change, and this is the cost.** The repair exists for
 * merges: the schema was made permissive precisely so a concurrent deletion could merge, and
 * this is where the resulting shape is folded back into one the product draws. But a merge is
 * seen by every open client at once, and a repair is an ordinary edit that broadcasts - so
 * repairing on receipt means N clients each append the same fix and each send it. For `widths`
 * that is N redundant writes of the same numbers; for `refill` it is N paragraphs inserted into
 * one empty column, because an insertion is not idempotent. Gating on a local change makes
 * exactly one client repair: the next one to touch the document.
 *
 * What that costs is a window. A malformed row that arrives while nobody is typing stays
 * malformed until somebody types *anywhere in the document* - see the scan note in the plugin
 * for why "anywhere" needs saying, and what it costs to be true. Readable, editable and slightly
 * odd in the meantime, which is the same smaller wrong `columns.ts` chose when it took the
 * permissive side of the schema. The
 * alternative considered and rejected was electing a repairer by lowest client id, which needs
 * awareness state this package cannot see and fails closed when that client is the one that
 * just disconnected.
 */
// Exported for this package's own tests, which drive the plugin against a bare `EditorState`
// rather than through an editor. Deliberately absent from `index.ts`: a consumer binds to the
// extension, not to the plugin it installs.
export function columnRepairPlugin(options: ColumnEditingOptions): Plugin<RepairScanState> {
  const { isRemote, onUnrepaired } = options;

  return new Plugin<RepairScanState>({
    key: columnRepairKey,

    state: {
      init: () => ({ remoteSinceScan: false }),
      apply: (transaction, value) => {
        if (!transaction.docChanged) {
          return value;
        }
        // A remote change arrives unrepaired and unscanned. A local one is always followed by
        // the `appendTransaction` below, which is where the debt is paid.
        return { remoteSinceScan: isRemote(transaction) };
      },
    },

    appendTransaction(transactions, oldState, newState) {
      if (!hasLocalChange(transactions, isRemote)) {
        return null;
      }

      // **Why a remote change forces a full scan on the next local one.** The scan is scoped by
      // comparing documents for reference identity, and a row a remote merge broke is identical
      // in both documents of a later keystroke that landed somewhere else - so the scoped scan
      // walks straight past it. The two optimisations are individually right and compose into a
      // fault that heals only when somebody edits that exact row, which for `refill` is an empty
      // column nobody can put a caret in and therefore nobody can ever edit.
      //
      // The debt is paid once, on the first local change after any remote batch: one full walk,
      // tens of microseconds on a large document, not one per keystroke.
      const owed =
        (columnRepairKey.getState(oldState)?.remoteSinceScan ?? false) ||
        transactions.some((transaction) => transaction.docChanged && isRemote(transaction));

      const tr = newState.tr;
      return repairColumnsTr(tr, owed ? undefined : oldState.doc, onUnrepaired) ? tr : null;
    },
  });
}

/** Whether a remote change has arrived that no scan has looked at yet. */
interface RepairScanState {
  readonly remoteSinceScan: boolean;
}

/**
 * The default reporter: the console, until there is somewhere better to send it.
 *
 * The same route and the same reasoning as `url-state.ts`'s unparseable search parameter - not a
 * silent fallback, and a telemetry event the day the telemetry client lands. It is a default
 * rather than the only option so the host can route it: `ColumnEditing.configure` takes one.
 */
function isRemoteByMeta(transaction: Transaction): boolean {
  return transaction.getMeta(Y_SYNC_META) !== undefined;
}

function warnUnrepaired(report: Parameters<ColumnRepairReporter>[0]): void {
  console.warn(
    `A column ${report.fault} fault at position ${String(report.pos)} could not be repaired ` +
      `(${report.reason}). The row will keep its shape until the document changes there.`,
  );
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    columnEditing: {
      /** Insert a row of side-by-side columns at the selection, caret in the first. */
      insertColumnBlock: (options?: { columns?: number }) => ReturnType;
      /**
       * Add a fresh column after the caret's, up to `MAX_COLUMNS`.
       *
       * **Named for the row, not `addColumnAfter`.** TipTap's command namespace is flat - the
       * editor reduces every extension's `addCommands()` into one object and the last one
       * registered wins - and `@tiptap/extension-table` already owns `addColumnAfter`. A name
       * collision here does not fail a typecheck, because the two declarations sit on different
       * members of `Commands`; it silently replaces the table's command with one that returns
       * false outside a column, which disables the table toolbar's own button. The same reason
       * gives `removeColumnFromRow` and `setColumnBlockWidths` their names.
       */
      addColumnToRow: () => ReturnType;
      /** Remove the caret's column, carrying its content into a neighbour. */
      removeColumnFromRow: () => ReturnType;
      /** Write one width per column of the row at `pos`. */
      setColumnBlockWidths: (options: {
        pos: number;
        widths: readonly (number | null)[];
      }) => ReturnType;
      /** Move the caret's block into the previous or next column. */
      moveBlockToColumn: (direction: 'previous' | 'next') => ReturnType;
    };
  }
}

/**
 * Column editing: the commands above and the repair plugin, as one extension the editor adds
 * beside its other behaviour. Not part of `nixExtensions` - see the header.
 */
export const ColumnEditing = Extension.create<ColumnEditingOptions>({
  name: 'columnEditing',

  addOptions() {
    return {
      // Both defaults are what an editor with no collaboration and no telemetry gets. A host
      // that has either - `apps/web` has both - configures them, which is what makes the
      // coupling to y-prosemirror a reference rather than a string, and the reporter routable.
      isRemote: isRemoteByMeta,
      onUnrepaired: warnUnrepaired,
    };
  },

  addCommands() {
    return {
      insertColumnBlock:
        (options = {}) =>
        ({ tr, dispatch }) =>
          insertColumnBlockTr(tr, options.columns ?? 2, dispatch !== undefined),
      addColumnToRow:
        () =>
        ({ tr, dispatch }) =>
          addColumnAfterTr(tr, dispatch !== undefined),
      removeColumnFromRow:
        () =>
        ({ tr, dispatch }) =>
          removeColumnTr(tr, dispatch !== undefined),
      setColumnBlockWidths:
        (options) =>
        ({ tr, dispatch }) =>
          setColumnWidthsTr(tr, options.pos, options.widths, dispatch !== undefined),
      moveBlockToColumn:
        (direction) =>
        ({ tr, dispatch }) =>
          moveBlockToColumnTr(tr, direction, dispatch !== undefined),
    };
  },

  addProseMirrorPlugins() {
    return [columnRepairPlugin(this.options)];
  },
});
