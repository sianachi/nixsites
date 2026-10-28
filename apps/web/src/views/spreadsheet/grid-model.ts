import { type CellRange, type CellRef, cellKey } from '@nix/sheet';

import { TITLE_COLUMN_KEY, resolveConfiguredColumns } from '../core/columns';
import { isComputedType, valueShapeOf } from '../core/property-types';
import {
  firstLine,
  readPropertyText,
  type EffectiveSchema,
  type Item,
  type PropertyValue,
  type View,
} from '../core/container-model';
import { dayFor, formatTime, readTimestampValue, readerZone } from '../core/timestamps';
import { continueSeries, type SeriesKind } from '../../lib/suggest/fill-series';

/**
 * The spreadsheet view's geometry and coercion, as pure functions.
 *
 * Rows are children and columns are properties, so unlike the spreadsheet body's free grid every
 * cell here has a type - which is why paste and fill go through one coercion table instead of
 * writing raw text. The component owns the DOM and the writes; everything that can be a unit test
 * lives here instead.
 */

export interface SpreadsheetColumn {
  readonly key: string;
  readonly label: string;

  /**
   * The schema's type for this column, or null for the title and for columns the schema does not
   * describe. A null type reads and copies but never edits: there is nothing to coerce a draft
   * into, and writing a guess would corrupt the very value the column exists to show.
   */
  readonly type: string | null;

  /** Whether free text, paste, fill and range clearing can write this column. */
  readonly editable: boolean;
}

/**
 * The types whose values a person can honestly type into a text overlay.
 *
 * Narrower than `isKnownPropertyType`, deliberately: that predicate means "the property panel has
 * a control for this", and the shared picker can edit values free text cannot describe.
 * A `timestamp` is stored as RFC 9557 with a bracketed zone - a format nobody would type and the
 * server refuses anything else - and an `image` is an asset reference free text can only break.
 * Those columns read and copy here; direct edits use the active property's shared control.
 */
const TEXT_EDITABLE_TYPES: readonly string[] = [
  'text',
  'long_text',
  'number',
  'select',
  'multi_select',
  'date',
  'checkbox',
  'url',
];

/**
 * Types whose *shape* is text but whose values are not something a person should type free-form.
 *
 * `assignee` shares its shape with plain `text` on purpose - see `valueShapeOf` - so width and
 * clearing stay on one switch with everything else string-shaped. But its value is a principal's
 * identifier, a canonical lowercase UUID, and a person typing one into a cell is not a workflow:
 * the shared picker turns a name into that identifier, while paste and fill remain restricted. Named by
 * type rather than by shape, unlike `TEXT_EDITABLE_TYPES` above, because there is nothing left in
 * the shape itself to tell `assignee` apart from an ordinary string.
 */
const TEXT_SHAPED_BUT_NOT_TEXT_EDITABLE: readonly string[] = ['assignee'];

/**
 * The columns, in order: the title first, then the properties.
 *
 * Resolution is the shared rule (`views/core/columns.ts`); what stays here is this view's answer
 * for an unresolvable key: a configured column the schema no longer describes still gets a column
 * headed by its key - a renamed property should leave a column of blanks with a name, not vanish
 * without a stated reason - and it reads without editing.
 */
export function resolveColumns(
  view: View | null,
  schema: EffectiveSchema | null,
): readonly SpreadsheetColumn[] {
  const { keys, definitions } = resolveConfiguredColumns(view, schema);

  return [
    { key: TITLE_COLUMN_KEY, label: 'Title', type: null, editable: false },
    ...keys.map((key): SpreadsheetColumn => {
      const definition = definitions.get(key);
      const type = definition?.type ?? null;

      return {
        key,
        label: definition?.label ?? key,
        type,
        editable:
          type !== null &&
          // Stated rather than left to the shape switch's default. A computed column already came
          // out uneditable, but only because `formula` happens not to be a shape in the list above
          // - an accident that would reverse the day that list grew, and would then send a paste
          // over the column into a per-row refusal from Core.
          !isComputedType(type) &&
          TEXT_EDITABLE_TYPES.includes(valueShapeOf(type)) &&
          !TEXT_SHAPED_BUT_NOT_TEXT_EDITABLE.includes(type),
      };
    }),
  ];
}

