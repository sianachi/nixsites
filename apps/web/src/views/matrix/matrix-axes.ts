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
