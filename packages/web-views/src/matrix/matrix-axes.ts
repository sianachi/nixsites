import {
  describeAxisProblem,
  resolveViewAxis,
  type ViewAxis,
} from '@nix/web-collections/core/view-axis';
import type { PropertyDefinition, View } from '@nix/web-collections/core/container-model';

export interface MatrixAxes {
  readonly rows: ViewAxis;
  readonly columns: ViewAxis;
}

/** A cell's address: its row group and its column group, "" standing for "no value". */
export interface CellAddress {
  readonly row: string;
  readonly column: string;
}

/** Both axes, or the sentence that says why the matrix cannot be drawn. */
export function resolveAxes(
  properties: readonly PropertyDefinition[],
  view: View,
): { readonly kind: 'ready'; readonly axes: MatrixAxes } | ({ readonly kind: 'broken' } & Message) {
  const columns = resolveViewAxis(properties, view.groupBy, { allowType: false });
  if (columns.kind !== 'ready') {
    return {
      kind: 'broken',
      title: 'This matrix has no columns to draw',
      detail: `"${view.name}" is a matrix. ${describeAxisProblem(columns, 'columns')} The items are all still here.`,
    };
  }
  const rows = resolveViewAxis(properties, view.rowBy, { allowType: false });
  if (rows.kind !== 'ready') {
    return {
      kind: 'broken',
      title: 'This matrix has no rows to draw',
      detail: `"${view.name}" is a matrix. ${describeAxisProblem(rows, 'rows')} The items are all still here.`,
    };
  }
  if (rows.axis.key === columns.axis.key) {
    return {
      kind: 'broken',
      title: 'This matrix uses one property for both axes',
      detail: `"${view.name}" lays out rows and columns by "${rows.axis.label}". Choose a different property for one of them.`,
    };
  }
  return { kind: 'ready', axes: { rows: rows.axis, columns: columns.axis } };
}

export interface Message {
  readonly title: string;
  readonly detail: string;
}

/** The value a cell's option carries: both groups, joined by a character no group contains. */
export function cellValue(address: CellAddress): string {
  return `${address.row}\u0000${address.column}`;
}

/**
 * A quadrant's tint, by its position among the axes' groups: row 1 / column 1 red, row 1 /
 * column 2 blue, row 2 / column 1 amber, row 2 / column 2 grey (the chart series tokens), anything further out untinted.
 * Class names are written out whole so the stylesheet scan finds them. `cell` washes a grid cell
 * and rules its top edge; `card` rules a card's left edge.
 */
const TINTS = [
  [
    { cell: 'bg-series-1/7 border-t-2 border-t-series-1', card: 'border-l-2 border-l-series-1' },
    { cell: 'bg-series-2/7 border-t-2 border-t-series-2', card: 'border-l-2 border-l-series-2' },
  ],
  [
    { cell: 'bg-series-3/7 border-t-2 border-t-series-3', card: 'border-l-2 border-l-series-3' },
    { cell: 'bg-series-4/7 border-t-2 border-t-series-4', card: 'border-l-2 border-l-series-4' },
  ],
] as const;
const NO_TINT = { cell: '', card: '' };

export function quadrantTint(
  rowIndex: number,
  columnIndex: number,
): { readonly cell: string; readonly card: string } {
  return TINTS[rowIndex]?.[columnIndex] ?? NO_TINT;
}