/**
 * A column's width, by what its values look like.
 *
 * Fixed rather than resizable: persisting a width would be a new field on the view record -
 * ADR-0020's nine-place threading cost - and a resize that does not persist is a promise the next
 * visit breaks. Until a goal pays for the field, the type is a better guess than a drag nobody
 * can keep.
 */
export function columnWidth(column: SpreadsheetColumn): number {
  if (column.key === TITLE_COLUMN_KEY) {
    return 240;
  }

  switch (valueShapeOf(column.type ?? '')) {
    case 'checkbox':
      return 96;
    case 'number':
      return 128;
    case 'date':
      return 152;
    case 'timestamp':
      return 232;
    default:
      return 184;
  }
}

/** What a copy carries, and what an opened edit starts from: the stored value as text. */
export function cellText(item: Item, column: SpreadsheetColumn): string {
  if (column.key === TITLE_COLUMN_KEY) {
    return item.title;
  }

  return readPropertyText(item, column.key);
}

/**
 * What a cell shows, which is not always what it stores.
 *
 * A timestamp is stored as RFC 9557 with a bracketed zone - `2026-03-17T09:00:00+00:00[Europe/London]` -
 * which printed verbatim is storage syntax in the wrong zone for most readers (ADR-0012's whole
 * point). It is shown as the reader's own clock instead. The copy value stays the stored string
 * (`cellText` above), so a copied timestamp pastes back losslessly. Everything else shows what it
 * stores: an ISO date is unambiguous, and inventing a second spelling would cost the round trip.
 *
 * A date-or-time column takes the same conversion whenever the item it is drawing actually holds a
 * moment - `readTimestampValue` returns null for a bare `yyyy-MM-dd`, which falls straight through
 * to the plain-text case below exactly as a `date` column's value already does.
 */
export function cellDisplay(item: Item, column: SpreadsheetColumn): string {
  if (column.type === 'timestamp' || column.type === 'datetime') {
    const stored = readTimestampValue(item.properties, column.key);

    if (stored !== null) {
      const zone = readerZone();
      return `${dayFor(stored, zone)} ${formatTime(stored, zone)}`;
    }
  }

  // One row tall, so the first line is what there is room for, with a mark that more follows. Any
  // text can hold line breaks if the API or an import wrote them. The copy value stays the whole text.
  const text = cellText(item, column);
  const first = firstLine(text);
  return first.length < text.length ? `${first} …` : text;
}

/** A coerced draft, or the sentence explaining why the text cannot become this column's value. */
export type Coerced =
  | { readonly ok: true; readonly value: PropertyValue }
  | { readonly ok: false; readonly reason: string };

/**
 * Turns the text somebody typed or pasted into the value the column's type stores.
 *
 * Only what has one obvious spelling is decided here - numbers, checkbox words, the comma in a
 * multi-select. Everything else passes through as text for the server to judge, because the server
 * owns validation and a second opinion here could only disagree with it: a select value outside
 * the options or a malformed date comes back as a refusal naming the rule, which is a better
 * answer than this function guessing at one.
 */
export function coerceCellText(text: string, type: string | null): Coerced {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    // Empty clears, per the merge contract - except a checkbox, whose "unchecked" is a value.
    return { ok: true, value: valueShapeOf(type ?? '') === 'checkbox' ? false : null };
  }

  switch (type === null ? null : valueShapeOf(type)) {
    case 'number': {
      const parsed = Number(trimmed);

      if (!Number.isFinite(parsed)) {
        return { ok: false, reason: `"${trimmed}" is not a number.` };
      }

      // The shape says "number"; the TYPE says which numbers are legal. Priority is the one
      // number-shaped type with a closed scale, and committing a 7 here for the server to refuse
      // later is the failure the panel's own select exists to prevent.
      if (type === 'priority' && !(Number.isInteger(parsed) && parsed >= 1 && parsed <= 4)) {
        return { ok: false, reason: `Priority is a whole number from 1 (most urgent) to 4.` };
      }

      return { ok: true, value: parsed };
    }

    case 'checkbox': {
      const word = trimmed.toLowerCase();

      if (word === 'yes' || word === 'true' || word === '1' || word === 'x') {
        return { ok: true, value: true };
      }

      if (word === 'no' || word === 'false' || word === '0') {
        return { ok: true, value: false };
      }

      return { ok: false, reason: `"${trimmed}" is not a yes or a no.` };
    }

    case 'multi_select': {
      const values = trimmed
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

      return { ok: true, value: values.length === 0 ? null : values };
    }

    default:
      return { ok: true, value: trimmed };
  }
}

/** One row's worth of writes: the item, and the property changes going to it together. */
interface RowWrite {
  readonly item: Item;
  readonly bag: Record<string, PropertyValue>;
}

/**
 * The writes a block of text produces, and the cells it could not take - told apart by why.
 *
 * The two reasons are different sentences. A read-only cell (the title, an uneditable type, a row
 * past the last child) is structural: clearing a whole row will always brush the title, and
 * announcing that as a failure would make the most ordinary gesture in the grid sound broken. An
 * unusable value - text that could not become the column's value - is about what somebody pasted,
 * and is worth a sentence.
 */
export interface WritePlan {
  readonly writes: readonly RowWrite[];

  /** Cells that are never writable by construction. Not spoken of. */
  readonly readOnly: number;

  /** Cells whose text could not become the column's value. Spoken of. */
  readonly unusable: number;
}

/**
 * Where a pasted block of TSV lands: one bag per row, anchored at a cell, clipped to the grid.
 *
 * Clipped rather than growing the container - a paste that silently created items would be a
 * create nobody asked for - and one bag per row rather than one write per cell, so a row pasted
 * across five columns is one request and one optimistic update instead of five racing ones.
 */
export function pastePlan(
  anchor: CellRef,
  block: readonly (readonly string[])[],
  items: readonly Item[],
  columns: readonly SpreadsheetColumn[],
): WritePlan {
  const writes: RowWrite[] = [];
  let readOnly = 0;
  let unusable = 0;

  block.forEach((fields, rowOffset) => {
    const item = items[anchor.row + rowOffset];

    if (item === undefined) {
      readOnly += fields.length;
      return;
    }

    const bag: Record<string, PropertyValue> = {};
    let taken = 0;

    fields.forEach((field, colOffset) => {
      const column = columns[anchor.col + colOffset];

      if (column?.editable !== true) {
        readOnly += 1;
        return;
      }

      const coerced = coerceCellText(field, column.type);

      if (!coerced.ok) {
        unusable += 1;
        return;
      }

      bag[column.key] = coerced.value;
      taken += 1;
    });

    if (taken > 0) {
      writes.push({ item, bag });
    }
  });

  return { writes, readOnly, unusable };
}

/**
 * Fill down: the range's first row, repeated over every row below it.
 *
 * The incumbents' Ctrl+D, and the "fill" the goal names: the top row of the selection is the
 * pattern and the rest of the range receives it. Values are re-coerced from their text on the way
 * so a filled cell is exactly what typing the same text would have stored.
 */
export function fillPlan(
  range: CellRange,
  items: readonly Item[],
  columns: readonly SpreadsheetColumn[],
): WritePlan {
  const source = items[range.startRow];

  if (source === undefined || range.endRow === range.startRow) {
    return { writes: [], readOnly: 0, unusable: 0 };
  }

  const pattern: readonly string[] = columnsIn(range, columns).map((column) =>
    cellText(source, column),
  );

  return pastePlan(
    { row: range.startRow + 1, col: range.startCol },
    Array.from({ length: range.endRow - range.startRow }, () => pattern),
    items,
    columns,
  );
}

/** What a series fill would do to one column of the selection, for the sentence offering it. */
interface SeriesColumnFill {
  readonly column: SpreadsheetColumn;
  readonly kind: SeriesKind;
  readonly describe: string;

  /** The filled-in cells the seed already holds, in order. */
  readonly seed: readonly string[];

  /** What the rows below the seed would receive, in order. */
  readonly values: readonly string[];
}

/** A fill the grid can offer: the plan to apply, and per column what it would write. */
export interface SeriesFill {
  readonly plan: WritePlan;
  readonly columns: readonly SeriesColumnFill[];

  /** Rows that would receive a value. */
  readonly rows: number;

  /** Whether any column continues a real pattern rather than repeating its last value. */
  readonly patterned: boolean;
}

/** The run of non-empty cells at the top of a range's column, and the first row after it. */
function seedOf(
  range: CellRange,
  items: readonly Item[],
  column: SpreadsheetColumn,
): { readonly seed: string[]; readonly row: number } {
  const seed: string[] = [];
  let row = range.startRow;
  for (; row <= range.endRow; row += 1) {
    const item = items[row];
    const text = item === undefined ? '' : cellText(item, column).trim();
    if (text.length === 0) {
      break;
    }
    seed.push(text);
  }
  return { seed, row };
}

/**
 * Fill down by pattern: each column of the range continued from the filled cells at its top.
 *
 * The seed of a column is the run of non-empty cells from the range's first row down; the rest of
 * the range receives the continuation `lib/suggest/fill-series.ts` finds for it - an arithmetic
 * series, a date step, a numbered label - or, when none fits, the seed's last value repeated. A
 * column whose seed is empty, or that has no rows below its seed inside the range, contributes
 * nothing. Read-only columns are skipped exactly as `pastePlan` skips them.
 *
 * Values go through the same `coerceCellText` a typed cell does, so a filled cell stores exactly
 * what typing the same text would have stored. Null when nothing in the range can be filled.
 */
export function seriesFillPlan(
  range: CellRange,
  items: readonly Item[],
  columns: readonly SpreadsheetColumn[],
): SeriesFill | null {
  const fills: SeriesColumnFill[] = [];
  const bags = new Map<number, Record<string, PropertyValue>>();
  let unusable = 0;

  for (const column of columnsIn(range, columns)) {
    if (!column.editable) {
      continue;
    }

    const { seed, row } = seedOf(range, items, column);
    const count = range.endRow - row + 1;
    const continuation = continueSeries(seed, count);
    if (continuation === null) {
      continue;
    }

    fills.push({
      column,
      kind: continuation.kind,
      describe: continuation.describe,
      seed,
      values: continuation.values,
    });

    continuation.values.forEach((text, offset) => {
      const coerced = coerceCellText(text, column.type);
      if (!coerced.ok) {
        unusable += 1;
        return;
      }
      const target = row + offset;
      const bag = bags.get(target) ?? {};
      bag[column.key] = coerced.value;
      bags.set(target, bag);
    });
  }

  if (fills.length === 0) {
    return null;
  }

  const writes: RowWrite[] = [];
  for (const [index, bag] of [...bags].sort((a, b) => a[0] - b[0])) {
    const item = items[index];
    if (item !== undefined) {
      writes.push({ item, bag });
    }
  }

  return {
    plan: { writes, readOnly: 0, unusable },
    columns: fills,
    rows: writes.length,
    patterned: fills.some((fill) => fill.kind !== 'repeat'),
  };
}

/** How many continued values an offer spells out; the sentence elides the rest. */
const SERIES_PREVIEW_VALUES = 3;

/** One column of a series-fill offer: what was found and the first values it would write. */
interface SeriesColumnOffer {
  readonly column: SpreadsheetColumn;
  readonly kind: SeriesKind;
  readonly describe: string;
  readonly seed: readonly string[];

  /** At most {@link SERIES_PREVIEW_VALUES} continued values, in order. */
  readonly preview: readonly string[];
}

/** What the unprompted offer needs to say, and nothing it would only need to write. */
export interface SeriesFillOffer {
  readonly columns: readonly SeriesColumnOffer[];

  /** Rows below the seeds that would receive a value. */
  readonly rows: number;

  /** Whether any column continues a real pattern rather than repeating its last value. */
  readonly patterned: boolean;
}

/**
 * Whether the selection is worth offering a series fill for, without building the fill.
 *
 * The same seed and continuation `seriesFillPlan` finds, but only a short preview of it is
 * computed and nothing is coerced, so the grid can ask on every render. **Only offered into empty
 * cells**: an unprompted button that overwrote somebody's values would be one click from losing
 * them, so a selection with any filled target cell gets no offer at all - Ctrl/Cmd+Shift+D, asked
 * for explicitly, still fills it. Null when there is nothing to offer.
 */
export function seriesFillOffer(
  range: CellRange,
  items: readonly Item[],
  columns: readonly SpreadsheetColumn[],
): SeriesFillOffer | null {
  const offered: SeriesColumnOffer[] = [];
  let rows = 0;

  for (const column of columnsIn(range, columns)) {
    if (!column.editable) {
      continue;
    }

    const { seed, row } = seedOf(range, items, column);
    const count = range.endRow - row + 1;
    if (seed.length === 0 || count <= 0) {
      continue;
    }

    for (let target = row; target <= range.endRow; target += 1) {
      const item = items[target];
      if (item !== undefined && cellText(item, column).trim().length > 0) {
        return null;
      }
    }

    const continuation = continueSeries(seed, Math.min(count, SERIES_PREVIEW_VALUES));
    if (continuation === null) {
      continue;
    }

    offered.push({
      column,
      kind: continuation.kind,
      describe: continuation.describe,
      seed,
      preview: continuation.values,
    });
    rows = Math.max(rows, count);
  }

  if (offered.length === 0) {
    return null;
  }

  return {
    columns: offered,
    rows,
    patterned: offered.some((offer) => offer.kind !== 'repeat'),
  };
}

/** A cleared range: every editable cell in it, written to nothing, one bag per row. */
export function clearPlan(
  range: CellRange,
  items: readonly Item[],
  columns: readonly SpreadsheetColumn[],
): WritePlan {
  const blank = columnsIn(range, columns).map(() => '');

  return pastePlan(
    { row: range.startRow, col: range.startCol },
    Array.from({ length: range.endRow - range.startRow + 1 }, () => blank),
    items,
    columns,
  );
}

function columnsIn(
  range: CellRange,
  columns: readonly SpreadsheetColumn[],
): readonly SpreadsheetColumn[] {
  return columns.slice(range.startCol, range.endCol + 1);
}

/**
 * The cells of a range as the map `rangeToTsv` reads, built for the range rather than the grid.
 *
 * The body's copy walks a map it already has; this view has items and columns instead, so the map
 * is made to order - the range's size, not the grid's.
 */
export function rangeTextMap(
  range: CellRange,
  items: readonly Item[],
  columns: readonly SpreadsheetColumn[],
): ReadonlyMap<string, string> {
  const cells = new Map<string, string>();

  for (let row = range.startRow; row <= range.endRow; row += 1) {
    const item = items[row];

    if (item === undefined) {
      continue;
    }

    for (let col = range.startCol; col <= range.endCol; col += 1) {
      const column = columns[col];

      if (column !== undefined) {
        cells.set(cellKey({ row, col }), cellText(item, column));
      }
    }
  }

  return cells;
}
